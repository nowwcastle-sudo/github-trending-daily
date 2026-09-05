# Observation Database Out of Git: Release Assets + Pointer Design

**Date:** 2026-09-05
**Status:** Draft — awaiting user approval (swe-cycle S3, size complex)
**Scope:** Where `data/repository-observations.sqlite` lives between refreshes, how every consumer resolves it, how the transition happens, and what stays untouched.
**Related:** `docs/superpowers/specs/2026-09-03-per-repo-summary-admission-and-star-ticks-design.md` (snapshot contract), `.swe-cycle/intake.md`, `.swe-cycle/problem.md`.

## 1. Problem

The observation database is committed on every W1 publish. Measured on main:

| commit | date (UTC) | bytes |
|---|---|---|
| 135528a | 2026-09-01 | 2,441,216 |
| af5ff84 | 2026-09-03 | 3,796,992 |
| e524fe6 | 2026-09-04 18:26 | 7,757,824 |
| 6f6fd1d | 2026-09-05 02:46 | 8,527,872 |

Steady growth is about 0.77 MB per refresh at four refreshes a day (about 3 MB/day). GitHub warns at 50 MiB per file and rejects a push containing a file over 100 MiB. At the current rate the warning arrives in roughly two weeks and the block in roughly a month; a hot repository's commit backlog can bring it forward (hermes-agent added 3.96 MB in a single run). Each publish also adds the whole blob to history, so the pack grows by the same amount per refresh.

## 2. Goal and non-goals

**Goal.** Each refresh stores the resulting database as an immutable GitHub Release asset and commits only a small, hash-verified pointer. Every consumer that today reads the blob from git reads it through the pointer instead, with the same fail-closed guarantees. No new vendor, no new credential: the workflows already hold `GITHUB_TOKEN` with `contents: write` in the publish job.

**Non-goals.**
- Rewriting history to purge blobs already committed (needs force-push; forbidden for this repository).
- Changing the SQLite schema, `record_repository_observations.py`, `derive_repository_artifacts.py`, or the Pages artifact contract (`VERSION_1_BASE_PATHS`, `artifact_hashes`). The database was never a Pages artifact and stays out of Pages.
- Slowing the database's own growth (row retention). That is a separate decision; see §10.
- Git LFS (1 GiB/month free bandwidth is exhausted within days at eight transfers a day) and third-party object storage (second credential and vendor for no additional benefit).

## 3. Current data flow (what changes)

| site | today | after |
|---|---|---|
| W1 prepare, parent capture (`daily-refresh.yml:189`) | `git cat-file blob $HYDRATION_SOURCE_SHA:data/repository-observations.sqlite` | read pointer at `$HYDRATION_SOURCE_SHA`, download asset, verify, write to the same frozen path |
| W1 prepare, existence checks (`:111`, `:136`) | blob exists at source SHA | pointer exists at source SHA (transition: pointer **or** blob, §7) |
| W1 recovery (`:156-164`) | `git archive` includes the blob | `git archive` then place the verified download at `$RECOVERY_SOURCE/data/repository-observations.sqlite` |
| W1 publish (`:488`, `:506`, `:511-514`) | copy DB into checkout, `git add`, scan the staged blob | scan the candidate DB file directly, upload asset, write pointer, `git add` pointer; DB never enters the index |
| W1 publish, committed-artifact probe (`:540-546`) | `git archive $SOURCE_SHA` includes the blob | `git archive` then place the verified download in `$PAGES_SOURCE/data/` |
| W1 verify job → `probe-production.mjs:35` | `gitBytes(sha, "data/repository-observations.sqlite")` | `gitBytes(sha, pointer)` → download → verify |
| W2 `star-ticks.yml:62,138` | `[ -f data/repository-observations.sqlite ]` in the checkout | fetch through the pointer in the checkout into `$RUNNER_TEMP`; export-contract reads that path |
| `deploy-current-pages.yml:46-49` | same as W2 | same as W2 |
| enrich job (self-hosted) | reads `frozen-parent-input/repository-observations.sqlite` from the workflow artifact | unchanged |

## 4. Storage layout

### 4.1 Release per UTC month, asset per snapshot

- Release tag `observation-db/YYYY-MM` (for example `observation-db/2026-09`), created on first use in that month with `gh release create <tag> --target <ORIGINAL_SHA> --prerelease --latest=false --title "Observation database snapshots YYYY-MM" --notes "<one fixed paragraph>"`. `--prerelease` and `--latest=false` keep these releases out of the repository's "Latest release" slot and out of `gh release download` without a tag.
- Asset name `repository-observations-<snapshotId>.sqlite.gz`. `snapshotId` already has the form `YYYYMMDDhhmmss-<16 hex>` and is unique per refresh, so the name is immutable and sortable.
- Content: the candidate database compressed with gzip level 9 through Node's `zlib` (no filename or mtime is written, so the same input gives the same bytes; a unit test pins this).

Why monthly rather than per snapshot or one rolling release: per-snapshot releases need one tag per refresh (about 120 tags a month polluting `git tag`); one rolling release accumulates thousands of assets on a single page. Twelve tags a year with about 120 assets each is easy to browse and easy to prune later.

### 4.2 Pointer file (tracked)

`data/observation-db.pointer.json`, written by publish and read by everyone. Synthetic example:

```json
{
  "version": 1,
  "snapshotId": "20260905024612-0123456789abcdef",
  "producedAt": "2026-09-05T02:46:12Z",
  "database": { "sha256": "<64 hex of the raw .sqlite>", "byteSize": 8527872 },
  "asset": {
    "releaseTag": "observation-db/2026-09",
    "name": "repository-observations-20260905024612-0123456789abcdef.sqlite.gz",
    "sha256": "<64 hex of the .gz bytes>",
    "byteSize": 1210344
  }
}
```

Rules: exact key set (`parseJsonStrict` + `exactKeys`, as the other JSON contracts do); `database.sha256` must equal the `file_sha256` that `export-parent-inputs` already records in parent evidence, so the pointer and the existing parent-evidence chain describe the same bytes. The pointer is committed in the same publish commit as `data/latest.json`, whose `snapshotId` it must match.

### 4.3 Immutability

An asset name is never overwritten. `publish` first lists the release's assets; if an asset with that name exists and its sha256 (from `--json` metadata `digest`, or by downloading and hashing when `digest` is absent) equals the local gz hash, upload is skipped (idempotent re-run); if it exists with a different hash the run fails. `--clobber` is never used.

## 5. Component: `scripts/observation-db-store.mjs`

One script, three subcommands, no third-party dependencies. It shells out to `gh` (present on GitHub-hosted runners and on the operator PC) with `GH_TOKEN`/`GITHUB_TOKEN` from the environment. It never prints token values.

| subcommand | inputs | behaviour | exit |
|---|---|---|---|
| `fetch --pointer <file> --out <file>` | pointer JSON (from `git cat-file blob <sha>:data/observation-db.pointer.json` or the checkout) | validate pointer shape → `gh release download <tag> --pattern <name> --dir <tmp>` (bounded retries on 5xx/429, deadline) → verify gz sha256 and byte size → gunzip → verify raw sha256 and byte size → write `--out` with `O_EXCL`, mode 0444 | 0 on success; non-zero on any mismatch, missing asset, or deadline |
| `publish --database <file> --snapshot-id <id> --release-tag <tag> --target-sha <sha> --pointer-out <file>` | candidate DB | gzip → compute both hashes → ensure release exists (create as §4.1 if not) → immutability check (§4.3) → `gh release upload <tag> <gz>` → re-list and confirm size and (when available) digest → write pointer atomically | non-zero if the asset cannot be confirmed |
| `verify --pointer <file> --database <file>` | pointer + a local DB | raw sha256 and size equality | 0/1 |

Constants: `RETRY_DELAYS_MS = [2000, 8000, 20000]`, `DOWNLOAD_DEADLINE_MS = 10 min`, max pointer size 4 KiB, max asset size 2 GiB (GitHub's limit; reaching it is a hard failure, see §10). `gh` invocations use `execFileSync` with argument arrays, never a shell string.

Tests: unit tests inject a fake `gh` (an environment variable selecting a stub script, the same pattern `tests/verify-refresh-chain.test.mjs` uses for `git`) to cover: success, gz hash mismatch, raw hash mismatch, size mismatch, asset missing, asset present with equal hash (idempotent), asset present with different hash (fail), release missing (created), release create races (second `create` returns "already exists" → proceed), gzip determinism.

## 6. Workflow changes

### 6.1 W1 prepare
- Existence checks (`:111`, `:136`): `git cat-file -e "$SHA:data/observation-db.pointer.json"`; during the transition (§7) accept the blob as an alternative.
- Parent capture (`:186-190`): `git cat-file blob "$SHA:data/observation-db.pointer.json" > "$RUNNER_TEMP/parent-pointer.json"` then `node scripts/observation-db-store.mjs fetch --pointer ... --out "$PARENT_DATABASE"`. `chmod 0444` and the `0555` directory stay. `export-parent-inputs` and `verify-parent-inputs` are unchanged and independently confirm `file_sha256`.
- Recovery artifact (`:156-164`): after `git archive`, run `fetch` into `$RECOVERY_SOURCE/data/repository-observations.sqlite` before `export-contract`.
- `prepare-refresh-candidate.mjs`: `MUTABLE_GENERATED_PATHS` replaces `data/repository-observations.sqlite` with `data/observation-db.pointer.json` (the candidate still writes its DB to `candidate/data/`; the `rm -f` at `:174` stays so a stale copy can never leak in).

### 6.2 W1 publish
Order matters: everything that can fail happens before the commit, and nothing after the push can invalidate the pointer.
1. `scan_repository_observations.py --database "$CANDIDATE/data/repository-observations.sqlite" --expect-snapshot "$SNAPSHOT_ID"` (moves up; today it scans the staged blob at `:513`).
2. `publish` subcommand (§5) uploads the asset and writes `data/observation-db.pointer.json` into the checkout. Release tag for the month is derived from `SNAPSHOT_ID`'s first six digits.
3. Copy text outputs as today, except the DB. Transition only: if `git ls-files --error-unmatch data/repository-observations.sqlite` succeeds, `git rm --cached --quiet data/repository-observations.sqlite` and delete the working-tree file.
4. Allowed-paths `case` list and `git add` list: replace the sqlite path with the pointer path.
5. Staged text secret scan: add the pointer path to the scanned set.
6. Commit, ancestry checks, push — unchanged. If the push fails, the asset already uploaded is harmless: the next run recomputes the same snapshot id only if inputs are identical, otherwise uploads a new name; orphans are listed by a later pruning decision (§10).
7. Committed-artifact probe (`:540-546`): after `git archive`, `fetch` into `$PAGES_SOURCE/data/` using the pointer inside the archive.

### 6.3 `probe-production.mjs`
`artifactContractFromGit`: `gitBytes(sourceSha, "data/observation-db.pointer.json")` → write to temp → `observation-db-store.mjs fetch` (spawned with the same deadline budget) → `export-contract` as today. Legacy fallback for the transition (§7) mirrors the workflow: only when the pointer path does not exist at that SHA and the blob does.

### 6.4 W2 `star-ticks.yml` and `deploy-current-pages.yml`
Replace `[ -f data/repository-observations.sqlite ]` with a "Resolve observation database" step: `fetch --pointer data/observation-db.pointer.json --out "$RUNNER_TEMP/repository-observations.sqlite"`, and point `export-contract --database` at that path. Transition: if the pointer is absent but the tracked blob is present, use the blob. `deploy-current-pages.yml` keeps its v0 branch when neither exists.

### 6.5 `verify-refresh-chain.mjs`
`approvedGeneratedCommitPath`: add `data/observation-db.pointer.json`; keep `data/repository-observations.sqlite` accepted **only** as a deletion during the transition (the diff-tree name list does not distinguish add from delete, so the transition PR accepts both names and the follow-up PR removes the sqlite name).

### 6.6 `.gitignore`
Add `data/repository-observations.sqlite` (ignoring a tracked file has no effect until it is removed from the index, which the transition run does; afterwards it prevents accidental re-adding from a local run).

## 7. Transition (no manual migration, no schedule pause)

The code PR merges while main still tracks the blob and has no pointer. The first W1 run after the merge:
- prepare finds no pointer at `HYDRATION_SOURCE_SHA` (the last publish commit) but finds the blob → uses the blob (existing path, byte-identical behaviour);
- publish uploads the new candidate DB as the first asset, writes the first pointer, removes the blob from the index, commits;
- verify and every later run find the pointer and never consult the blob path.

W2 and `deploy-current-pages.yml` between merge and that first W1 see "blob present, pointer absent" and use the blob. The fallback is exactly one predicate (`pointer absent AND blob present`) implemented once in the store script (`resolve --source-sha <sha>` helper used by every consumer) so the transition logic cannot drift between workflows. A follow-up PR removes the blob branch after two clean W1 runs (same pattern as Task 14 removing the probe tolerance), and the `verify-refresh-chain` allowance for the sqlite name goes with it.

Local pre-flight before merging (lesson from W1 runs 1–3: pre-flight the whole stage, not one error): run the prepare stage and the publish stage's steps 1–5 locally against a throwaway release tag (`observation-db/test-<date>`) in the same repository, then delete that test release. This exercises `gh release create/upload/download` with the real token scope before the cloud run.

## 8. Failure modes and behaviour

| failure | behaviour | recovery |
|---|---|---|
| asset download 404 / release deleted by a human | `fetch` fails; run stops before enrichment | re-upload the DB from the `frozen-parent-input` workflow artifact (7-day retention) or from the operator's local checkout with `publish --snapshot-id <id> --release-tag <tag>`; the pointer already names the expected hashes so the re-upload is verified |
| hash or size mismatch | fail-closed, same as today's parent-evidence mismatch | investigate; never patch the pointer by hand |
| upload succeeds, push fails | no pointer commit; orphan asset | harmless; next run uploads its own snapshot |
| `gh` rate limit (1,000 requests/hour per repository for `GITHUB_TOKEN`) | not reachable: a run makes at most about six release API calls | — |
| transient 5xx/429 on download | three bounded retries then fail | re-run the workflow |
| asset reaches 2 GiB | `publish` refuses before upload | §10 retention work must land long before this |

## 9. Testing and verification plan

- Unit: store script with fake `gh` (§5). Pointer parsing rejects extra keys, wrong snapshot format, non-hex hashes, non-integer sizes.
- Workflow-shape tests (`tests/daily-refresh-workflow.test.mjs`, `tests/star-ticks-workflow.test.mjs`, `tests/pages-publication.test.mjs`, `tests/verify-refresh-chain.test.mjs`): update the pinned strings; add assertions that the sqlite path is absent from `git add`, present only in the transition `git rm --cached`, and that `fetch` precedes every `export-contract` that used to read the checkout.
- Local pre-flight (§7) against a test release, then delete it.
- Production verification (S6/S7): first W1 run green; `git ls-files data/repository-observations.sqlite` empty on main; `gh release view observation-db/2026-09 --json assets` lists exactly one asset whose name matches `data/observation-db.pointer.json`; W2 tick green; `git count-objects -vH` after two refreshes shows pack growth in KB.

## 10. Decisions deferred with re-open conditions

- **Asset retention / pruning:** not automated in v1. Every snapshot is kept. Re-open when the monthly release's total asset size passes 5 GB or when GitHub signals storage concerns. Candidate policy then: keep the last 28 snapshots (7 days) plus the first snapshot of each month.
- **Database row retention:** at about 3 MB/day the raw file reaches 1 GB in roughly a year, and each run downloads and uploads it in full. Re-open when the raw DB passes 200 MB or a refresh's download step exceeds two minutes. This is where the real long-term ceiling sits; release assets remove the git ceiling only.
- **History purge of already-committed blobs:** not planned; would require force-push.

## 11. Rollout checklist (S7)

1. Merge the PR (tests green, two reviews: adversarial blueprint review and security review of the store script's `gh` argument handling).
2. Watch the next scheduled W1 (KST 00/06/12/18, minute 07) — or dispatch manually — through verify.
3. Confirm: pointer tracked, blob untracked, release asset present, W2 tick green.
4. After two clean runs: follow-up PR removing the transition fallback and the sqlite name from `approvedGeneratedCommitPath`.
5. README data section: describe the pointer and the release location; remove the "under consideration" paragraph about moving the database.
6. Decision record in the vault (`47_의사결정기록/`): chosen, rejected (LFS, R2/B2, local-only), why, re-open conditions from §10.
