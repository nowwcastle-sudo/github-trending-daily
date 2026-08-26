# GitHub Trending Daily N3→N5 확장 기능 핸드오프북

- 작성일시: 2026-08-26 18:48 KST
- 저장소: `https://github.com/nowwcastle-sudo/github-trending-daily`
- 운영 페이지: `https://nowwcastle-sudo.github.io/github-trending-daily/`
- canonical checkout: `C:\Users\nasca\AppData\Local\Temp\gh-trending-page`
- 작성 시작 시점 `HEAD == origin/main`: `abc39cf485ccc499c0dd5d036ec6c356ae76def4`
- 직전 전체 핸드오프: [`2026-08-26-feature-expansion-next-round.md`](2026-08-26-feature-expansion-next-round.md)
- 직전 조사 기준서: [`2026-08-26-feature-expansion-research.md`](2026-08-26-feature-expansion-research.md)
- 상태 주의: `cron: "7 */2 * * *"` 자동 갱신이 `main`을 계속 전진시킨다. 이 문서의 SHA를 새 작업의 현재값으로 가정하지 않는다.

## 0. 이 문서의 지위와 사용자 승인

이 문서는 **N1·N2 완료 뒤 사용자가 별도 Codex 작업에서 N3→N4→N5를 순차 구현하라고 승인한 공식 후속 정본**이다. 새 작업은 예전 핸드오프의 “N1~N5 미승인”, “M1~M4부터”, “N3 정본 합의 전 중지” 문구를 현재 승인 경계로 사용하지 않는다. 예전 문서는 구현 배경과 보존 불변식을 확인하는 역사 자료다.

승인된 범위와 순서는 다음과 같다.

1. `N3 신규·재진입·이탈 이력`
2. `N4 Atom feed`
3. `N5 현재 보기 내보내기`

N3, N4, N5는 각각 **RED 테스트 → 최소 구현 → 전체 테스트 → 의도적 변이 → 브라우저·접근성 검증 → 추가 내용 비밀값 검사 → 별도 커밋·push → Pages build/deploy → production 재검증**을 끝낸 뒤 다음 항목으로 넘어간다. 세 기능을 한 커밋으로 합치지 않는다.

현재 막힌 질문은 없다. 아래 N3 정본 설계는 현행 v1 데이터베이스의 스키마 지문 검증과 2시간 publication 경로를 다시 읽고 정한 우선안이다. 구현 중 실제 코드가 이 전제와 충돌해 기존 정본을 변형해야만 한다면 그때만 측정값과 최소 대안을 들고 사용자에게 묻는다.

## 1. 직전 작업에서 실제로 완료된 상태

### 1.1 유지보수와 기능

- M1 로그인 persistence는 **미완료가 아니라 명시적 보류**다. 사용자가 원격이라 Google 로그인을 제공할 수 없어 reload·새 탭·브라우저 완전 재시작·logout 재시작 검증을 수행하지 못했다. `firebase-client.js`의 persistence를 추측으로 바꾸지 않았다.
- M2 사이드바 최상단 갱신 상태: `d2dd3f8`
- M3 light surface 경계 강화: `37219a6`
- M4 접근 가능한 왼쪽 edge tab: `219821f`
- M2~M4 README 동기화: `2532944`
- N1 브라우저 로컬 숨김·복구: `5c999a7`
- N2 공유 가능한 명시적 정렬: `0356994`
- N1·N2 README 한·영 동기화: `abc39cf`

N1은 localStorage만 쓰며 URL·Firebase·계정 문서에 숨긴 slug를 넣지 않는다. 즐겨찾기와 숨김이 함께 있으면 숨김이 화면 표시에서 우선하지만 즐겨찾기 값은 보존된다. 카드 action과 키보드 `Delete`, 직후 되돌리기, 사이드바 관리 화면 복구가 있다.

N2의 기본값은 embedded `REPOS`의 원래 Trending 순서다. 추가 정렬은 선택 기간 증가, 총 스타, 최근 push, 최근 release이며 stable sort와 원래 index tie-breaker를 쓴다. 결측값은 뒤로 가고, 선택 기간 증가값이 전부 없으면 해당 정렬이 비활성화된다. `sort`는 whitelist된 URL 상태이고 즐겨찾기 보기에서도 `period`를 보존한다.

### 1.2 검증된 기준선

- 최종 `npm test` 종료 코드 0
- Node 총 180개: 171 통과, 0 실패, Firestore Rules emulator용 9개 건너뜀
- Python unittest 23개 통과
- local 390·720·1200·1440px 문서 가로 넘침 0
- production 390·1200px에서 N1·N2 재검증
- N1 Pages run `32952063332`: success, head `5c999a7`
- N2 Pages run `32953001018`: success, head `0356994`
- README Pages run `32953372807`: success, head `abc39cf`
- production guest 흐름에서 N1·N2와 즐겨찾기는 작동했다.

production console에서 Firebase App Check 초기 throttle 관련 403 경고가 관측됐다. guest 기능은 작동했지만 이는 로그인 persistence를 검증하지도, App Check를 정상이라고 증명하지도 않는다. Actions에는 `actions/upload-artifact@v4` Node 20 deprecation 경고가 있었지만 위 Pages 배포들은 성공했다. 두 경고를 N3~N5와 무관하게 재구현하거나 숨기지 않는다.

## 2. 맥락 복원 원천과 우선순위

새 작업은 다음 순서로 현재 사실을 판정한다.

1. 현재 checkout과 `origin/main`의 코드·테스트·Actions·production 실측
2. 이 핸드오프북
3. OFA 정본 기록
4. `.ua/knowledge-graph.json` 구조 지도
5. agentmemory의 과거 관측

### 2.1 `.ua`

현재 `.ua`에는 `.ua/knowledge-graph.json`만 있고 `.ua/meta.json`은 없다. 99 nodes, 123 edges이며 `index.html`, refresh workflow, README, star history 같은 큰 구조는 찾을 수 있지만 N1·N2와 새 파일은 반영하지 못한 2026-08-24 계열 지도다. 따라서 `.ua`는 **어디를 읽을지 찾는 지도**로만 쓰고 현재 동작·테스트 수·스케줄·로그인 상태의 증거로 쓰지 않는다.

이번 N3~N5 작업 중 `.ua` 전체 rebuild를 자동으로 하지 않는다. rebuild에는 `.understandignore`와 생성물 범위를 먼저 정해야 하므로 별도 승인 대상이다.

### 2.2 agentmemory

직전 작업에서 `memory_sessions`로 exact cwd를 찾았지만 `gh-trending-page`와 일치하는 최근 세션은 없었다. `memory_recall`로 나온 2026-08-25 관측은 03:17 KST 스케줄, 테스트 116개, 로그인 불안정 등 현재와 다른 값이 섞인 stale 기록이다. 2026-08-26 기록도 N1·N2 이전 상태다.

새 작업은 agentmemory에서 `github-trending-daily`, `gh-trending-page`, `n3-n5-expansion-handoff`, `membership-history`를 recall하되, 이 문서와 현재 코드를 우선한다. agentmemory는 검색 단서와 의사결정 이유를 복원하는 보조 수단이다.

### 2.3 OFA 정본

데스크톱에서 읽고 쓰는 vault 정본은 `D:\OFA\OFA\00_원천`뿐이다. 더청춘 vault와 OFA 파생 `wiki\`에는 새 기록을 쓰지 않는다.

먼저 다음을 끝까지 읽는다.

- `D:\OFA\OFA\00_원천\10_클로드작업기록\2026-08-26_GitHub_Trending_사이드바·분야필터·URL상태·README_구현과_다음라운드_handoff.md`
- `D:\OFA\OFA\00_원천\47_의사결정기록\2026-08-26_GitHub_Trending_오버레이사이드바·다중태그·후속순서_결정.md`
- `D:\OFA\OFA\00_원천\47_의사결정기록\2026-08-23_GitHub_Trending_데이터·인증·모바일_결정.md`

작업 종료 때 첫 두 파일을 실제 N3~N5 커밋, 테스트, Pages run, production 결과로 갱신한다. 기존 내용을 지우지 말고 날짜가 붙은 후속 절을 추가한다.

## 3. 새 작업의 첫 실행 순서

Windows PowerShell에서 한 줄씩 실행한다.

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\AppData\Local\Temp\gh-trending-page'
Get-ChildItem -Path 'C:\Users\nasca' -Filter 'AGENTS.md' -File -ErrorAction SilentlyContinue
Get-ChildItem -Path . -Filter 'AGENTS.md' -File -Recurse -ErrorAction SilentlyContinue
Get-Content -LiteralPath '.\docs\handoffs\2026-08-26-n3-n5-expansion-handoff.md' -Raw
Test-Path -LiteralPath '.\.ua\knowledge-graph.json'
git fetch origin main
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git log -8 --format='%H %cI %an %s'
npm test
```

판정 규칙:

- 작업트리가 더러우면 모든 기존 변경을 사용자 소유로 보고 덮어쓰기·reset·checkout하지 않는다.
- `HEAD != origin/main`이면 `git show --stat origin/main`과 `git diff --name-status HEAD..origin/main`으로 먼저 확인한다.
- 작업트리가 깨끗하고 remote 전진분이 bot의 expected generated outputs와 검증된 커밋뿐일 때만 `git merge --ff-only origin/main`을 쓴다.
- 2시간 bot이 작업 중 main을 전진시키므로 **각 push 직전** fetch, status, remote diff 판정을 반복한다.
- 첫 `npm test` 실패는 새 기능 수정 전에 기존 실패·환경 문제·remote 변화로 분리한다.

작업 시작 commentary에는 복원한 현재 SHA·기준 테스트와 `N3→N4→N5`, 그리고 M1이 로그인 불가로 보류됐다는 사실만 짧게 알린다.

## 4. 먼저 읽을 코드와 보존해야 할 계약

다음 순서로 파일을 읽는다.

1. `package.json`, `.github/workflows/daily-refresh.yml`
2. `scripts/update-trending.mjs`
3. `scripts/record_star_observations.py`
4. `scripts/update-latest-feed.mjs`, `scripts/update-star-history.mjs`
5. `index.html`의 generated REPOS 밖 CSS·HTML·JS
6. `repo-filters.js`, `hidden-repos.js`, `favorites.js`, `favorite-sync.js`
7. `ui-motion.js`, `refresh-schedule.js`, `firebase-client.js`
8. `tests/daily-refresh-workflow.test.mjs`, `tests/test_star_observations.py`, `tests/latest-feed.test.mjs`, `tests/page-runtime.test.mjs`, `tests/repo-filters.test.mjs`
9. `README.md`, `README.en.md`

기존 불변식:

- 정적 GitHub Pages 구조를 유지한다. 새 서버, 프레임워크, 메일 제공자, push token, LLM 호출을 추가하지 않는다.
- `data/star-observations.sqlite`는 v1 canonical schema fingerprint와 append-only trigger를 검증한다. N3 때문에 이 DB를 재해석하거나 테이블을 얹지 않는다.
- `data/latest.json`은 공개 파생 feed이며 membership 전체 이력 정본이 아니다.
- `scripts/update-trending.mjs`가 10~75개의 완결된 page snapshot을 먼저 준비하고 원자적으로 설치한다.
- daily refresh는 test-before → generate-all → validate-all → allowlisted git add → staged secret scan → one bot commit 순서다. 중간 산출물을 publish하지 않는다.
- 번역은 README source hash와 유료 호출 gate를 보존한다. N3~N5 UI 문구 추가가 기존 번역 queue를 불필요하게 재호출하지 않게 한다.
- 숨김은 local-only, 즐겨찾기는 기존 guest/account controller, 정렬·필터는 URL whitelist라는 경계를 유지한다.
- overlay coordinator, tooltip rail, 모바일 첫 탭, README/sidebar 상호 배타성, body inert/scroll lock, focus trap/restore, 44×44px target, reduced motion을 회귀시키지 않는다.
- UI는 `impeccable` + `apple-design`을 쓰고 `frontend-design`은 쓰지 않는다. parser가 없는 degraded detector 결과를 완전한 품질 증거로 과장하지 않는다.
- Ponytail Full 원칙대로 현재 구조에서 해결한다. 새 dependency는 표준 라이브러리로 불가능한 이유가 검증될 때만 제안한다.

## 5. N3 — 신규·재진입·유지·이탈 이력

### 5.1 사용자에게 보이는 계약

- 신규: baseline 이후 저장된 전체 membership 이력에서 처음 관측된 저장소
- 재진입: 과거에는 관측됐지만 직전 finalized membership에는 없고 현재 다시 나타난 저장소
- 유지: 직전과 현재 finalized membership에 모두 있는 저장소
- 이탈: 직전 finalized membership에는 있었지만 현재에는 없는 저장소
- 첫 baseline의 현재 저장소는 모두 `baseline`으로 취급하고 신규 badge를 표시하지 않는다.
- 현재 카드에는 `신규`와 `재진입`만 짧은 semantic badge로 표시한다. 유지 badge는 카드 밀도만 늘리므로 표시하지 않는다.
- 최근 이탈은 사이드바 안의 compact section에서 제공한다. 현재 카드 목록에 유령 카드를 만들지 않는다.
- N3에서 `sort=new`를 자동 추가하지 않는다. N2의 기본·증가·스타·push·release 계약을 보존한다.

### 5.2 확정한 데이터 방향

우선안은 **별도 append-only SQLite 정본 `data/trending-membership.sqlite` + 브라우저용 검증된 파생 JSON `data/membership-status.json`**이다.

왜 같은 `star-observations.sqlite`를 쓰지 않는가:

- 현재 star DB는 `PRAGMA user_version = 1`, canonical object set, SQL fingerprint를 전부 비교한다.
- 새 table이나 trigger 하나만 추가해도 `_validate_schema`가 실패한다.
- v2 migration은 N3보다 범위와 되돌리기 비용이 크며 star 정본을 불필요하게 위험에 노출한다.

권장 v1 membership DB 계약:

- `schema_meta`: version 1, append-only policy
- `snapshots`: 내부 id, UTC ISO `generated_at`, Seoul `stats_date`, slug-set SHA-256, item count, baseline 여부
- `snapshot_members`: snapshot id + case-insensitive canonical slug, 복합 unique/primary key
- snapshot/member update·delete 차단 trigger
- 동일 `generated_at` + 동일 checksum/members 재실행은 no-op
- 동일 `generated_at`의 다른 내용은 conflict로 실패
- 최신보다 오래된 snapshot append는 실패
- 한 snapshot의 10~75개 slug는 case-insensitive unique이고 전부 `owner/repo` 형식
- snapshot header와 members는 한 `BEGIN IMMEDIATE` transaction에서 기록
- `PRAGMA foreign_key_check`, `integrity_check`, sidecar 부재를 publication 전에 검증

snapshot 시간은 `data/latest.json.generatedAt`의 UTC ISO를 우선 사용한다. membership recorder는 먼저 page REPOS와 latest feed의 slug set·count·statsDate가 정확히 일치하는지 확인한 뒤 기록한다. identical latest feed가 이전 `generatedAt`을 유지하면 membership도 no-op이므로 불필요한 bot commit이 생기지 않는다. 실제 코드에서 이 시간이 2시간 finalized run을 구분하지 못하는 반례가 재현되면 임의의 `Date.now()`를 흩뿌리지 말고 workflow에서 한 번 만든 run timestamp를 관련 생성기에 주입하는 최소 대안을 택한다.

`data/membership-status.json` 권장 공개 schema:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-26T08:58:32.295Z",
  "statsDate": "2026-08-26",
  "baseline": true,
  "current": [
    { "slug": "owner/repo", "status": "baseline" }
  ],
  "exited": []
}
```

- `current` 순서는 embedded REPOS 순서와 같아야 한다.
- status 허용값은 `baseline | new | reentered | stayed`다.
- `exited`는 직전 snapshot 순서를 보존하고 공개 필드는 slug와 관측 시각 정도로 제한한다.
- JSON은 temp file → atomic rename으로 설치한다.
- 첫 기능 커밋에 현재 finalized snapshot을 baseline으로 만든 DB와 JSON을 포함한다. production 첫 배포에서 모든 카드를 신규로 거짓 표시하지 않는다.
- N4가 과거 변화 feed를 만들 수 있도록 DB에서 최근 `new`·`reentered` event를 결정적으로 재계산할 수 있어야 한다. 설명·요약·개인 상태를 membership DB에 복제하지 않는다.

### 5.3 workflow 연결

권장 생성 순서:

1. `node scripts/update-trending.mjs`
2. `node scripts/generate-translations.mjs`
3. `python scripts/record_star_observations.py`
4. `node scripts/update-latest-feed.mjs`
5. 새 membership recorder와 status generator
6. `node scripts/update-star-history.mjs`

새 DB·JSON은 validation, `git diff --check`, unexpected-output allowlist, `git add`, staged diff check, 비밀값 검사 대상에 모두 포함한다. 어느 단계든 실패하면 bot commit과 push가 없어야 한다. runner working tree에서 생성된 일부 파일은 성공 증거가 아니다.

### 5.4 N3 RED와 예외 테스트

코드 전에 최소 다음 실패를 고정한다.

- 첫 실행은 baseline이며 현재 전부 신규가 아님
- baseline 다음에 새 slug가 들어오면 `new`
- 과거 존재 → 직전 부재 → 현재 존재면 `reentered`
- 직전·현재 존재면 `stayed`
- 직전 존재 → 현재 부재면 `exited`
- 같은 날짜의 서로 다른 2시간 snapshot도 generatedAt이 다르면 순서대로 기록 가능
- exact rerun은 DB bytes/row count와 derived JSON 의미가 변하지 않음
- 같은 generatedAt의 conflicting set은 실패하고 이전 DB·JSON 보존
- partial insert, 잘못된 slug, 9개·76개, duplicate case, invalid timestamp/date, out-of-order snapshot 실패
- snapshot gap이 있어도 직전 finalized row를 기준으로 판정
- DB schema/trigger 변조, update/delete/replace, foreign key·integrity 오류 탐지
- page/latest slug set 불일치 때 DB·JSON과 page publication이 전부 중단
- baseline DB가 없는 production upgrade 경로가 명시적이고 거짓 신규를 만들지 않음
- workflow allowlist 누락·validation 제거·publish-before-validation 변이를 테스트가 잡음
- 파일 크기 측정값을 기록한다. 임의 retention 삭제는 append-only와 충돌하므로 이번 라운드에서는 삭제하지 않는다. 예상 증가량과 1년/2년 크기를 실제 표본으로 계산해 문서화한다.

의도적 변이는 최소 두 개다.

1. baseline을 `new`로 분류하도록 바꿔 RED가 실패하는지 확인
2. publish allowlist 또는 conflict check 하나를 무효화해 workflow/DB 테스트가 실패하는지 확인

변이는 즉시 원복하고 `git diff`로 잔여가 없음을 확인한다.

### 5.5 N3 브라우저·production 완료 기준

- 390·720·1200·1440px에서 badge와 최근 이탈 section이 가로 넘침·카드 폭·tooltip rail을 침범하지 않는다.
- light/dark, hover, focus-visible 대비를 확인한다.
- 키보드로 sidebar를 열고 최근 이탈 link에 도달하며 Escape·focus restore가 유지된다.
- reduced-motion에서 새 badge 때문에 새 animation이 강제되지 않는다.
- baseline production에는 거짓 `신규` 0개다.
- 합성/격리 fixture로 new·reentered·exited UI를 확인하고 production에서는 실제 데이터에 존재하는 상태만 주장한다.
- N3 별도 커밋·push, Pages build/deploy success, production data JSON 200과 UI를 확인한다.

권장 커밋 메시지: `feat: track trending membership changes`

## 6. N4 — 정적 Atom feed

### 6.1 범위

이번 N4는 Atom 1.0 두 개를 구현한다.

- `feed.xml`: 현재 전체 Trending 저장소
- `changes.xml`: N3의 최근 `new`·`reentered` events

RSS와 Atom을 중복 생성하지 않는다. Atom 하나로 표준 구독 경로를 만들고, 실제 수요가 확인되기 전에는 언어·분야별 feed, 이메일, web push를 추가하지 않는다.

### 6.2 feed 계약

- 정적 Actions 생성물이며 backend와 token 저장이 없다.
- feed와 entry의 stable `id`를 정의한다.
  - 전체 feed entry: 저장소 slug 기반으로 실행 사이에 안정적
  - changes entry: snapshot generatedAt + status + slug 기반으로 한 사건에 안정적
- 전체 feed `updated`는 validated latest snapshot의 `generatedAt`이다.
- changes feed는 DB에서 결정적으로 계산한 최근 100개의 new/reentered event를 최신순으로 제공한다. baseline 항목은 포함하지 않는다.
- entry link는 public GitHub repository URL, alternate site link는 운영 Pages URL이다.
- title·summary·author가 없어도 되는지 Atom schema로 검증하고, 필요한 필드만 공개 데이터에서 만든다.
- XML text와 attribute escaping, `& < > " '` 및 Unicode/newline을 검증한다.
- 동일 입력 재실행은 XML bytes가 바뀌지 않는다.
- temp file → atomic rename을 사용한다.
- page `<head>`에 정확한 `<link rel="alternate" type="application/atom+xml">`를 추가한다.
- README.md와 README.en.md에 두 URL과 차이를 1:1로 설명한다.

### 6.3 N4 RED·변이·publication

- 최소 Atom 필수 요소와 namespace 검증
- 10~75 current entries, slug/URL identity, ordering
- changes feed baseline 0건, new/reentered만, stayed/exited 제외, 최근 100개 cap
- malicious description/slug fixture의 XML escaping
- invalid timestamp, duplicate id, missing membership DB, latest/page mismatch 실패
- 생성기 중간 실패 때 기존 last-good XML bytes 보존
- workflow validation 전 publish 불가, unexpected XML 외 생성물 차단
- `<link rel=alternate>`와 README 한·영 URL 계약
- XML escaping 한 줄 또는 stable id를 의도적으로 깨서 테스트가 실제 실패하는지 확인

N4 push 전에 N3의 production 상태가 유지되는지 전체 테스트와 브라우저에서 다시 본다. push 후 Pages run이 success인지, production `feed.xml`·`changes.xml`이 200인지, XML을 파싱할 수 있는지, page head 링크가 맞는지 검증한다. Content-Type은 GitHub Pages 응답을 측정해 사실대로 보고하고 임의 헤더 제어를 약속하지 않는다.

권장 커밋 메시지: `feat: publish atom feeds for trending updates`

## 7. N5 — 현재 보기 CSV·JSON·공유 URL 내보내기

### 7.1 범위와 UI

- 브라우저 내부 변환만 쓴다. 서버 업로드와 개인 export 저장을 추가하지 않는다.
- sidebar의 정렬·필터 근처에 compact export group을 둔다.
- 조작은 `CSV 다운로드`, `JSON 다운로드`, `현재 링크 복사` 세 개다.
- 카드마다 export control을 추가하지 않는다.
- 버튼의 실제 조작 영역은 44×44px 이상이고 accessible name과 live success/error status를 제공한다.
- 현재 sidebar/README/tooltip overlay 상호 배타성과 focus 흐름을 보존한다.

### 7.2 데이터 계약

export 대상은 **숨김·즐겨찾기·검색·언어·분야·형태·AI 제외·기간·정렬을 모두 적용한 뒤 화면에 보이는 배열**이다. 별도 재필터링으로 화면과 export가 갈라지지 않게 render 직전의 동일 배열을 넘긴다.

JSON 권장 top-level:

- `schemaVersion`
- `exportedAt`
- `sourceUrl`
- `filters`: `view, period, lang, field[], tag[], excludeAi, q, sort`
- `resultCount`
- `repositories`

repository 공개 필드는 slug, name, description, language, topics, stars, forks, issues, contributors, 선택 기간 gain, pushedAt, latestRelease, N3 current status 정도로 제한한다. Firebase uid, 로그인 상태, 즐겨찾기 전체 목록, 숨긴 slug 전체 목록, localStorage key를 내보내지 않는다. 즐겨찾기 view인지는 filter metadata에 표시할 수 있지만 계정 정보는 포함하지 않는다.

CSV는 고정 column 순서를 문서화하고 RFC 4180 계열 quoting을 적용한다.

- comma, quote, CR/LF가 있으면 double quote로 감싼다.
- 내부 `"`는 `""`로 바꾼다.
- leading whitespace 뒤 `=`, `+`, `-`, `@` 또는 tab/CR/LF로 spreadsheet formula가 실행될 수 있는 문자열에는 앞 apostrophe를 붙인다.
- 숫자는 숫자로 유지하되 문자열 입력을 숫자로 강제 변환하지 않는다.
- UTF-8 BOM 포함 여부를 한국어 Excel 호환성과 테스트로 한 번 정하고 README와 맞춘다.

download helper는 Blob 생성·`URL.createObjectURL`·임시 anchor click 뒤 object URL을 반드시 revoke하고 anchor를 제거한다. Blob/URL/clipboard 거부는 페이지를 깨뜨리지 않고 live error로 알린다. 현재 최대 75개여도 empty·75개·긴 Unicode 필드를 테스트한다.

현재 링크 복사는 whitelist된 현재 URL state만 사용한다. 숨긴 slug, 즐겨찾기 slug, 계정 정보는 URL에 새로 넣지 않는다. Clipboard API가 없거나 거부될 때 현재 코드 스타일에 맞는 작은 fallback 또는 명시적 실패 중 하나를 택하고 테스트한다.

### 7.3 N5 RED·변이·브라우저

- 기본 Trending 순서 export와 화면 순서 동일
- 각 N2 sort, filter 조합, favorites, hidden, empty state에서 export 순서·count 동일
- popstate로 복원한 상태와 export metadata 일치
- CSV comma/quote/CRLF/Unicode와 formula injection fixture
- JSON 공개-field allowlist와 개인 상태 부재
- Blob URL revoke, anchor cleanup, repeated download
- clipboard success/denial, live status, focus 보존
- large/75 item, empty result, serialization failure 처리
- formula 방어 또는 동일 배열 연결을 의도적으로 깨서 테스트 실패 확인
- 390·720·1200·1440px, keyboard only, light/dark, reduced-motion에서 export group 겹침·overflow 0
- 실제 다운로드한 CSV·JSON을 다시 읽어 화면 slug 순서와 1:1 대조
- production에서 copy URL을 새 탭에 열어 동일 view·period·sort·filters가 복원되는지 확인

N5 production 확인 뒤 README.md와 README.en.md의 현재 기능·사용법을 함께 동기화한다. README 변경은 N5 기능 커밋에 포함할 수 있지만 두 언어판과 production 증거가 모두 맞아야 한다.

권장 커밋 메시지: `feat: export the current trending view`

## 8. 공통 작업 절차와 비밀값 검사

각 기능마다 다음을 반복한다.

1. 현재 문제를 재현하거나 RED 테스트로 고정
2. 한 기능의 최소 코드만 수정
3. 관련 테스트와 `npm test`
4. 의도적 변이 후 RED 실패 확인, 변이 원복
5. local browser 390·720·1200·1440px와 keyboard/reduced-motion 검증
6. `git diff --check`, 변경 파일 재독, 예상 밖 파일 0 확인
7. `git add -A`
8. staged added-content 중심 비밀값 검사
9. 기능별 커밋
10. push 직전 fetch/status/remote advance 재판정
11. push
12. Pages build와 deploy 모두 success 확인
13. production 기능·console·network 재검증
14. 다음 기능 착수

비밀값을 출력하지 않는다. staged scan은 기존 workflow 패턴을 포함해 최소 다음 종류를 찾되, 매치가 있으면 값 전체를 대화에 찍지 말고 파일·줄과 종류만 안전하게 판정한다.

- GitHub classic/fine-grained token 패턴
- Google API key 패턴
- private key header
- 새로 추가된 password/token/secret assignment의 실값

SQLite는 binary이므로 문자열 grep 하나를 완전한 검사로 과장하지 않는다. `strings` 등으로 민감값 전체를 출력하지 말고, 새 DB가 오직 공개 slug·timestamp·checksum·schema만 갖는지 schema와 row projection으로 검증한다.

## 9. 자동 갱신과 Git 충돌 처리

- feature 작업 중 bot이 main을 전진시킬 수 있다.
- force push, reset --hard, history rewrite, remote branch 삭제를 하지 않는다.
- 작업트리가 깨끗하고 bot commit만 앞서면 `git merge --ff-only origin/main`.
- feature commit이 있고 remote가 bot으로 전진했으면 먼저 변경 경로와 merge 가능성을 검사한다. non-destructive merge 또는 rebase가 필요한 상황에서는 저장소의 현재 정책과 사용자 변경을 보존한다. 자동으로 history를 재작성하지 않는다.
- N3 이후 bot expected output allowlist가 늘어난다. 새 DB·JSON·XML을 빠뜨리면 bot이 실패하고, 너무 넓히면 예상 밖 생성물이 publish된다. exact path로만 허용한다.
- bot commit 자체가 Pages를 다시 배포할 수 있으므로 각 기능의 production SHA를 run metadata와 연결해 기록한다.

## 10. 사용자에게 다시 물어야 하는 경계

다음 경우에만 자동 진행을 멈춘다.

- N3를 구현하려면 기존 `star-observations.sqlite` v1을 변형하거나 history migration을 다시 해야 하는 경우
- 첫 baseline으로 현재 snapshot 외의 과거 membership을 추론해야 하는 경우
- N4가 이메일·web push·언어/분야별 feed·외부 feed service로 확대되는 경우
- N5가 개인 즐겨찾기·숨김 목록·uid를 파일이나 URL에 포함해야 하는 경우
- 새 서버, 비용 있는 API, 비밀값, 개인정보, 새 영구 dependency가 필요한 경우
- bot remote advance가 사람의 변경과 섞여 ff-only/보존 가능한 merge로 해결되지 않는 경우
- production 로그인만으로 확인 가능한 회귀가 생긴 경우. 사용자는 현재 원격이라 로그인해 줄 수 없으므로 M1을 우회해 인증을 추측 수정하지 않는다.

그 밖의 정상적인 구현 선택은 이 문서의 우선안과 현재 코드 스타일을 따라 진행한다.

## 11. 최종 완료 정의

- N3, N4, N5가 순서대로 서로 다른 커밋과 production SHA로 배포됐다.
- N3 baseline은 거짓 신규 0이며 이후 new/reentered/stayed/exited 정의가 append-only 정본과 일치한다.
- 기존 star observation DB의 schema fingerprint와 canonical legacy rows가 그대로다.
- partial failure와 conflicting rerun은 last-good page/data/feed를 publish하지 않는다.
- `feed.xml`과 `changes.xml`이 표준 XML로 파싱되고 stable id·escaping·alternate links를 갖는다.
- CSV·JSON export가 현재 화면 순서와 1:1이며 formula injection과 quoting을 방어한다.
- export와 URL에 개인 상태·비밀값이 없다.
- 390·720·1200·1440px에서 overflow·overlay·tooltip·44px target 회귀가 없다.
- keyboard, Escape, focus restore, inert, scroll lock, reduced-motion이 유지된다.
- N1 숨김, N2 정렬, 즐겨찾기, guest fallback, 2시간 갱신, README hash 번역 gate가 회귀하지 않는다.
- Node·Python 전체 테스트가 통과하고 Firestore Rules 범위는 인증/Rules를 바꿨을 때만 현재 환경에서 다시 실행한다.
- 각 새 테스트가 의도적 변이를 실제로 잡았다.
- staged 비밀값 검사와 unexpected-output gate가 통과했다.
- 각 Pages build/deploy와 production 재검증 증거가 있다.
- README.md와 README.en.md가 현재 기능과 feed/export 사용법을 1:1로 설명한다.
- `HEAD == origin/main`, 작업트리 clean이다.
- OFA 작업기록·의사결정기록에 실제 결과와 남은 M1 보류가 반영됐다.
- N5 뒤 L1~L5나 로그인 유지보수를 자동으로 시작하지 않는다. 완료 보고 뒤 다음 범위는 사용자가 정한다.
