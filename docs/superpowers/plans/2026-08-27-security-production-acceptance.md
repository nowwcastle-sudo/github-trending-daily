# Security and Production Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 완성된 immutable SHA를 Codex Security로 검토·수정·재검증하고, 모든 workflow·data·UI·auth 기능이 production에서 같은 snapshot으로 정상 작동함을 증명한다.

**Architecture:** security scan artifact는 system temp에 두고 source-backed threat model → deep scan → validation/attack path → finding fix/verify → diff/full rescan 순으로 진행한다. 자동 test와 paired README까지 final candidate SHA에 포함해 다시 scan한 뒤에만 workflow를 활성화하고 한 번 dispatch한다. 그 exact Pages manifest, browser matrix와 OFA 기록을 최종 evidence set으로 묶으며 production 뒤 새 tracked edit·commit·push는 만들지 않는다. 검증된 bot child의 fetch와 ff-only local synchronization만 허용한다.

**Tech Stack:** Codex Security skills, Git/GitHub CLI, Node/Python/Firebase emulators, GitHub Actions/Pages, actual browser automation and manual Google consent.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md`

## Global Constraints

- Plans 1-4가 각각 local/full-test/mutation/browser/emulator/push 검증을 통과하고 workflow가 `bootstrap_v0_pending_approval`일 때 시작한다. 이번 plan의 Task 5가 최초 production 갱신이다.
- scan target은 시작 시 clean `HEAD == origin/main`인 immutable 40-hex SHA다.
- threat hypothesis와 validated finding을 구분한다.
- Critical/High와 auth isolation·secret·publication integrity·history loss 관련 Medium은 완료를 차단한다.
- `findings: []`는 검토한 SHA/범위의 reportable finding 0이라는 뜻이며 runtime 전체 안전 보장이 아니다.
- 비밀값, UID, 계정 식별자, token, header, raw error body를 scan report나 대화에 복사하지 않는다.
- 새 vault 기록은 `D:\OFA\OFA\00_원천` 하위에만 두고 더청춘 vault와 OFA `wiki`에는 쓰지 않는다.
- 다음 확장 후보를 자동 시작하지 않는다.
- repository Commit step은 명시된 `git add` 다음, `git commit` 전에 Transactional Refresh plan의 Common Commit Gate를 실행한다.

---

## File Structure

- Temporary directory derived in Task 1 as `$scanRoot`: threat model, coverage, findings, validation report.
- Modify only when validated findings require it: finding-owned source/test files.
- Modify `README.md`, `README.en.md`: final actual workflow/data/UI/auth behavior.
- Modify `tests/daily-refresh-workflow.test.mjs`: paired README exact claims.
- Do not update tracked screenshots after dispatch. Capture final production screenshots/evidence in system temp so the deployed SHA remains the final Git SHA.
- Create/update OFA actual-result notes only after production evidence is complete.

### Task 1: Freeze the security target and build a source-backed threat model

**Files:**
- Read-only repository source.
- Temporary security scan context outside the repository.

**Interfaces:**
- Produces canonical `threatModel` with summary, assets, trustBoundaries, attackerCapabilities, securityObjectives, assumptions.

- [ ] **Step 1: Freeze and record the target**

Run in PowerShell:

```powershell
git fetch origin main
git status --short --branch
$securitySha = git rev-parse HEAD
$remoteSha = git rev-parse origin/main
if ($securitySha -ne $remoteSha) { throw 'Security target is not clean origin/main' }
if ($securitySha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid security SHA' }
if ((Select-String -LiteralPath '.github/workflows/daily-refresh.yml' -SimpleMatch 'bootstrap_v0_pending_approval').Count -ne 1) { throw 'Security target is not pending-safe' }
if ((Select-String -LiteralPath '.github/workflows/daily-refresh.yml' -SimpleMatch 'bootstrap_v0_approved').Count -ne 0) { throw 'Security target was activated before scan' }
$scanId = "${securitySha}_$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))"
$scanRoot = Join-Path $env:TEMP "codex-security-scans\gh-trending-page\$scanId"
New-Item -ItemType Directory -Path $scanRoot -Force | Out-Null
```

Require an empty short-status body after the branch line.

- [ ] **Step 2: Read Codex Security instructions**

Read the full `codex-security:threat-model`, `codex-security:deep-security-scan`, `codex-security:validation`, `codex-security:attack-path-analysis`, `codex-security:fix-finding`, `codex-security:verify-fix`, and `codex-security:security-diff-scan` skill files and their directly required references before invoking them.

- [ ] **Step 3: Resolve repository security policy**

Search for every applicable `SECURITY.md` from repository root to scoped files. If none exists, record that absence; do not invent a repository policy. Apply the approved design invariants as user context.

- [ ] **Step 4: Generate a per-scan threat model**

Use the exact repository root and `$securitySha`. Model the GitHub Actions secrets/permissions, public README and LLM boundary, translated Markdown/DOM, URL/export inputs, Firebase Auth/Rules/App Check, SQLite parent continuity, Pages artifact/deployment/readback, and external action/CDN dependencies.

- [ ] **Step 5: Delegate one fresh-context architecture review**

Spawn one fresh-context subagent with only the authorized repository path, immutable SHA, scope, approved security invariants, and threat-model guide. It performs read-only architecture mapping, not a vulnerability scan. Verify every material claim against source lines before incorporating it.

- [ ] **Step 6: Check threat-model completeness**

Every trust boundary must have source evidence or be labeled deployment assumption/unknown. Confirm attacker capabilities do not assume operator/Firebase/GitHub account compromise. Store only safe secret references, never values.

### Task 2: Run repository-wide Codex Security discovery and validation

**Files:**
- Temporary scan artifacts only until a validated finding exists.

**Interfaces:**
- Produces canonical findings and coverage for the immutable target.

- [ ] **Step 1: Invoke repository-wide deep scan**

Run `codex-security:deep-security-scan` for the whole repository at `$securitySha`, using the per-scan threat model and actual source inventory. Include production workflow and generated/runtime source; distinguish tests/docs from privileged paths.

- [ ] **Step 2: Require coverage dispositions**

Coverage must explicitly address: Actions triggers/permissions/secrets/action pinning; GitHub/Anthropic request construction and logs; prompt injection; Markdown rendering and URL schemes; inline JSON/script termination; URL state; CSV formula/quoting; clipboard/blob lifecycle; Firebase persistence/tokens/Rules/App Check; account switching; SQLite replacement; Pages allowlist/manifest/recovery; external scripts/SRI.

- [ ] **Step 3: Validate every candidate independently**

Use `codex-security:validation` to establish source-to-sink reachability, existing controls, required attacker input and concrete impact. Reject keyword-only, self-only, already-authorized, unreachable, test-only and configuration-free hypotheses with evidence.

- [ ] **Step 4: Analyze attack paths for surviving candidates**

Use `codex-security:attack-path-analysis`. Assign severity from actual privilege gain and affected asset, not from vulnerability class name. Preserve prerequisites and confidence separately.

- [ ] **Step 5: Branch on canonical result**

If canonical findings are empty, preserve the exact coverage/open questions and proceed to Task 4. If findings exist, continue to Task 3 and do not run final production acceptance yet.

### Task 3: Fix and verify every blocking finding

**Files:**
- Modify only files named by validated source/sink evidence.
- Add one RED test per finding in the nearest existing test suite.

**Interfaces:**
- Consumes one validated finding at a time.
- Produces a test-backed fix plus verification receipt.

- [ ] **Step 1: Triage findings in severity and dependency order**

Order Critical, High, blocking Medium, then nonblocking Low. Deduplicate findings sharing the same root cause. For each item record exact id, affected SHA/path, attack prerequisite, expected blocked behavior and owning test file.

- [ ] **Step 2: Invoke `codex-security:fix-finding` for one finding**

The fix must preserve the approved product contract and avoid new dependency/server/framework. If a fix adds a public runtime asset, first add a failing exact-allowlist test, then update `scripts/build-pages-artifact.mjs` and `tests/pages-publication.test.mjs`; never broaden the copy rule. If the proposed fix expands scope or changes a user-approved behavior, stop and request a design amendment rather than silently implementing it.

- [ ] **Step 3: Write and run the RED test before source change**

Use the concrete payload/path from validation in a safe fixture. Confirm the test fails for the expected security reason, not syntax or harness failure.

- [ ] **Step 4: Apply the minimum fix and run focused/full tests**

Run the focused test, `npm test`, and `npm run test:rules` when auth/Rules are affected. Inject the original vulnerable mutation and prove the new test fails, then restore.

- [ ] **Step 5: Verify the finding and scan the diff**

Use `codex-security:verify-fix` against the original finding and `codex-security:security-diff-scan` against the exact fix diff. A passing test without source-to-sink revalidation is insufficient.

- [ ] **Step 6: Commit the isolated fix**

Stage only finding-owned source/test files and run the staged secret scanner. Set `$findingId` to the canonical finding id produced by Task 2, require `$findingId -match '^[A-Za-z0-9._-]+$'`, then commit with `git commit -m "security: block $findingId attack path"`. Repeat Tasks 3.2-3.6 for each additional validated finding.

- [ ] **Step 7: Push all isolated fixes while dispatch remains disabled**

After all finding commits, run `npm test`, `npm run test:rules` when available, and the Common Commit Gate. Fetch origin, display the exact local log/diff, require fast-forward eligibility, push and require clean `HEAD == origin/main`. Reassert exact pending/approved string counts. Do not dispatch, deploy or spend LLM budget here.

- [ ] **Step 8: Full rescan the new pushed immutable SHA**

At that new clean `HEAD == origin/main` SHA, repeat Task 1 target freeze and Task 2 repository-wide scan. Do not reuse a threat model whose Repository/Version footer does not match unless the scan workflow explicitly creates a per-scan copy and updates evidence. Repeat Tasks 3.1-3.8 until no blocking finding remains, always with pending workflow state.

### Task 4: Execute the complete automated acceptance matrix

**Files:**
- No intended source changes; failures return to their owning plan.

**Interfaces:**
- Produces exact command exit codes and artifact/count evidence.

- [ ] **Step 1: Run all local suites**

```powershell
npm test
npm run test:rules
git diff --check
```

Require Node and Python pass, Firestore Rules executed without skip, and exit 0 for all commands.

- [ ] **Step 2: Run targeted workflow/data validators**

Run the context, LLM, Markdown XSS, latest/Atom integration, observation DB, artifact builder/probe, UI motion, auth lifecycle and workflow shell suites individually. This proves they are collected by the full suite and gives per-boundary exit evidence.

- [ ] **Step 3: Inspect the current real-data distribution**

Run the exact offline two-snapshot candidate rehearsal and read-only scripts that report counts/hashes only: current repository count; summary valid/invalid; translation applicable/N/A/mismatch; snapshot/item count; release versions/inventories/latest ids; OSS estimates versus exact observations; commit events; README change events; null source/selected colors; watcher/subscriber separation; canonical tags; placeholder/fallback; compact fields; SQLite integrity/foreign keys/sidecars. Inspect representative records without private/auth data. Production DB is not expected to exist yet.

- [ ] **Step 4: Cross-check public artifacts**

Assert the locally built candidate page/latest/membership/feed/star-history use one snapshot id, repository counts and order match where required, DB `artifact_hashes` exactly equals the Pages allowlist/hash set, Atom summaries are nonempty, CSV/JSON/share URL exclude private state, and original README bodies do not occur in the analytical DB or tracked cache.

- [ ] **Step 5: Re-run deliberate mutations**

Execute the documented mutations for LLM swallowed failure, Atom field drift, midnight clock, stale metadata, DB truncation, Pages SHA mismatch, Markdown XSS, unrestricted mobile swipe, BFCache dispose, persistence order and Rules UID equality. Restore each mutation immediately and require clean source afterward.

- [ ] **Step 6: Synchronize paired README before activation and rescan that commit**

Write RED assertions for paired Korean/English claims, then update both READMEs from locally proven implementation behavior: transactional 2-hour refresh; facts/events before paid LLM; canonical detailed tooltip; hover rail/mobile edge swipe; explicit local auth persistence; exact observations plus separately labeled OSS Insight estimates; release/full-inventory and prospective commit boundaries; original README body temp-only; translated Markdown retained in Pages JSON; CSV/JSON/share privacy; explicit Pages deploy/probe. Commit subject/message/name/email/files/patch are all absent—do not repeat the superseded “subject first line” claim. Keep section order and feature counts 1:1.

Run `npm test`, stage only both READMEs and their exact tests, secret-scan and commit `docs: document verified refresh and persistence behavior`. Fetch/push without dispatch, require clean `HEAD == origin/main` and pending workflow state, then repeat Tasks 1–2 for this exact docs-inclusive candidate SHA. Only a full scan with zero blocking findings may proceed to Task 5.

### Task 5: Run real workflow, Pages and browser production acceptance

**Files:**
- Generated production snapshot only.

**Interfaces:**
- Produces one Actions run id, bot commit SHA, Pages deployment and production manifest evidence.
- This is the one and only paid/manual dispatch authorized for this completion. It creates one production `migration_baseline`; Plan 2's offline two-snapshot rehearsal proves later `refresh` behavior.

- [ ] **Step 1: Fetch immediately before dispatch**

Set `$holdAuditOriginUtc` from the local clock before the first Actions query. Enumerate all `daily-refresh.yml` schedule runs currently queued/in-progress and retain their run ids as `$preHoldIncompleteRunIds`; do not infer safety from an empty list without also checking the API exit and pagination. Then set/read back hold:

```powershell
git fetch origin main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'Local main is not current' }
if (git status --porcelain) { throw 'Worktree is not clean' }
gh variable set GH_TRENDING_REFRESH_SCHEDULE --body hold --repo nowwcastle-sudo/github-trending-daily
$scheduleHold = (gh variable get GH_TRENDING_REFRESH_SCHEDULE --repo nowwcastle-sudo/github-trending-daily).Trim()
if ($scheduleHold -ne 'hold') { throw 'Scheduled refresh hold readback failed' }
```

Immediately after hold readback, enumerate again and form the immutable audit set as the union of `$preHoldIncompleteRunIds` plus every schedule run created at or after `$holdAuditOriginUtc`. Drain that set before freezing any source/manifest/plan-only identity. A run created after hold must be exact guard-skipped with zero RunContext, GitHub/OSS/Anthropic fetch, commit, artifact, publisher and deploy work. A pre-hold incomplete run that had already passed the enabled gate may not be treated as skipped: wait for it, require a successful independently verified normal-maintenance receipt and resulting source/production consistency, then restart Step 1 from a fresh audit origin while hold remains set. Any failed, ambiguous, unverified or still-running pre-hold run stops acceptance. This closes the query/set race; no activation or paid dispatch may overlap a pre-hold run.

Only after the drained/restarted audit set is clean, fetch origin again, require a clean fast-forward-equal checkout, reprobe the production manifest, and rerun the final `--plan-only` bootstrap receipt with Anthropic fetch 0. Remeasure source/snapshot and the fixed `11,500,000` input / `1,200,000` output caps, and stop on any drift/excess. Restate immediately that `$17.50` is a conservative maximum allocation, not an expected bill, and that an extremely slow provider can consume part of it while publication remains 0. Apply the separately tested minimal `bootstrap_v0_approved` activation commit, full tests, staged scanner, source-backed threat-model delta and `codex-security:security-diff-scan`; independently validate any candidate finding. Fetch/push only with zero blocking finding and bind the dispatch to that exact remote SHA. Do not dispatch from the activation step and do not raise caps. Preserve a system-temp audit receipt containing only repository, variable name, `hold`, UTC timestamp and activation SHA; never include secret values. Missing, differently cased, padded, partial or numeric schedule values must already have failed the workflow tests with RunContext/external fetch/commit all at zero. Any failure from this point leaves the variable at `hold` until a new explicit recovery decision.

- [ ] **Step 2: Resolve the bootstrap parent, dispatch once and capture the exact run id**

```powershell
$manifestUrl = 'https://nowwcastle-sudo.github.io/github-trending-daily/deployment-manifest.json'
$manifestStatus = (curl.exe -sS -o NUL -w '%{http_code}' "${manifestUrl}?probe=$([guid]::NewGuid())").Trim()
if ($LASTEXITCODE -ne 0) { throw 'Production manifest status request failed' }
if ($manifestStatus -eq '404') {
  $pagesBuild = gh api 'repos/nowwcastle-sudo/github-trending-daily/pages/builds/latest' | ConvertFrom-Json
  $bootstrapSourceSha = $pagesBuild.commit
  if ($pagesBuild.status -ne 'built' -or $bootstrapSourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid last successful Pages build' }
  git merge-base --is-ancestor $bootstrapSourceSha origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Pages bootstrap is not an origin/main ancestor' }
  node scripts/probe-production.mjs --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ --bootstrap-preflight-sha $bootstrapSourceSha
  if ($LASTEXITCODE -ne 0) { throw 'Bootstrap production does not match Pages build' }
  $dispatch = node scripts/dispatch-refresh.mjs --wait --bootstrap-source-sha $bootstrapSourceSha | ConvertFrom-Json
} elseif ($manifestStatus -eq '200') {
  $dispatch = node scripts/dispatch-refresh.mjs --wait | ConvertFrom-Json
} else {
  throw "Unexpected production manifest status $manifestStatus"
}
if (-not $dispatch.runId -or -not $dispatch.sourceSha -or -not $dispatch.snapshotId -or -not $dispatch.manifestSha256) { throw 'Acceptance dispatch returned an incomplete receipt' }
```

This command is executed exactly once. Any nonzero workflow/deploy/probe result preserves its receipt and stops; it is not followed by a second manual dispatch without a new explicit user decision.

- [ ] **Step 3: Bind bot commit, Pages and manifest**

Fetch origin after success and run `scripts/verify-refresh-chain.mjs` with all four immutable receipt fields. Require `effectiveRunId == expectedRunId == $dispatch.runId`, manifest file hashes, successful deploy/probe, and `origin/main == verified.sourceSha`. Prove `HEAD..origin/main` is a fast-forward containing only the approved generated-path regex, then `git merge --ff-only origin/main` and require a clean equal readback. Re-enumerate the Step 1 audit set plus every scheduled workflow run created since its final fresh `$holdAuditOriginUtc`. Before release, wait for any queued/in-progress schedule run to complete or stop acceptance. Every post-hold completed run must prove its exact schedule guard skipped the build before RunContext, GitHub/OSS/Anthropic fetch, commit, artifact, publisher and deploy work; those counts are all zero. Zero held runs is allowed but not required. Any post-hold schedule run that passes the guard or begins external/publication work, or any unaccounted pre-hold incomplete run, is a breach and stops acceptance without rebinding to a newer branch value.

SQLite is intentionally absent from Pages. Materialize `data/repository-observations.sqlite` from the exact `verified.sourceSha` Git blob (equivalent to `git show $verified.sourceSha:data/repository-observations.sqlite`) into a new system-temp file, hash-bind it to that source commit, inspect read-only, and delete it in `finally`. Require exact schema fingerprint, 14 tables, one and only one `migration_baseline`, zero fabricated production `refresh`, current item count/order equal page/latest/feed contracts, all first memberships `baseline_present`, frozen legacy membership/public-star/exact-star identities and public timeline equivalence, release inventory counts/hashes/latest ids valid, OSS complete receipts/versions, summary/translation provenance joins exact, `artifact_hashes` equal Pages files, integrity/foreign-key checks clean and no sidecars.

- [ ] **Step 4: Execute actual browser matrix**

At 390, 720, 1200, 1440px verify filters, period/language/field/form/sort, favorites, hidden/undo/restore, membership badges/recent exits, CSV/JSON/share URL, detailed tooltip, README Korean/source tabs, desktop hover/modal sidebar, mobile edge swipe/close/second tap, light/dark/reduced motion, keyboard focus/Escape and no console/network error.

Capture production screenshots and the matrix receipt only in system temp. Do not create a post-dispatch screenshot commit.

- [ ] **Step 5: Reconfirm login persistence**

Ask the user only for account selection/consent, then repeat refresh/new-tab/browser-restart/BFCache/cross-tab logout/guest separation at the exact production SHA. Record no identity data. Local/emulator Plan 4 evidence is not a substitute for this production matrix.

- [ ] **Step 6: Verify external failure paths without damaging production**

Use fixtures/local candidate runs for missing Anthropic key, truncated output, GitHub 500/429, README 404, Pages manifest mismatch, App Check initialization failure, Firebase persistence/storage denial, clipboard denial, recovery deploy that keeps the overall workflow red, and a version-0 next-run retry. Do not intentionally corrupt main or production.

- [ ] **Step 7: Read-only full security scan of the exact deployed bot commit**

Freeze `verified.sourceSha` and rerun Tasks 1–2 against that exact source, including generated HTML/JSON/translation inputs now present. Do not mutate source during this scan. Zero blocking findings is required for Task 5 success. If a blocking finding appears, preserve it and stop without an automatic fix push or second dispatch; remediation requires a new explicit user decision because the authorized one-run boundary has been consumed.

### Task 6: Record actual results outside Git, read back and stop

**Files:**
- Create/update only under: `D:\OFA\OFA\00_원천\10_클로드작업기록\` and `D:\OFA\OFA\00_원천\47_의사결정기록\`.
- After the verified bot child fast-forward, no new tracked edit, commit or push is allowed. Read-only inspection plus `git fetch` and the one verified `git merge --ff-only` synchronization in Task 5 are the only permitted Git mutations after dispatch.

**Interfaces:**
- Produces clean `HEAD == origin/main == verified.sourceSha`, OFA actual-result records and final evidence report.

- [ ] **Step 1: Update OFA from actual results only**

Read the three governing OFA sources named by the handoff, then create/update exactly `D:\OFA\OFA\00_원천\10_클로드작업기록\2026-08-27_GitHub_Trending_워크플로·데이터·UI·로그인지속_구현결과.md` and `D:\OFA\OFA\00_원천\47_의사결정기록\2026-08-27_GitHub_Trending_원자적게시·관측원장·로그인지속_결정.md` using local templates/tag rules. Record the deployed SHA, expected/effective workflow and Pages run ids, measured tests, pre-dispatch security result scope, production checks, changed decisions, rejected alternatives and reversal conditions. Do not write to 더청춘 or OFA `wiki`.

- [ ] **Step 2: Restore the natural schedule only after every acceptance record is complete**

Require the manual run, Pages probe, browser matrix, production login persistence, external failure fixtures, exact deployed-source security scan, and OFA readback all green. Re-enumerate the final Step 1 audit set plus every schedule run created since its fresh hold audit origin and apply Task 5 Step 3's exact audit: no unaccounted pre-hold run exists, none may remain queued/in-progress, and every post-hold completed run must be guard-skipped with zero RunContext, external fetch, commit, artifact, publisher and deploy work. Then set `GH_TRENDING_REFRESH_SCHEDULE` to exact lowercase `enabled`, immediately read it back, and append only repository, variable name, `enabled`, UTC timestamp and verified source SHA to the system-temp/OFA audit receipt. Do not use a workflow input or Git commit to release the schedule. Failure before this step leaves `hold`; failure to read back exact `enabled` is not completion. A later natural run after this release is normal maintenance and is not part of the one paid/manual acceptance dispatch.

- [ ] **Step 3: Re-read final state and produce the scoped report**

Run `git fetch origin main` and require clean `HEAD == origin/main == verified.sourceSha` at the acceptance readback point; this fetch may update Git metadata but may not introduce a new tracked edit, commit or push. Confirm the retained Task 5 receipt names that exact SHA/snapshot and the schedule receipt is exact `enabled`. Re-run only non-mutating production probes and status reads. Report baseline/final SHA, commits, test counts and exit codes, Rules execution, Actions/Pages ids, production snapshot/hash result, browser matrix, login persistence, Codex Security findings/coverage/open questions, collected data tables/counts, README/OFA paths and any nonblocking uncertainty. If a legitimate natural schedule finishes after the release before this readback, retain its separate receipt and verify it independently rather than claiming the manual baseline SHA is still current.

- [ ] **Step 4: Stop**

Do not dispatch a second workflow, create a post-production documentation/screenshot commit, start L1-L5 or M1 follow-ons, or choose an expansion candidate. Ask whether the user wants to end the session; only after explicit consent perform the configured session retrospective.
