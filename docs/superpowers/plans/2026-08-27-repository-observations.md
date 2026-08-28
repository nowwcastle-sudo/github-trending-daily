# Repository Observations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 화면에 제공하는 모든 public repository fact와 향후 분석용 별·순위·membership·release·commit 변화를 정확한 2시간 append-only SQLite 정본에 보존한다.

**Architecture:** GitHub fact collector가 snapshot JSON을 만들고 Python recorder가 last-good DB 복제본에 원자적으로 append한다. 기존 두 SQLite는 immutable legacy baseline으로 남기며 public JSON·Atom·star history는 신규 DB에서 결정적으로 파생한다.

**Tech Stack:** Node.js 24, Python 3.13 `sqlite3`, GitHub REST API, existing vanilla site generators.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md`

## Global Constraints

- Plan 1의 `RunContext`, canonical repository facts, schema-v2 summaries, transactional candidate workflow는 로컬 전체 테스트·적대적 리뷰·원격 push까지 통과했다. workflow는 `bootstrap_v0_pending_approval`로 유지되어 실제 API 호출·production 갱신은 아직 발생하지 않았다.
- `data/star-observations.sqlite`와 `data/trending-membership.sqlite`는 byte-for-byte legacy baseline으로 보존한다.
- 첫 신규 snapshot의 현재 repository는 `baseline_present`이며 모두 `new`가 아니다.
- README body, release body/assets, commit patch/files/message/subject/name/email은 저장하지 않는다.
- 성공한 2시간 run은 visible data가 같아도 반드시 `snapshot_runs`와 `snapshot_items`에 append한다.
- DB UPDATE/DELETE뿐 아니라 부모 DB history 축소·교체도 거부한다.
- Pages artifact에는 SQLite를 넣지 않는다.
- 모든 Commit step은 명시된 `git add` 다음, `git commit` 전에 Transactional Refresh plan의 Common Commit Gate를 실행한다.

---

## File Structure

- Create `scripts/collect-repository-events.mjs`: release baseline/change와 future default-branch commit 수집.
- Create `scripts/record_repository_observations.py`: schema v1 생성, append, logical-row/hash-chain 검증.
- Create `scripts/scan_repository_observations.py`: staged SQLite index blob을 임시 복사해 schema·logical cells·raw pages/freelist의 금지 field·비밀값 형태를 값 출력 없이 검사.
- Create `scripts/derive_repository_artifacts.py`: 신규 DB에서 membership, insights, daily star series를 파생.
- Create `tests/collect-repository-events.test.mjs`: pagination, no releases, commit continuity, safe fields.
- Create `tests/test_repository_observations.py`: schema, first baseline, unchanged snapshot, append-only, logical-row prefix replacement.
- Create `tests/test_scan_repository_observations.py`: staged index blob 검사와 fail-closed 출력 계약.
- Create `tests/test_repository_artifacts.py`: membership/insight/star derivation.
- Generate in the first verified workflow: `data/readme-state.json`, current/previous README path·immutable blob SHA·content SHA rolling identity only; README body는 영구 저장하지 않는다.
- Generate in the first verified workflow: `data/repository-observations.sqlite`, first validated production baseline.
- Modify `scripts/update-trending.mjs`: page 설치와 canonical facts 생성을 분리하고 watchers·세 source color·event/enrichment provenance를 보존.
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
            {"schema_meta", "baseline_sources", "baseline_membership_slugs", "snapshot_runs", "repository_profiles", "snapshot_items", "release_versions", "snapshot_release_items", "historical_star_estimates", "historical_star_observations", "commit_events", "readme_change_events", "repository_insights", "artifact_hashes"},
        )
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute("UPDATE schema_meta SET creation_policy='mutable'")

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

Require SQLite `STRICT` support from the pinned Python 3.13 runtime and fail startup if a one-table STRICT probe fails. Implement the exact 14-table typed/null/default/enum/FK/check/index matrix in spec §6.3.1 without adding inferred columns. The responsibility summary is:

- `schema_meta`: singleton schema version and `append_only` policy.
- `baseline_sources`: each frozen legacy DB plus immutable cutover copy `data/legacy-public-star-history.json` path, byte size, file SHA256, schema fingerprint, canonical PK-ordered logical-row count/hash, last logical key and cutover snapshot reference.
- `baseline_membership_slugs`: distinct canonical lowercase slugs ever observed in the frozen legacy membership DB. This imports identity only, not fabricated historical snapshots.
- `snapshot_runs`: integer monotonic `snapshot_seq`, unique snapshot/time, `migration_baseline|refresh`, exact parent, input source/manifest identity, non-unique core payload SHA256, and unique parent-bound chain SHA256. Only one child may reference a parent.
- `repository_profiles`: immutable profile versions for display slug, description, primary language, topics, license, archived/fork, default branch, created time, exact `field_tags_json`, `form_tags_json` and rule version. `updated_at`, `pushed_at`, colors and counts are snapshot facts. AI has no separate column and is only `field_tags_json` containing exact `ai-ml`.
- `snapshot_items`: composite profile FK; display/source ranks and gains; all three source colors plus selected color/source; stars, forks, GitHub `watchers_count`, subscribers, `open_issues_and_pull_requests`, contributors; updated/pushed time; HEAD/README/membership; release count/hash/latest id; OSS complete/empty response receipt; summary/translation provenance hashes. Require at least one source rank and unique display rank.
- `release_versions`: immutable allowlisted release metadata versions; no body/assets.
- `snapshot_release_items`: every release present in the fully paginated snapshot with zero-based contiguous ordinal and composite FK to its exact version. Repository inventory count/hash must match these ordered rows; an empty inventory is represented by count zero plus the canonical empty hash.
- `historical_star_estimates`: versioned OSS Insight date/star estimates with explicit source and first-observed snapshot, never mixed with exact GitHub observations.
- `historical_star_observations`: immutable cutover import of every legacy public observed point and every legacy exact DB row with distinct provenance; conflicting same-date values are preserved.
- `commit_events`: SHA, `first_observed_snapshot_seq`, branch, authored/committed time, nullable public author login, parent SHA array and HTML URL only. No subject/message/name/email/files/patch.
- `readme_change_events`: old/new path, immutable blob SHA and content SHA256 identities plus change kind only; no body.
- `repository_insights`: exact previous snapshot reference, `observation_gap_milliseconds`, stars delta since that observation, previous-minus-current display/source rank deltas, exact `repository-insight-v1` and canonical insight hash. Daily close, daily delta, velocity and acceleration are derived from raw snapshots rather than stored as unstable rows.
- `artifact_hashes`: public Pages allowlist only. It must reject the SQLite DB itself and the deploy manifest to avoid a self-hash cycle.

Every Git SHA/SHA256 check must prove both `value = lower(value)` and `value NOT GLOB '*[^0-9a-f]*'`; `lower(value) NOT GLOB ...` alone incorrectly accepts uppercase. Keep numeric `tag_rule_version` as `INTEGER NOT NULL` to match the canonical collector. Add exact indexes for parent traversal, slug/time history, source/display rank history, release inventories and commit first-observation order.

Create `reject_update`, `reject_delete`, and natural-key `reject_replace`/conflicting duplicate protections for every immutable table. Writers must query an existing natural key first: byte-for-byte/canonical-equivalent content is a verified no-op, different content fails, and `INSERT OR REPLACE`/`INSERT OR IGNORE` is forbidden. A rerun with the same snapshot id and all canonical hashes is a full verified no-op; the same id with any different value fails. A different snapshot id with identical visible facts still appends, and a parent can have only one child.

Include every normalized table/index/trigger statement in an exact schema fingerprint validator modeled after `record_star_observations.py`. Validator tests exercise every stored SHA constraint, valid composite parent key, manifest hash null only for verified 404+explicit bootstrap, exact UTC/KST millisecond equality, three independent source colors with no local-map source, watcher/subscriber separation, numeric canonical tags/no AI column, enrichment preimages plus `applicable|not_applicable:no_readme|not_applicable:no_prose` nullability, OSS complete/empty receipt, canonical ordered release inventory and ASCII `[]` hash, exact millisecond gap, previous-minus-current rank/null rules, `repository-insight-v1` preimage, estimate/exact-source separation, legacy conflict preservation, README kind nullability, same-key equivalence/conflict, update/delete/replace rejection, unique-parent child, artifact path exclusion and schema mutation—not merely representative README checks.

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
- Modify: `tests/update-trending.test.mjs`

**Interfaces:**
- Consumes current repository facts and the prior DB high-water marks exported as JSON.
- Produces `{ releases, latestReleaseIds, commits, heads, budgetReceipt }` with allowlisted public fields.

- [ ] **Step 1: Write pagination and field-boundary RED tests**

```js
test("release baseline follows pagination and excludes bodies and assets", async () => {
  const events = await collectRepositoryEvents([repo], { mode: "baseline", fetchImpl });
  assert.deepEqual(events.releases.map(r => r.id), [1, 2]);
  assert.equal("body" in events.releases[0], false);
  assert.equal("assets" in events.releases[0], false);
});

test("repository facts keep stars watchers and subscribers independent", async () => {
  const fact = await collectOne({ stargazers_count: 10, watchers_count: 11, subscribers_count: 12 });
  assert.deepEqual([fact.stars, fact.watchers_count, fact.subscribers], [10, 11, 12]);
});

test("all source colors survive before deterministic selection", async () => {
  const fact = await collectFromPeriods({ daily: "#111111", weekly: "#222222", monthly: "#333333" });
  assert.deepEqual([fact.language_color_daily, fact.language_color_weekly, fact.language_color_monthly], ["#111111", "#222222", "#333333"]);
  assert.equal(fact.selected_language_color_source_period, "daily");
});

test("future commits dedupe overlap and reject an unexplained head gap", async () => {
  const events = await collectRepositoryEvents([repo], { previous: { headSha: prior }, fetchImpl });
  assert.deepEqual(events.commits.map(c => c.sha), [next1, next2]);
  await assert.rejects(collectRepositoryEvents([repo], { previous: { headSha: missing }, fetchImpl: gap }), /continuity/);
});

test("a proven rewrite starts a new prospective baseline without importing fetched history", async () => {
  const events = await collectRepositoryEvents([repo], { previous: { branch: "main", headSha: prior }, fetchImpl: deepRewrite });
  assert.equal(events.heads[0].transition, "history_rewritten");
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

Follow `Link` pagination for `/repos/{slug}/releases?per_page=100` to the final page on every successful snapshot; do not stop at a high-water id because an old release can be edited. Validate every `next` URL's HTTPS origin, repository releases path, `per_page=100`, strictly increasing page and absence of unapproved query keys. Reject duplicate release ids. Page 20 with no `next` succeeds and all of its rows enter count/hash; page 20 with a valid `next` proves a 21st page would be required and fails before LLM rather than truncating. Save every visited page URL, strong ETag when present, ordered id/metadata-hash identity and `next` identity. Revalidate every page, requiring 304 for a strong ETag or a byte-equivalent canonical second body/Link identity otherwise. Add both exact page-20 RED fixtures. A page-2-only mutation with unchanged page 1 must fail. GitHub REST cannot provide a point-in-time transaction across pages, so this remains a bounded consistency check rather than an atomicity claim.

Read official `/repos/{slug}/releases/latest` and return nullable latest release id: exact 404 means no stable latest release; any non-null id/hash must occur in the complete inventory. Prerelease-only and no-release fixtures must reproduce current screen semantics. Map only `id`, `tag_name`, `name`, `target_commitish`, `draft`, `prerelease`, `created_at`, `published_at`, `html_url`; hash canonical JSON. Insert a deduplicated `release_versions` row for each distinct hash and a contiguous-ordinal `snapshot_release_items` row for every release present in every snapshot, so A→B→A remains three timed inventories that refer to two immutable versions.

- [ ] **Step 4: Implement commit collection**

Record the first observed default branch HEAD as `baseline` without past history and an identical later HEAD as `unchanged`. Later runs request `/commits` from the current HEAD/default branch with `per_page=100`, without `since`, and paginate from HEAD until the exact prior head is found; cap at 20 pages and fail rather than truncate. Store commits before that stop point, deduped by SHA, with first-observed ordinal, branch name, author/commit timestamps, public author login or null, parent SHA array, and HTML URL. Do not admit subject, message, author/committer name or email, files, patches or API response bodies into the event payload.

A changed default-branch name creates an explicit `branch_changed` prospective baseline. If the same branch no longer reaches the prior head, use only allowlisted compare/ref endpoints and exact `ahead|behind|diverged|identical` status mapping to prove a rewrite; ambiguous/404/partial evidence fails. At most two diagnostic logical requests are allowed. For a proven branch/rewrite transition, store current head, return zero `commit_events` for that repository in that run, and discard every historical commit returned while diagnosing the gap—even if up to 20 pages were fetched. The next run continues prospectively from this new head. Add backdated-fast-forward and deep-rewrite fixtures proving respectively that removal of `since` prevents omission and that rewritten history is never backfilled.

- [ ] **Step 5: Request-budget and error tests**

Constants are immutable in source: maximum 75 repositories; release 20 pages per pass; commit 20 pages; continuity diagnostics 2; logical requests 3,600; actual HTTP attempts 4,500; request timeout 30 seconds; exact event admission reserve 5 seconds; retry attempts 3 with 2s/8s delay; build timeout 120 minutes. The first executable step precedes checkout and fixes origin, internal hard deadline `origin+115m`, and event deadline `origin+15m`; enrichment is `min(event_success+70m, hard-30m)`. Every canonical-fact, OSS Insight, first/second release pass, latest-release, commit and diagnostic request consumes the logical counter; every initial request and retry consumes the attempt counter. Numeric environment/workflow override is rejected. An attempt starts only with at least 35 seconds remaining; a retry sleep starts only when its delay plus 35 seconds remains in the immutable event deadline. Cap/deadline failure aborts the complete event set before the first Anthropic fetch and never truncates or resets a clock.

Assert all caps, 75-repository worst case, hostile/cross-origin/malformed `Link`, duplicate release id, page-2-only mutation, ETag 304/body fallback, 429 bounded retry, 404 deleted repository failure, stable-latest 404/prerelease-only/no-release semantics, backdated commit retention, full release rescan, A→B→A inventories, branch/rewrite zero-history baselines, independent stars/watchers/subscribers, three source colors/selection and content-free errors. For OSS Insight pin exact HTTPS host/path/method, no query/redirect, JSON content type, ≤2 MiB body, exact envelope/row keys, integer number or canonical integer-string stargazers normalized within the JavaScript safe range, unique ascending ≤10,000 stored rows, full-response hash, complete-empty receipt, 30-second/3-attempt/2s-8s shared budget and whole-candidate failure before LLM. Explicitly reject fractional, signed, whitespace-padded, leading-zero, exponent, unsafe-range and null stargazer fixtures. Public JSON may display only the newest 500 estimates but DB recording may not use that display cap. Mutate watchers to subscribers, drop one source color, stop release collection after newest id, revalidate only page 1, restore commit `since`, import rewritten history, coerce a fractional OSS value, stale-carry an OSS terminal failure, apply the display-500 slice before DB recording, accept 10,001 OSS rows, exclude retries from the attempt counter, reset the absolute clock and move events after LLM; each owning test must fail, then restore. Run focused tests and `npm test`.

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
- Produces: `prepare_candidate_database(parent_database_path, candidate_database_path, parent_evidence, legacy_baselines) -> Path`.
- Produces: `record_core_snapshot(candidate_database_path, snapshot_payload, event_payload, readme_state) -> CoreRecordResult`.
- `CoreRecordResult`: inserted/reused core counts plus `core_payload_sha256`; its exact preimage covers schema/input identity and every nonderived baseline/profile/item/enrichment/release/estimate/legacy-exact/commit/README logical row added or referenced by the snapshot. It excludes only later `repository_insights`, `artifact_hashes`, its own hash fields and SQLite file bytes.

- [ ] **Step 1: Add first-baseline, unchanged-run and prefix RED tests**

```python
def test_first_snapshot_is_baseline_and_identical_next_run_still_appends(self):
    first = payload("2026-08-27T00:07:00Z", run_kind="migration_baseline")
    record_core_snapshot(self.database, first, events(), readme_state())
    second = payload("2026-08-27T02:07:00Z", same_repositories=True)
    record_core_snapshot(self.database, second, events(), readme_state())
    with sqlite3.connect(self.database) as connection:
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (2,))
        self.assertEqual(set(r[0] for r in connection.execute("SELECT i.membership_status FROM snapshot_items i JOIN snapshot_runs r USING(snapshot_seq) WHERE r.snapshot_id=?", (first["snapshotId"],))), {"baseline_present"})

def test_truncated_parent_database_is_rejected(self):
    evidence = parent_evidence(self.database)
    replace_with_older_copy(self.database)
    with self.assertRaisesRegex(ValueError, "parent database"):
        prepare_candidate_database(self.database, self.candidate, evidence)
```

- [ ] **Step 2: Run RED**

Run: `python -m unittest tests.test_repository_observations`

- [ ] **Step 3: Implement candidate-copy recording**

The CLI requires `--parent-database`, `--candidate-database`, `--snapshot`, `--events`, `--enrichment-index`, `--parent-evidence`, `--legacy-star-database`, `--legacy-membership-database`, `--legacy-public-star-history`, and `--readme-state`. It refuses identical parent/candidate paths, copies the last-good DB to the explicit candidate path, opens `DELETE` journal + `synchronous=FULL`, validates parent file SHA/size/last snapshot/hash chain and table-by-table canonical PK-ordered logical-row count/hash, and appends core rows inside `BEGIN IMMEDIATE`. It runs integrity/foreign-key checks, closes sidecars, then enumerates every natural key/canonical row hash from every parent table—including static baseline tables—and directly requires the same key/value in the candidate. SQLite byte/page prefixes and ambiguous per-table sequence selectors are not invariants. It does not replace any tracked file.

Only a missing parent DB accepts `run_kind="migration_baseline"` with null `parent_snapshot_id`. In that same transaction, remeasure and record all three frozen baseline sources, import distinct historical membership slugs into `baseline_membership_slugs`, import `legacy-public-star-history.observed` and every legacy exact DB row into `historical_star_observations` with source-separated row hashes, and import only the baseline file's estimated points into `historical_star_estimates`. Reject any identity or logical row that differs from the reviewed cutover receipt. This preserves real legacy data without inventing historical canonical snapshots. Every later append requires `run_kind="refresh"`, the exact last snapshot id as parent, parent sequence + 1, and unchanged baseline identities/files.

Profile versions insert only when `profile_sha256` changes. Task 1's exact schema validator rejects any AI-specific column and verifies all tags/colors/counts/provenance. For each current slug, recompute the spec §6.3.1 canonical source/content/envelope preimages from the enrichment index and validated tracked JSON before storing only those hashes in `snapshot_items`; bodies never enter SQLite. Full OSS response collection is already complete before LLM: record its exact complete/empty status, payload hash and point count, then append a present version for a new date/value change and a tombstone version for a previously present API date removed from the full response. Preserve A→B→removed→A by first-observed sequence and never merge estimates with exact GitHub observations.

README rolling state writes both `current` and `previous` identity objects, each containing nullable path/immutable blob SHA/content SHA256 plus its own observation time; it inserts `readme_change_events` on path-only, blob, content, added or removed changes and never writes original body. When a text comparison is needed, fetch the previous immutable blob to run temp, compare, then discard it; deleted/inaccessible repositories may make the old body unavailable and that limitation must be surfaced rather than silently replaced. Releases and commits use explicit existing-row equivalence checks followed by plain `INSERT`; a conflicting same key fails. Every current release must have exactly one contiguous-ordinal `snapshot_release_items` row for the snapshot, official non-null latest id must reference it, and A→B→A points back to the original deduplicated version on the third inventory.

- [ ] **Step 4: Membership transitions**

First snapshot uses `baseline_present`. For later snapshots compare to the prior successful snapshot and `baseline_membership_slugs`: absent→present is `new` only if never seen in either source, `reentered` if historically seen; present→present is `stayed`. Exits are derived as prior-present slugs absent from current, not inserted as fake snapshot items.

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
- Produces `data/membership-status.json`, `star-history.json`, insight rows, and Atom inputs from one DB snapshot plus the hash-pinned frozen legacy membership timeline.
- Produces `finalize_snapshot_derivatives(candidate_database_path, snapshot_id, insights, artifact_hashes) -> FinalizeResult`; this inserts only derived rows into the still-unpublished candidate and returns verified counts.

- [ ] **Step 1: Write deterministic derivation RED tests**

Create a temp DB with snapshots covering different millisecond fractions, a non-2h gap, same-day decrease, a KST day boundary, an exit, a legacy-seen reentry, a truly new repository, OSS Insight A→B→removed→A estimates beside exact GitHub observations, conflicting legacy exact rows, and release metadata A→B→A. Add a frozen legacy membership fixture and cutover public star-history fixture. Assert exact previous-observation stars delta plus millisecond gap, UI 2-hour semantics only at exact `7,200,000`, previous-minus-current display/source rank signs and null propagation, recomputed `repository-insight-v1` hash, provisional current-day close, finalized prior-day close only after a later KST-day success, exact-date nullable 7/30-day velocity, the exact non-overlapping acceleration formulas from spec §6.4.1, all legacy membership snapshot/member ordinals and transitions, public observed cutover precedence, estimate/exact provenance separation, three timed `snapshot_release_items` inventories, and two deduplicated `release_versions`.

- [ ] **Step 2: Run RED**

Run: `python -m unittest tests.test_repository_artifacts`

- [ ] **Step 3: Implement SQL-backed derivation**

Use ordered snapshot sequences/timestamps, never current wall clock. Store only previous-observation references/gaps and raw stars/rank deltas in `repository_insights`. Derive `(slug, stats_date_kst)` close from the last successful snapshot of that date; a date becomes `finalized` only after at least one later KST-date success and the current date remains `provisional`. A repository that exits keeps its last observed value with that semantic label—it is not fabricated as a midnight value. Define `velocity_7d=(close(D)-close(D-7))/7` and `velocity_30d=(close(D)-close(D-30))/30`; if either exact finalized date is absent, return null rather than nearest-date interpolation. Acceleration is current equal-window velocity minus the preceding equal-window velocity. Preserve cutover public observed points as the pre-cutover primary exact series, use finalized new closes afterward, keep provisional separate, and retain conflicting legacy DB rows as an auxiliary provenance series.

Generate every public JSON/Atom/page file inside the workflow temp candidate first, hash the exact Pages allowlist, then call `finalize_snapshot_derivatives` once to insert `repository_insights` and `artifact_hashes` in one transaction. The DB file itself and manifest are excluded from `artifact_hashes`; after closing the DB and proving sidecar absence, their final external SHA256/size belong only in the workflow receipt. Run expected-row-count, foreign-key, integrity, logical-row-prefix and sidecar checks again. Only after that whole candidate tree passes does the workflow copy verified files and DB into the checkout for one Git commit; no recorder function replaces tracked files directly.

- [ ] **Step 4: Switch membership and Atom readers**

Change `generate_atom_feeds.py` validation to read new membership events from `repository-observations.sqlite` and pre-cutover events/ranks from the hash-pinned frozen membership DB. The first cutover candidate must preserve the current 10 legacy `changes.xml` entry ids, order, updated/category semantics and the exact 7 snapshot/287 member identity before appending new events. Update `update-latest-feed.mjs` to consume an exported snapshot JSON rather than query legacy star rows. Both `index.html` REPOS and `data/latest.json` must losslessly carry exact numeric `tag_rule_version`, canonical `field_tags` and `form_tags`; add round-trip validators for missing/unknown/duplicate/out-of-order/version-drift values. Add `snapshotId` without dropping existing fields.

- [ ] **Step 5: Switch star-history derivation**

Import immutable `data/legacy-public-star-history.json.estimated` as present `legacy_star_history_cache` versions and its exact `observed` points plus every frozen legacy star DB row into the source-separated exact table. Every imported legacy estimate row uses the SHA256 of that exact immutable file bytes as `source_payload_sha256`, equal to the matching `baseline_sources.file_sha256`; it never hashes a per-repository subset. For each successful candidate, fetch and validate the full OSS series for every active repository before LLM; append present versions for dates new to or changed from the latest prior `ossinsight_api` version and tombstones for removed dates, retaining A→B→removed→A. Do not stale-carry a terminal failure. Public series chooses the latest API version as-of target when present, omits a latest tombstone, and falls back to legacy estimate only when no API version ever existed; exact series applies the spec's legacy-public/finalized-new precedence and never relabels an estimate as observed.

- [ ] **Step 6: Mutation and tests**

Run each mutation separately and restore it: change daily close query from last to max stars; finalize the current KST day without a later-day success; interpolate a missing D-7 close; compute acceleration from D-1 instead of non-overlapping D-7/D-14 or D-30/D-60 windows; merge an OSS Insight estimate into the observed series; drop one legacy membership snapshot or existing Atom entry; omit tag arrays from latest; overwrite a conflicting legacy exact row; replace one legacy estimate payload hash with its per-repository subset hash; collapse estimate A→B→removed→A or ignore a removed-date tombstone; drop the third A→B→A `snapshot_release_items` link; let artifact derivation publish files before `finalize_snapshot_derivatives`. The owning tests must fail respectively. Run new tests, existing membership/Atom/star suites, then `npm test`.

- [ ] **Step 7: Commit**

```powershell
git add scripts/derive_repository_artifacts.py scripts/update-latest-feed.mjs scripts/generate_atom_feeds.py scripts/update-star-history.mjs tests/test_repository_artifacts.py tests/latest-feed.test.mjs tests/test_atom_feeds.py tests/update-star-history.test.mjs
git commit -m "feat: derive public trends from exact repository snapshots"
```

### Task 5: Scan the exact staged SQLite blob without leaking values

**Files:**
- Create: `scripts/scan_repository_observations.py`
- Create: `tests/test_scan_repository_observations.py`

**Interfaces:**
- CLI: `python scripts/scan_repository_observations.py --database STAGED_COPY --expect-snapshot SNAPSHOT_ID`.
- Output: one content-free JSON receipt containing schema version, table/count totals, expected snapshot presence and hash prefixes only.

- [ ] **Step 1: Write staged-blob and nonleak RED tests**

Create fixtures for an exact valid DB, corrupt DB, forbidden schema column, forbidden logical value, private-key/PAT/Anthropic/Google-key patterns in live text, and a secret-shaped byte sequence left only in an unreferenced/freelist page. Add an integration fixture where the Git index contains the malicious DB but the worktree path is replaced by a safe DB; the gate must inspect the index version. Every failure assertion requires the secret value itself to be absent from stdout/stderr.

- [ ] **Step 2: Run RED and implement the scanner**

Run `python -m unittest tests.test_scan_repository_observations`. Reuse the Task 1 exact schema validator, enumerate schema/table/text cells without printing values, and scan the entire raw SQLite byte stream including unused pages/freelist for allowlisted ASCII and UTF-16 secret patterns. Report only fixed pattern ids, table/column when known, row count and SHA prefix. Corrupt/unreadable DB, unexpected BLOB/text/schema, expected snapshot mismatch or any secret-shaped pattern exits nonzero. Do not attempt redaction of a value after reading it into output.

- [ ] **Step 3: Prove the post-stage pre-commit boundary in an isolated Git harness**

In a temp Git repository, stage the DB, then replace the worktree copy with a safe file. Materialize the index object with `git show :data/repository-observations.sqlite` to a new temp file, invoke the scanner, and delete it in `finally` on pass or failure. Do not modify the real workflow yet. Tests prove the malicious staged blob is caught, worktree substitution cannot bypass it, and temp cleanup occurs. Task 6 owns the real workflow ordering `git add → git show :... → scanner → commit`.

- [ ] **Step 4: Mutation, full tests and commit**

Temporarily scan the worktree path instead of the staged blob and require the divergent-index fixture to fail; restore. Temporarily skip raw bytes and require the freelist fixture to fail; restore. Run focused tests and `npm test`, then:

```powershell
git add scripts/scan_repository_observations.py tests/test_scan_repository_observations.py
git commit -m "security: scan the staged observation database"
```

### Task 6: Cut the workflow over and create the validated baseline

**Files:**
- Modify: `.github/workflows/daily-refresh.yml`
- Delete: `.github/workflows/update-star-history.yml`
- Modify: `.gitignore`
- Modify: `scripts/update-trending.mjs`
- Modify: `scripts/generate-translations.mjs`
- Modify: `scripts/prepare-refresh-candidate.mjs`
- Modify: `scripts/verify-refresh-chain.mjs`
- Modify: `scripts/build-pages-artifact.mjs`
- Modify: `scripts/probe-production.mjs`
- Modify: `scripts/record_star_observations.py`
- Modify: `scripts/record_trending_membership.py`
- Modify: `tests/daily-refresh-workflow.test.mjs`
- Modify: `tests/update-trending.test.mjs`
- Modify: `tests/generate-translations.test.mjs`
- Modify: `tests/pages-publication.test.mjs`
- Modify: `tests/verify-refresh-chain.test.mjs`
- Modify: `tests/update-star-history.test.mjs`
- Modify: `tests/test_star_observations.py`
- Modify: `tests/test_trending_membership.py`
- Create: `data/legacy-observation-baseline.json`
- Create once at cutover: `data/legacy-public-star-history.json` as a canonical immutable copy of the current validated `star-history.json`.
- Generate in the workflow candidate: `data/repository-observations.sqlite`, `data/readme-state.json`, and derived public artifacts.

**Interfaces:**
- Workflow order: initialize the immutable job clock before checkout → collect Trending/canonical GitHub facts → collect and completely validate releases/prospective commits/full OSS estimate series → freeze the complete fact/event set → run approved LLM summary/translation work → prepare DB candidate → record core snapshot joined to the exact validated enrichment set → derive public artifacts from that DB snapshot + hash-bound enrichment and frozen legacy timeline → finalize insights/hashes → validate whole candidate → promote to checkout → publish/deploy/probe.

- [ ] **Step 1: Write workflow cutover RED test**

Assert Trending/canonical fact collection precedes event collection, and the complete event set precedes the first LLM request. A hostile release Link, page cap, page revalidation change, commit continuity gap, event request cap or event deadline must produce Anthropic fetch 0 and unchanged checkout bytes. A newly entered repository must receive a schema-valid detailed summary and applicable Korean README translation in the same successful run with exact source/envelope hashes joined to its snapshot item.

Then assert core recording, DB+enrichment-backed artifact derivation, derivative finalization and whole-candidate validation occur in that order. Assert `timeout-minutes:120`; the first executable step precedes checkout and freezes origin, internal hard=+115m, event=+15m, enrichment=`min(success+70m, hard-30m)` and teardown cushion=5m. Assert workflow no longer invokes `record_star_observations.py` or `record_trending_membership.py`, removes the separate `.github/workflows/update-star-history.yml` writer, moves full OSS estimate work into the pre-LLM candidate boundary, and allowed recurring staged outputs include only the new DB/readme state while Pages excludes every SQLite, readme state and baseline receipt. Add failure fixtures for late checkout, clock reset, before LLM completion and between core recording/finalization; tracked checkout bytes remain unchanged.

- [ ] **Step 2: Run RED**

Run: `node --test tests/daily-refresh-workflow.test.mjs`

- [ ] **Step 3: Update candidate workflow**

Split fact collection from page rendering. `update-trending.mjs --facts-out "$RUNNER_TEMP/canonical-refresh-facts-v1.json"` emits a private version-1 payload bound to `snapshotId`, source SHA, active-set SHA256 and each repository's canonical fact/README identity; original README bodies may exist only in this runner-temp file. `collect-repository-events.mjs --facts ... --events-out "$RUNNER_TEMP/canonical-repository-events-v1.json"` writes the allowlisted inventories and budget receipt, bound to the facts hash, snapshot and a complete-set SHA256. Re-read and validate that exact event hash immediately before the first LLM fetch and immediately before DB recording. `generate-translations.mjs --facts ... --events ... --enrichment-index-out "$RUNNER_TEMP/enrichment-index-v1.json"` consumes that exact active set rather than `index.html`; any immutable blob re-fetch must match recorded path/blob/content hashes. It may write only temp enrichment outputs. Final HTML/JSON/feeds render only after DB core recording from the exact snapshot plus hash-bound enrichment index.

Add parent evidence export from production manifest/source SHA, candidate DB append, derivation, schema fingerprint, logical-row/hash-chain, sidecar, artifact hash and cross-count validation. When production has no repository DB, require `migration_baseline` and import `data/legacy-observation-baseline.json`. Immediately before the cutover commit, validate current `star-history.json` and copy its exact canonical public payload once to immutable `data/legacy-public-star-history.json`; then create the reviewed receipt from both canonical legacy DBs plus that immutable file with path, byte size, file SHA256, schema/JSON-schema fingerprint, PK/natural-key ordered logical row count/hash and last key. Tests pin all three identities and the public observed/estimated semantic rows. The mutable `star-history.json` is never a baseline source after this copy. Remove both legacy DBs and the immutable baseline file from candidate mutable/generated/bot allowlists; only the cutover implementation commit may stage the newly created baseline file. Existing legacy writers must fail closed when their output resolves to either canonical DB path while continuing to allow explicit temp fixture DBs. Add `repository-observations.sqlite-{journal,shm,wal}` and exact legacy sidecars to `.gitignore`. Any later missing/new/changed frozen identity is history loss and fails.

Extend recurring candidate mutable/staged allowlists only for `data/repository-observations.sqlite` and `data/readme-state.json`; `verify-refresh-chain.mjs` bot-generated paths add those two and remove both legacy DBs and the immutable legacy-public file. Do not extend the Pages allowlist. `artifact_hashes` path set must equal the Pages builder allowlist exactly, with every byte hash equal, while DB, readme state, baseline receipt and deploy manifest remain excluded. Rebuilding the recovery artifact from its source commit must reproduce the same equality. Run Task 5's staged-index scanner after `git add` and before commit; scanner failure blocks the commit.

Add a repository-variable schedule hold before activation: scheduled publication may enter the build only when `vars.GH_TRENDING_REFRESH_SCHEDULE == 'enabled'`; absence, `hold`, or any other value skips before RunContext, GitHub API, OSS Insight and Anthropic work. `workflow_dispatch` does not accept an override and uses its separate bootstrap identity gate. Tests require a held schedule to make zero external fetches/commits while manual remains testable. Final acceptance sets `hold` and verifies it before activation, then changes it to `enabled` only after the one manual run, browser/security/OFA evidence and clean readback complete. A crash/failure leaves it held and is reported.

For version 1, a successful run must create exactly one generated child commit containing a new snapshot; the old staged-diff-quiet reuse of the original SHA is a failure. `verify-refresh-chain.mjs` must reject a version-1 receipt whose source is the run head instead of the unique generated child. Version-0 recovery remains a separate documented case.

- [ ] **Step 4: Create a local fixture baseline and test it**

Use the verified Plan 1 manifest and captured current public facts/events/enrichment without network in an untracked temp directory to rehearse a `migration_baseline` followed by one distinct `refresh` snapshot. Remeasure all three frozen sources before/after; assert receipt byte/schema/logical identities, legacy membership 7 snapshots/287 members and current 10 Atom entries preserved, then-current legacy public observed/estimated rows preserved one-for-one (the 2026-08-28 review fixture is 168/643), every 325 legacy exact DB row retained with its 301 unique slug/date/stars tuples, conflicting legacy exact rows retained, first current items `baseline_present`, later stayed/new/reentered/exits, exact parent+1/unique-child chain, same visible facts still append, historically seen-but-currently-absent slugs only in baseline membership identity, README original bodies absent from SQLite/tracked JSON, estimate A→B→A/exact source separation, enrichment preimage joins, numeric tag round-trip, and release/commit restricted fields absent. Cutover tests derive the exact counts from the just-frozen files so a verified bot-only advance is not misclassified as loss. Delete temp DB/state. This two-snapshot rehearsal—not a second paid dispatch—proves the later refresh append contract.

- [ ] **Step 5: Full tests and mutation**

Run `npm test`. Mutate one item at a time and restore: put LLM before event validation; alter the frozen event file after its first hash check; let `generate-translations` rediscover active slugs from `index.html`; substitute subscribers for watchers; omit a source color/tag/enrichment hash; use a local-map color; stale-carry an OSS error; alter/drop a frozen source or legacy Atom entry; leave a legacy DB/baseline in a mutable/bot allowlist; let a legacy writer target the canonical path; bypass the staged scanner; let Pages and `artifact_hashes` differ by one path/hash; let held schedule enter RunContext; accept version-1 no generated diff; copy core-recorded candidate bytes before derivative finalization. Every owning test must fail, then rerun `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add .github/workflows/daily-refresh.yml .gitignore data/legacy-observation-baseline.json data/legacy-public-star-history.json scripts/update-trending.mjs scripts/generate-translations.mjs scripts/prepare-refresh-candidate.mjs scripts/verify-refresh-chain.mjs scripts/build-pages-artifact.mjs scripts/probe-production.mjs scripts/record_star_observations.py scripts/record_trending_membership.py tests/daily-refresh-workflow.test.mjs tests/update-trending.test.mjs tests/generate-translations.test.mjs tests/pages-publication.test.mjs tests/verify-refresh-chain.test.mjs tests/update-star-history.test.mjs tests/test_star_observations.py tests/test_trending_membership.py
git add -u .github/workflows/update-star-history.yml
git commit -m "feat: publish exact repository observation history"
```

- [ ] **Step 7: Push the implementation while dispatch remains disabled**

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
if ((Select-String -LiteralPath '.github/workflows/daily-refresh.yml' -SimpleMatch 'bootstrap_v0_pending_approval').Count -ne 1) { throw 'Workflow is not still pending approval' }
if ((Select-String -LiteralPath '.github/workflows/daily-refresh.yml' -SimpleMatch 'bootstrap_v0_approved').Count -ne 0) { throw 'Workflow was activated too early' }
```

Review the displayed pre-push log/diff and stop unless remote movement is either absent or a separately verified bot-only fast-forward. Do not dispatch, activate `bootstrap_v0_approved`, spend LLM budget, create a production baseline, or claim production verification in Plan 2. The implementation push is safe only while the workflow remains fail-closed at its pending gate.

- [ ] **Step 8: Gate entry to UI work on local and remote implementation evidence**

Plan 3 may start after the offline two-snapshot rehearsal, schema/derivation/workflow mutations, full suite, staged SQLite scan, push readback and exact pending-gate assertions all agree. The single final acceptance dispatch after Plans 3–5, auth, security and whole-system local verification needs to prove one production `migration_baseline` only. The next natural schedule may later create the first production `refresh`; it is not fabricated, manually dispatched, or required for this completion because the exact refresh contract is already proven by the offline two-snapshot rehearsal. A failure in the one paid dispatch does not authorize an automatic second dispatch.
