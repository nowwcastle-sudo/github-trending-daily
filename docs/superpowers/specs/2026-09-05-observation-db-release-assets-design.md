# Observation Database Out of Git: Release Assets + Pointer Design

**Date:** 2026-09-05 (rev. 2 after adversarial review)
**Status:** Approved for implementation under the user's blanket approval of 2026-09-05 (swe-cycle S3, size complex). Review record: `.swe-cycle/state.json` evidence; red-team report in the session scratchpad (`design-review/redteam-design.md`), verdict REJECT on rev. 1, all 15 required changes applied here.
**Scope:** Where `data/repository-observations.sqlite` lives between refreshes, how every consumer resolves it, how the transition happens, and what stays untouched.
**Related:** `docs/superpowers/specs/2026-09-03-per-repo-summary-admission-and-star-ticks-design.md` (snapshot contract), `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md` ("final DB SHA256/size are recorded only in the external workflow receipt, never inside the DB" — the pointer is a second external receipt describing the same bytes), `.swe-cycle/intake.md`, `.swe-cycle/problem.md`.

## 1. Problem

The observation database is committed on every W1 publish. Measured on main:

| commit | date (UTC) | bytes |
|---|---|---|
| 135528a | 2026-09-01 | 2,441,216 |
| af5ff84 | 2026-09-03 | 3,796,992 |
| e524fe6 | 2026-09-04 18:26 | 7,757,824 |
| 6f6fd1d | 2026-09-05 02:46 | 8,527,872 |

Steady growth is about 0.77 MB per refresh at four refreshes a day (about 3 MB/day). GitHub warns at 50 MiB per file and rejects a push containing a file over 100 MiB. At the current rate the warning arrives in roughly two weeks and the block in roughly a month; a hot repository's commit backlog can bring it forward (hermes-agent added 3.96 MB in a single run). Each publish also adds the whole blob to history.

## 2. Goal and non-goals

**Goal.** Each refresh stores the resulting database as an immutable GitHub Release asset and commits only a small, hash-verified pointer. Every consumer that today reads the blob from git resolves it through the pointer instead, with the same fail-closed guarantees. No new vendor, no new credential, and no widening of where the Actions token is exposed: only the publish job's promote step talks to the Releases API.

**Non-goals.**
- Rewriting history to purge blobs already committed (needs force-push; forbidden for this repository).
- Changing the SQLite schema, `record_repository_observations.py`, `derive_repository_artifacts.py`, or the Pages artifact contract (`VERSION_1_BASE_PATHS`, `artifact_hashes`). The database was never a Pages artifact and stays out of Pages. **The pointer path is never added to `VERSION_1_BASE_PATHS` or `artifact_hashes` either; it is a repository file, not a Pages artifact.**
- Slowing the database's own growth (row retention). Separate decision; see §10.
- Git LFS (1 GiB/month free bandwidth is exhausted within days at eight transfers a day) and third-party object storage (second credential and vendor for no additional benefit).
- Compression. Rev. 1 proposed gzip; it added a second hash and a determinism caveat (zlib output differs across Node builds) for an 8.5 MB file that GitHub already serves from a CDN. Raw `.sqlite` assets keep one identity (the raw sha256) everywhere.

## 3. Current data flow (what changes)

| site | today | after |
|---|---|---|
| W1 prepare, production-state probe (`daily-refresh.yml:144`) | `probe-production.mjs --source-sha $HYDRATION_SOURCE_SHA` with no `--artifact-contract` → `artifactContractFromGit` → `git show <sha>:data/repository-observations.sqlite` (`probe-production.mjs:35`) | `artifactContractFromGit` calls the store's `resolve` for that SHA (§6.3) |
| W1 prepare, parent capture (`:186-190`) | `git cat-file blob $HYDRATION_SOURCE_SHA:data/repository-observations.sqlite` | `resolve --source-sha $HYDRATION_SOURCE_SHA --expect-snapshot-id $PARENT_SNAPSHOT_ID --out $PARENT_DATABASE` |
| W1 prepare, existence checks (`:111`, `:136`) | blob exists at source SHA | `resolve --source-sha <sha> --check` (pointer xor blob, §7) |
| W1 recovery build (`:156-164`) | `git archive` includes the blob | `git archive`, then `resolve` writes `$RECOVERY_SOURCE/data/repository-observations.sqlite` (transition: the archive already contains the blob; `resolve` refuses to overwrite, so the step deletes the archived blob first when it exists) |
| W1 publish, promote (`:488`, `:506`, `:511-514`) | copy DB into checkout, `git add`, scan the staged blob | scan the candidate DB file, upload asset, write pointer, `git add` pointer; DB never enters the index (§6.2) |
| W1 publish, committed-artifact probe (`:549-552`) | `git archive $SOURCE_SHA` includes the blob | `git archive`, then `resolve --source-sha $SOURCE_SHA` into `$PAGES_SOURCE/data/`, then `cmp` against the candidate DB |
| W1 verify job (`:603`) | `export-contract --database data/repository-observations.sqlite` from the `main` checkout | "Resolve observation database" step writes `$RUNNER_TEMP/repository-observations.sqlite`; `export-contract` reads it |
| W1 recovery job probe (`:647`) | probe without contract → `artifactContractFromGit` | same path as `:144`; transition fallback applies because `RECOVERY_SOURCE_SHA` may predate the pointer |
| W2 `star-ticks.yml:62,138` | `[ -f data/repository-observations.sqlite ]` in the checkout | "Resolve observation database" step (`resolve --source-sha "$(git rev-parse HEAD)"`), `export-contract` reads `$RUNNER_TEMP/repository-observations.sqlite` |
| `deploy-current-pages.yml:46-49` | same as W2 | same as W2; the v0 branch stays for "neither pointer nor blob" |
| enrich job (self-hosted, `:315`) | reads `frozen-parent-input/repository-observations.sqlite` from the workflow artifact | unchanged |
| `scripts/generate_atom_feeds.py:39` | `DEFAULT_DATABASE` under `data/` when `--database` is omitted | unchanged; every workflow passes `--database`. Local runs without it fail with "database unavailable", documented in README |

## 4. Storage layout

### 4.1 Release per UTC month, asset per snapshot

- Release tag `observation-db-YYYY-MM` (for example `observation-db-2026-09`), created on first use in that month by the publish step: `gh release create <tag> --target <ORIGINAL_SHA> --prerelease --latest=false --title "Observation database snapshots YYYY-MM" --notes "<fixed paragraph>"`. If the release already exists (HTTP 422 `already_exists`), proceed. The tag's target commit is informational only; no consumer reads it. Tag pushes trigger no workflow (`tests.yml` and `codeql.yml` filter on `branches: [main]`). The month is the first six digits of `SNAPSHOT_ID` (UTC).
- Asset name `repository-observations-<snapshotId>.sqlite`. `snapshotId` has the form `YYYYMMDDhhmmss-<16 hex>`, is unique per refresh (derived from `REFRESH_ORIGIN_EPOCH_MS`, `run-context.mjs`), so the name is immutable and sortable.
- Content: the raw candidate database, uncompressed.
- Anonymous download URL used by every consumer: `https://github.com/nowwcastle-sudo/github-trending-daily/releases/download/<tag>/<name>` (302 to `objects.githubusercontent.com`). No listing call is needed to fetch, so REST pagination of assets (30 per page) never matters for reads.

Why monthly: per-snapshot releases need one tag per refresh (about 120 tags a month); a single rolling release accumulates thousands of assets. Twelve tags a year with about 120 assets each is browsable and easy to prune later. Fetch does not depend on listing, so a month with more than 100 assets is safe.

### 4.2 Pointer file (tracked)

`data/observation-db.pointer.json`, written by `publish`, committed in the same commit as `data/latest.json`. Synthetic example:

```json
{
  "version": 1,
  "snapshotId": "20260905024612-0123456789abcdef",
  "database": { "sha256": "<64 hex of the raw .sqlite>", "byteSize": 8527872 },
  "asset": { "releaseTag": "observation-db-2026-09", "name": "repository-observations-20260905024612-0123456789abcdef.sqlite" }
}
```

Rules: exact key set (`parseJsonStrict` + `exactKeys`, as the other JSON contracts do); `snapshotId` matches `^[0-9]{14}-[a-f0-9]{16}$`; `asset.name` must equal `repository-observations-<snapshotId>.sqlite` and `asset.releaseTag` must equal `observation-db-<YYYY-MM of snapshotId>` (both derived, both re-checked on read); `database.sha256` is the identity of the snapshot and must equal the full digest the scan receipt reports for the file that was uploaded (§6.2). `publish` refuses to write a pointer whose `snapshotId` differs from `data/latest.json` in the candidate. No `producedAt`: `latest.json.generatedAt` is authoritative.

### 4.3 Immutability

An asset name is never overwritten and `--clobber` is never used. `publish` attempts `gh release upload <tag> <file>`; if the upload fails, it downloads the anonymous URL for that name: if the bytes hash to the local raw sha256 the run is an idempotent re-run and continues; otherwise it fails. Identity is the raw sha256 in all comparisons.

## 5. Component: `scripts/observation-db-store.mjs`

Two subcommands in steady state (`resolve`, `publish`); `resolve` carries the transition fallback that the follow-up PR deletes (§7). No third-party dependencies.

| subcommand | inputs | behaviour | exit |
|---|---|---|---|
| `resolve --source-sha <sha> --out <file> [--expect-snapshot-id <id>] [--git-root <dir>] [--check]` | a commit SHA in the local clone | reads `git show <sha>:data/observation-db.pointer.json` and `git cat-file -e <sha>:data/repository-observations.sqlite`. Pointer only → validate pointer (§4.2), `--expect-snapshot-id` equality when given, anonymous HTTPS download (Node `fetch`, redirects followed only to `github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com`, body bounded by `database.byteSize`, streamed to a temp file in the target directory, bounded retries on 408/425/429/5xx and network errors), verify sha256 and byte size, rename into `--out` with `O_EXCL`, mode 0444. Blob only (transition) → `git cat-file blob` to the same destination. Both or neither → fail. `--check` performs only the pointer-xor-blob test and pointer validation, writes nothing. | 0 on success; non-zero on any mismatch, missing asset, ambiguity, or deadline |
| `publish --database <file> --snapshot-id <id> --target-sha <sha> --latest <candidate latest.json> --scan-receipt <file> --pointer-out <file>` | candidate DB | re-validates `snapshotId` (`^[0-9]{14}-[a-f0-9]{16}$`) and derives tag and name; hashes the file and refuses if the hash differs from the receipt's `databaseSha256` or `latest.json.snapshotId` differs from `--snapshot-id`; ensures the release exists (§4.1); uploads (§4.3); confirms by anonymous download that the served bytes hash to the raw sha256; writes the pointer atomically | non-zero if the asset cannot be confirmed |

Constants: `OWNER_REPO = "nowwcastle-sudo/github-trending-daily"` next to the production base URL; `RETRY_DELAYS_MS = [2000, 8000, 20000]`; `RESOLVE_DEADLINE_MS = 600000`; max pointer size 4 KiB; max asset size 2 GiB (GitHub's limit; `publish` refuses beyond it, see §10). Only `publish` shells out to `gh`, always through `execFileSync` with argument arrays; it is the only place that needs `GH_TOKEN`, and only the promote step exports it. `resolve` never overwrites: callers choose a fresh path (on W2 and deploy the step deletes any stale `$RUNNER_TEMP/repository-observations.sqlite` first because `$RUNNER_TEMP` is shared across steps in a job). Nothing in the store prints token values; `gh` stderr is passed through only after a regex scrub for the known token shapes.

Tests (`tests/observation-db-store.test.mjs`): fake `gh` selected by `GH_SCRIPT` (same pattern as `GIT_SCRIPT`), fake HTTP served by a local `http.createServer` with the download base URL overridden by `OBSERVATION_DB_DOWNLOAD_BASE_URL` (test-only override, refused when `GITHUB_ACTIONS=true`), fake git via `GIT_SCRIPT`: pointer-only success; blob-only transition success; both present → fail; neither → fail; sha256 mismatch; size mismatch; 404; 503 then success (retry); redirect to a non-allowlisted host → fail; oversize body → fail; `--expect-snapshot-id` mismatch → fail; `publish` upload success; upload failure with equal served hash → idempotent success; upload failure with different served hash → fail; release missing → created; receipt hash mismatch → refuse before upload; `latest.json` snapshot mismatch → refuse; pointer output exact key set.

## 6. Workflow changes

### 6.1 W1 prepare
- Existence checks (`:111`, `:136`): `node scripts/observation-db-store.mjs resolve --source-sha "$HYDRATION_SOURCE_SHA" --check`.
- Parent capture (`:186-190`): `resolve --source-sha "$HYDRATION_SOURCE_SHA" --expect-snapshot-id "$PARENT_SNAPSHOT_ID" --out "$PARENT_DATABASE"`. `chmod 0444` and the sealed `0555` directory stay. After `export-parent-inputs`, the step asserts `pointer.database.sha256 == parent-evidence.parent_database.file_sha256` whenever a pointer exists at that SHA (a small `node -e` comparison), so the pointer and the parent-evidence chain describe the same bytes. The chain itself stays anchored by `PARENT_SNAPSHOT_ID` from the production manifest (`export_parent_inputs`, `derive_repository_artifacts.py:639`); it does not read the pointer.
- Recovery artifact (`:156-164`): after `git archive`, `rm -f "$RECOVERY_SOURCE/data/repository-observations.sqlite"` (transition archives contain it), then `resolve --source-sha "$HYDRATION_SOURCE_SHA" --expect-snapshot-id "$PARENT_SNAPSHOT_ID" --out "$RECOVERY_SOURCE/data/repository-observations.sqlite"`, then `export-contract` as today.
- `prepare-refresh-candidate.mjs`: `MUTABLE_GENERATED_PATHS` (tree paths reinstated from `lastGoodSha`) gains `data/observation-db.pointer.json` and loses `data/repository-observations.sqlite`. The set accepted by `approvedGeneratedFile` / `verifyCandidateMutations` **keeps** `data/repository-observations.sqlite`, because the recorder still writes it into the candidate; a new constant `CANDIDATE_ONLY_GENERATED_PATHS = ["data/repository-observations.sqlite"]` is unioned into that set. Unit test: baseline without the sqlite, candidate with it, `--verify-generated` passes; baseline with it (transition), candidate with a different one, passes. The `rm -f` of any reinstated sqlite at `:174` and `:404` stays.

### 6.2 W1 publish, promote step — order
Only the network push can leave an orphan asset; every other check precedes the upload.
1. `scan_repository_observations.py --database "$CANDIDATE/data/repository-observations.sqlite" --expect-snapshot "$SNAPSHOT_ID" --receipt-out "$RUNNER_TEMP/scan-receipt.json"`; the receipt gains a full `databaseSha256` field next to the existing `databaseSha256Prefix` (receipt only, schema untouched).
2. Copy text outputs into the checkout as today, without the DB. Transition only: `git rm --cached --quiet data/repository-observations.sqlite` when `git ls-files --error-unmatch` succeeds, and delete the working-tree file.
3. Allowed-paths `case` list: the sqlite entry becomes the pointer entry. `changed_paths` is computed after step 6 writes the pointer (so the list is computed once, after all writes); `git ls-files --others --exclude-standard` hides an ignored stray sqlite copy, which is acceptable because `git add` is an explicit list.
4. `git fetch origin main` and the `origin/main advanced` check move here, before the upload.
5. `publish --database "$CANDIDATE/data/repository-observations.sqlite" --snapshot-id "$SNAPSHOT_ID" --target-sha "$ORIGINAL_SHA" --latest "$CANDIDATE/data/latest.json" --scan-receipt "$RUNNER_TEMP/scan-receipt.json" --pointer-out data/observation-db.pointer.json` with `GH_TOKEN` exported for this step only.
6. Allowed-paths check, `git add -- <text outputs> data/observation-db.pointer.json`, staged text secret scan (pointer included), `git diff --cached --check`, commit, ancestry checks, re-check `origin/main`, push — as today.
7. Snapshot ids never repeat across runs (they derive from `REFRESH_ORIGIN_EPOCH_MS`); the only same-id republish is a re-run of the failed `publish` job, which rebuilds the DB from frozen inputs and fails closed if the rebuilt raw sha256 differs from the existing asset. Recovery from that state is a new dispatch. A unit test records the same frozen inputs twice and compares sha256 to document whether the recorder is byte-deterministic; if it is not, §8 says so.
8. Committed-artifact probe (`:549-552`): after `git archive`, `resolve --source-sha "$SOURCE_SHA" --expect-snapshot-id "$SNAPSHOT_ID" --out "$PAGES_SOURCE/data/repository-observations.sqlite"`, then `cmp` against `$CANDIDATE/data/repository-observations.sqlite` (byte identity with the scanned file, end to end), then `export-contract` and the probe as today.
9. New step after the push, `Upload published observation database copy`: `actions/upload-artifact` of `$CANDIDATE/data/repository-observations.sqlite` as `observation-db-<run_id>` with `retention-days: 30`. Second copy of the newly published snapshot (§8).

### 6.3 `probe-production.mjs`
`artifactContractFromGit`: replaces `gitBytes(sourceSha, "data/repository-observations.sqlite")` with a spawn of `observation-db-store.mjs resolve --source-sha <sha> --expect-snapshot-id <snapshotId> --out <temp>`, honouring the same deadline. The spawn target is injectable through `OBSERVATION_DB_RESOLVER_SCRIPT` (mirrors `GIT_SCRIPT`) so tests never touch the network. The operator's local probe now needs network access to github.com when no `--artifact-contract` is given; it needs no `gh` and no token. Tests that pin the old shape and must be rewritten: `tests/verify-refresh-chain.test.mjs:74,305-313`, `tests/daily-refresh-workflow.test.mjs:95-97,156-190,311`, `tests/star-ticks-workflow.test.mjs:68,80`, `tests/deploy-current-pages-workflow.test.mjs:15,17`.

Shipped-file list (added 2026-09-06 after W1 run 33993892427): `verifyVersion1Payload` reads `scripts/build-pages-artifact.mjs` at `manifest.sourceSha` through `gitBytes` and parses `VERSION_1_BASE_PATHS` from it (`parseVersion1BasePaths`, strict literal shape, fail-closed), so a deployment is judged against the list of the commit that built it, never against the checkout running the probe. Without this, the first release that adds or removes a shipped file makes intact production look broken and the refresh cannot start.

### 6.4 W1 verify job, W2, `deploy-current-pages.yml`
Each gains one step, `Resolve observation database`, before its `export-contract`: `rm -f "$RUNNER_TEMP/repository-observations.sqlite"; node scripts/observation-db-store.mjs resolve --source-sha "$(git rev-parse HEAD)" --expect-snapshot-id "$SNAPSHOT_ID" --out "$RUNNER_TEMP/repository-observations.sqlite"`, and `export-contract --database` points at that path (`read_finalized_artifact_contract` has no layout requirement). `deploy-current-pages.yml` keeps its v0 branch when `resolve --check` reports neither pointer nor blob. No step other than the promote step exports `GH_TOKEN`; a workflow-shape test asserts this.

### 6.5 W1 recovery job
The probe at `:647` runs without a contract and therefore resolves through `artifactContractFromGit` (§6.3). During the transition `RECOVERY_SOURCE_SHA` may predate the pointer; `resolve` handles it.

The version-1 recovery artifact in W1 prepare is rebuilt from the production commit's tree by that commit's own builder (`node "$RECOVERY_SOURCE/scripts/build-pages-artifact.mjs"`), for the same reason: this checkout's builder carries this checkout's shipped-file list.

### 6.6 `verify-refresh-chain.mjs`
`approvedGeneratedCommitPath`: add `data/observation-db.pointer.json`; keep `data/repository-observations.sqlite` accepted during the transition because the transition commit deletes it (diff-tree name lists do not distinguish add from delete). The follow-up PR removes the sqlite name.

### 6.7 `.gitignore`
Add `data/repository-observations.sqlite`. It has no effect while the file is tracked; after the transition commit it prevents re-adding from a local run.

## 7. Transition (no manual migration, no schedule pause)

The code PR merges while main still tracks the blob and has no pointer. The first W1 run after the merge: prepare resolves the blob at `HYDRATION_SOURCE_SHA` (pointer absent, blob present); publish uploads the first asset, writes the first pointer, removes the blob from the index, commits and pushes; verify resolves the pointer at the new main. Every later run finds the pointer.

Orderings examined (W1 and W2 share the `daily-refresh` concurrency group, so they never overlap; `deploy-current-pages.yml` can run at any time):

| case | behaviour |
|---|---|
| merge → W2 or deploy-current-pages → first W1 | blob path via `resolve`; ledger commits do not touch the DB |
| first W1 publish uploads, then fails before push | orphan asset, main unchanged; next run has a new snapshot id |
| push succeeds, run fails before deploy | main = pointer commit, production still names the blob commit; next W1 resolves the blob for the parent, `git rm --cached` is skipped (guarded by `git ls-files --error-unmatch`) |
| deploy OK, verify fails → recovery redeploys the previous artifact | production stays on the blob commit; later runs keep using the fallback until a clean deploy |
| pointer and blob both present at one SHA | impossible from the workflow (rm + add in one commit); a hand edit → `resolve` fails closed |
| deploy-current-pages during W1 publish | redeploys the same content through the `pages` group; harmless |

"Clean run" means the deployed manifest's `sourceSha` is a pointer commit, not merely a green workflow. After two clean runs a follow-up PR deletes the blob branch of `resolve`, the transition `git rm --cached`, and the sqlite name in `approvedGeneratedCommitPath` (same pattern as the probe-tolerance removal).

Pre-flight before merging (lesson from W1 runs 1–3: exercise the whole stage, not one error): (a) local, with the operator's PAT: the full store test suite plus a real `publish` + `resolve` round trip against a throwaway tag `observation-db-test-<date>`, deleted afterwards with `gh release delete <tag> --cleanup-tag --yes`; (b) a dispatch-only workflow `observation-db-preflight.yml` (`contents: write`, single job) that runs the same round trip with the Actions `GITHUB_TOKEN` and deletes its test release, because only that proves the token can create a release and upload an asset under the repository's policies. The workflow stays in the repository as the runbook for re-uploading a lost asset (§8).

## 8. Failure modes and behaviour

| failure | behaviour | recovery |
|---|---|---|
| asset missing (404), release or tag deleted by a human or a `contents: write` token | `resolve` fails; the run stops before enrichment (or verify fails and recovery redeploys the previous artifact) | re-upload from the second copy: the `observation-db-<run_id>` workflow artifact (30-day retention) of the run that published it, or the `refresh-input-<run_id>` artifact (1-day retention, holds the **parent** DB only), or the operator's local clone of the candidate if kept. Run `observation-db-preflight.yml` in restore mode with the file and the original snapshot id; the pointer already names the expected hash, so the re-upload is verified |
| sha256 or size mismatch, redirect to an unexpected host, oversize body | fail-closed | investigate; never edit the pointer by hand |
| upload succeeds, push fails | no pointer commit; orphan asset | harmless; next run uploads its own snapshot |
| `publish` job re-run rebuilds a different DB for the same snapshot id | fail-closed at the immutability check | new dispatch |
| transient 5xx/429 on download | three bounded retries, then fail | re-run the workflow |
| rate limits | `resolve` makes no API call (anonymous CDN download); `publish` makes about four API calls against the 1,000/hour `GITHUB_TOKEN` budget | — |
| asset reaches 2 GiB | `publish` refuses before upload | §10 retention must land long before this |

## 9. Testing and verification plan

- Unit: store script (§5 list). Pointer parsing rejects extra keys, wrong snapshot format, non-hex hashes, non-integer sizes, derived-field mismatches.
- `prepare-refresh-candidate.mjs`: the two `--verify-generated` cases from §6.1.
- Workflow-shape tests: every `export-contract --database` in the three workflows is preceded in the same job by a `resolve` step writing that exact path (assert per occurrence, including `daily-refresh.yml:603`); the sqlite path is absent from `git add`; `git rm --cached` appears once, guarded; no step other than the promote step exports `GH_TOKEN`; the promote ordering scan → copy → fetch/advance check → publish → add → scan → check → commit → push; the second-copy upload step exists with `retention-days: 30`; `resolve` in W2 and deploy passes `--expect-snapshot-id`.
- `verify-refresh-chain.test.mjs`: diff-tree lists with the sqlite (transition) and with the pointer both pass; fake git learns `show <sha>:data/observation-db.pointer.json`; probe resolver stubbed via `OBSERVATION_DB_RESOLVER_SCRIPT`.
- Recorder determinism test (§6.2 step 7).
- Pre-flight (§7 a and b).
- Production verification (S6/S7): first W1 run green; `git ls-files data/repository-observations.sqlite` empty on main; `gh release view observation-db-2026-09 --json assets` lists one asset per successful publish since the tag was created and the newest matches the pointer; W2 tick green; `git count-objects -vH` after two refreshes shows pack growth in KB.

## 10. Decisions deferred with re-open conditions

- **Asset retention / pruning:** not automated in v1. Re-open when the monthly release's total asset size passes 5 GB. Candidate policy: keep the last 28 snapshots plus the first of each month.
- **Database row retention:** at about 3 MB/day the raw file reaches 1 GB in roughly a year and every run moves it twice. Re-open when the raw DB passes 200 MB or a resolve step exceeds two minutes. This is the real long-term ceiling; release assets remove only the git ceiling.
- **Operator local mirror of assets:** not required in v1 (the 30-day workflow artifact is the second copy). Re-open the first time an asset is unavailable.
- **History purge of already-committed blobs:** not planned; would require force-push.

## 11. Rollout checklist (S7)

1. Merge the PR (tests green; independent review of the store script's argument handling and redirect allowlist).
2. Run `observation-db-preflight.yml` once by dispatch; confirm it creates, uploads, resolves and deletes its test release.
3. Watch the next W1 (KST 00/06/12/18, minute 07) or dispatch it: verify job green, deployed manifest `sourceSha` is the pointer commit.
4. Confirm: pointer tracked, blob untracked, release asset present, second-copy artifact present, W2 tick green.
5. After two clean runs: follow-up PR removing the transition fallback (§7).
6. README: leave the paragraph about the star-tick ledgers (`README.md:127`) as is; add a paragraph describing the pointer, the release location, and that the DB is not in the checkout.
7. Decision record in the vault (`47_의사결정기록/`): chosen, rejected (LFS, R2/B2, local-only, gzip), why, re-open conditions from §10.
