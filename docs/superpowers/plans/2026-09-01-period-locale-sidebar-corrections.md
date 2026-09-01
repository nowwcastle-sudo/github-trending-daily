# GitHub Trending 기간·언어·사이드바 교정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans in one inline flow. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch parallel implementers because the tasks share `index.html`.

**Goal:** 사이트 locale, sidebar interaction, period membership/gain, v1 membership transition을 현재 source contract와 일치시키고, 실제 Google 로그인 persistence를 deploy-only 전 마지막 게이트로 완결한다.

**Architecture:** UI 상태는 기존 `index.html` controller 경계에서 최소 수정하고, period의 순수 계산은 `ui-motion.js`, filter와 정렬은 `repo-filters.js`가 소유한다. Membership DB는 변경하지 않고 temp 3-snapshot integration fixture로 baseline→new→reentered 전이를 증명한다.

**Tech Stack:** vanilla HTML/CSS/JavaScript, Node 24 test runner, Python 3.13 unittest/sqlite3, Firebase Auth/Firestore emulator, GitHub Actions/Pages, actual Chrome.

**Spec:** `docs/superpowers/specs/2026-09-01-period-locale-sidebar-corrections-design.md`

## Global Constraints

- Production source 작업 전에 clean `HEAD == origin/main == ls-remote main`을 다시 확인한다.
- TDD 순서는 RED 실행 → 최소 구현 → GREEN 실행 → deliberate mutation → 복원 GREEN이다.
- 새 dependency, framework, server를 추가하지 않는다.
- Current snapshot과 append-only DB를 수정하거나 소급 재분류하지 않는다.
- Daily Refresh, LLM, DB write, schedule enable, quota-reset resume를 하지 않는다.
- Deep Scan은 폐기한다.
- Google 로그인 persistence가 실제 production에서 완결되지 않으면 merge/deploy 게이트로 넘어가지 않는다.
- PR merge와 deploy-only는 별도 사용자 확인 전에는 하지 않는다.

---

### Task 1: 사이트 locale과 요약 locale을 단일화

**Files:**
- Modify: `tests/summary-locales.test.mjs`
- Modify: `tests/site-i18n.test.mjs`
- Modify: `tests/page-runtime.test.mjs`
- Modify: `index.html`

**Interfaces:**
- `resolveSummaryLocale(repo, preferredLocale): string | null`은 exact preferred locale만 반환한다.
- `tipHTML(repo, locale)`은 locale이 불완전하면 localized unavailable content를 반환한다.
- Tooltip에 `.summary-tabs`, `.summary-tab`, `data-summary-locale`, `activeSummaryLocale`이 없다.

- [x] summary control 0개, exact site locale, missing-locale unavailable, saved locale와 BFCache fixture를 작성한다.
- [x] focused tests를 실행해 현재 5-button/fallback 구현 때문에 RED인지 확인한다.
- [x] 별도 summary locale 상태와 event handler/CSS를 제거하고 site locale만 사용한다.
- [x] focused tests를 GREEN으로 만든다.
- [x] English fallback과 5-button row를 각각 복구한 mutation에서 RED를 확인한 뒤 원복한다.

### Task 2: hover close delay를 제거하고 모바일 진입점을 접근성 전용으로 전환

**Files:**
- Modify: `tests/page-runtime.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Hover close는 0ms scheduling delay와 210ms CSS transition을 갖는다.
- `#mobileNavToggle`은 touch에서 visually-hidden이고 `:focus-visible`에서만 44x44px 이상이다.
- Existing swipe interfaces in `ui-motion.js` do not change.

- [x] rail/sidebar `relatedTarget`, focus guard, no timer, focus-visible mobile trigger behavior tests를 작성한다.
- [x] 현재 180ms timer와 visible mobile button 때문에 RED인지 확인한다.
- [x] timer state를 제거하고 결합 영역 밖 pointer/focus 전이에서 직접 close한다.
- [x] 모바일 버튼의 persistent layout을 sr-only/focus-visible layout으로 교체한다.
- [x] focused tests를 GREEN으로 만든다.
- [x] 180ms delay, focus guard 제거, always-visible mobile button mutation을 각각 RED로 확인한 뒤 원복한다.

### Task 3: period membership, gain, HOT, period rank sorting을 교정

**Files:**
- Modify: `tests/ui-motion.test.mjs`
- Modify: `tests/repo-filters.test.mjs`
- Modify: `tests/current-view-export.test.mjs`
- Modify: `tests/page-runtime.test.mjs`
- Modify: `ui-motion.js`
- Modify: `repo-filters.js`
- Modify: `index.html`

**Interfaces:**
- `UiMotion.periodGain(repo, "all")`은 `null`이다.
- Missing period gain은 `null`, exact source zero는 `0`이다.
- `RepoFilters.matchesRepo`는 selected period의 valid positive rank와 nonnegative finite gain을 요구한다.
- `RepoFilters.sortRepos(..., "trending", period)`는 selected period rank 오름차순이다.

- [x] literal fixture로 all/daily/weekly/monthly membership, missing-vs-zero, rank ordering, export set을 RED로 고정한다.
- [x] focused tests에서 45개 공통 노출, fallback gain, original-order behavior 때문에 RED인지 확인한다.
- [x] pure helpers부터 최소 수정하고 render에서 all gain/HOT/spark를 제거한다.
- [x] focused tests를 GREEN으로 만든다.
- [x] period filter 제거, missing→0, all fallback gain, all HOT, original order mutation을 각각 RED로 확인한 뒤 원복한다.

### Task 4: neutral baseline과 다음 v1 refresh 전이를 증명

**Files:**
- Modify: `tests/test_repository_artifacts.py`
- Modify: `tests/test_atom_feeds.py`
- Modify: `tests/membership-history.test.mjs`
- Modify: `tests/page-runtime.test.mjs`

**Interfaces:**
- S1 migration baseline은 전부 `baseline_present`이고 event 0이다.
- S2 refresh는 `stayed`, `new`, `exited`를 만든다.
- S3 refresh는 직전 누락·과거 존재 repository를 `reentered`로 만든다.

- [x] temp DB S1/S2/S3 fixture를 ledger→membership JSON→Atom→card까지 연결한다.
- [x] current implementation이 이미 계약을 만족하면 production code를 수정하지 않고 verification-only task로 남긴다.
- [x] baseline→new 또는 legacy→v1 bridge mutation에서 테스트가 실패하는지 확인한다.

### Task 5: 문서, 전체 검증, 브라우저, Git/PR

**Files:**
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md`

- [x] 두 README와 handoff에 2026-09-01 superseding contract를 반영하되 production success를 미리 쓰지 않는다.
- [x] focused Node tests, `npm test`, `npm run test:rules`, actionlint, production audit, `git diff --check`를 fresh 실행한다.
- [ ] 390/720/1200/1440, 5 locales, BFCache, hover/modal, keyboard, real swipe, reduced motion, exact period counts, overflow 0을 actual browser로 확인한다.
- [x] staged diff와 staged added lines에서 secret pattern을 값 출력 없이 검사한다.
- [ ] 작은 한국어 커밋으로 나눠 push하고 PR을 만든다.
- [ ] PR과 main 후보 SHA에 실제 CodeQL analyses 2건과 results 0을 확인한다.

### Task 6: Google 로그인 persistence 최종 pre-deploy gate

**Files:**
- No intended source change unless current production failure is reproduced by a RED test.

- [ ] exact current production에서 사용자가 Google account selection/consent를 수행한다.
- [ ] login→favorite→reload→new tab→BFCache→browser restart→cross-tab logout→guest/account separation을 actual browser로 확인한다.
- [ ] identity, UID, token, storage value를 출력하거나 기록하지 않는다.
- [ ] current production이 통과하면 exact browser/version/source SHA와 pass matrix만 기록한다.
- [ ] 실패하면 stack/network boundary를 조사하고 RED를 작성하되, 새 auth fix를 production에서 검증했다고 추정하지 않고 merge/deploy 전 정지한다.

### Task 7: merge/deploy confirmation gate

- [ ] PR/CodeQL/auth 결과와 exact merge candidate SHA를 사용자에게 보고한다.
- [ ] 별도 확인 전 merge와 deploy-only를 실행하지 않는다.
- [ ] 확인 후 main을 재측정하고 deploy-current-pages workflow를 정확히 한 번 실행한다.
- [ ] manifest sourceSha, unchanged snapshotId, 20 file hashes, browser matrix, active runs/schedule 상태를 검증한다.
- [ ] post-deploy probe 실패 시 blind retry나 자동 recovery를 하지 않는다.

### Task 8: 450k context handoff gate

- [ ] Goal usage가 약 450,000 tokens에 도달하면 상세 handoff를 작성한다.
- [ ] 같은 버그나 오류가 두 번의 수정 뒤에도 재발하면 세 번째 수정 전에 `mattpocock-skills:wait-what`으로 현재 위치와 문제 정의를 단순한 기술 문장으로 다시 설명한다.
- [ ] handoff에는 decisions, current coordinates, diff, commits, RED/GREEN/mutations, test outputs, browser/auth/Actions/Pages state, blockers, unanswered question, exact next command, `wait-what` 발동 여부와 결과를 포함한다.
- [ ] 새 Goal session을 만들고 `agentmemory:handoff`가 동일 cwd 경계로 최근 session을 복원하는지 확인한다.
