# Security and Production Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 완성된 immutable SHA를 Codex Security로 검토·수정·재검증하고, 모든 workflow·data·UI·auth 기능이 production에서 같은 snapshot으로 정상 작동함을 증명한다.

**Architecture:** security scan artifact는 system temp에 두고 source-backed threat model → deep scan → validation/attack path → finding fix/verify → diff/full rescan 순으로 진행한다. 그 뒤 자동 test, real workflow, Pages manifest, browser matrix, paired README와 OFA 기록을 하나의 최종 evidence set으로 묶는다.

**Tech Stack:** Codex Security skills, Git/GitHub CLI, Node/Python/Firebase emulators, GitHub Actions/Pages, actual browser automation and manual Google consent.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md`

## Global Constraints

- Plans 1-4가 각각 production에서 통과한 뒤 시작한다.
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
- Update `docs/screenshots/*.png` only if Plan 3 did not already commit exact production captures.
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
$productionReceipt = node scripts/verify-refresh-chain.mjs --current-production --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ | ConvertFrom-Json
if (-not $productionReceipt.effectiveRunId -or -not $productionReceipt.sourceSha -or -not $productionReceipt.snapshotId -or -not $productionReceipt.manifestSha256) { throw 'Current production has no unique verified receipt' }
$securitySha = $productionReceipt.sourceSha
$remoteSha = git rev-parse origin/main
if ((git rev-parse HEAD) -ne $securitySha -or $securitySha -ne $remoteSha) { throw 'Security target is not clean deployed origin/main' }
if ($securitySha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid security SHA' }
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

- [ ] **Step 7: Publish and deploy all isolated fixes**

After all finding commits, run `npm test`, `npm run test:rules` when available, and the Common Commit Gate. Fetch origin, display the exact local log/diff, require fast-forward eligibility, push, then dispatch with `scripts/dispatch-refresh.mjs --wait`. Verify its immutable receipt with `scripts/verify-refresh-chain.mjs`, prove any bot commit changes only the approved generated paths, and fast-forward locally. Require clean `HEAD == origin/main` at the verified production source SHA. A failed dispatch/deploy/probe returns to the owning finding; it is not a scannable completion state.

- [ ] **Step 8: Full rescan the new deployed immutable SHA**

At that new clean production SHA, repeat Task 1 target freeze and Task 2 repository-wide scan. Do not reuse a threat model whose Repository/Version footer does not match unless the scan workflow explicitly creates a per-scan copy and updates evidence. Repeat Tasks 3.1-3.8 until no blocking finding remains.

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

Run read-only scripts that report counts/hashes only: current repository count; summary valid/invalid; translation applicable/N/A/mismatch; snapshot count; snapshot item count; release versions; commit events; README change events; null language colors; placeholder/fallback; compact fields; SQLite integrity/foreign keys/sidecars. Inspect representative records without private/auth data.

- [ ] **Step 4: Cross-check public artifacts**

Assert page/latest/membership/feed/star-history use one snapshot id, repository counts and order match where their contracts require it, Atom summaries are nonempty, CSV/JSON export fields exclude private state, and README bodies do not occur in the analytical DB.

- [ ] **Step 5: Re-run deliberate mutations**

Execute the documented mutations for LLM swallowed failure, Atom field drift, midnight clock, stale metadata, DB truncation, Pages SHA mismatch, Markdown XSS, unrestricted mobile swipe, BFCache dispose, persistence order and Rules UID equality. Restore each mutation immediately and require clean source afterward.

### Task 5: Run real workflow, Pages and browser production acceptance

**Files:**
- Generated production snapshot only.

**Interfaces:**
- Produces one Actions run id, bot commit SHA, Pages deployment and production manifest evidence.

- [ ] **Step 1: Fetch immediately before dispatch**

```powershell
git fetch origin main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'Local main is not current' }
if (git status --porcelain) { throw 'Worktree is not clean' }
```

- [ ] **Step 2: Dispatch and capture the exact run id**

```powershell
$dispatch = node scripts/dispatch-refresh.mjs --wait | ConvertFrom-Json
if (-not $dispatch.runId -or -not $dispatch.sourceSha -or -not $dispatch.snapshotId -or -not $dispatch.manifestSha256) { throw 'Acceptance dispatch returned an incomplete receipt' }
```

- [ ] **Step 3: Bind bot commit, Pages and manifest**

Fetch origin after success and run `scripts/verify-refresh-chain.mjs` with all four immutable receipt fields. Require the expected/effective run evidence, manifest file hashes, successful deploy/probe, and `origin/main == verified.sourceSha`. Prove `HEAD..origin/main` is a fast-forward containing only the approved generated-path regex, then `git merge --ff-only origin/main` and require a clean equal readback. If a queued schedule already advanced production, retain both exact receipts and the verifier's fast-forward proof; do not silently bind acceptance to the newest branch value.

- [ ] **Step 4: Execute actual browser matrix**

At 390, 720, 1200, 1440px verify filters, period/language/field/form/sort, favorites, hidden/undo/restore, membership badges/recent exits, CSV/JSON/share URL, detailed tooltip, README Korean/source tabs, desktop hover/modal sidebar, mobile edge swipe/close/second tap, light/dark/reduced motion, keyboard focus/Escape and no console/network error.

- [ ] **Step 5: Reconfirm login persistence**

Use the already-authorized user interaction from Plan 4 if the same production SHA/session is available; otherwise ask the user only for account selection/consent and repeat refresh/new-tab/browser-restart/BFCache/cross-tab logout/guest separation. Record no identity data.

- [ ] **Step 6: Verify external failure paths without damaging production**

Use fixtures/local candidate runs for missing Anthropic key, truncated output, GitHub 500/429, README 404, Pages manifest mismatch, App Check initialization failure, Firebase persistence/storage denial, clipboard denial, recovery deploy that keeps the overall workflow red, and a version-0 next-run retry. Do not intentionally corrupt main or production.

### Task 6: Synchronize documentation and OFA actual results

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `tests/daily-refresh-workflow.test.mjs`
- Create/update only under: `D:\OFA\OFA\00_원천\10_클로드작업기록\` and, because decisions changed, `D:\OFA\OFA\00_원천\47_의사결정기록\`.

**Interfaces:**
- Paired README section order and feature bullet count remain 1:1.

- [ ] **Step 1: Write README RED assertions**

Update paired README tests to require transactional 2-hour refresh, canonical detailed tooltip, hover rail/mobile edge swipe, explicit local login persistence, exact observation data, explicit Pages deploy/probe, and removal of `홀수 시각의 07분`/click-only sidebar/compact mobile claims.

- [ ] **Step 2: Run RED and update Korean README**

Run `node --test tests/daily-refresh-workflow.test.mjs`; then edit only claims proven by production evidence. The paired assertions must require these exact semantics in both languages: original README bodies exist only in per-run temporary processing and are not stored in the analytical DB, archive, or repository cache; published Korean translated Markdown is retained in the Pages artifact; commit history starts prospectively from the observed default-branch head and stores only future commits; commit subject is the first line capped at 500 characters and excludes full message/email/patch/files; releases exclude body/assets. Also state public data sources, auth persistence limitations, and export privacy boundary.

- [ ] **Step 3: Mirror English README 1:1**

Keep headings, feature/roadmap bullet counts, workflow/data semantics, links, CSV columns and limitations aligned. Do not add a claim in only one language.

- [ ] **Step 4: Test and commit README pair**

Run `npm test`, stage both READMEs/test, secret-scan, and commit `docs: document verified refresh and persistence behavior`.

### Task 7: Final push, readback and stop

**Files:**
- All verified commits from security/docs only.

**Interfaces:**
- Produces clean `HEAD == origin/main` and final evidence report.

- [ ] **Step 1: Final staged secret scan and remote race check**

Run `git diff --cached --check`, the repository's staged secret pattern, `git fetch origin main`, and verify origin is an ancestor of HEAD. If origin advanced, inspect the exact remote diff and do not force/rebase/history-rewrite.

- [ ] **Step 2: Push documentation and dispatch the explicit final deployment**

Push main, fetch, and require the pushed docs SHA equals `origin/main`. Because Pages `build_type` is `workflow`, invoke `scripts/dispatch-refresh.mjs --wait`; do not wait for an implicit branch build. Require its complete immutable receipt.

- [ ] **Step 3: Verify the final receipt and fast-forward the bot commit**

Run `scripts/verify-refresh-chain.mjs` with the final dispatch receipt, require its exact Pages deploy/probe, inspect `HEAD..origin/main`, allow only the approved generated paths, and fast-forward with `git merge --ff-only origin/main`. Repeat the compact production smoke test for page/latest/feed/auth controls and require clean `HEAD == origin/main == verified.sourceSha`.

- [ ] **Step 4: Run the final repository-wide security scan at the deployed SHA**

Freeze the new exact deployed SHA and perform Task 1 plus the full Task 2 Codex Security scan again, including README/workflow/generated runtime changes since the prior scan. A diff-only scan is not sufficient. If a blocking finding appears, return to Task 3 and repeat publish/deploy/final scan. Once this final scan passes, make no further source, worktree, index, commit, or remote repository writes; later `git fetch` readback may update only remote-tracking refs.

- [ ] **Step 5: Update OFA from actual results only**

Read the three governing OFA sources named by the handoff, then create/update exactly `D:\OFA\OFA\00_원천\10_클로드작업기록\2026-08-27_GitHub_Trending_워크플로·데이터·UI·로그인지속_구현결과.md` and `D:\OFA\OFA\00_원천\47_의사결정기록\2026-08-27_GitHub_Trending_원자적게시·관측원장·로그인지속_결정.md` using the local templates/tag rules. Record the final deployed SHA, expected/effective workflow and Pages run ids, measured tests, final security result scope, production checks, changed decisions, rejected alternatives and reversal conditions. Do not write to 더청춘 or OFA `wiki`.

- [ ] **Step 6: Re-read final state and produce the scoped report**

Run read-only `git fetch origin main`, require clean `HEAD == origin/main`, and confirm the production receipt still names that SHA/snapshot. Report baseline/final SHA, commits, test counts and exit codes, Rules execution, Actions/Pages ids, production snapshot/hash result, browser matrix, login persistence, Codex Security findings/coverage/open questions, collected data tables/counts, README/OFA paths and any nonblocking uncertainty.

- [ ] **Step 7: Stop**

Do not start L1-L5, M1 follow-ons, or choose an expansion candidate. Ask whether the user wants to end the session; only after explicit consent perform the configured session retrospective.
