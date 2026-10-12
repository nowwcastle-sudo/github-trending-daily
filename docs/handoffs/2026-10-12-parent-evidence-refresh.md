# Trending refresh: parent-evidence size repair

Last updated: 2026-10-12 07:36 UTC / 16:36 KST.

## Goal and ownership

- Restore the failing parent-evidence preparation path without dropping historical data, weakening verification, raising paid quotas, or changing production directly.
- The owner assigned Trending error/bug repair to 고슬 on 2026-10-12. The earlier DESKTOP assignment is superseded for this Trending task only. Other projects remain outside this task.
- Work is in an isolated assistant-cloud checkout. No user computer, self-hosted runner, credentials, security settings, production database, or deployed Pages artifact was changed.
- GitHub open-PR search returned zero at 2026-10-12 06:56 UTC and again at 07:10 UTC. Main was still at the source baseline on the second check. The visible branch list had no new competing repair branch. No existing repair handoff document was found in the current tracked tree. This does not claim visibility into unpushed work on other computers.
- Source baseline: `b037cd44103556ad45bd72ca7eca3a3daf8a1775` (`main`). README and the current release-semantics specification were read before changes. The latter concerns an older feature rollout; its data-preservation and separate-release requirements remain relevant, not its unrelated feature acceptance checklist.

## Reproduced failure

Latest inspected full refresh: [38188171020](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38188171020), finished with failure at 2026-10-12 00:30:57 UTC / 09:30:57 KST.

The [prepare job](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38188171020/job/114614957868) successfully resolved the production DB and exported parent evidence, then `verify-parent-inputs` stopped with `parent evidence size is invalid`. Enrichment, publication, deployment and production probing were skipped. Separate Star ticks success is not evidence of full-refresh recovery.

The immutable release pointer identifies:

- Snapshot: `20261007203441-a8b11f19ca8d09c5`
- DB bytes: `78,417,920`
- DB SHA-256: `ee1f459e2187244929994687c6a61e8c0617e6a6f355eb2b68e5186effdeb2c2`
- Historical evidence: 14 tables, 283,405 rows; complete prior heads: 254 repositories

An anonymously downloaded release asset was checked against that size/hash. The unmodified exporter produced a **67,234,054-byte** v1 evidence JSON, exceeding the existing 64 MiB limit (67,108,864 bytes) by 125,190 bytes. The unmodified verifier reproduced the production failure with exit 1.

The problem is duplication of every historical row key and hash into a transport JSON. Whitespace compaction would temporarily reduce it to 37,089,102 bytes but still grow with every historical row. Raising the cap would postpone the same failure.

## Change

New parent-evidence envelopes use version 2. Each table transports only its exact row count and the SHA-256 of the same ordered full row-evidence sequence. The file hash/size, last snapshot/sequence/chain, historical-head proof, production source binding, and legacy baseline receipt remain.

Full row evidence is still reconstructed from a single immutable SQLite byte capture. Candidate creation and post-append checks still use every captured row to prove preservation. No history is deleted, truncated, sampled, or rewritten. DB schema, snapshot IDs, artifact contracts, JSON size limits, retry policy and provider budgets are unchanged.

Version 1 remains readable within its existing size bound, including its exact row-list comparison. Oversized legacy v1 receipts must be re-exported from the verified immutable DB using the updated exporter; the bound is deliberately not relaxed. Prior-head envelopes and the verifier acknowledgment retain their independent version-1 contracts.

Changed files:

- `scripts/derive_repository_artifacts.py`: export bounded v2 receipts; remeasure and compare all declared evidence
- `scripts/record_repository_observations.py`: exact v1/v2 table-field allowlists; retain candidate preservation checks
- `scripts/collect-repository-events.mjs`: admit v2 while retaining source/head/DB binding and Python re-verification
- `tests/test_parent_evidence.py`: bounded export, v1 compatibility, hash/count/identity mutations, incomplete JSON, atomic-write failure and size boundary
- Existing artifact, recorder CLI and event-collector tests: v2 across all consumers, exact v1/v2 candidate-byte equality

Consumer inventory was checked with a repository-wide parent-evidence search. The event collector parses it directly. Summary and retired translation pipelines invoke the Python verifier via `verifyFrozenParentInputs`. The Python recorder loads and validates it independently. The workflow only additionally compares the preserved `parent_database.file_sha256` to the release pointer. No consumer requires the old row list except v1 validation.

## Verification evidence and current status

- Before patch: production-size export succeeded; verification failed at the 64 MiB bound. Three new regression checks were red against the original source.
- After patch: same DB exports a **4,544-byte** receipt; Python verifier succeeds. All 14 table counts and full-row digests match the v1 export; prior-head file bytes are identical.
- A candidate DB copied through the v2 recorder preparation path has exactly the original DB bytes/SHA-256. Original DB remains unchanged.
- JS strict parsing, complete prior-head validation and the real Python subprocess verifier also succeeded against that same production-size snapshot (254 heads).
- Focused Python suite passed 104 tests before final CLI parity coverage was added.
- Mutation probes removed evidence comparison separately at verifier and recorder boundaries; regression tests failed in both cases as required.
- Full Node suite, run without forced exit: **851 passed, 13 skipped, 0 failed, 864 total** (859 top-level plus 5 nested tests; TAP counts checked). Skips are 9 emulator-only Firestore tests, 3 retired translation tests and 1 Windows-only alias test. Command: `node --test --test-concurrency=4 --test-timeout=300000 --test-reporter=tap`.
- Full Python suite: **175 tests passed**. The first new recorder parity fixture reused already-advanced README state and correctly failed; it now restores identical parent README-state bytes for both versions. No production behavior was changed to accommodate the fixture. `npm test` also returned exit 0, but the independent complete Node run below is the stronger coverage evidence.
- One aggregate run lost its tool session before a result; it is not counted as a pass.
- Firestore emulator suite: **9/9 passed**, exit 0, with explicit writable emulator/config cache paths and a demo project. The first attempt could not write the default cloud-home cache; supported per-process cache overrides resolved it. This was isolated emulation, not Firebase deployment.
- JavaScript syntax, Python compilation and `git diff --check` passed at the current checkpoint.
- Parent code review found no blocking regression in the three implementation changes; it is not a substitute for the execution evidence above. A changed-file known credential-pattern scan passed for all 8 patch files.
- Production-dependency audit (`npm audit --omit=dev --audit-level=high`) returned 0 vulnerabilities.
- Publication approval: the first commit request was blocked at 07:11 UTC pending explicit approval. The owner subsequently authorized a new branch, draft PR and CI. The identical rejected call was retried once and succeeded at 07:36 UTC, creating code commit `56cb6427edf0b45f4fce081fe0512b8b529b71c1`. Main remained `b037cd44103556ad45bd72ca7eca3a3daf8a1775`, with zero open PRs at the pre-publication recheck.
- Publishing the final handoff on repair branch `fix/compact-parent-evidence-20261012`; draft PR and exact-head CI are pending at this checkpoint. Main merge, auto-merge, workflow dispatch and production deployment remain outside this approval.

### Existing test-runner observation

Repeated existing `npm test` invocations returned Node counts of 861, 864 and 860 with no Node failures. Comparing test names showed omitted tail cases in some files, so those partial counts were not accepted as full coverage. The explicit non-forced TAP run completed all 864 registered cases; isolated page-runtime runs also completed 166/166. The exact cause of the inconsistent forced aggregate reports is not established and `package.json` is unchanged. Node documents `--test-force-exit` as exiting after all known tests finish; see [official CLI documentation](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-force-exit). A follow-on maintainer should investigate reporting/termination separately rather than assume an exit-0 aggregate proves exact coverage.

## Reproduction commands

Run from the repository root. Use a new `$WORK` directory **outside the checkout**; these commands only read the public release asset and write isolated evidence/candidate files.

```sh
BASE=b037cd44103556ad45bd72ca7eca3a3daf8a1775
SNAPSHOT=20261007203441-a8b11f19ca8d09c5
node scripts/observation-db-store.mjs resolve --source-sha "$BASE" \
  --expect-snapshot-id "$SNAPSHOT" --out "$WORK/parent.sqlite"
python scripts/derive_repository_artifacts.py export-parent-inputs \
  --parent-database "$WORK/parent.sqlite" \
  --baseline-receipt data/legacy-observation-baseline.json \
  --expected-parent-snapshot "$SNAPSHOT" --production-source-sha "$BASE" \
  --parent-evidence-out "$WORK/parent-evidence.json" --prior-heads-out "$WORK/prior-heads.json"
python scripts/derive_repository_artifacts.py verify-parent-inputs \
  --parent-database "$WORK/parent.sqlite" \
  --parent-evidence "$WORK/parent-evidence.json" --prior-heads "$WORK/prior-heads.json"
python -m unittest tests.test_parent_evidence tests.test_repository_artifacts tests.test_repository_observations -v
node --test tests/collect-repository-events.test.mjs
npm test
```

The reference commit must exist in the checkout. Keep command exit codes; do not pipe test execution into a command that hides its failure.

## Next steps and completion boundary

1. Finish aggregate tests, isolated Firestore tests, diff/secret review and code review. Update this same handoff with measured results.
2. Publish these approved 8 files on the repair branch, create a draft PR, and verify CI for its exact head SHA. Record the PR link and completed checks here. Do not merge automatically.
3. After the owner authorizes merge/production activation, apply through the existing controlled full-refresh workflow. A full refresh uses the existing self-hosted enrichment runner and provider credentials; those were not accessed or changed here.
4. Verify that prepare passes and a **new** snapshot reaches successful publication, deployment and production probe. Only then report production recovery. Other latent failures after the previously blocked stage remain untested until that controlled run.

Do not call the production system fixed on the basis of unit tests, a draft PR, Star ticks, or this isolated DB verification. No workflow dispatch, main update, auto-merge or deployment is authorized by this handoff itself.
