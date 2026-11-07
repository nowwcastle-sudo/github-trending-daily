# Trending refresh: parent-evidence size repair

Last updated: 2026-10-14. Operational times below are UTC unless explicitly marked KST.

## Goal and ownership

- Restore the failing parent-evidence preparation path without dropping historical data, weakening verification, raising paid quotas, or changing production directly.
- The owner assigned Trending error/bug repair to 고슬 on 2026-10-12. The earlier DESKTOP assignment is superseded for this Trending task only. Other projects remain outside this task.
- Repair work is in an isolated assistant-cloud checkout. User-computer access and credential/security changes were not used. On 2026-10-12 08:42 UTC, the owner subsequently authorized operational application through the existing full-refresh pipeline, including its existing enrichment runner, publication, deployment and verification. See the operational record below for actual outcomes.
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
- Published [draft PR #93](https://github.com/nowwcastle-sudo/github-trending-daily/pull/93) on branch `fix/compact-parent-evidence-20261012`, covering exactly these 8 files. Remote file bytes were re-fetched and matched the tested checkout.
- CI for code/handoff head `a5a916883a85c5090b7b2884f0b2ad2a2faec32e`: [Tests 38218789524](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38218789524) and [CodeQL 38218789898](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38218789898) both completed successfully, including Python and JavaScript/TypeScript CodeQL jobs. Verified at 07:39 UTC.
- This subsequent documentation-only update records those finished results; its own exact-head CI is verified separately in the [live PR checks](https://github.com/nowwcastle-sudo/github-trending-daily/pull/93/checks), avoiding a self-referential commit-hash claim. At that checkpoint, main merge, auto-merge, workflow dispatch and production deployment were outside the then-current approval. The subsequent operational approval is recorded below.

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

## Operational application record

- At 08:42 UTC / 17:42 KST, the owner approved Trending operational application following the explicit proposal to merge PR #93 and verify a full refresh and deployment. No new authentication, paid-quota increase or security change was requested or performed.
- Final PR head `5e816d070853b73949528d90a556aba20ddf6a08` passed [Tests 38219045393](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38219045393) (851 Node passed, 13 conditionally skipped; 175 Python passed) and [CodeQL 38219045401](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38219045401).
- Immediately before application, PR head/checks/mergeability and active workflow runs were rechecked. No competing full refresh was active. Automatic Star ticks commit `ca0b33214ac781fbae2615342d3e0bcf2704a6fe` was preserved.
- PR #93 was marked ready and merged with an exact-head guard at 08:44:35 UTC, producing main merge commit `5081c730675b425b78138c7f80c10662c5a53901`. Its post-merge [Tests 38225444829](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38225444829) and [CodeQL 38225444848](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38225444848) also succeeded.
- The pre-refresh production manifest was valid version 1, source `ca0b33214ac781fbae2615342d3e0bcf2704a6fe`, snapshot `20261007203441-a8b11f19ca8d09c5`. Merge/CI alone did not update the snapshot.
- The existing signed-in assistant-cloud GitHub browser session submitted the normal `daily-refresh.yml` workflow once on main with the optional bootstrap field blank. [Full refresh 38226333908](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38226333908) started at 08:53 UTC with exact head `5081c730675b425b78138c7f80c10662c5a53901`; prepare was in progress at this checkpoint. No new login or credentials were used.
- At 08:56 UTC, the production workflow passed the previously failing `Freeze one run context and parent evidence` step, including export and verification. Fact collection was then in progress. This confirms the size-failure repair in the real workflow, while downstream completion remains pending.
- Prepare completed successfully at 08:58:30 UTC with frozen candidate snapshot `20261012085311-0117c92a67a05555`, 38 repositories and complete event collection. Its verifier receipt was `{"verified":true,"version":1}`; that version is the acknowledgment contract, not the v2 evidence envelope.
- At 09:04 UTC, [registered-runner settings](https://github.com/nowwcastle-sudo/github-trending-daily/settings/actions/runners) showed `nasca-gh-trending-claude` **Offline**. The enrichment job `114736497214` remained queued with runner ID 0 and no started steps. This is a separate infrastructure blocker exposed after the fixed prepare stage. No user-host access or runner configuration changes were attempted. The existing queue guard will wait until the frozen enrichment deadline (approximately 10:08 UTC) before its normal cancellation behavior.
- The prior successful [enrichment job 112770100990](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/37613956447/job/112770100990) identifies the runner host in its setup header. That host matches the disconnected registered environment; this was established from repository/Actions reads, without accessing the host.
- Restoring the existing runner service requires an available host and explicit user-host access approval if performed by the assistant. No fresh credentials, runner registration or security changes are authorized by the production-application request.
- Documentation was held off main while the refresh was active to avoid invalidating its exact-main publication guard. The subsequent failed run and diagnostic repair are recorded below.

## Subsequent enrichment failure and bounded-diagnostic repair

- The owner connected the identified desktop and explicitly asked to continue at 09:58 UTC / 18:58 KST. The existing runner had already resumed at 09:50:10 UTC. No assistant service restart was needed to make the job start.
- [Enrichment job 114736497214](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38226333908/job/114736497214) failed at 09:51:03 UTC with `Summary bundle held ratio exceeds 50% (25/38)`. Publication, deployment and production probe were skipped. The queue guard finished successfully after it saw the runner acquire the job.
- The existing failure-artifact upload found no diagnostic file. Code inspection shows that the held-majority gate threw a plain `Error`, discarding already-bounded per-repository reasons before the CLI's diagnostic writer. This is a separate, reproducible observability bug. The gate correctly stopped publication; it must not be relaxed to force recovery.
- The original frozen input ZIP was downloaded via the GitHub connector and verified against artifact digest `eee42944ce1e53460867d5c08f2dab9dfb5de8303dadd85a383f494259a5f521`. All 38 fact classifications were verified. Offline summary-reuse planning found 13 retained and 25 pending repositories. These facts narrow the failure but do **not** establish why the 25 generation requests were held.
- The diagnostic-only follow-on starts from main `4103863ec92e68ef0593142ff115ef4838e426d7`, preserving the intervening automatic Star ticks update. It changes `scripts/generate-summary-bundles.mjs`, `tests/summary-bundle-pipeline.test.mjs`, and this same handoff. At the existing greater-than-50% failure gate, it attaches the existing version-2 held-diagnostic envelope to the error so the CLI can save it. It includes classification holds as well as request holds. Thresholds, provider budgets, retries, output contracts and candidate installation order are unchanged. No raw provider stdout/stderr is included.
- Three regression checks were red on the unmodified source. The fixed summary suite passed **76/76**. Checks cover quality-failure reasons, rate-limit/remaining-request causes without raw-output leakage, candidate preservation, exactly 22/44 held being allowed, 23/44 being rejected, and the actual CLI producing the diagnostic file on that rejection.
- Complete non-forced Node suite: **866 total, 853 passed, 13 skipped, 0 failed**, exit 0. Full Python suite: **175 passed**, exit 0. JavaScript syntax and `git diff --check` passed. Parent independent diff review found no blocking regression; it does not replace the test evidence.
- An isolated test against the real frozen input, with mocked rate-limit responses and **zero provider calls**, reproduced the same 25/38 gate and preserved all 25 bounded reasons without writing a candidate index. This is a diagnostic-path simulation, not evidence that the real provider failure was a rate limit.
- At 10:07 UTC, the live manifest still had snapshot `20261007203441-a8b11f19ca8d09c5`, source `4103863ec92e68ef0593142ff115ef4838e426d7`, version 1 and 22 files. The source advanced through Star ticks; a new full-refresh snapshot has not been published.
- A scoped desktop task creation returned an internal tool error. No admitted task turn or local inspection was verified; no successful PC repair is claimed. The code diagnosis and tests above ran in the assistant cloud. No new credentials, runner registration, installation or security changes were performed.

- [PR #94](https://github.com/nowwcastle-sudo/github-trending-daily/pull/94), exact head `25b98d2f6500886f2a4b33667fa2639eaf67602f`, passed [Tests 38234671336](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38234671336) and [CodeQL 38234671163](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38234671163). Both language analyzers and the aggregate CodeQL check succeeded. It was merged with an expected-head guard at 10:14:13 UTC as `991cc62f6b7e0d194fc36665fc6f664911f99bcf`.
- At 10:15 UTC, one fresh normal [full refresh 38235202153](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38235202153) was dispatched on that exact main after checking for active duplicates. The existing signed-in cloud GitHub UI was used, bootstrap input stayed blank, and the earlier expired job was not rerun. At that checkpoint prepare was in progress and documentation writes to main were deferred to protect the active run. The terminal outcome is recorded below.

## Confirmed fresh-run provider blocker

- Fresh run `38235202153` passed prepare, and the existing runner immediately started enrichment at 10:21:14 UTC. Generation failed at 10:22:13 UTC at the unchanged 25/38 held gate; publication/deployment/probe were skipped.
- The diagnostic fix worked in production: artifact `11740960692` was uploaded, ZIP SHA-256 `d8bea12ebcc70a391fada318beaee4d0f937f57aff425319ad8659d87e2ff0af`. Downloaded bytes matched the digest. The JSON is 11,664 bytes, version 2; its SHA-256 is `a92dffb288c68415738cd6f7ea98b074c9e88bbcd6e704155bf684bc0b6f1011`. The three direct rate-limited repositories were `morluto/rea`, `storytold/artcraft`, and `cathrynlavery/diagram-design`; the other 22 cite a causal held request rather than an independent quality failure.
- All 25 holds have reason `budget_exhausted`: the first 3 contain `CLAUDE_RATE_LIMITED`, and the remaining 22 contain `BUDGET_EXHAUSTED` with an explicit causal repository. No quality defect is reported. Runtime is Claude CLI OAuth/firstParty 2.1.292, model claude-sonnet-5. Recorded aggregate usage is 9 attempts, 6 retries and 0 input/output tokens; these fields are execution receipts, not a billing statement.
- The runtime classifies 429/rate-limit responses as `CLAUDE_RATE_LIMITED`. The bounded artifact does not reveal whether the constraint is transient throttling, a session limit or a weekly allowance, and contains no reset time. This is now the active blocker. Do not present a provider-limit guess as a confirmed account state.
- The run reached terminal `completed/failure` at 10:22:24 UTC. Its [diagnostic download](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38235202153/artifacts/11740960692) expires on 2026-10-13 at about 10:22 UTC; the bounded facts and digest above remain in this durable handoff.
- A read-only attempt to open Claude Settings > Usage in the existing assistant-cloud browser redirected to reauthentication. No login, payment, usage setting or credential action was taken. Limit type and reset time remain unverified.
- At 10:28 UTC / 19:28 KST, the user was asked to provide the displayed Claude limit message and reset time. That answer is pending. No additional full refresh was dispatched after run 38235202153.
- The final supported desktop-task recheck returned zero direct child tasks (no continuation cursor). The uncertain empty thread still had no parent, admitted turn or messages. No new task was created, no instructions were sent to that unidentified thread, and no desktop inspection is claimed.
- Do not repeatedly dispatch full refreshes against that unchanged constraint. Read the relevant existing account's usage/availability state through an authorized route, then wait for its confirmed reset or request any additional approval required. No extra paid usage, account change, model substitution, security change or quota increase has been performed.

## Next steps and completion boundary

1. Establish Claude provider availability or the existing account's reset time. The user can check **Claude Settings > Usage** in the account used by the existing runner and provide the limit kind and reset time; a screenshot should omit unrelated account details. The fresh-run rate-limit blocker is confirmed, but its reset timing is not. Do not weaken the 50% publication gate or raise paid budgets.
2. When availability is restored, check for a duplicate and run one fresh normal full refresh. Never rerun an expired frozen enrichment job.
3. Resolve any subsequent failure from its real bounded diagnostic within scope; new authentication, payment/quota or security changes require separate approval.
4. Verify a **new** snapshot, immutable DB pointer, published source SHA and successful production probe before reporting operational recovery.
5. Continue updating this existing handoff without racing any active full refresh. The separate forced Node test-runner reporting observation remains open and does not invalidate the successful exact-head CI results already recorded.

The parent-evidence size failure is repaired and verified in the real prepare stage. End-to-end operational recovery remains incomplete because enrichment failed later. This document records approval and evidence; it does not independently authorize new authentication, access expansion, payments or security changes.

## Desktop continuation and current provider blocker — 2026-10-13

The owner connected the desktop and approved PC reads and continuation of the existing Trending operation. Local PowerShell commands, repository access and the existing GitHub CLI connection worked. No runner restart was necessary: the existing Windows runner `nasca-gh-trending-claude` was online and idle, and its listener recorded `Listening for Jobs` at 10:10:37 UTC / 19:10:37 KST.

At the first live recheck, queued and in-progress workflow counts were both zero. The latest full refresh was still [38323723198](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38323723198), cancelled at 01:00:49 UTC. Its enrichment job had no acquired runner or steps; the queue guard cancelled it at its own deadline. That cancellation is a runner-acquisition outcome, not evidence of a Claude limit in that particular run.

The current provider constraint was checked independently using the existing runner user's configured OAuth token, the repository's bounded CLI runtime and the unchanged `claude-sonnet-5` model. OAuth preflight passed at 10:23:33 UTC with CLI 2.1.292, `authMethod=oauth_token`, `apiProvider=firstParty`. One brief structured availability request, without tools or session persistence, failed at 10:23:37 UTC with `CLAUDE_RATE_LIMITED`. It was not retried. No fresh authentication, token issuance, paid-quota increase, account/model change or security change was performed.

### Automatic full refresh and original diagnostic

While the PC investigation was running, GitHub started [full refresh 38383420844](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38383420844) at 10:26:57 UTC / 19:26:57 KST, head `cdd7ae8e573462f9280dbd5cdcfce27f04d189dc`. Its event was `schedule`, attempt 1; actor and triggering actor were `nowwcastle-sudo`. This desktop continuation did not dispatch that run or rerun an expired job. No duplicate manual refresh was submitted.

- [Prepare job 115249201450](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38383420844/job/115249201450) passed, including the pre-refresh tests and parent-evidence verification, and completed at 10:32:03 UTC.
- [Enrichment job 115251159354](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38383420844/job/115251159354) was actually acquired by `nasca-gh-trending-claude` at 10:32:06 UTC. The queue guard observed execution and completed successfully at 10:32:10 UTC. PC connectivity and runner acquisition were therefore verified in a real refresh, separately from provider availability.
- Enrichment failed at 10:33:18 UTC with `Summary bundle held ratio exceeds 50% (29/38)`. Publication, candidate deployment, production probe and recovery were skipped. The full run reached `completed/failure` at 10:33:20 UTC / 19:33:20 KST. The watch command's exit 1 agreed with the final API status.
- The original [failure artifact 11804787957](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38383420844/artifacts/11804787957) was downloaded and inspected. Its ZIP metadata records digest `sha256:134790c35e79cd63b09df61dda6f5b36635c123db0feb8eb686db1198231c2a9` and expiry 2026-10-14 10:33:10 UTC. The extracted bounded JSON is 13,758 bytes, version 2, SHA-256 `668a0519f5679bc3bb545e4a96b1f1a5e6a4e9e55c92e8dff826997120a62ca5`. The ZIP digest and JSON hash identify different byte streams.
- All 29 held entries have reason `budget_exhausted`. The direct `CLAUDE_RATE_LIMITED` entries are `morluto/rea`, `bilawalsidhu/gods-eye-view`, and `storytold/artcraft`. The remaining 26 entries carry `BUDGET_EXHAUSTED` with `storytold/artcraft` as their causal request. Reported quality-defect count is zero; the failure is not evidence of 29 independent summary-quality defects.
- Runtime is Claude CLI OAuth/firstParty 2.1.292, model `claude-sonnet-5`. The shared aggregate execution receipt reports 9 attempts, 6 retries, 0 input tokens and 0 output tokens. It is repeated in per-repository diagnostics and must not be summed across those entries or treated as a billing statement.

The bounded artifact establishes the current rate-limit failure in actual enrichment, in addition to the earlier minimal availability check. It does not identify transient throttling versus a session/weekly allowance, and it has no reset timestamp. Do not claim that a particular allowance or reset time was verified.

### Separate publication, deployment and public readback

The unchanged published snapshot remained `20261007203441-a8b11f19ca8d09c5`, with `statsDate=2026-10-08` and `generatedAt=2026-10-07T20:34:41.377Z`.

After the failed full refresh, the already-created [Star ticks run 38383769171](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38383769171) completed successfully. It published generated child [672a696f8bd08db67ee0b0e2e7a1d3e32966c9e5](https://github.com/nowwcastle-sudo/github-trending-daily/commit/672a696f8bd08db67ee0b0e2e7a1d3e32966c9e5) at 10:34:07 UTC, parent `cdd7ae8e573462f9280dbd5cdcfce27f04d189dc`. GitHub Pages deployment `7036161925` reached `success` at 10:34:35 UTC; [job 115251657405](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38383769171/job/115251657405) passed the commit, deploy and deployed-probe steps.

At 10:35:13 UTC, actual HTTPS reads of the public `deployment-manifest.json` and `data/latest.json` both returned 200. The manifest had version 1 and source `672a696f8bd08db67ee0b0e2e7a1d3e32966c9e5`; its snapshot matched the still-October-8 dataset. An independent `probe-production.mjs` run against that exact public source and snapshot passed with exit 0 and 22 files, manifest SHA-256 `2f031c51e4e5049a6ea7b7cf6d0ac1e414c7d757ca866203794ae80c92da8c6b`.

The independent probe used the already-installed bundled Node 24.21.0 and fetched the exact public commit object into the isolated verification clone. Two attempts with the system Node 24.20.0 had ended in the local undici `Parser.finish` assertion `assert(!this.paused)` and are not counted as passes. No Node installation or global configuration change was made. Successful star-tick publication and Pages integrity do not establish successful full-refresh recovery.

### Remaining action

The smallest unresolved action is to establish the existing runner account's Claude reset time or restored availability, then check for duplicates and submit one fresh normal full refresh with the bootstrap input blank. Do not repeatedly dispatch against the unchanged rate-limit failure, rerun an expired frozen job, weaken the held-majority publication guard, or increase paid quotas to force a result. A new snapshot/date, generated child commit, Pages deployment success and exact-source public probe are still required before claiming operational recovery.

The reset time was not available from the diagnostic. The desktop's CUA initialization failed with a missing Windows platform-directory error, and the existing BrowserSkill daemon could not detach from this host's Job Object. These UI-tool limitations did not prevent PC commands or runner operation; they prevented reading the Usage screen in this continuation. No browser login, new credential, installation or security workaround was attempted. No WF/LF source or another session's checkout was modified.

## Verified full-refresh recovery — 2026-10-14

The owner reconnected the same desktop and authorized continuing the existing Trending operation at 20:00 KST. The existing runner was online and idle; no runner restart was needed. Before any restart, the original diagnostics from the two latest failed scheduled runs were downloaded and checked:

- [38536329663](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38536329663), [artifact 11880960819](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38536329663/artifacts/11880960819): v2, 13,322 JSON bytes, SHA-256 `86bfe12362d83cc449706b6e720ca04784a143c523a62509db86107631cdc263`.
- [38489117127](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38489117127), [artifact 11860558984](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38489117127/artifacts/11860558984): v2, 13,447 JSON bytes, SHA-256 `164384e1fc30d5227bd0ccd949958b1ff44dc10f59008630164a0ab816abf7d3`.
- Both had held 28/37: direct `CLAUDE_RATE_LIMITED` for `morluto/rea`, `bilawalsidhu/gods-eye-view`, `debpalash/VoiceStudio`, followed by 25 `BUDGET_EXHAUSTED` entries. Each shared execution receipt recorded 9 attempts, 6 retries and zero input/output tokens, with zero quality defects. The runtime was unchanged OAuth/firstParty, CLI 2.1.292, `claude-sonnet-5`. These records do not establish an account balance, a particular allowance type or a reset time.

At 11:05:45 UTC / 20:05:45 KST, one brief structured request using the existing runner OAuth, the same repository runtime and `claude-sonnet-5` returned `{"status":"ok"}`, exit 0. Recorded usage was 7279 input and 52 output tokens. This actual response, rather than elapsed time or a recalled reset schedule, established availability for a fresh normal attempt. It was not a guarantee about the whole batch or a billing statement.

Immediate duplicate checks at 11:07:12 UTC returned queued 0 and in_progress 0. One normal `daily-refresh.yml` dispatch was then submitted on main, with the optional bootstrap field omitted. [Run 38554338345](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345), exact original head `7ea81d2cd70f70aaf28396bc5270396b69d633eb`, started at 11:07:14 UTC / 20:07:14 KST and completed successfully at 11:33:28 UTC / 20:33:28 KST. No duplicate was dispatched.

| Stage | Evidence | Terminal result |
| --- | --- | --- |
| Prepare and frozen-input verification | [job 115819628414](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345/job/115819628414) | success, 11:13:09 UTC |
| Source-bound summaries | [job 115821905124](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345/job/115821905124) | success, 11:30:45 UTC; acquired by the existing Windows runner |
| Validate and publish candidate | [job 115828772020](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345/job/115828772020) | success, 11:32:37 UTC |
| Deploy candidate Pages artifact | [job 115829517585](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345/job/115829517585) | success, 11:32:54 UTC |
| Probe production candidate | [job 115829626284](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345/job/115829626284) | success, 11:33:27 UTC |

The queue guard also succeeded after acquisition; recovery was conditionally skipped because the production probe succeeded. The watch command's exit 0 agreed with the final API status.

The generated publication is [813c35cb3b3bf401f1fedc1c7b793728ad3eba4c](https://github.com/nowwcastle-sudo/github-trending-daily/commit/813c35cb3b3bf401f1fedc1c7b793728ad3eba4c), committed at 11:32:14 UTC, with the exact original head as its parent. The new snapshot is `20261014110720-080daee75ec84614`, `statsDate=2026-10-14`, `generatedAt=2026-10-14T11:07:20.321Z`, containing 40 repositories. The immutable observation-DB pointer carries that same snapshot, byte size 85,155,840 and SHA-256 `edc0d7c1f4b29fc150ca518da75ca5021cab848c48dd6fe0d570c414885b7233`, asset `repository-observations-20261014110720-080daee75ec84614.sqlite` under release `observation-db-2026-10`.

Pages deployment `7064144550` recorded `success` at 11:32:55 UTC. Its API sha is the workflow's original head; the published artifact identifies the generated child above. At 11:35:01 UTC, independent HTTPS reads of the public manifest and latest data both returned 200 and matched the new snapshot/date. By that read, the ordinary star-tick descendant [a75beca6b0cca6dd6b5b3d6014129ae19456ece5](https://github.com/nowwcastle-sudo/github-trending-daily/commit/a75beca6b0cca6dd6b5b3d6014129ae19456ece5) was the public source. Its ancestry from the generated refresh commit was checked. The independent public `probe-production.mjs` passed with exit 0 and 22 files using the already-installed Node 24.21.0, manifest SHA-256 `f609b4de553714782a8a85dbfabe288992ffe450cf298f4882e4008a14084e44`.

### Remaining per-repository holds

The successful [enrichment artifact 11890473410](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345/artifacts/11890473410) records repositories 40, pending 32, held 3. The unchanged admission policy allowed publication with these three explicit holds; no quality threshold was lowered. [Bounded held artifact 11890163470](https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/38554338345/artifacts/11890163470), JSON SHA-256 `f22c69f022038fce2be275a98b4af9023225a81a9607abb85c99dd2af5bbc22e`, records:

- `rust-lang/rust`: `quality_defects`, `GENERIC_OR_PLACEHOLDER`, `QUALITY_VALIDATION_FAILED`.
- `boykopovar/AnyPS5`: the same quality defect and failure code.
- `TencentCloud/Octop`: `request_failed`, without a further failure code in the bounded diagnostic. Its underlying cause is not established by that receipt.

The successful batch's shared usage receipt records 32 logical calls, 43 attempts, 11 retries, 1,618,565 input and 305,606 output tokens. These are runtime counts, not proof of charges or remaining allowance. Per-repository holds remain visible under the existing contract; this recovery does not claim that all 40 summaries were admitted.

This single authorized full refresh, publication, deployment and public readback are verified. Future scheduled reliability and the three held summaries are separate follow-up scope. No product code, workflow, quality gate, paid budget, model, authentication or security setting was changed. WF/LF and other sessions were not modified.
