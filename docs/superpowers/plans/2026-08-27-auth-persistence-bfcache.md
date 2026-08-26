# Auth Persistence and BFCache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Firebase Google 로그인을 같은 browser origin에서 명시적 logout까지 유지하고, BFCache·새 탭·계정 전환에서도 guest/account 즐겨찾기 경계를 보존한다.

**Architecture:** 기존 `getAuth(app)`과 `FavoriteSync`를 유지하면서 `browserLocalPersistence` 완료를 auth observer와 popup보다 앞에 둔다. 작은 `auth-lifecycle.js`가 pagehide/pageshow의 persisted 상태를 관리하고 Firebase module은 UI와 controller를 idempotent하게 복원한다.

**Tech Stack:** Firebase browser modules 12.17.1, vanilla JavaScript, Firestore emulator, Node test runner, actual Google OAuth production validation.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md`

## Global Constraints

- Plan 3 production UI 검증이 끝난 뒤 시작한다.
- 로그인 persistence는 `browserLocalPersistence`; session/memory로 조용히 낮추지 않는다.
- persistence 완료 전 auth observer·Google popup·login enable을 허용하지 않는다.
- persistence 실패는 guest controller를 유지하고 명확한 한국어 상태를 표시한다.
- Firestore sync 실패는 auth session을 임의 logout하지 않는다.
- `pagehide.persisted === true`에서는 controller/observer를 dispose하지 않는다.
- logout은 account favorites를 guest storage에 복사하지 않는다.
- 실제 Google account 선택·동의는 사용자만 수행하며 credential/token을 출력하지 않는다.
- 모든 Commit step은 명시된 `git add` 다음, `git commit` 전에 Transactional Refresh plan의 Common Commit Gate를 실행한다.

---

## File Structure

- Create `auth-lifecycle.js`: BFCache-aware, idempotent lifecycle helper.
- Create `tests/auth-lifecycle.test.mjs`: persisted/non-persisted transitions and duplicate listeners.
- Modify `firebase-client.js`: explicit persistence, startup ordering, guest fallback, lifecycle.
- Modify `tests/favorite-sync.test.mjs`: SDK import/order/failure/UI contract.
- Modify `index.html`: lifecycle helper load order and pending auth accessibility state.
- Modify `tests/page-runtime.test.mjs`: script order and visible status.
- Modify `scripts/build-pages-artifact.mjs`: add the new runtime to the exact Pages allowlist.
- Modify `tests/pages-publication.test.mjs`: require the auth lifecycle runtime and reject extras.
- Verify `favorite-sync.js` behavior; modify only if a failing lifecycle/race test proves a defect.

### Task 1: Make auth persistence explicit and ordered

**Files:**
- Modify: `firebase-client.js`
- Modify: `tests/favorite-sync.test.mjs`

**Interfaces:**
- Firebase imports: `browserLocalPersistence`, `setPersistence`.
- `bootstrap()` does not register auth state or login handlers until persistence resolves.

- [ ] **Step 1: Write ordering RED tests**

```js
test("local persistence resolves before observer and popup wiring", async () => {
  const { source } = await loadFirebaseClientForTest();
  const persistence = source.indexOf("await setPersistence(auth, browserLocalPersistence)");
  assert.ok(persistence > source.indexOf("const auth = getAuth(app)"));
  assert.ok(persistence < source.indexOf("onAuthStateChanged(auth"));
  assert.ok(persistence < source.indexOf('login.addEventListener("click"'));
});
```

Add a runtime harness where `setPersistence` returns a controlled promise; assert observer registration, account-controller replacement, guest disposal, and `login.disabled=false` remain absent until resolve. Add three failure harnesses: persistence rejection before guest replacement; App Check initialization rejection; and an unrelated later bootstrap rejection after persistence. In all three, the original guest controller stays usable, no popup/observer/account handler is installed, no raw error is rendered, and account actions remain unavailable. Only the persistence case may render the persistence-specific Korean message; App Check and later-bootstrap failures must render distinct generic login-unavailable messages.

- [ ] **Step 2: Run RED**

Run: `node --test tests/favorite-sync.test.mjs`

Expected: FAIL because imports/call are missing.

- [ ] **Step 3: Implement explicit local persistence**

Add to the pinned Firebase Auth import:

```js
browserLocalPersistence,
setPersistence,
```

Use a two-phase bootstrap. Phase A leaves the existing guest controller and guest event path live while it validates config, initializes app, App Check, Auth, and the Firestore handle (without creating a cloud adapter/controller), sets pending account UI state, and runs immediately after `const auth = getAuth(app);`:

```js
await setPersistence(auth, browserLocalPersistence);
```

Only after persistence succeeds does Phase B use the already-created Firestore handle to prepare the cloud adapter/account-controller resources. Register `onAuthStateChanged` and login/logout handlers into a disposable resource bundle while account actions remain disabled; only after the entire bundle is ready may it atomically replace/dispose the guest controller, publish the bundle, and enable login. A generation token prevents an older partial bootstrap from replacing a newer guest/account state.

- [ ] **Step 4: Implement fail-closed storage denial**

Remove the broad `bootstrap().catch(keepGuestMode)` classification. Catch App Check/config initialization, persistence, and Phase-B resource failures at their owning boundary; dispose only resources created by that failed phase and retain the pre-existing guest controller. Persistence failure displays `이 브라우저에서 로그인 상태를 저장할 수 없어 브라우저 저장으로 사용합니다.`; App Check/config failure displays `로그인 보안 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.`; a later resource failure displays `로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.`. Every case hides/disables account actions, never calls popup, and never includes the raw Firebase error.

- [ ] **Step 5: Mutation and tests**

Run each mutation separately and restore it: move `setPersistence` after `onAuthStateChanged`; dispose guest before persistence; route an App Check failure through the persistence message; restore the broad catch so an unrelated later error is mislabeled. Require the ordering, guest-retention, App Check, and error-classification tests to fail respectively. Run focused and full tests.

- [ ] **Step 6: Commit**

```powershell
git add firebase-client.js tests/favorite-sync.test.mjs
git commit -m "fix: make Firebase login persistence explicit"
```

### Task 2: Preserve live controllers through BFCache

**Files:**
- Create: `auth-lifecycle.js`
- Create: `tests/auth-lifecycle.test.mjs`
- Modify: `index.html`
- Modify: `firebase-client.js`
- Modify: `tests/page-runtime.test.mjs`
- Modify: `scripts/build-pages-artifact.mjs`
- Modify: `tests/pages-publication.test.mjs`

**Interfaces:**
- `AuthLifecycle.create({ target, onDiscard, onRestore }): { start, stop }`.
- `start()` and `stop()` are idempotent.

- [ ] **Step 1: Write lifecycle RED tests**

```js
test("BFCache hide preserves resources and restore runs once", () => {
  const calls = [];
  const lifecycle = AuthLifecycle.create({ target, onDiscard: () => calls.push("discard"), onRestore: () => calls.push("restore") });
  lifecycle.start(); lifecycle.start();
  target.emit("pagehide", { persisted: true });
  target.emit("pageshow", { persisted: true });
  assert.deepEqual(calls, ["restore"]);
});

test("real discard disposes once", () => {
  target.emit("pagehide", { persisted: false });
  target.emit("pagehide", { persisted: false });
  assert.deepEqual(calls, ["discard"]);
});
```

Add a Pages-publication RED assertion that the exact version-1 runtime allowlist now contains `auth-lifecycle.js` once. It must fail before the builder changes; no wildcard or broad JavaScript copy is allowed.

- [ ] **Step 2: Run RED**

Run: `node --test tests/auth-lifecycle.test.mjs tests/pages-publication.test.mjs`

- [ ] **Step 3: Implement the lifecycle helper**

Use a UMD pattern matching `favorite-sync.js`. `pagehide` calls `onDiscard()` only when `event.persisted === false`; `pageshow` calls `onRestore()` only when `event.persisted === true`. `stop()` removes both listeners. Internal booleans prevent duplicate registration and duplicate discard.

- [ ] **Step 4: Integrate without recreating Firebase Auth**

Add `auth-lifecycle.js` explicitly to the exported version-1 Pages allowlist and keep exact-path/extra-path tests green. Load it before the dynamic Firebase import. In `firebase-client.js`, replace the `{ once:true }` pagehide handler. `onDiscard` increments `authGeneration`, unsubscribes auth, disposes controller, and stops lifecycle. `onRestore` does not recreate the disposed controller because persisted hide never disposed it; it re-applies login/logout visibility, sync label, and current favorites from `auth.currentUser`/controller.

- [ ] **Step 5: Add cross-event mutation test**

Temporarily call `controller.dispose()` for persisted hide; verify lifecycle integration test failure. Restore. Run new tests, favorite/page tests and `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add auth-lifecycle.js firebase-client.js index.html scripts/build-pages-artifact.mjs tests/auth-lifecycle.test.mjs tests/favorite-sync.test.mjs tests/page-runtime.test.mjs tests/pages-publication.test.mjs
git commit -m "fix: preserve authentication through BFCache restores"
```

### Task 3: Verify account isolation under persistence and cross-tab changes

**Files:**
- Modify if required by RED: `favorite-sync.js`
- Modify: `tests/favorite-sync.test.mjs`
- Modify: `tests/firestore.rules.test.mjs`

**Interfaces:**
- Existing `FavoriteSync.createController` API remains stable.

- [ ] **Step 1: Add restored-session and cross-tab RED tests**

Test sequences:

1. guest list → restored Alice auth → cloud list
2. Alice auth callback pending → Bob auth callback → late Alice result ignored
3. restored Alice → cross-tab signout callback → guest list only
4. Firestore listener error → Alice auth label retained, account cache displayed
5. logout → reload harness → no account favorites in guest key

Use exact assertions on controller mode, subscriptions, storage writes, and visible state; never inspect Firebase token values.

- [ ] **Step 2: Run RED/green classification**

Run: `node --test tests/favorite-sync.test.mjs`. If current generation/subscription logic already passes, record it as verified and do not edit `favorite-sync.js`; still deliberately remove the generation guard in a temporary mutation and require the late-Alice-result test to fail, then restore. If a test initially fails, change only the proven boundary and repeat the same mutation proof after green.

- [ ] **Step 3: Execute Firestore Rules, not skips**

Run:

```powershell
npm run test:rules
```

Require owner CRUD pass; collection query, unauthenticated, other UID, extra field, client timestamp, non-list, duplicate and 501-item cases denied. Temporarily remove UID equality in a local mutation and verify the other-UID test fails, then restore.

- [ ] **Step 4: Full tests and commit**

Run `npm test` and `npm run test:rules`. Commit only files actually needed:

```powershell
git add favorite-sync.js tests/favorite-sync.test.mjs tests/firestore.rules.test.mjs
git commit -m "test: prove restored login keeps favorite isolation"
```

If `favorite-sync.js` is unchanged, omit it from `git add`.

### Task 4: Production login persistence acceptance

**Files:**
- No source change unless a reproduced defect requires returning to Tasks 1-3.

**Interfaces:**
- Consumes the production SHA deployed after Tasks 1-3.

- [ ] **Step 1: Full pre-push gates**

Run `npm test`, `npm run test:rules`, and `git diff --check`. Require a clean worktree after the verified auth commits, confirm that the per-commit staged secret scans passed, fetch origin, display `git log --oneline origin/main..HEAD` and `git diff --stat origin/main..HEAD`, and verify fast-forward push eligibility. Stop unless any remote advance is a verified refresh-bot-only fast-forward.

- [ ] **Step 2: Push and verify Pages**

Push the verified auth commits, explicitly dispatch the refresh/deploy workflow, and probe its exact bot SHA/snapshot:

```powershell
git fetch origin main
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
git merge-base --is-ancestor origin/main HEAD
if ($LASTEXITCODE -ne 0) { throw 'origin/main is not an ancestor of the auth commits' }
git push origin main
$dispatch = node scripts/dispatch-refresh.mjs --wait | ConvertFrom-Json
if (-not $dispatch.runId -or -not $dispatch.sourceSha -or -not $dispatch.snapshotId -or -not $dispatch.manifestSha256) { throw 'Auth dispatch returned an incomplete receipt' }
git fetch origin main
$verified = node scripts/verify-refresh-chain.mjs --expected-run-id $dispatch.runId --expected-source-sha $dispatch.sourceSha --expected-snapshot-id $dispatch.snapshotId --expected-manifest-sha256 $dispatch.manifestSha256 --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ | ConvertFrom-Json
if (-not $verified.effectiveRunId) { throw 'Auth production chain verification failed' }
if ((git rev-parse origin/main) -ne $verified.sourceSha) { throw 'Auth origin/main does not match verified production' }
git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) { throw 'Auth refresh bot commit is not a fast-forward' }
$allowedBotPath = '^(index\.html|data/(latest\.json|membership-status\.json|repo-summaries\.json|translation-sources\.json|repository-observations\.sqlite|readme-state\.json)|translations/[^/]+\.json|feed\.xml|changes\.xml|star-history\.json)$'
$unexpectedBotPaths = @(git diff --name-only HEAD..origin/main | Where-Object { $_ -notmatch $allowedBotPath })
if ($unexpectedBotPaths.Count) { throw "Unexpected auth bot paths: $($unexpectedBotPaths -join ', ')" }
git merge --ff-only origin/main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main) -or (git status --porcelain)) { throw 'Auth fast-forward readback failed' }
```

- [ ] **Step 3: Prepare the production browser**

Open `https://nowwcastle-sudo.github.io/github-trending-daily/` in the user's normal browser profile. Confirm no console error and that login status is ready. The user performs the Google account selection/consent once.

- [ ] **Step 4: Execute the persistence matrix**

Verify in order: login and favorite; refresh; duplicate tab; close the tab and reopen; close the browser and reopen; navigate away/back (BFCache); sign out in one of two tabs; verify the other tab returns to guest; reload after signout; verify guest/account favorites separation.

- [ ] **Step 5: Record exact outcomes without credentials**

Record browser/version, production SHA, each pass/fail, visible sync label and console error count. Do not record email, UID, token, storage value, or profile details.

- [ ] **Step 6: Stop before security scan on any failure**

If a real path fails, reproduce it with a RED test and return to the owning task. Do not claim persistence from SDK defaults or component tests alone.
