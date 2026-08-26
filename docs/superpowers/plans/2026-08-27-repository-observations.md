# Repository Observations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 화면에 제공하는 모든 public repository fact와 향후 분석용 별·순위·membership·release·commit 변화를 정확한 2시간 append-only SQLite 정본에 보존한다.

**Architecture:** GitHub fact collector가 snapshot JSON을 만들고 Python recorder가 last-good DB 복제본에 원자적으로 append한다. 기존 두 SQLite는 immutable legacy baseline으로 남기며 public JSON·Atom·star history는 신규 DB에서 결정적으로 파생한다.

**Tech Stack:** Node.js 24, Python 3.13 `sqlite3`, GitHub REST API, existing vanilla site generators.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md`

## Global Constraints

- Plan 1의 `RunContext`, canonical repository facts, schema-v2 summaries, transactional candidate workflow가 production에서 통과한 뒤 시작한다.
- `data/star-observations.sqlite`와 `data/trending-membership.sqlite`는 byte-for-byte legacy baseline으로 보존한다.
- 첫 신규 snapshot의 현재 repository는 `baseline_present`이며 모두 `new`가 아니다.
- README body, release body/assets, commit patch/files/full message/email은 저장하지 않는다.
- 성공한 2시간 run은 visible data가 같아도 반드시 `snapshot_runs`와 `snapshot_items`에 append한다.
- DB UPDATE/DELETE뿐 아니라 부모 DB history 축소·교체도 거부한다.
- Pages artifact에는 SQLite를 넣지 않는다.
- 모든 Commit step은 명시된 `git add` 다음, `git commit` 전에 Transactional Refresh plan의 Common Commit Gate를 실행한다.

---

## File Structure

- Create `scripts/collect-repository-events.mjs`: release baseline/change와 future default-branch commit 수집.
- Create `scripts/record_repository_observations.py`: schema v1 생성, append, prefix/hash-chain 검증.
- Create `scripts/derive_repository_artifacts.py`: 신규 DB에서 membership, insights, daily star series를 파생.
- Create `tests/collect-repository-events.test.mjs`: pagination, no releases, commit continuity, safe fields.
- Create `tests/test_repository_observations.py`: schema, first baseline, unchanged snapshot, append-only, prefix replacement.
- Create `tests/test_repository_artifacts.py`: membership/insight/star derivation.
- Generate in the first verified workflow: `data/readme-state.json`, current/previous README hash rolling state.
- Generate in the first verified workflow: `data/repository-observations.sqlite`, first validated production baseline.
- Modify `scripts/update-trending.mjs`: event collector 입력에 필요한 default branch/release/profile facts.
- Modify `scripts/update-latest-feed.mjs`, `scripts/generate_atom_feeds.py`, `scripts/update-star-history.mjs`: 신규 DB 파생물 사용.
- Modify `.github/workflows/daily-refresh.yml`, `tests/daily-refresh-workflow.test.mjs`: 신규 collector/recorder/deriver 순서와 legacy writer 제거.

### Task 1: Define and fingerprint the append-only schema

**Files:**
- Create: `scripts/record_repository_observations.py`
- Create: `tests/test_repository_observations.py`

**Interfaces:**
- Produces: `create_database(path)`, `validate_schema(connection)`, `schema_fingerprint(connection)`.
- Schema version: integer `1`; creation policy: `append_only`.

- [ ] **Step 1: Write schema RED tests**

```python
def test_schema_has_exact_tables_and_rejects_update_delete(self):
    create_database(self.database)
    with sqlite3.connect(self.database) as connection:
        self.assertEqual(
            set(row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")),
            {"schema_meta", "snapshot_runs", "repository_profiles", "snapshot_items", "release_versions", "release_observations", "commit_events", "readme_change_events", "repository_insights", "artifact_hashes"},
        )
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute("UPDATE snapshot_runs SET stats_date_kst='2026-01-01'")

def test_snapshot_items_reject_invalid_ranks_gains_and_readme_state(self):
    create_database(self.database)
    for invalid in (item(rank_daily=0), item(gain_weekly=-1), item(readme_status="present", readme_path=None), item(readme_status="absent", readme_blob_sha="a" * 40)):
        with self.assertRaises(sqlite3.IntegrityError):
            insert_snapshot_item(self.database, invalid)
```

- [ ] **Step 2: Run RED**

Run: `python -m unittest tests.test_repository_observations.RepositoryObservationTests.test_schema_has_exact_tables_and_rejects_update_delete`

Expected: import failure because the recorder does not exist.

- [ ] **Step 3: Implement exact schema**

Require SQLite `STRICT` support from the pinned Python 3.13 runtime and fail startup if a one-table STRICT probe fails. Core keys and constraints are:

```sql
CREATE TABLE snapshot_runs(
  snapshot_id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK(run_kind IN ('migration_baseline','refresh')),
  observed_at_utc TEXT NOT NULL UNIQUE,
  observed_at_kst TEXT NOT NULL,
  stats_date_kst TEXT NOT NULL,
  parent_snapshot_id TEXT REFERENCES snapshot_runs(snapshot_id),
  input_source_sha TEXT NOT NULL CHECK(length(input_source_sha)=40 AND lower(input_source_sha) NOT GLOB '*[^0-9a-f]*'),
  input_snapshot_id TEXT,
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64 AND lower(input_sha256) NOT GLOB '*[^0-9a-f]*'),
  snapshot_payload_sha256 TEXT NOT NULL UNIQUE CHECK(length(snapshot_payload_sha256)=64 AND lower(snapshot_payload_sha256) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE repository_profiles(
  profile_id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE,
  display_slug TEXT NOT NULL,
  captured_snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  description TEXT,
  primary_language TEXT,
  language_color TEXT,
  topics_json TEXT NOT NULL,
  license_spdx TEXT,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  is_fork INTEGER NOT NULL CHECK(is_fork IN (0,1)),
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pushed_at TEXT,
  field_tags_json TEXT NOT NULL,
  form_tags_json TEXT NOT NULL,
  tag_rule_version INTEGER NOT NULL,
  profile_sha256 TEXT NOT NULL,
  UNIQUE(slug, profile_sha256)
) STRICT;
CREATE TABLE snapshot_items(
  snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  slug TEXT NOT NULL COLLATE NOCASE,
  profile_id INTEGER NOT NULL REFERENCES repository_profiles(profile_id),
  display_rank INTEGER NOT NULL CHECK(display_rank > 0),
  rank_daily INTEGER CHECK(rank_daily IS NULL OR rank_daily > 0),
  rank_weekly INTEGER CHECK(rank_weekly IS NULL OR rank_weekly > 0),
  rank_monthly INTEGER CHECK(rank_monthly IS NULL OR rank_monthly > 0),
  gain_daily INTEGER CHECK(gain_daily IS NULL OR gain_daily >= 0),
  gain_weekly INTEGER CHECK(gain_weekly IS NULL OR gain_weekly >= 0),
  gain_monthly INTEGER CHECK(gain_monthly IS NULL OR gain_monthly >= 0),
  stars INTEGER NOT NULL CHECK(stars >= 0),
  forks INTEGER NOT NULL CHECK(forks >= 0),
  open_issues_and_pull_requests INTEGER NOT NULL CHECK(open_issues_and_pull_requests >= 0),
  contributors INTEGER NOT NULL CHECK(contributors >= 0),
  subscribers INTEGER NOT NULL CHECK(subscribers >= 0),
  default_branch_head_sha TEXT NOT NULL CHECK(length(default_branch_head_sha)=40 AND lower(default_branch_head_sha) NOT GLOB '*[^0-9a-f]*'),
  previous_default_branch_head_sha TEXT CHECK(previous_default_branch_head_sha IS NULL OR (length(previous_default_branch_head_sha)=40 AND lower(previous_default_branch_head_sha) NOT GLOB '*[^0-9a-f]*')),
  head_transition TEXT NOT NULL CHECK(head_transition IN ('baseline','fast_forward','branch_changed','force_pushed')),
  readme_status TEXT NOT NULL CHECK(readme_status IN ('present','absent')),
  readme_path TEXT,
  readme_blob_sha TEXT,
  readme_content_sha256 TEXT,
  membership_status TEXT NOT NULL CHECK(membership_status IN ('baseline_present','new','reentered','maintained')),
  PRIMARY KEY(snapshot_id, slug),
  UNIQUE(snapshot_id, display_rank),
  CHECK(
    (readme_status='absent' AND readme_path IS NULL AND readme_blob_sha IS NULL AND readme_content_sha256 IS NULL)
    OR
    (readme_status='present' AND length(readme_path)>0
      AND length(readme_blob_sha)=40 AND lower(readme_blob_sha) NOT GLOB '*[^0-9a-f]*'
      AND length(readme_content_sha256)=64 AND lower(readme_content_sha256) NOT GLOB '*[^0-9a-f]*')
  )
) STRICT;
CREATE TABLE release_versions(
  slug TEXT NOT NULL COLLATE NOCASE,
  release_id INTEGER NOT NULL,
  metadata_sha256 TEXT NOT NULL,
  first_observed_snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  tag_name TEXT NOT NULL,
  name TEXT,
  target_commitish TEXT NOT NULL,
  draft INTEGER NOT NULL CHECK(draft IN (0,1)),
  prerelease INTEGER NOT NULL CHECK(prerelease IN (0,1)),
  created_at TEXT NOT NULL,
  published_at TEXT,
  html_url TEXT NOT NULL,
  PRIMARY KEY(slug, release_id, metadata_sha256)
) STRICT;
CREATE TABLE release_observations(
  snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  slug TEXT NOT NULL COLLATE NOCASE,
  release_id INTEGER NOT NULL,
  metadata_sha256 TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, slug, release_id),
  FOREIGN KEY(slug, release_id, metadata_sha256) REFERENCES release_versions(slug, release_id, metadata_sha256)
) STRICT;
CREATE TABLE commit_events(
  slug TEXT NOT NULL COLLATE NOCASE,
  commit_sha TEXT NOT NULL,
  first_observed_snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  branch_name TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  author_login TEXT,
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 500),
  parent_shas_json TEXT NOT NULL,
  html_url TEXT NOT NULL,
  PRIMARY KEY(slug, commit_sha)
) STRICT;
CREATE TABLE readme_change_events(
  slug TEXT NOT NULL COLLATE NOCASE,
  snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  old_path TEXT,
  new_path TEXT,
  old_blob_sha TEXT,
  new_blob_sha TEXT,
  old_content_sha256 TEXT,
  new_content_sha256 TEXT,
  change_kind TEXT NOT NULL CHECK(change_kind IN ('baseline','added','changed','removed')),
  PRIMARY KEY(slug, snapshot_id)
) STRICT;
CREATE TABLE repository_insights(
  snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  slug TEXT NOT NULL COLLATE NOCASE,
  stars_delta_2h INTEGER,
  stars_daily_close INTEGER,
  stars_daily_delta INTEGER,
  velocity_7d REAL,
  velocity_30d REAL,
  acceleration_7d REAL,
  acceleration_30d REAL,
  display_rank_delta INTEGER,
  rank_daily_delta INTEGER,
  rank_weekly_delta INTEGER,
  rank_monthly_delta INTEGER,
  insight_sha256 TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, slug),
  FOREIGN KEY(snapshot_id, slug) REFERENCES snapshot_items(snapshot_id, slug)
) STRICT;
CREATE TABLE artifact_hashes(
  snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(snapshot_id),
  artifact_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  PRIMARY KEY(snapshot_id, artifact_path)
) STRICT;
```

Create both `reject_update` and `reject_delete` BEFORE triggers for each of these nine exact tables: `snapshot_runs`, `repository_profiles`, `snapshot_items`, `release_versions`, `release_observations`, `commit_events`, `readme_change_events`, `repository_insights`, and `artifact_hashes`. Each trigger raises `ABORT` with the table name and `is append-only`. Include every normalized table/index/trigger statement in an exact schema fingerprint validator modeled after `record_star_observations.py`. Validator tests also exercise every stored Git SHA/SHA-256 length and lowercase-hex constraint, not merely the representative README checks above.

- [ ] **Step 4: Run schema tests and mutation**

Run: `python -m unittest tests.test_repository_observations`. Temporarily omit one trigger and verify fingerprint test failure; restore.

- [ ] **Step 5: Commit**

```powershell
git add scripts/record_repository_observations.py tests/test_repository_observations.py
git commit -m "feat: define the repository observation ledger"
```

### Task 2: Collect releases and prospective commits safely

**Files:**
- Create: `scripts/collect-repository-events.mjs`
- Create: `tests/collect-repository-events.test.mjs`
- Modify: `scripts/update-trending.mjs`

**Interfaces:**
- Consumes current repository facts and the prior DB high-water marks exported as JSON.
- Produces `{ releases, commits, heads }` with allowlisted public fields.

- [ ] **Step 1: Write pagination and field-boundary RED tests**

```js
test("release baseline follows pagination and excludes bodies and assets", async () => {
  const events = await collectRepositoryEvents([repo], { mode: "baseline", fetchImpl });
  assert.deepEqual(events.releases.map(r => r.id), [1, 2]);
  assert.equal("body" in events.releases[0], false);
  assert.equal("assets" in events.releases[0], false);
});

test("future commits dedupe overlap and reject an unexplained head gap", async () => {
  const events = await collectRepositoryEvents([repo], { previous: { headSha: prior }, fetchImpl });
  assert.deepEqual(events.commits.map(c => c.sha), [next1, next2]);
  await assert.rejects(collectRepositoryEvents([repo], { previous: { headSha: missing }, fetchImpl: gap }), /continuity/);
});

test("a proven rewrite starts a new prospective baseline without importing fetched history", async () => {
  const events = await collectRepositoryEvents([repo], { previous: { branch: "main", headSha: prior }, fetchImpl: deepRewrite });
  assert.equal(events.heads[0].transition, "force_pushed");
  assert.equal(events.heads[0].headSha, rewrittenHead);
  assert.deepEqual(events.commits, []);
});

test("release observations preserve A to B to A and a README path-only change", async () => {
  const snapshots = await collectThreeSnapshots({ releaseHashes: ["a", "b", "a"], readmePaths: ["README.md", "README.md", "docs/README.md"] });
  assert.deepEqual(snapshots.map(value => value.releases[0].metadataSha256), ["a", "b", "a"]);
  assert.equal(snapshots[2].readmes[0].changeKind, "changed");
  assert.equal(snapshots[2].readmes[0].newPath, "docs/README.md");
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/collect-repository-events.test.mjs`

- [ ] **Step 3: Implement release collection**

Follow `Link` pagination for `/repos/{slug}/releases?per_page=100` to the final page on every successful snapshot; do not stop at a high-water id because an old release can be edited. Map only `id`, `tag_name`, `name`, `target_commitish`, `draft`, `prerelease`, `created_at`, `published_at`, `html_url`; hash canonical JSON. Insert a deduplicated `release_versions` row for each distinct hash and a `release_observations` link for every release present in every snapshot, so A→B→A remains three timed observations.

- [ ] **Step 4: Implement commit collection**

Record the first observed default branch HEAD as baseline without past history. Later runs request `/commits` from the current HEAD/default branch with `per_page=100`, without `since`, and paginate from HEAD until the exact prior head is found; cap at 20 pages and fail rather than truncate. Store commits before that stop point, deduped by SHA, with branch name, author/commit timestamps, public author login or null, subject first line capped at 500 characters, parent SHA array, and HTML URL. Reject emails and full commit messages.

A changed default-branch name creates an explicit `branch_changed` prospective baseline. If the same branch no longer reaches the prior head, require compare/ref evidence of `diverged` or `behind` before `force_pushed`; otherwise fail. For either proven transition, store the transition and current head in `snapshot_items`, return zero `commit_events` for that repository in that run, and discard every historical commit returned while diagnosing the gap—even if up to 20 pages were fetched. The next run continues prospectively from this new head. Add backdated-fast-forward and deep-rewrite fixtures proving respectively that removal of `since` prevents omission and that rewritten history is never backfilled.

- [ ] **Step 5: Request-budget and error tests**

Assert maximum pages, 429 bounded retry, 404 deleted repository failure, empty release list success, backdated commit retention, full release rescan, A→B→A release observations, branch-change/force-push zero-history baselines, and errors without response bodies/tokens. Mutate release collection to stop after the newest known id, mutate commit collection to restore `since`, and mutate rewrite handling to import the fetched historical page; require the edited-old-release, backdated-commit, and deep-rewrite tests to fail respectively, restoring after each. Run focused tests and `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add scripts/collect-repository-events.mjs scripts/update-trending.mjs tests/collect-repository-events.test.mjs tests/update-trending.test.mjs
git commit -m "feat: collect release and future commit events"
```

### Task 3: Append one complete snapshot with parent continuity

**Files:**
- Modify: `scripts/record_repository_observations.py`
- Modify: `tests/test_repository_observations.py`
- Generate during the first verified workflow: `data/readme-state.json`

**Interfaces:**
- Produces: `prepare_candidate_database(parent_database_path, candidate_database_path, parent_evidence) -> Path`.
- Produces: `record_core_snapshot(candidate_database_path, snapshot_payload, event_payload, readme_state) -> CoreRecordResult`.
- `CoreRecordResult`: inserted core counts plus `snapshot_payload_sha256`; this hash covers canonical snapshot/profile/item/release-observation/commit/README-event input, not later derived rows or SQLite file bytes.

- [ ] **Step 1: Add first-baseline, unchanged-run and prefix RED tests**

```python
def test_first_snapshot_is_baseline_and_identical_next_run_still_appends(self):
    first = payload("2026-08-27T00:07:00Z", run_kind="migration_baseline")
    record_core_snapshot(self.database, first, events(), readme_state())
    second = payload("2026-08-27T02:07:00Z", same_repositories=True)
    record_core_snapshot(self.database, second, events(), readme_state())
    with sqlite3.connect(self.database) as connection:
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (2,))
        self.assertEqual(set(r[0] for r in connection.execute("SELECT membership_status FROM snapshot_items WHERE snapshot_id=?", (first["snapshotId"],))), {"baseline_present"})

def test_truncated_parent_database_is_rejected(self):
    evidence = parent_evidence(self.database)
    replace_with_older_copy(self.database)
    with self.assertRaisesRegex(ValueError, "parent database"):
        prepare_candidate_database(self.database, self.candidate, evidence)
```

- [ ] **Step 2: Run RED**

Run: `python -m unittest tests.test_repository_observations`

- [ ] **Step 3: Implement candidate-copy recording**

The CLI requires `--parent-database`, `--candidate-database`, `--snapshot`, `--events`, `--parent-evidence`, and `--readme-state`. It refuses identical parent/candidate paths, copies the last-good DB to the explicit candidate path, opens `DELETE` journal + `synchronous=FULL`, validates parent file SHA/size/last snapshot/hash chain, and appends the core rows inside `BEGIN IMMEDIATE`. It runs integrity/foreign-key checks, closes sidecars, and compares every parent table row digest, but does not replace any tracked file. Only a missing parent DB accepts `run_kind="migration_baseline"` with null `parent_snapshot_id`; every later append requires `run_kind="refresh"` and the exact last snapshot id as parent.

Profile versions insert only when `profile_sha256` changes. README rolling state writes both `current` and `previous` objects, each containing nullable path/blob SHA/content SHA256 plus its own `observedAtUtc` and `observedAtKst`; it inserts `readme_change_events` on path-only, blob, content, added or removed changes and never writes body. Releases and commits use `INSERT` after explicit conflict equivalence checks; a conflicting same key with different content fails. Each current release must have exactly one `release_observations` row for the snapshot, including an A→B→A sequence that points back to the original deduplicated version on the third observation.

- [ ] **Step 4: Membership transitions**

First snapshot uses `baseline_present`. For later snapshots compare to the prior successful snapshot: absent→present is `new` if never seen, `reentered` if historical; present→present is `maintained`. Exits are derived as prior-present slugs absent from current, not inserted as fake snapshot items.

- [ ] **Step 5: Mutation and full tests**

Temporarily bypass parent row digest comparison; verify truncation test failure. Restore. Run `python -m unittest tests.test_repository_observations` and `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add scripts/record_repository_observations.py tests/test_repository_observations.py
git commit -m "feat: append complete two-hour repository snapshots"
```

### Task 4: Derive insights, membership and star history

**Files:**
- Create: `scripts/derive_repository_artifacts.py`
- Create: `tests/test_repository_artifacts.py`
- Modify: `scripts/update-latest-feed.mjs`
- Modify: `scripts/generate_atom_feeds.py`
- Modify: `scripts/update-star-history.mjs`

**Interfaces:**
- Produces `data/membership-status.json`, `star-history.json`, insight rows, and Atom inputs from one DB snapshot.
- Produces `finalize_snapshot_derivatives(candidate_database_path, snapshot_id, insights, artifact_hashes) -> FinalizeResult`; this inserts only derived rows into the still-unpublished candidate and returns verified counts.

- [ ] **Step 1: Write deterministic derivation RED tests**

Create a temp DB with four snapshots covering same-day 2h changes, a KST day close, an exit, a reentry, and release metadata A→B→A. Assert exact 2h delta, daily closing value, daily delta, 7/30-day nullable velocity, source/display rank changes, membership events, three timed `release_observations`, and two deduplicated `release_versions`.

- [ ] **Step 2: Run RED**

Run: `python -m unittest tests.test_repository_artifacts`

- [ ] **Step 3: Implement SQL-backed derivation**

Use ordered snapshot timestamps, never current wall clock. Daily close is the last successful KST snapshot for each slug/date. Velocity requires enough distinct daily closes; otherwise store null. Acceleration is current velocity minus the previous equal-window velocity. Generate every public JSON/Atom/page file inside the workflow temp candidate first, hash the exact Pages allowlist, then call `finalize_snapshot_derivatives` once to insert `repository_insights` and `artifact_hashes` in one transaction. Run expected-row-count, foreign-key, integrity, prefix and sidecar checks again. Only after that whole candidate tree passes does the workflow copy the verified files and DB into the checkout for one Git commit; no recorder function replaces tracked files directly.

- [ ] **Step 4: Switch membership and Atom readers**

Change `generate_atom_feeds.py` validation to read membership events from `repository-observations.sqlite`. Update `update-latest-feed.mjs` to consume an exported snapshot JSON rather than query legacy star rows. Preserve existing public feed/change contracts while adding `snapshotId`.

- [ ] **Step 5: Switch star-history derivation**

Keep GH Archive estimates as historical context but source exact observations from the new DB. Do not make new external history requests for values already recorded. Same-day exact points remain visible internally; the public chart can use KST daily closes.

- [ ] **Step 6: Mutation and tests**

Run each mutation separately and restore it: change daily close query from last to max stars; drop the third A→B→A `release_observations` link; let artifact derivation publish files before `finalize_snapshot_derivatives`. The same-day decrease, release-timeline, and core/finalize-gap tests must fail respectively. Run new tests, existing membership/Atom/star suites, then `npm test`.

- [ ] **Step 7: Commit**

```powershell
git add scripts/derive_repository_artifacts.py scripts/update-latest-feed.mjs scripts/generate_atom_feeds.py scripts/update-star-history.mjs tests/test_repository_artifacts.py tests/latest-feed.test.mjs tests/test_atom_feeds.py tests/update-star-history.test.mjs
git commit -m "feat: derive public trends from exact repository snapshots"
```

### Task 5: Cut the workflow over and create the validated baseline

**Files:**
- Modify: `.github/workflows/daily-refresh.yml`
- Modify: `tests/daily-refresh-workflow.test.mjs`
- Generate in the workflow candidate: `data/repository-observations.sqlite`, `data/readme-state.json`, and derived public artifacts.

**Interfaces:**
- Workflow order: collect facts/events → prepare DB candidate → record core snapshot → derive public artifacts → finalize insights/hashes → validate whole candidate → promote to checkout → publish/deploy/probe.

- [ ] **Step 1: Write workflow cutover RED test**

Assert `collect-repository-events.mjs`, core recording, `derive_repository_artifacts.py`, derivative finalization and whole-candidate validation occur in that order. Assert workflow no longer invokes `record_star_observations.py` or `record_trending_membership.py`, and allowed staged outputs include the new DB/readme state but Pages allowlist still excludes SQLite. Add a failure fixture between core recording and finalization and require tracked checkout bytes to remain unchanged.

- [ ] **Step 2: Run RED**

Run: `node --test tests/daily-refresh-workflow.test.mjs`

- [ ] **Step 3: Update candidate workflow**

Add parent evidence export from the production manifest/source SHA, event collection, candidate DB append, derivation, schema fingerprint, parent prefix/hash-chain, sidecar, artifact hash and cross-count validation. When the production parent has no repository DB, require the recorder to create it as `migration_baseline` inside the workflow candidate; any later absence is history loss and fails. Stop legacy writer invocations; leave legacy files tracked and byte-identical.

- [ ] **Step 4: Create a local fixture baseline and test it**

Use the verified Plan 1 production manifest and captured current public facts without network in an untracked temp directory to rehearse one `migration_baseline` row whose `input_source_sha`/`input_snapshot_id` equal that manifest. Assert every current item is `baseline_present`, `parent_snapshot_id` is null, legacy fingerprints remain unchanged, README bodies are absent from SQLite/JSON, and release/commit restricted fields are absent. Delete the temp rehearsal; do not add its DB or rolling state to the implementation commit.

- [ ] **Step 5: Full tests and mutation**

Run `npm test`. Temporarily remove the new DB from staged allowlist and verify workflow test failure; restore. Then mutate the workflow to copy core-recorded candidate bytes before derivative finalization and require the tracked-checkout-unchanged failure fixture to catch it; restore and rerun `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add .github/workflows/daily-refresh.yml tests/daily-refresh-workflow.test.mjs
git commit -m "feat: publish exact repository observation history"
```

- [ ] **Step 7: Push and production verification**

Run from PowerShell after all Common Commit Gates and full tests:

```powershell
git fetch origin main
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
git merge-base --is-ancestor origin/main HEAD
if ($LASTEXITCODE -ne 0) { throw 'origin/main is not an ancestor of HEAD' }
git push origin main
git fetch origin main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'Push readback mismatch' }
$dispatch = node scripts/dispatch-refresh.mjs --wait | ConvertFrom-Json
if (-not $dispatch.runId -or -not $dispatch.sourceSha -or -not $dispatch.snapshotId -or -not $dispatch.manifestSha256) { throw 'Observation dispatch returned an incomplete receipt' }
git fetch origin main
$verified = node scripts/verify-refresh-chain.mjs --expected-run-id $dispatch.runId --expected-source-sha $dispatch.sourceSha --expected-snapshot-id $dispatch.snapshotId --expected-manifest-sha256 $dispatch.manifestSha256 --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ | ConvertFrom-Json
if (-not $verified.effectiveRunId) { throw 'Observation refresh-chain verification failed' }
if ((git rev-parse origin/main) -ne $verified.sourceSha) { throw 'Observation origin/main does not match verified production' }
git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) { throw 'Observation bot commit is not a fast-forward' }
$allowedBotPath = '^(index\.html|data/(latest\.json|membership-status\.json|repo-summaries\.json|translation-sources\.json|repository-observations\.sqlite|readme-state\.json)|translations/[^/]+\.json|feed\.xml|changes\.xml|star-history\.json)$'
$unexpectedBotPaths = @(git diff --name-only HEAD..origin/main | Where-Object { $_ -notmatch $allowedBotPath })
if ($unexpectedBotPaths.Count) { throw "Unexpected observation bot paths: $($unexpectedBotPaths -join ', ')" }
git merge --ff-only origin/main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main) -or (git status --porcelain)) { throw 'Observation fast-forward readback failed' }
```

Review the displayed pre-push log/diff and stop unless any remote movement is the verified bot-only fast-forward. After the first run and local fast-forward, query counts from a read-only DB copy: exactly one `migration_baseline`, no required second row yet, current item count equals page/latest/feed, legacy DB hashes unchanged, and no `-wal`/`-shm`/`-journal` sidecars. The next scheduled or manual success must append a `refresh` row; its absence is a later acceptance failure, not a reason to fabricate a second baseline row.

- [ ] **Step 8: Stop before UI work on any mismatch**

Do not start Plan 3 until DB, derived artifacts, Pages, and production evidence agree.
