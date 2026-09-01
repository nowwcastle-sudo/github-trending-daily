# GitHub Trending Daily Goal 세션 인계

- 작성 시각: 2026-09-01T10:42:12+09:00
- 원 세션 task/thread id: `01a05a63-c260-7c72-9e29-559e53b6998b`
- 인계 사유: Goal 도구가 보고한 사용량이 `625075`토큰으로, 사용자가 정한 `450000`토큰 인계선을 이미 넘었음
- 정본 작업 경로: `C:\Users\nasca\.codex\worktrees\3a3b\transactional-refresh-20260827`
- 현재 단계: 전체 6단계 중 2단계. locale/tooltip과 hover/mobile 수정은 국소 TDD·변이 검증까지 진행했으며, 기간별 필터·gain/HOT 작업부터 남아 있음

## 1. 새 Goal 세션의 첫 행동

1. `agentmemory:handoff`를 위 정본 작업 경로를 명시한 cwd override로 실행한다. 디렉터리 경계 일치만 인정하고, 접두사만 같은 형제 저장소는 고르지 않는다.
2. 이 파일을 처음부터 끝까지 읽는다.
3. 아래 목적을 그대로 새 Goal로 만든다. 명시적 토큰 예산은 만들지 않는다.
4. 아래 좌표 확인 명령을 실행해 현재 상태가 이 문서와 다르면 수정하지 말고 먼저 사용자에게 보고한다.

새 Goal 목적:

> GitHub Trending Daily production closure 후속을 inline 방식으로 완결한다. 승인된 변경은 (1) 메인 사이트 언어와 summary locale 엄격 결합 및 tooltip 언어 row 제거, (2) hover 종료 즉시 210ms 닫힘 모션 시작, (3) 모바일 visible 탐색 버튼 제거와 focus-visible 접근성 진입점 유지, (4) 일간/주간/월간 실제 membership과 정확한 gain 표시 및 전체 gain/HOT 제거, (5) migration baseline 불변과 다음 v1 refresh부터 new/reentered 전이 증명이다. Deep Scan은 폐기한다. Google 로그인 persistence는 deploy-only 전 마지막 필수 완결 게이트다. TDD, mutation, 전체 테스트, 실제 390/720/1200/1440 브라우저, staged secret scan, PR/CodeQL을 통과하고 merge/deploy 전 사용자 확인에서 멈춘다. 같은 기능 버그가 두 차례 수정 뒤 재발하면 세 번째 패치 전에 mattpocock `wait-what`으로 더 넓고 단순하게 재정의하고, 발동·결론을 인계 기록에 남긴다.

## 2. 사용자 승인·범위·금지선

승인된 원 요구사항은 다음 여섯 가지다.

1. 메인 사이트 locale이 tooltip summary locale을 단독으로 결정한다. tooltip 내부의 별도 언어 선택 UI는 제거한다.
2. hover가 끝나면 sidebar 닫힘을 지체 없이 시작하되 기존 210ms transition은 유지한다.
3. All/daily/weekly/monthly가 같은 목록을 보이고 star gain도 잘못된 문제를 바로잡는다.
4. New badge가 동작하지 않는 문제를 바로잡는다.
5. Reentered badge가 동작하지 않는 문제를 바로잡는다.
6. 모바일은 오른쪽 swipe로 열고 왼쪽 swipe로 닫는다. 항상 보이는 Explore 버튼은 제거한다.

사용자가 모두 추천안으로 승인한 세부 결정:

- 선택한 사이트 locale의 완전한 summary가 없으면 영어 등 다른 언어로 조용히 대체하지 않는다. 해당 locale 요약을 사용할 수 없다는 번역 문구를 표시한다.
- hover close 지연은 0ms다. rail↔sidebar 내부 이동과 sidebar 내부 focus는 열린 상태를 보존한다.
- 모바일 Explore 버튼은 시각적으로 상시 노출하지 않는다. compact/coarse 환경에서만 screen-reader/keyboard 진입점으로 활성화하고, keyboard focus 시 44x44 이상으로 보이게 한다.
- daily/weekly/monthly는 해당 기간에 실제 순위와 gain이 존재하는 repo만 포함한다.
- All은 기간별 membership의 합집합이며 gain·HOT·spark를 숨기고 total stars만 보여 준다.
- 기존 migration baseline은 중립 상태로 둔다. 약 5일 전 legacy history와 억지로 연결해 new/reentered를 소급 생성하지 않는다.
- new/reentered는 다음 v1 refresh부터 실제 연속 snapshot 전이로 증명한다.

명시적 범위 변경과 게이트:

- Codex Deep Scan은 폐기됐다. 재개·대체·완료 게이트·잔여 위험으로 취급하지 않는다.
- Google 로그인 유지는 이번 범위에서 배포 전 마지막 최종 완결 항목이다.
- 현재 production에서 실제 Google 로그인 후 reload, 새 탭, BFCache, 브라우저 재시작, cross-tab logout, guest/account 분리를 확인한다.
- current production이 실패해 code fix가 필요하면 미배포 코드를 production 검증 완료로 부르지 않는다. merge/deploy 승인 전에 멈춰 결과와 필요한 다음 확정 행위를 보고한다.
- 실행 방식은 1번 inline이다. source edit, commit, push, PR까지 승인됐다. merge와 deploy-only는 별도의 사용자 확인 전에는 실행하지 않는다.
- force push, reset --hard, history rewrite, remote branch delete 금지. 비밀값 실값 출력 금지.

## 3. `wait-what` 발동 규칙

사용자가 2026-09-01에 `mattpocock-skills:wait-what` 적용을 명시했다.

- 같은 기능 버그 또는 오류가 두 번의 수정 뒤 재발하면 세 번째 patch 전에 작업을 멈춘다.
- 현재 관측, 기대 동작, 실제 동작, 두 번의 수정이 각각 무엇을 전제로 했는지를 간단한 기술 언어로 다시 쓴다.
- 부분 patch 관점에서 벗어나 데이터 흐름·상태 경계·단일 진실 공급원을 더 넓고 단순하게 다시 본다.
- repo에 `CONTEXT.md`와 `CONTEXT-MAP.md`가 없으므로 이 설계 문서, 인계 문서, 실제 코드 명칭을 정본 용어로 사용한다.
- 발동 시점·재정의·결론을 다음 handoff에 남긴다.

현재까지 발동 횟수는 0회다. 앞서 있었던 세 차례의 `apply_patch` 문맥/문법 실패는 동일 기능 버그의 수정 후 재발이 아니었고, patch를 더 작게 나누는 것으로 처리했다. 기능 버그가 두 수정 뒤 재발한 사례는 아직 없다.

## 4. Git·worktree 좌표

2026-09-01T10:42:12+09:00 실측:

- branch: `codex/fix-period-locale-sidebar-20260901`
- `HEAD`: `084a657d1bb36c7a79b3005161c50ddabf4938c0`
- `origin/main`: `084a657d1bb36c7a79b3005161c50ddabf4938c0`
- 원격 `main`도 fetch 후 같은 SHA였음
- linked worktree git dir: `C:/Users/nasca/AppData/Local/Temp/gh-trending-page/.git/worktrees/transactional-refresh-202608271`
- common git dir: `C:/Users/nasca/AppData/Local/Temp/gh-trending-page/.git`

현재 working tree:

```text
 M index.html
 M site-i18n.js
 M tests/page-runtime.test.mjs
 M tests/site-i18n.test.mjs
 M tests/summary-locales.test.mjs
?? docs/superpowers/plans/2026-09-01-goal-session-handoff.md
?? docs/superpowers/plans/2026-09-01-period-locale-sidebar-corrections.md
?? docs/superpowers/specs/2026-09-01-period-locale-sidebar-corrections-design.md
```

기존 다섯 modified 파일의 diff stat은 `165 insertions, 98 deletions`다. 새 문서들은 아직 stat에 포함되지 않은 untracked 파일이다. 커밋·push·PR은 아직 없다.

좌표 재확인 명령:

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\.codex\worktrees\3a3b\transactional-refresh-20260827'
git fetch --prune origin
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git ls-remote origin refs/heads/main
git status --short
```

이 결과가 위 좌표와 다르면 자동 정리·rebase·reset하지 말고 사용자에게 먼저 보고한다.

## 5. 원 baseline 검증

변경 전 전체 테스트:

- `npm test`: Node 552 total = 540 pass + 12 intentional skip, 0 fail; Python 147 pass; exit code 0.
- `npm run test:rules`: Firestore Rules 9/9 pass, exit code 0.
- negative-path 테스트가 출력하는 error line은 의도된 증거이며 실패로 오독하지 않는다.

production URL:

`https://nowwcastle-sudo.github.io/github-trending-daily/`

production 배포 좌표:

- source SHA: `084a657d1bb36c7a79b3005161c50ddabf4938c0`
- snapshot: `20260831232256-93d42067ab071cda`
- manifest SHA256: `04fd835b5b5071aeda40728e772b82fbbe28eb2b25ef309be18c67dd6b420d04`
- manifest 20개 파일 전부 live hash 일치, 총 1,069,238 bytes
- deploy-only run `33454071342`: success, head `084a657d...`
- Pages deployment id `6191963666`: success, SHA `084a657d...`
- 같은 SHA CodeQL 실제 분석: JavaScript/TypeScript rules 87/results 0, Python rules 43/results 0, open alerts 0
- `GH_TRENDING_REFRESH_SCHEDULE` 부재, active Daily Refresh 0
- 과거 heartbeat는 PAUSED 확인. 재개하지 않는다.

브라우저에서 재현한 production 결함:

- All/daily/weekly/monthly 모두 45 cards.
- source data에는 daily 16, weekly 20, monthly 22개의 유효 rank/gain row가 있음.
- 기간 값이 없는 repo가 `+0`으로 보임.
- All gain이 daily→weekly→monthly 중 첫 finite 값을 섞어 사용함.
- HOT 개수: All 32, daily 4, weekly 18, monthly 22.
- locale을 KO에서 JA로 바꾸면 tooltip 내용은 바뀌지만 별도 언어 tab 5개가 계속 있음.
- hover 종료 뒤 약 202ms 지연된 후 210ms transition이 시작됨.
- 390px viewport에서 visible mobile button이 71x44로 보임.

## 6. 데이터·membership 원인 진단

현재 local observation DB:

- `data/repository-observations.sqlite`에는 `migration_baseline` run 1개만 있음.
- 45개 모두 `baseline_present`, parent run 없음.
- valid gain row: daily 16, weekly 20, monthly 22.

legacy membership DB:

- snapshot 7개, 각 41 rows.
- 마지막 legacy snapshot은 현재 target보다 약 4일 23시간 54분 전.
- 잘못 연결하면 stayed 26, new 18, reentered 1, exited 15가 생기므로 연결 금지.
- 현재 `changes.xml`의 10개 entry는 과거 legacy event이지 현재 migration event가 아님.
- 현 membership 설계 원리는 맞다. S1/S2/S3 통합 테스트를 강화해 다음 v1 refresh 전이를 증명하는 방향이다.

## 7. 완료된 Task 1: 사이트 locale과 summary locale

테스트를 먼저 바꾼 RED:

- `tests/summary-locales.test.mjs`를 실제 production summary runtime을 `vm`으로 추출해 실행하는 harness로 변경.
- 사이트 locale 단독 사용, 별도 selector 부재, 선택 locale 누락 시 `null`과 번역 unavailable, 완전 summary의 5개 field와 AI note를 검사.
- `tests/site-i18n.test.mjs`는 5개 locale 모두 `tooltip.unavailable`이 비어 있지 않은지 검사.
- `tests/page-runtime.test.mjs`는 `activeSummaryLocale` 부재와 site locale 변경 시 직접 재렌더를 검사.
- source 변경 전 집중 결과는 67개 중 6 fail로, 정확히 별도 state/tab/영어 fallback/번역 key 누락을 잡음.

production source 변경:

- `site-i18n.js`에 5개 locale의 `tooltip.unavailable` 추가.
- `index.html`에서 summary tabs CSS, label map, row, click handler, `activeSummaryLocale` 제거.
- `resolveSummaryLocale`은 선택 locale의 완전 summary만 허용하고 아니면 `null`.
- 선택 locale 누락 시 README와 hide action은 유지하고 unavailable message를 표시.
- site locale change와 tooltip open이 `siteI18n.locale`로 직접 렌더.

GREEN과 변이 검증:

- `node --test tests\summary-locales.test.mjs tests\site-i18n.test.mjs tests\page-runtime.test.mjs`: 67/67 pass.
- 영어 fallback을 다시 넣는 변이에서 missing-locale test가 `en !== null`로 실패함을 확인하고 원복.
- 최소 summary-tabs markup을 다시 넣는 변이에서 no-control test 실패를 확인하고 원복.
- 원복 뒤 67/67 pass.

## 8. 완료된 Task 2 일부: hover close와 모바일 trigger

테스트를 먼저 바꾼 RED:

- rail→sidebar `relatedTarget` 이동은 open 유지.
- sidebar 내부 focus는 open 유지.
- 외부 focusout과 pointerleave는 timer advance 없이 즉시 close.
- coarse media에 `.mobile-nav-toggle{display:inline-flex}`가 없어야 함.
- static button은 `aria-hidden=true`, `tabindex=-1`, `inert`.
- base style은 1px clipped, `:focus-visible`은 fixed 44x44 이상.
- runtime은 compact/coarse에서만 `tabIndex`, `inert`, `aria-hidden`을 전환.
- source 변경 전 두 targeted test가 timer와 visible CSS 때문에 정확히 실패.

production source 변경:

- base mobile button을 1px clipped로 변경하고 focus-visible일 때만 fixed 44x44 이상 표시.
- coarse와 max-width 720의 `display:inline-flex` 제거.
- static button에 `aria-hidden=true tabindex=-1 inert` 추가.
- `sidebarHoverTimer`와 timer helper 제거.
- `sidebarOwnsTarget`과 `closeHoverSidebarIfOutside`로 관련 target과 focus 경계를 보존하며 즉시 close.
- `sidebarMobileAccessMedia`와 `updateMobileNavAccess`로 compact/coarse에서만 keyboard/screen-reader 진입 활성화.
- swipe threshold와 기존 gesture 구현은 변경하지 않음.

현재 GREEN:

- 2026-09-01T10:40경 `node --test tests\page-runtime.test.mjs tests\ui-motion.test.mjs`
- exit code 0, 74 tests, 74 pass, 0 fail/skip.

완료된 변이:

- 180ms delay를 다시 넣자 hover test가 실패했고 원복.
- `:focus-within` guard를 제거하자 hover test가 실패했고 원복.
- 원복 뒤 위 74/74 GREEN을 다시 확인.

아직 남은 Task 2 변이 한 건:

- coarse media 안에 `.mobile-nav-toggle{display:inline-flex}`를 일시 재삽입해 targeted test가 실패하는지 확인한 뒤 반드시 원복한다.
- 이 변이를 하지 않은 채 Task 2 mutation coverage 완료로 부르지 않는다.

## 9. 다음 구현 Task 3: period membership, gain, HOT, All

테스트를 먼저 추가·수정할 파일:

- `tests/ui-motion.test.mjs`
- `tests/repo-filters.test.mjs`
- `tests/current-view-export.test.mjs`
- 필요할 때만 `tests/page-runtime.test.mjs`

의도한 최소 인터페이스와 동작:

- `UiMotion.periodGain(repo, "all") === null`.
- 선택 period gain 값이 없으면 `null`; 실제 숫자 0은 0으로 보존.
- `UiMotion.badgeModel(..., "all").hot === false`.
- `RepoFilters.matchesRepo`는 선택 period에 유효한 양의 `rank_*`와 0 이상의 finite `stars_*`가 있는 repo만 통과.
- `sortRepos(..., "trending", period)`는 선택 period rank 오름차순. All은 원래 feed order를 안정적으로 보존.
- render는 All에서 gain, HOT, spark를 숨김.
- 실제 embedded data 또는 브라우저에서 daily/weekly/monthly card count가 16/20/22인지 확인.
- 필터·정렬·export는 같은 rendered array를 사용해 화면과 내보내기가 어긋나지 않게 한다.

먼저 production code와 현재 test를 다시 읽고 기존 함수 signature를 확인한다. 위 interface는 설계 방향이며, 실제 코드 패턴과 다르면 임의로 새 추상화를 추가하지 않는다.

## 10. 다음 검증 Task 4: new/reentered 전이

- migration baseline 자체에서는 `new`와 `reentered`를 생성하지 않는 불변을 유지한다.
- 격리 DB/fixture로 최소 S1/S2/S3를 만든다.
  - S1: baseline present.
  - S2: 다음 v1 run에서 처음 들어온 repo는 new, 빠진 repo는 exited.
  - S3: 이전에 exited한 repo가 다시 들어오면 reentered.
- current 45-row baseline과 legacy history를 연결하지 않는다.
- test가 실제 defect를 잡는지 최소 한 번의 mutation으로 증명한다.

## 11. 전체 검증·Git·PR 순서

1. 관련 집중 test RED→GREEN→mutation restore를 끝낸다.
2. `npm test`와 `npm run test:rules`를 다시 실행해 exit code와 pass/skip/fail을 기록한다.
3. 390/720/1200/1440 viewport에서 실제 browser 검증을 한다. locale fail-closed, hover 즉시 close+210ms motion, mobile swipe, keyboard-only hidden trigger, period counts/gain/HOT/All, new/reentered readiness를 확인한다.
4. 변경된 docs/README/handoff가 실제 구현과 맞는지 갱신한다. Deep Scan을 남은 gate로 적지 않는다.
5. `git diff --check`, staged secret scan, staged diff review 후에만 커밋한다.
6. 승인된 branch push와 PR 생성까지 진행한다. merge와 deploy-only는 사용자 확인 전에 실행하지 않는다.
7. PR head/base, Actions, matching commit SHA CodeQL actual analysis를 확인한다. `alerts?ref=`의 0건만으로 security green을 주장하지 않는다.

커밋 전 인증정보 검사는 비밀값을 출력하지 않는 방식으로 수행한다. 이상 match가 나오면 해당 파일과 line 위치만 제한적으로 보고하고 실값은 표시하지 않는다.

## 12. 마지막 pre-deploy gate: Google 로그인 유지

이 항목은 다른 구현·검증·PR closure가 끝난 뒤 마지막에만 수행한다.

기존 production RED 증거:

- 오래 열린 tab에서는 sync처럼 보였음.
- reload와 새 tab에서는 sign-in 상태로 돌아감.
- Firestore backend 호출 하나가 약 10초 timeout.
- account option 선택은 아직 하지 않음.

반드시 실제 current production에서 확인할 항목:

- Google login 성공.
- reload 뒤 유지.
- 새 tab에서 유지.
- BFCache 왕복 뒤 유지.
- 브라우저 완전 재시작 뒤 유지.
- 한 tab logout이 다른 tab에 전파.
- guest local state와 signed-in account state가 섞이지 않음.

실패하면 network/auth console 증거를 수집해 root cause를 분리한다. code fix가 생겨도 deploy 전에는 production pass로 말하지 않는다. merge/deploy-only 승인 요청에 이 한계를 명시한다.

## 13. 현재 읽은 주요 파일과 정본 문서

현재 세션에서 실제로 읽은 파일:

- `index.html` 전체 UI/CSS/JS. 한 줄짜리 대형 embedded `REPOS` JSON은 별도 구조 검증.
- `site-i18n.js`
- `ui-motion.js`
- `repo-filters.js`
- `tests/page-runtime.test.mjs`
- `tests/summary-locales.test.mjs`
- `tests/site-i18n.test.mjs`
- 관련 ui-motion/repo-filter test.

새 정본 문서:

- `docs/superpowers/specs/2026-09-01-period-locale-sidebar-corrections-design.md`
- `docs/superpowers/plans/2026-09-01-period-locale-sidebar-corrections.md`
- 이 인계 파일.

## 14. 새 세션의 정확한 다음 명령

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\.codex\worktrees\3a3b\transactional-refresh-20260827'
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
node --test tests\page-runtime.test.mjs tests\ui-motion.test.mjs
```

위 좌표와 74/74가 유지되면 먼저 남은 mobile visible-control 변이를 한 번 수행·원복하고, 그 뒤 Task 3의 period membership/gain/HOT test RED를 작성한다.

## 15. 완료·미완료 판정

완료됨:

- 요구사항/결정/범위 문서화.
- current git/production/data baseline 측정.
- locale/summary 엄격 결합 TDD와 두 변이.
- hover immediate close와 mobile hidden trigger TDD.
- hover delay·focus guard 두 변이와 최종 74/74 복원.
- mobile always-visible control 변이 RED와 원복 후 focused 74/74 복원.
- period membership/gain/HOT/All RED→GREEN. actual embedded count 45/16/20/22, focused 101/101, 계획된 변이 5종 RED와 원복.
- temp DB S1/S2/S3 ledger→membership JSON→Atom→card 통합 GREEN. migration baseline→new 변이 RED와 원복.
- `npm test` exit 0: Node 559 total = 547 pass + 12 intentional skip, Python 148 pass. Firestore Rules 9/9, actionlint 1.7.12 exact custom-label ignore, production dependency audit 0.
- local actual browser 390/720/1200/1440 overflow 0, 5 locale 전환, hover immediate close+210ms, keyboard hidden trigger, exact period/export contract, reduced-motion 확인. headless coarse pointer/BFCache 한계는 production pass로 세지 않음.
- implementation commit `3fef215f55e619a86b6d1c97722c25b1d09f847f`, branch push, PR #34 생성.
- actual Chrome에서 login reload, 새 탭, BFCache `persisted=true`, 완전 재시작과 account favorites 6개 유지 확인.
- current production cross-tab logout RED 확인: logout 탭은 guest 1개, peer는 10초 뒤에도 account 6개이며 reload 뒤에만 guest 1개. `firebase-client.js` same-origin signout 신호 TDD는 수정 전 2 RED, 수정 후 focused 59/59, 변이 2 RED와 원복.
- `wait-what` 발동 0회.

미완료:

- fresh `git diff --check`, staged secret scan과 staged diff review.
- PR #34 최종 head coordinate, Actions, matching commit CodeQL 검증.
- cross-tab logout 보완의 전체 검증, commit/push, PR #34 새 head CodeQL.
- 미배포 auth 보완의 production 재검증과 Google 로그인 persistence 최종 gate.
- merge/deploy-only 사용자 확인과 실제 배포.
- headless가 제공하지 않은 real coarse touch는 current production의 실제 브라우저 gate에서 재검증.

따라서 현재 상태를 기능 완결, PR 준비 완료, 배포 준비 완료로 부르면 안 된다.
