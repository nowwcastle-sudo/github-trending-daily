# Detailed Tooltip, Sidebar and Gestures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 viewport에서 같은 상세 요약을 제공하고, desktop full-height hover rail과 mobile edge swipe로 재배치된 dashboard sidebar를 부드럽고 접근 가능하게 연다.

**Architecture:** pure interaction 판정은 `ui-motion.js`에 두고 DOM modality·focus·inert 처리는 `index.html`의 기존 sidebar controller 경계에서 수행한다. hover non-modal, click/keyboard modal, mobile drag state를 명시적으로 구분한다.

**Tech Stack:** vanilla HTML/CSS/JavaScript, existing `ui-motion.js`, browser Pointer/Touch APIs, Node test runner, actual Chromium/Edge browser validation.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md`

## Global Constraints

- Plan 1과 Plan 2 production 검증이 끝난 뒤 시작한다.
- `impeccable`과 `apple-design`을 사용하고 `frontend-design`은 사용하지 않는다.
- desktop/mobile content는 canonical detailed summary 하나이며 compact branch는 0개다.
- desktop fine pointer rail은 `100dvh`; mobile/coarse pointer에는 rail과 hamburger가 없다.
- mobile open gesture는 왼쪽 24px 시작, horizontal 48px commit, vertical intent cancel이다.
- hover open은 focus·inert·scrim·scroll lock을 사용하지 않는다.
- click/keyboard modal open은 focus trap·restore·Escape·scrim·scroll lock을 유지한다.
- reduced motion에서는 translation animation을 제거한다.
- 모든 Commit step은 명시된 `git add` 다음, `git commit` 전에 Transactional Refresh plan의 Common Commit Gate를 실행한다.

## Approved Plan 3 Addendum — 2026-08-28

These four owner-approved additions are required Plan 3 inputs. Before implementation, run the named brainstorming and grilling design passes, then apply `impeccable` and `apple-design`; do not use `frontend-design`. Expand the items into RED tests and minimal implementation steps without weakening the existing sidebar, accessibility, URL-state, or motion contracts.

- Add a `신규 저장소만` checkbox immediately beside `AI 분야 제외`. Its exact filter meaning is membership status `new`; `reentered`, `stayed`, and unknown/unavailable membership are not new. Include the public filter in the existing shareable URL-state whitelist and preserve the current fail-closed input-size/value gates.
- Add three badge groups to each repository card: every stored `형태` tag, every stored `분야·기술` tag, and one `AI` badge only when the stored classification says the repository is AI-related. Do not invent tags from display prose, collapse a multi-tag repository to one value, or expose private/local state. Design and browser-test wrapping, density, contrast, screen-reader labeling, and 390/720/1200/1440px overflow before accepting the layout.
- Add a fixed bottom-right scroll-to-top control. It must have an accessible Korean name, keyboard activation, safe-area/sidebar/scrim awareness, no card or export overlap, deterministic visibility, and smooth scrolling only when reduced motion is not requested.
- Remove the title box border and separate surface color so its background exactly uses the page background token in light and dark modes. Preserve title hierarchy, spacing, contrast, and focus/landmark semantics; do not remove the title itself.
- Add actual-browser validation for the new filter, all multi-badge combinations, long Korean/English labels, the scroll-to-top control, light/dark, keyboard, touch, reduced motion, and horizontal overflow. Each requirement receives a deliberate mutation before the Plan 3 production gate.

---

## File Structure

- Modify `ui-motion.js`: sidebar open mode, edge gesture, duration/easing pure functions.
- Modify `tests/ui-motion.test.mjs`: thresholds, vertical cancel, reduced-motion, touch card navigation.
- Modify `index.html`: sidebar DOM order/copy, rail CSS, controller states, tooltip/bottom sheet.
- Modify `tests/page-runtime.test.mjs`: semantic structure, exact labels/order, modality and mobile exclusions.
- Modify `docs/screenshots/production-desktop.png`, `docs/screenshots/production-mobile-sidebar.png`: only after production verification.

### Task 1: Remove compact tooltip data and rendering branches

**Files:**
- Modify: `index.html`
- Modify: `tests/ui-motion.test.mjs`
- Modify: `tests/page-runtime.test.mjs`

**Interfaces:**
- `tipHTML(repo): string` consumes `repo.summary` as one detailed object.
- `UiMotion.touchCardAction` retains first-tap detail, second-tap repository navigation.

- [ ] **Step 1: Write RED assertions for one detailed contract**

```js
test("tooltip runtime has one detailed content path", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /function tipHTML\(r\)/);
  assert.doesNotMatch(html, /tipHTML\(r,detailed\)|r\.detail|mobile summary/i);
  for (const label of ["프로젝트 목표", "실행 방법", "장점", "단점·주의점", "어울리는 상황", "트렌드 한 줄 평"]) {
    assert.match(html, new RegExp(label));
  }
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/page-runtime.test.mjs tests/ui-motion.test.mjs`

- [ ] **Step 3: Collapse `tipHTML` to canonical summary**

Remove the `detailed` parameter and every `r.detail` branch. Render the six rows from `r.summary`; `stars_note` is deterministic data already attached by Plan 1. Desktop uses the floating container and mobile uses the bottom-sheet CSS, but both call the same function.

- [ ] **Step 4: Keep explicit mobile tap behavior**

Exclude `.favbtn`, `.js-readme`, `.js-hide-repo`, buttons and anchors from card navigation. First tap on a closed card calls `showTip`; second tap on the same open card assigns the GitHub URL. A tap on a different card moves the detail instead of navigating the prior card.

- [ ] **Step 5: Mutation and tests**

Temporarily call a compact formatter under `touchLayout()`; verify the single-contract test fails. Restore. Run focused tests and `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add index.html tests/page-runtime.test.mjs tests/ui-motion.test.mjs
git commit -m "fix: use one detailed tooltip on every viewport"
```

### Task 2: Reorder and rename the sidebar

**Files:**
- Modify: `index.html`
- Modify: `tests/page-runtime.test.mjs`

**Interfaces:**
- Sidebar heading: `대시보드 메뉴`.
- Refresh lines: recent time, next time, `2시간마다 갱신`.

- [ ] **Step 1: Add an exact DOM-order RED test**

Extract `#filterSidebar` and assert the ids appear in this order:

```js
const ids = [
  "refreshStatus", "accountSection", "viewSection", "periodSection", "languageSection",
  "fieldSection", "formSection", "sortSection", "resultSection", "hiddenRepoSection",
  "recentExitsSection", "exportSection",
];
assert.ok(ids.every((id, index) => index === 0 || sidebar.indexOf(`id="${ids[index - 1]}"`) < sidebar.indexOf(`id="${id}"`)));
```

Also assert exactly one `대시보드 메뉴`, exactly three refresh paragraphs, `2시간마다 갱신`, and absence of `서울 기준 홀수 시 07분`.

- [ ] **Step 2: Run RED**

Run: `node --test tests/page-runtime.test.mjs`

- [ ] **Step 3: Reorder existing sections without duplicating controls**

Move the existing account, favorite/view, period, language, field, form, sort, result/reset, hidden, recent exits, and export DOM blocks into the approved order. Preserve every existing id and label binding. Add section ids only where absent; do not clone event targets.

- [ ] **Step 4: Replace refresh copy**

`updateRefreshStatus` fills three existing `<p>` elements with `최근 갱신`, `다음 갱신`, and `2시간마다 갱신`. It continues to calculate the next time through `RefreshSchedule`, but no longer exposes cron wording.

- [ ] **Step 5: Verify keyboard order and scroll**

Add a test that focusable controls occur in DOM order and hidden sections do not create tab stops. Deliberately swap `periodSection` and `accountSection`; require the exact-order test to fail, restore, then run focused and full tests.

- [ ] **Step 6: Commit**

```powershell
git add index.html tests/page-runtime.test.mjs
git commit -m "refactor: prioritize sidebar filters and account controls"
```

### Task 3: Implement desktop full-height hover rail and modal fallback

**Files:**
- Modify: `ui-motion.js`
- Modify: `tests/ui-motion.test.mjs`
- Modify: `index.html`
- Modify: `tests/page-runtime.test.mjs`

**Interfaces:**
- `UiMotion.sidebarMode({ hoverCapable, trigger }): "hover" | "modal"`.
- DOM state: `sidebar.dataset.openMode` is absent, `hover`, or `modal`.

- [ ] **Step 1: Write RED mode and CSS tests**

```js
test("sidebar mode separates passive hover from modal activation", () => {
  assert.equal(UiMotion.sidebarMode({ hoverCapable: true, trigger: "pointer" }), "hover");
  assert.equal(UiMotion.sidebarMode({ hoverCapable: true, trigger: "keyboard" }), "modal");
  assert.equal(UiMotion.sidebarMode({ hoverCapable: false, trigger: "pointer" }), "modal");
});
```

Page tests assert `.nav-toggle`/rail uses `height:100dvh`, fine-pointer media query, and hover-open code does not set `pageMain.inert`, scrim, focus or `overlay-open`. A DOM timer harness moves the pointer out while focus remains in a sidebar control and asserts the sidebar stays open; after focus leaves both rail/sidebar, it closes. A click or keyboard interaction while hover-open must upgrade exactly once to modal semantics.

- [ ] **Step 2: Run RED**

Run: `node --test tests/ui-motion.test.mjs tests/page-runtime.test.mjs`

- [ ] **Step 3: Implement rail presentation**

At `@media (hover:hover) and (pointer:fine)`, make the left trigger fixed from `top:0` to `bottom:0`, keep its protruding width, remove the small rounded-button silhouette, and retain the current accent token with visible hover/focus state. Sidebar remains transform-based and `100dvh`.

- [ ] **Step 4: Implement open modes**

Replace boolean-only `openSidebar()` with `openSidebar(mode, trigger)`. Hover mode sets open classes and ARIA state but leaves focus, main inert, scrim and body scroll untouched. Modal mode additionally records trigger, enables scrim, sets main inert, locks scroll and focuses close. `closeSidebar` reverses only effects belonging to its current mode.

- [ ] **Step 5: Add hover intent**

`pointerenter` on rail/sidebar cancels a close timer and opens hover mode. `pointerleave` schedules close after 180ms only when both rail and sidebar are outside and `sidebar.matches(':focus-within')` is false. `focusin` cancels the timer; `focusout` re-evaluates after the related focus transition. Click and keyboard Enter/Space upgrade an open hover sidebar to modal instead of closing it.

- [ ] **Step 6: Mutation and tests**

Run each mutation separately and restore it: call `sidebarClose.focus()` in hover mode; remove the `:focus-within` close guard; make click on hover-open close instead of modal-upgrade. Require the modality, focused-control, and interaction-upgrade tests to fail respectively. Run focused/full tests.

- [ ] **Step 7: Commit**

```powershell
git add ui-motion.js index.html tests/ui-motion.test.mjs tests/page-runtime.test.mjs
git commit -m "feat: open the desktop sidebar from a full-height hover rail"
```

### Task 4: Implement mobile edge swipe open and swipe close

**Files:**
- Modify: `ui-motion.js`
- Modify: `tests/ui-motion.test.mjs`
- Modify: `index.html`
- Modify: `tests/page-runtime.test.mjs`

**Interfaces:**
- `UiMotion.startEdgeGesture({ x, y, sidebarOpen, withinSidebar }): Gesture | null`.
- `UiMotion.updateEdgeGesture(gesture, { x, y }): { state, progress }`.
- `UiMotion.finishEdgeGesture(gesture): "open" | "close" | "cancel"`.
- `UiMotion.cancelEdgeGesture(gesture): "cancel"` restores its exact prior open state.

- [ ] **Step 1: Write threshold RED tests**

```js
test("mobile gesture starts only in 24px edge and commits after 48px horizontal intent", () => {
  assert.equal(UiMotion.startEdgeGesture({ x: 25, y: 100, sidebarOpen: false, withinSidebar: false }), null);
  const gesture = UiMotion.startEdgeGesture({ x: 20, y: 100, sidebarOpen: false, withinSidebar: false });
  assert.equal(UiMotion.updateEdgeGesture(gesture, { x: 69, y: 105 }).state, "horizontal");
  assert.equal(UiMotion.finishEdgeGesture(gesture), "open");
});

test("vertical intent cancels without preventing scroll", () => {
  const gesture = UiMotion.startEdgeGesture({ x: 10, y: 100, sidebarOpen: false, withinSidebar: false });
  assert.equal(UiMotion.updateEdgeGesture(gesture, { x: 18, y: 140 }).state, "cancelled");
});

test("close threshold, short taps, and pointer cancellation restore the prior state", () => {
  const closing = UiMotion.startEdgeGesture({ x: 260, y: 100, sidebarOpen: true, withinSidebar: true });
  UiMotion.updateEdgeGesture(closing, { x: 211, y: 104 });
  assert.equal(UiMotion.finishEdgeGesture(closing), "close");
  const tap = UiMotion.startEdgeGesture({ x: 12, y: 100, sidebarOpen: false, withinSidebar: false });
  UiMotion.updateEdgeGesture(tap, { x: 16, y: 102 });
  assert.equal(UiMotion.finishEdgeGesture(tap), "cancel");
  const cancelled = UiMotion.startEdgeGesture({ x: 260, y: 100, sidebarOpen: true, withinSidebar: true });
  UiMotion.updateEdgeGesture(cancelled, { x: 230, y: 102 });
  assert.equal(UiMotion.cancelEdgeGesture(cancelled), "cancel");
  assert.equal(cancelled.sidebarOpen, true);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/ui-motion.test.mjs`

- [ ] **Step 3: Implement pure gesture state**

Track start/last x/y, prior open state, direction lock, and normalized sidebar-width progress. A closed gesture may start only at `x <= 24`; an open closing gesture may start only when `withinSidebar` is true. Register `pointermove` with `{ passive:false }` from the start but do not call `preventDefault()` or `setPointerCapture()` before horizontal intent is proven. Once `abs(dx) > 8` and `abs(dx) > abs(dy) * 1.2`, lock horizontal, prevent default, capture the pointer, and apply drag transform. Open commits at rightward 48px; close commits at leftward 48px or progress midpoint. Short movement, vertical intent, `pointercancel`, and `lostpointercapture` remove drag styles and restore the exact prior state.

- [ ] **Step 4: Wire touch/pointer lifecycle**

On coarse pointer, hide the desktop rail via CSS and do not render any transparent overlay, edge hit target, icon, label, or hamburger. Observe `pointerdown` in the document capture phase; when the sidebar is closed, create only an in-memory candidate for `clientX <= 24`, leaving the original event/target untouched. When open, accept closing starts only from within the sidebar. The document/body keeps vertical panning; register `pointermove` with `{ passive:false }`, but claim the pointer only after horizontal intent. During a claimed drag set `transition:none`; on release remove inline transform and call modal `openSidebar` or `closeSidebar`. A DOM harness dispatches an unclaimed down/up/click on a card at `x <= 24` and proves no gesture handler prevents it: first tap opens detailed tooltip, second tap follows the repository URL. It also proves a different-card tap, an ordinary link/button tap, `pointercancel`, and a start at `x=25` retain their existing behavior. Page tests reject any coarse-pointer hamburger or fixed edge overlay.

- [ ] **Step 5: Keep close alternatives**

Mobile sidebar still closes through close button, scrim and Escape. No hamburger or small edge button is rendered under coarse pointer.

- [ ] **Step 6: Mutation and tests**

Run each mutation separately and restore it: change edge limit to full viewport; call `preventDefault` on initial `pointerdown`; omit the close threshold; omit `pointercancel` restoration. Require the left-edge-only, tap-preservation/first-second-tap, close, and cancellation tests to fail respectively. Run focused and full tests.

- [ ] **Step 7: Commit**

```powershell
git add ui-motion.js index.html tests/ui-motion.test.mjs tests/page-runtime.test.mjs
git commit -m "feat: open the mobile sidebar with an edge swipe"
```

### Task 5: Tune motion and complete real-browser validation

**Files:**
- Modify: `index.html`
- Modify: `tests/page-runtime.test.mjs`
- Update after production: `docs/screenshots/production-desktop.png`, `docs/screenshots/production-mobile-sidebar.png`

**Interfaces:**
- Open 260ms, close 210ms, tooltip 160ms; reduced motion 0ms.

- [ ] **Step 1: Add exact motion RED tests**

Assert CSS custom properties `--sidebar-open-duration:260ms`, `--sidebar-close-duration:210ms`, `--tooltip-duration:160ms`, transform/opacity-only transitions, and reduced-motion override to `0ms`/`none`.

- [ ] **Step 2: Run RED and implement motion tokens**

Run `node --test tests/page-runtime.test.mjs`, then define the tokens once and use them for sidebar/tooltip state classes. Drag state disables transition. Avoid width/left animation.

- [ ] **Step 3: Run all automated tests and mutation**

Run `npm test`. Temporarily remove the reduced-motion override and confirm failure; restore.

- [ ] **Step 4: Validate actual browsers**

Serve the candidate with `python -m http.server 8000 --bind 127.0.0.1`. In actual browser sessions validate 390, 720, 1200, 1440px; mouse hover path; click/keyboard modal path; edge swipe/open/close; first/second mobile card taps; outside/Escape/close; light/dark; reduced motion; focus trap/restore; no console errors; no horizontal overflow.

- [ ] **Step 5: Commit and production deploy**

```powershell
git add index.html tests/page-runtime.test.mjs
git commit -m "style: tune sidebar and tooltip motion"
```

Fetch/secret-scan/push only after all UI commits pass together. Wait for explicit Pages deployment and repeat the viewport/keyboard/touch matrix against production.

```powershell
git fetch origin main
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
git merge-base --is-ancestor origin/main HEAD
if ($LASTEXITCODE -ne 0) { throw 'origin/main is not an ancestor of the UI commits' }
git push origin main
$dispatch = node scripts/dispatch-refresh.mjs --wait | ConvertFrom-Json
if (-not $dispatch.runId -or -not $dispatch.sourceSha -or -not $dispatch.snapshotId -or -not $dispatch.manifestSha256) { throw 'UI dispatch returned an incomplete receipt' }
git fetch origin main
$verified = node scripts/verify-refresh-chain.mjs --expected-run-id $dispatch.runId --expected-source-sha $dispatch.sourceSha --expected-snapshot-id $dispatch.snapshotId --expected-manifest-sha256 $dispatch.manifestSha256 --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ | ConvertFrom-Json
if (-not $verified.effectiveRunId) { throw 'UI production chain verification failed' }
if ((git rev-parse origin/main) -ne $verified.sourceSha) { throw 'UI origin/main does not match verified production' }
git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) { throw 'UI refresh bot commit is not a fast-forward' }
$allowedBotPath = '^(index\.html|data/(latest\.json|membership-status\.json|repo-summaries\.json|translation-sources\.json|repository-observations\.sqlite|readme-state\.json)|translations/[^/]+\.json|feed\.xml|changes\.xml|star-history\.json)$'
$unexpectedBotPaths = @(git diff --name-only HEAD..origin/main | Where-Object { $_ -notmatch $allowedBotPath })
if ($unexpectedBotPaths.Count) { throw "Unexpected UI bot paths: $($unexpectedBotPaths -join ', ')" }
git merge --ff-only origin/main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main) -or (git status --porcelain)) { throw 'UI bot fast-forward readback failed' }
```

Review the displayed log/diff before push; stop unless any remote advance is the verified refresh bot and a safe fast-forward.

- [ ] **Step 6: Update screenshots only from verified production**

Capture desktop 1440px and mobile 390px production states, replace the two existing PNGs, run `node --test tests/daily-refresh-workflow.test.mjs` and `npm test`, stage the two images and `tests/daily-refresh-workflow.test.mjs`, run the Common Commit Gate, and commit `docs: refresh production interface screenshots`. Then run:

```powershell
git fetch origin main
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
git merge-base --is-ancestor origin/main HEAD
if ($LASTEXITCODE -ne 0) { throw 'origin/main advanced before screenshot push' }
git push origin main
$dispatch = node scripts/dispatch-refresh.mjs --wait | ConvertFrom-Json
if (-not $dispatch.runId -or -not $dispatch.sourceSha -or -not $dispatch.snapshotId -or -not $dispatch.manifestSha256) { throw 'Screenshot dispatch returned an incomplete receipt' }
git fetch origin main
$verified = node scripts/verify-refresh-chain.mjs --expected-run-id $dispatch.runId --expected-source-sha $dispatch.sourceSha --expected-snapshot-id $dispatch.snapshotId --expected-manifest-sha256 $dispatch.manifestSha256 --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ | ConvertFrom-Json
if (-not $verified.effectiveRunId) { throw 'Post-screenshot production chain verification failed' }
if ((git rev-parse origin/main) -ne $verified.sourceSha) { throw 'Post-screenshot origin/main does not match verified production' }
git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) { throw 'Post-screenshot bot commit is not a fast-forward' }
$allowedBotPath = '^(index\.html|data/(latest\.json|membership-status\.json|repo-summaries\.json|translation-sources\.json|repository-observations\.sqlite|readme-state\.json)|translations/[^/]+\.json|feed\.xml|changes\.xml|star-history\.json)$'
$unexpectedBotPaths = @(git diff --name-only HEAD..origin/main | Where-Object { $_ -notmatch $allowedBotPath })
if ($unexpectedBotPaths.Count) { throw "Unexpected post-screenshot bot paths: $($unexpectedBotPaths -join ', ')" }
git merge --ff-only origin/main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main) -or (git status --porcelain)) { throw 'Post-screenshot fast-forward readback failed' }
```

- [ ] **Step 7: Stop before auth work on any mismatch**

Do not start Plan 4 while animation, accessibility, mobile gesture, or production layout has an unresolved failure.
