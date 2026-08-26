# GitHub Trending Daily 다음 기능 라운드 핸드오프

- 작성일시: 2026-08-26 16:09 KST
- 저장소: `https://github.com/nowwcastle-sudo/github-trending-daily`
- 운영 페이지: `https://nowwcastle-sudo.github.io/github-trending-daily/`
- 로컬 경로: `C:\Users\nasca\AppData\Local\Temp\gh-trending-page`
- 직전 조사 기준서: [`2026-08-26-feature-expansion-research.md`](2026-08-26-feature-expansion-research.md)
- 기능 구현 커밋: `a2bf3c699a928e4b6fee5d2e965e3d383c9d9013`
- README·운영 이미지 커밋: `a19ec3aff6e65a35debdddf7e0668cbaf1662c67`
- 작성 직전 최신 자동 갱신 커밋: `7bc3d026d518ba259370731d1db5a4cc6f4ec8b0`
- 상태 주의: 2시간 자동 갱신이 `main`을 계속 전진시킨다. 위 SHA를 새 세션의 현재값으로 가정하지 말고 반드시 다시 측정한다.

## 다음 세션의 우선순위와 승인 경계

사용자는 2026-08-26 종료 인계 중 네 가지 유지보수를 추가로 요청했고, **기능 후보보다 먼저 처리하라고 순서를 확정했다.** 새 세션은 별도 범위 질문 없이 `M1 로그인 유지 → M2 갱신 시각 이동 → M3 light mode 경계 강화 → M4 탐색 트리거 재배치` 순서로 시작한다. 단, 관측과 지시가 충돌하면 추측으로 고치지 않고 실제 실패 조건을 먼저 제시한다.

유지보수 네 건을 각각 검증·배포한 뒤에만 다음 코드 라운드를 `N1 관심 없음` 하나로 작게 시작할지, 같은 사이드바 상태를 공유하는 `N1 관심 없음 + N2 명시적 정렬`을 두 개의 독립 커밋으로 한 라운드에 구현할지 사용자에게 확인한다.

기능 후보에 대한 권고는 **N1을 먼저 완성하고 같은 라운드에서 N2를 별도 커밋으로 이어가는 것**이다. 둘 다 기존 공개 데이터와 브라우저 상태만 사용하고 운영비가 없지만, N1은 개인 상태·복구 UX를 추가하고 N2는 URL 호환성과 정렬 불변식을 추가하므로 테스트와 커밋을 합치지 않는다.

사용자가 N1~N5 전체를 아직 일괄 구현 승인한 것은 아니다. 직전 조사에서 `I1 I2 I3`만 명시적으로 채택했고, `N1~N5`는 “다음 순서 권고”였다. 반면 `M1~M4`는 이번 추가 요청으로 착수 승인된 유지보수 범위다.

## 이번 세션에서 완료한 것

### I1 반응형 탐색 사이드바

- 계정 상태, Google 로그인·로그아웃, 즐겨찾기 보기를 사이드바 최상단에 배치했다.
- 기간·검색은 빠른 상단 조작으로 남기고, 언어·분야·형태·AI 제외는 사이드바에 모았다.
- 데스크톱 고정 패널은 채택하지 않았다. 기존 툴팁이 1440px에서도 카드 열을 왼쪽으로 이동시키므로 고정 258px 패널과 레일이 실제로 겹쳤다.
- 모든 화면에서 열고 닫는 overlay sidebar로 구현해 카드 폭과 조건부 툴팁 레일을 보존했다.
- 사이드바는 `role="dialog"`, `aria-modal`, 초기 포커스, 포커스 트랩, Escape 닫기, 배경 `inert`, body scroll lock, 트리거 포커스 복원을 갖는다.
- README 패널에도 같은 포커스·배경 경계를 보완했다.

### I2 분야·형태 다중 태그와 AI 제외

- 새 모듈: `repo-filters.js`
- 분야 태그:
  - `AI·머신러닝`
  - `웹·앱 개발`
  - `개발 도구`
  - `데이터·DB`
  - `DevOps·인프라`
  - `보안·프라이버시`
  - `앱·생산성`
  - `시스템·하드웨어`
  - `학습·자료`
  - `미분류`
- 형태·기술 태그:
  - `Agent`
  - `MCP`
  - `Plugin·Skill`
  - `IDE·코딩 도구`
  - `Library·SDK`
  - `Framework`
  - `CLI·Automation`
- 분야 그룹 안은 OR, 형태 그룹 안은 OR, 분야·형태·언어·검색 사이는 AND다.
- `AI 제외`는 양의 태그 선택보다 우선한다.
- 초기 구현은 LLM 분류를 쓰지 않는다. `slug`, 이름, 설명, 언어, GitHub Topics, 기존 요약의 목표·적합 상황을 규칙으로 분류한다.
- `scripts/update-trending.mjs`가 GitHub REST 저장소 응답의 `topics`를 검증·보존하고, `scripts/update-latest-feed.mjs`가 공개 feed에 전달한다.
- 2026-08-26 16:04 KST 자동 갱신 뒤 embedded REPOS와 `data/latest.json`은 모두 41개이고 모든 저장소에 `topics` 배열이 있다. 그중 29개는 비어 있지 않다.
- 연구 보고서에서 제안했던 `API·Integration`, `RAG·Memory`, `Model·Inference`, `Generative Media`, `Local-first` 형태 태그와 수동 override 파일은 실제 표본 없이 범주를 늘리지 않기 위해 아직 구현하지 않았다. 다음 라운드에서 조용히 추가하지 않는다.

### I3 공유 가능한 URL 필터 상태

- URL에 보존하는 상태:
  - `period`
  - `view=favorites`
  - `lang`
  - `field`
  - `tag`
  - `exclude=ai`
  - `q`
- 허용값 whitelist를 적용하고 검색어는 120자로 제한한다.
- 입력 중 검색어는 `history.replaceState`, 명시적 선택은 `history.pushState`를 사용한다.
- `popstate`에서 전체 필터 UI와 카드 목록을 복원한다.
- 정렬 기능 N2를 추가하면 `sort`도 같은 whitelist·round-trip 계약에 포함해야 한다.

### README와 실제 production 이미지

- `README.md`와 `README.en.md`를 동일한 7개 섹션으로 개편했다.
- 현재 기능 12개와 로드맵 2개가 한·영 1:1로 대응한다.
- 실제 1차 기능 배포가 끝난 뒤 production에서 직접 촬영한 이미지 2개를 저장했다.
  - `docs/screenshots/production-desktop.png`
  - `docs/screenshots/production-mobile-sidebar.png`
- README의 로드맵은 현재 확정된 범위만 적었다. N1~N5가 채택되면 구현·production 확인 뒤 두 언어판을 함께 갱신한다.

## 완료 증거

### 테스트

최종 기능·README 커밋 기준 `npm test` 종료 코드 0:

- Node: 총 161개
- 통과: 152개
- 실패: 0개
- 건너뜀: Firestore Rules 에뮬레이터용 9개
- Python unittest: 23개 통과

새 AI 제외 테스트가 실제 결함을 잡는지 확인하기 위해 조건을 한 줄 의도적으로 무효화했다. 해당 테스트가 `true !== false`로 실패하는 것을 확인한 뒤 원상복구하고 전체 테스트를 다시 통과시켰다. 변이 코드는 커밋하지 않았다.

Firestore Rules 9개는 이번 `npm test`에서 에뮬레이터 미실행으로 건너뛴 범위다. 이전 완료 기준에서 별도 9/9 통과 증거가 있지만, 다음 인증·동기화 변경이 있으면 `npm run test:rules`를 현재 환경에서 다시 실행한다.

### 브라우저·운영 검증

- production 1440px: 문서 가로 넘침 0
- production 390px: 문서 가로 넘침 0
- 모바일 저장소명과 즐겨찾기 버튼 실제 겹침: 0/41
- 즐겨찾기 버튼과 기간 버튼: 44px 터치 높이
- `?tag=mcp` 적용: 41개에서 3개로 필터링
- 브라우저 뒤로가기: URL, 선택 상태, 41개 목록 복원
- 사이드바 열림: main `inert`, body scroll lock, 닫기 버튼 초기 포커스
- Escape 닫힘: main 복구, `navToggle`로 포커스 복원
- axe 4.12.1: violations 0
- axe incomplete 1그룹: 기존 gradient와 아이콘 전경의 대비를 자동 계산하지 못한 항목. 완전한 대비 통과로 과장하지 않는다.
- Impeccable detector: parser 의존성 부재로 DEGRADED regex 모드, 결과 `[]`. undercount이므로 브라우저 실측과 독립 레이아웃 검토를 주된 근거로 사용했다.

### 배포

- 기능 Pages 배포: `https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/32939496000`
- README Pages 배포: `https://github.com/nowwcastle-sudo/github-trending-daily/actions/runs/32940389473`
- 두 배포 모두 build·deploy 성공
- Pages 상태: `built`
- production에서 두 이미지가 HTTP 200 `image/png`으로 제공되는 것을 확인했다.
- Pages build에는 `actions/upload-artifact@v4`의 Node.js 20 폐기 예정 경고가 있다. GitHub가 Node.js 24로 강제 실행해 현재 성공했지만 후속 유지보수 경고로 남긴다.

## 되풀이하지 않을 결정과 이유

### 고정 사이드바를 다시 제안하지 않는다

고정 폭 사이드바는 기존 툴팁 레일과 충돌하고 카드 열을 압박했다. 현재 overlay가 단순한 임시방편이 아니라 측정된 공간 제약에 따른 결정이다. 되돌릴 조건은 툴팁 구조나 전체 shell을 함께 재설계해 1100~1440px 구간의 레일 충돌이 사라졌다는 실측이 있을 때뿐이다.

### 분야와 형태를 한 카테고리로 합치지 않는다

`AI Agent`, `MCP`, `Plugin`, `Library`는 같은 축이 아니다. 한 저장소가 AI·보안 분야이면서 MCP·Agent 형태일 수 있다. 현재 두 축 다중 태그는 이 중첩을 보존한다.

### LLM으로 매 갱신마다 분류하지 않는다

규칙 기반 분류는 설명 가능하고 추가 비용이 없으며 정적 Pages와 맞는다. 오분류 개선은 우선 실제 표본 검수, 규칙 수정, 필요하면 명시적 수동 override로 해결한다.

### 기존 완료 항목을 재구현하지 않는다

새 반증이 없는 한 다음은 이미 완료된 회귀 보호 대상이다.

- Google 로그인과 Firebase App Check·즐겨찾기 동기화
- 모바일 첫 탭 요약과 데스크톱 조건부 툴팁 이동
- transform 중심 모션과 reduced-motion
- 2시간 갱신과 화면의 최근·다음 갱신 안내
- 연속 등장·총 스타 변화·HOT 배지 안내
- README 원문·캐시된 한국어 뷰어
- 신규 저장소 또는 README SHA-256 변경에만 유료 번역하는 비용 게이트

## 전체 작업 순서

유지보수 우선 요청을 반영한 전체 순서는 다음과 같다. I1~I3는 구현 완료이고 M1~M4가 새 세션의 첫 작업이다.

| ID | 단계 | 기능 | 현재 상태 |
|---|---|---|---|
| I1 | 즉시 | 반응형 사이드바 | **완료·배포** |
| I2 | 즉시 | 분야·형태 다중 태그와 AI 제외 | **완료·배포** |
| I3 | 즉시 | URL 필터 상태 | **완료·배포** |
| M1 | 유지보수 1 | 로그인 유지 | **착수 승인·최우선** |
| M2 | 유지보수 2 | 갱신 시각을 사이드바 상단으로 이동 | **착수 승인** |
| M3 | 유지보수 3 | light mode 카드·title box border 강화 | **착수 승인** |
| M4 | 유지보수 4 | 탐색 트리거를 좌측 사이드바에 결합 | **착수 승인** |
| N1 | 다음 1 | 관심 없음·숨기기 | 후보, 다음 착수 권고 |
| N2 | 다음 2 | 명시적 정렬 | 후보 |
| N3 | 다음 3 | 신규·재진입·이탈 이력 | 후보 |
| N4 | 다음 4 | RSS/Atom | 후보 |
| N5 | 다음 5 | 현재 보기 내보내기 | 후보 |
| L1 | 나중 | README 자연어 필터 | 보류 |
| L2 | 나중 | 저장소 비교 | 보류 |
| L3 | 나중 | 규칙 기반 개인화 | 보류, N1과 선호 데이터 이후 |
| L4 | 나중 | 메일·웹푸시 알림 | 보류, RSS 이후 |
| L5 | 나중 | 외부 활동 신호 | 보류, 운영비·외부 의존 큼 |
| R1 | 기각 | 브라우저 BYO LLM API key | 기각 |
| R2 | 기각 | Codex·Claude 구독 OAuth 연동 | 기각 |
| R3 | 기각 | 불투명한 종합 품질 점수 | 기각 |

## 우선 유지보수별 예상 작업

### M1 로그인 유지 — 유지보수 1

한 줄 정의: 같은 브라우저에서 새로고침·새 탭·브라우저 재시작 뒤에도 사용자가 명시적으로 로그아웃하기 전까지 Google 로그인 상태를 복원한다.

현재 관측:

- `firebase-client.js`는 `getAuth(app)`과 `onAuthStateChanged`를 사용하지만 persistence를 명시적으로 선택하는 코드는 없다.
- Firebase의 암묵적 기본값을 근거로 완료 처리하지 않는다. production에서 실제 재시작·새 탭 동작을 먼저 재현한다.
- 기존 로그인·즐겨찾기 동기화는 사용자가 실제 페이지에서 정상 작동을 확인한 완료 항목이다. 유지 실패 조건이 없으면 인증 흐름 전체를 재구현하지 않는다.

권장 작업:

- 로그인 상태가 풀리는 정확한 조건을 production과 로컬에서 재현한다: 새로고침, 새 탭, 브라우저 완전 종료·재시작, 명시적 로그아웃.
- 실패가 재현되면 현재 pinned Firebase 모듈이 제공하는 local persistence를 로그인 전에 명시하고 초기화 실패는 기존 guest fallback으로 안전하게 보낸다.
- 로그아웃 뒤에는 다시 로그인되지 않아야 하며, guest·account 즐겨찾기 분리와 계정 전환 stale callback 방어를 보존한다.
- persistence 선택이 실패했을 때 raw 오류·토큰·사용자 정보를 화면이나 로그에 노출하지 않는다.

예상 파일과 테스트:

- `firebase-client.js`
- `tests/favorite-sync.test.mjs`
- 필요하면 `tests/page-runtime.test.mjs`
- RED: 명시적 persistence가 auth observer와 로그인보다 먼저 설정됨
- RED: persistence 초기화 실패 시 guest fallback이며 로그인 성공으로 오표시하지 않음
- 브라우저: reload·new tab·restart 유지, logout 뒤 restart는 signed-out

완료 기준:

- 사용자가 로그아웃하기 전에는 동일 브라우저에서 로그인 상태가 유지된다.
- 명시적 로그아웃은 브라우저 재시작 뒤에도 유지된다.
- 기존 첫 import·삭제 유지·계정 전환·guest fallback 테스트가 회귀하지 않는다.

### M2 갱신 시각 텍스트를 사이드바 상단으로 이동 — 유지보수 2

한 줄 정의: 메인 카드 영역의 시각적 잡음을 줄이고, 데이터 상태 정보는 사이드바를 열었을 때 가장 먼저 확인할 수 있게 한다.

권장 작업:

- 현재 최근 갱신·다음 갱신 안내를 계정 영역보다 위 또는 사이드바 제목 바로 아래의 compact status 영역으로 옮긴다.
- 메인 페이지에서 같은 텍스트를 중복 표시하지 않는다.
- 2시간 스케줄 계산과 최근·다음 갱신 의미, live status 접근성은 그대로 보존한다.
- 사이드바가 닫혀 있어도 정보가 사라졌다는 오해를 줄이도록 탐색 트리거에 긴 문구를 넣지 말고 accessible name 또는 상태 표식만 검토한다.

예상 파일과 테스트:

- `index.html`
- `tests/page-runtime.test.mjs`
- `tests/refresh-schedule.test.mjs`
- RED: refresh status가 sidebar 내부에 정확히 한 번 존재하고 main header row에는 없음
- RED: 계산·문구 계약은 이동 전과 동일

완료 기준:

- 메인 상단이 간결해지고 갱신 안내는 사이드바 최상단에서 읽힌다.
- 390·720·1200·1440px에서 잘림·가로 넘침·헤더 높이 회귀가 없다.

### M3 light mode 카드·title box border 강화 — 유지보수 3

한 줄 정의: 흰 배경에서 카드와 상단 title box의 경계를 분명히 해 목록 구조와 가독성을 높인다.

권장 작업:

- light theme 전용 semantic border token을 두고 카드와 title box에 같은 계열의 절제된 경계색을 적용한다.
- 그림자나 두꺼운 선으로 무게를 늘리지 않는다. dark theme의 현재 대비와 카드 중심 밀도는 건드리지 않는다.
- hover·focus-visible·selected 상태가 기본 border와 구분되도록 상태 대비를 확인한다.

예상 파일과 테스트:

- `index.html`
- `tests/page-runtime.test.mjs`
- RED: light theme 카드와 title box가 semantic border를 사용하고 dark theme 계약은 유지
- 브라우저·axe: light mode 실제 화면과 자동 대비를 함께 확인하고 `incomplete`는 통과로 세지 않음

완료 기준:

- light mode에서 카드·상단 title box 경계가 한눈에 구분된다.
- 경계 추가가 답답한 이중 테두리나 과도한 box shadow를 만들지 않는다.

### M4 탐색 트리거를 좌측 사이드바에 결합 — 유지보수 4

한 줄 정의: 탐색 버튼을 멀리 찾지 않고 페이지 왼쪽 가장자리에서 사이드바와 한 덩어리처럼 열고 닫는다.

권장 구현안:

- 현재 탐색 아이콘을 사용한 작은 edge tab을 페이지 왼쪽 끝에 고정하고, 사이드바가 열리면 같은 높이에서 패널 가장자리에 붙어 함께 이동시킨다.
- 화살표만 쓰면 의미 발견성이 떨어지므로 기본은 현재 탐색 아이콘을 유지하고 `aria-label`, `aria-expanded`, `aria-controls`로 상태를 전달한다.
- 시각적으로 compact하게 보여도 실제 pointer target은 최소 44×44px로 유지한다.
- 버튼과 패널 사이에는 이중 border·틈을 만들지 않고 하나의 surface처럼 보이게 한다.
- 버튼 재클릭, 바깥 클릭, Escape로 닫고 트리거에 포커스를 복원한다. 스크림을 별도 클릭해도 닫힌다.
- transform·opacity 중심으로 부드럽게 움직이고 duration/easing은 `apple-design` 기준으로 조정한다. `prefers-reduced-motion`에서는 이동을 즉시 또는 최소화한다.
- tooltip·README와 overlay 상호 배타성, body scroll lock, `inert`, focus trap을 보존한다.
- 모바일에서는 safe-area와 브라우저 edge gesture를 침범하지 않는지 390px 실제 viewport에서 확인한다.

예상 파일과 테스트:

- `index.html`
- `ui-motion.js` 또는 기존 inline sidebar coordinator
- `tests/page-runtime.test.mjs`
- `tests/ui-motion.test.mjs`
- RED: 버튼·바깥 클릭·Escape 닫기, `aria-expanded`, 포커스 복원, overlay 상호 배타성
- 브라우저: 390·720·1200·1440px 위치·겹침·motion·reduced-motion 측정

완료 기준:

- 탐색 트리거가 왼쪽 가장자리에서 즉시 발견되고 사이드바와 시각적으로 결합된다.
- 닫힌 상태에서 카드·tooltip·스크롤을 가리지 않는다.
- 열린 상태에서 버튼과 패널이 같은 surface처럼 부드럽게 출입한다.
- bare arrow 대안이나 상단 버튼 단순 이동은 실제 viewport 측정에서 edge tab이 사용성을 해칠 때만 다시 선택한다.

## 다음 후보별 예상 작업

### N1 관심 없음·숨기기 — 다음 1

한 줄 정의: 특정 저장소를 이 브라우저의 목록에서 감추고 사이드바 관리 화면에서 언제든 복구한다.

해결하는 문제:

- 같은 저장소의 반복 노출
- 개인적으로 관심 없는 분야가 상위 목록을 차지하는 문제

권장 첫 범위:

- localStorage 전용으로 시작한다.
- Firebase 계정 문서에 숨김 목록을 추가하지 않는다. 클라우드 동기화는 관심 프로필이라는 개인정보 경계를 새로 만들므로 별도 승인 대상이다.
- 카드 밀도를 해치지 않도록 상시 세 번째 아이콘을 추가하지 않는다.
- 데스크톱 툴팁과 모바일 첫 탭 요약의 action 영역에 `관심 없음`을 두는 방식을 우선 검토한다.
- 직후 되돌리기와 사이드바의 `숨긴 저장소 관리`에서 복구할 수 있어야 한다.
- 전체 초기화가 숨김 목록까지 지우는지, 필터 상태만 지우는지 의미를 분리한다.

예상 파일:

- 새 작은 상태 모듈 또는 `favorites.js`와 분리된 `hidden-repos.js`
- `index.html`
- 새 단위 테스트
- `tests/page-runtime.test.mjs`

필수 테스트:

- slug 검증, 중복 제거, 손상된 storage, storage read/write 거부
- 숨김·복구·되돌리기
- 숨김 적용 뒤 결과 수와 empty state
- 즐겨찾기와 숨김이 동시에 존재할 때의 명시적 우선순위
- 계정 전환이 local hidden 상태를 건드리지 않음
- 브라우저 새로고침 후 유지

권장 완료 기준:

- 사용자가 한 동작으로 감추고 즉시 되돌릴 수 있다.
- 숨김 관리에서 모두 복구할 수 있다.
- URL에는 숨긴 저장소 slug를 노출하지 않는다.
- Firebase schema와 Rules는 바뀌지 않는다.

### N2 명시적 정렬 — 다음 2

한 줄 정의: 현재 필터 결과를 설명 가능한 원자료 기준으로 재정렬한다.

권장 첫 정렬값:

- 기본 Trending 순서
- 선택 기간 스타 증가
- 총 스타
- 최근 push
- 최근 release

`신규` 정렬은 N3의 정의와 데이터가 생긴 뒤 추가한다.

예상 작업:

- `repo-filters.js` URL state에 whitelist된 `sort` 추가
- 사이드바에 정렬 select 추가
- stable sort와 결정적 tie-breaker 정의
- 현재 기간과 기간 증가 정렬의 관계 명시
- 뒤로가기·공유 URL round-trip 테스트
- null `pushed_at`, `latest_release`, 기간 증가값 처리 테스트

금지:

- 여러 값을 임의 가중치로 섞은 자체 종합 점수
- 사용자가 이유를 알 수 없는 자동 재정렬

### N3 신규·재진입·이탈 이력 — 다음 3

한 줄 정의: 직전 finalized snapshot과 현재 목록을 비교해 `신규`, `재진입`, `유지`, `이탈`을 구분한다.

먼저 확정할 정의:

- 신규: 저장된 전체 이력에서 처음 관측
- 재진입: 과거 관측은 있으나 직전 finalized snapshot에는 없고 현재 다시 등장
- 유지: 직전과 현재 모두 등장
- 이탈: 직전에는 있었으나 현재 없음

현재 `data/latest.json`만으로는 이탈과 재진입의 전체 이력을 안전하게 복원할 수 없다. 코드 전에 데이터 정본을 설계해야 한다.

권장 방향:

- 기존 append-only `data/star-observations.sqlite`를 무작정 재해석하지 않는다.
- membership snapshot을 별도 append-only table 또는 작고 검증 가능한 데이터 파일로 둘지 비교한다.
- 이력 생성이 실패하면 last-good page를 유지하고 부분 데이터를 게시하지 않는다.
- 카드에는 신규·재진입처럼 현재 저장소에 해당하는 짧은 신호만 표시하고, 이탈 목록은 별도 compact view나 feed에서 제공한다.

필수 검증:

- 첫 실행 baseline은 모든 현재 저장소를 신규라고 거짓 표시하지 않도록 migration 의미를 정한다.
- 동일 날짜·중복 실행·부분 실패·snapshot gap
- bot 자동 갱신이 main을 전진시키는 publication gate
- 보존 기간과 파일 크기

### N4 RSS/Atom — 다음 4

한 줄 정의: 사이트를 열지 않아도 새 Trending 항목을 feed reader에서 구독한다.

권장 순서:

1. 표준 전체 feed 하나
2. N3가 있으면 신규·재진입 중심 feed
3. 실제 수요를 확인한 뒤 언어·분야 feed

예상 작업:

- Actions에서 정적 XML 생성
- atom/rss schema와 escaping 검증
- 항목 identity와 updated 시각 안정화
- `<link rel="alternate">`와 README 사용법
- last-good feed publication과 partial failure 차단

메일 시스템이나 push token 저장보다 먼저 구현한다. 공개 데이터만 쓰므로 정적 Pages 적합성이 높다.

### N5 현재 보기 내보내기 — 다음 5

한 줄 정의: 현재 필터·정렬 결과를 CSV, JSON 또는 클립보드로 재사용한다.

권장 첫 범위:

- 브라우저 내부 변환만 사용
- CSV와 JSON 다운로드, 현재 공유 URL 복사
- 공개 필드와 현재 필터 metadata만 포함
- CSV formula injection 방지와 quote/newline escaping
- Blob URL revoke와 큰 결과 실패 처리

내보내기 순서는 반드시 화면의 현재 정렬과 같아야 한다.

## 나중 후보의 진입 조건

### L1 README 자연어 필터

- 공식 Trending의 Spoken Language와 현재 한국어 번역이 이미 문제를 상당 부분 해결한다.
- 혼합 언어 README와 판정 오류의 실수요가 확인될 때만 시작한다.

### L2 저장소 비교

- 현재 history 데이터 범위 안에서 2~4개 비교가 유용한지 먼저 확인한다.
- 외부 star service 의존 없이 가능한 범위를 우선한다.

### L3 규칙 기반 개인화

- N1 숨김과 즐겨찾기·선호 태그가 축적된 뒤다.
- 첫 버전은 local-only, 설명 가능한 규칙이어야 한다.
- 추천 이유를 표시하고 기본 Trending 순서로 즉시 돌아갈 수 있어야 한다.
- LLM을 쓰지 않는다.

### L4 메일·웹푸시 알림

- N4 RSS로 수요를 먼저 검증한다.
- 메일·push는 구독 동의, 해지, 이메일 또는 push token, 실패 재시도, 제공자 비용이 생기므로 정적 Pages 범위를 벗어난다.

### L5 외부 활동 신호

- HN, 릴리스, 이슈 품질 등은 정보 유용성이 있지만 API quota, schema drift, 약관, 장애가 생긴다.
- 명확한 단일 신호와 운영비 승인이 없으면 시작하지 않는다.

## 기각 경계

### R1 브라우저 BYO LLM API key

- 브라우저 client-side에 사용자의 provider key를 두지 않는다.
- 안전하게 만들면 backend proxy, 키 보관, rate limit, abuse·billing guard가 필요해 현재 정적 구조와 맞지 않는다.

### R2 Codex·Claude 구독 OAuth 연동

- 제3자 웹앱이 구독 credential을 추천 엔진으로 중계할 수 있다고 가정하지 않는다.
- 공식 공개 OAuth 지원, 약관, token scope, 저장 경계가 모두 확인되기 전에는 후보로 되살리지 않는다.

### R3 불투명한 종합 품질 점수

- 정렬은 기간 증가, 총 스타, 최근 push/release, 신규·재진입처럼 원자료를 그대로 노출한다.
- 설명할 수 없는 단일 품질 점수는 순위 불신을 더 키우므로 만들지 않는다.

## 현재 주요 파일

- `index.html` — sidebar, URL state wiring, 카드·툴팁·README 렌더링, generated REPOS
- `repo-filters.js` — 분류, 필터, URL parse/serialize
- `favorites.js` — legacy/local favorite normalization helper
- `favorite-sync.js` — guest·account favorite controller
- `firebase-client.js` — Google 인증, App Check, Firestore wiring
- `ui-motion.js` — tooltip rail/overlay 계산, 모바일 첫 탭, badges
- `scripts/update-trending.mjs` — Trending 수집, REST metadata/topics, snapshot publication
- `scripts/update-latest-feed.mjs` — 공개 latest feed와 signals
- `.github/workflows/daily-refresh.yml` — 2시간 갱신·번역·검증·publication
- `scripts/generate-translations.mjs` — README SHA-256 기반 유료 번역 queue
- `data/translation-sources.json` — 마지막 성공 번역 source hash
- `data/star-observations.sqlite` — append-only star observation 정본
- `star-history.json` — 현재 페이지용 history cache
- `README.md`, `README.en.md` — 1:1 사용자 문서
- `tests/repo-filters.test.mjs` — 새 분류·필터·URL 계약
- `tests/page-runtime.test.mjs` — DOM·접근성·wiring 계약
- `tests/update-trending.test.mjs` — metadata/topics·snapshot·publication 계약
- `tests/daily-refresh-workflow.test.mjs` — workflow와 README 계약

## 도구·기억 경계

- 저장소 루트에 별도 `AGENTS.md`는 없다. 상위 지침을 따른다.
- `.ua/knowledge-graph.json`은 존재하지만 2026-08-24 생성본이고 옛 갱신 설명이 섞여 있다. 구조 지도일 뿐 현재 동작의 정답이 아니다. 전체 rebuild는 `.understandignore` 결정과 별도 승인이 필요하다.
- Agentmemory에는 이 저장소와 경로가 일치하는 최근 세션이 없었다.
- 검색된 2026-08-25 agentmemory 관측은 `03:17 KST`, 로그인 불안정, 번역 누락, 테스트 116개 등 현재와 다른 내용을 포함한다. 새 세션은 해당 관측을 현재 사실로 사용하지 않는다.
- 이 문서의 순서는 원래 조사 최종 보고서를 로컬 Codex session JSONL에서 복원해 정본화했다. 다음 세션은 더 이상 대화 기록에 의존하지 않아도 된다.
- 기존 조사에서는 Exa와 agentbrowser를 실제 사용했다. 당시 `web-collect` 직접 실행 도구는 없었고 대체 경로를 명시했다.
- UI 변경 시 `impeccable`과 `apple-design`을 사용하고 `frontend-design`은 사용하지 않는다.
- Ponytail Full 원칙대로 새 프레임워크·서버·의존성을 기능 편의를 위해 추가하지 않는다.

## OFA에서 읽을 정본 기록

데스크톱의 정본 vault는 `D:\OFA\OFA\00_원천`이다. 더청춘 vault에는 새 기록을 쓰지 않는다.

- `D:\OFA\OFA\00_원천\10_클로드작업기록\2026-08-26_GitHub_Trending_사이드바·분야필터·URL상태·README_구현과_다음라운드_handoff.md`
- `D:\OFA\OFA\00_원천\47_의사결정기록\2026-08-26_GitHub_Trending_오버레이사이드바·다중태그·후속순서_결정.md`
- 기존 관련 결정: `D:\OFA\OFA\00_원천\47_의사결정기록\2026-08-23_GitHub_Trending_데이터·인증·모바일_결정.md`

위 두 2026-08-26 파일은 이 핸드오프와 같은 세션에서 생성한다. 경로가 없으면 기록 작성 실패로 보고하고 다른 vault에서 추측해 찾지 않는다.

## 새 세션의 첫 실행 순서

Windows PowerShell에서 다음을 한 줄씩 실행한다.

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\AppData\Local\Temp\gh-trending-page'
Test-Path -LiteralPath '.\AGENTS.md'
Test-Path -LiteralPath '.\.ua\knowledge-graph.json'
git fetch origin main
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git log -5 --format='%H %cI %s'
npm test
```

판정:

- 작업트리가 더럽다면 기존 변경을 사용자 소유로 보고 덮어쓰거나 reset하지 않는다.
- `HEAD != origin/main`이면 자동 갱신인지 `git show --stat origin/main`과 `git diff --name-status HEAD..origin/main`으로 먼저 확인한다.
- 작업트리가 깨끗하고 bot의 expected generated files만 전진했을 때만 `git merge --ff-only origin/main`을 사용한다.
- 테스트 실패가 있으면 기능 작업 전에 기존 실패인지 현재 remote 변화인지 분리한다.

그다음 다음 파일을 먼저 읽는다.

1. 이 핸드오프 전체
2. 직전 조사 핸드오프 전체
3. `repo-filters.js`
4. `index.html`의 generated REPOS 밖 CSS·HTML·JS
5. `favorites.js`, `favorite-sync.js`, `firebase-client.js`
6. `scripts/update-trending.mjs`, `scripts/update-latest-feed.mjs`
7. 관련 테스트
8. 위 OFA 작업기록·의사결정 기록

## 다음 라운드의 작업 규칙

1. M1→M2→M3→M4 유지보수를 후보 기능보다 먼저 처리한다.
2. 유지보수별로 재현 또는 RED 테스트를 먼저 만들고, 한 번에 하나씩 수정한다.
3. 각 유지보수의 검증 증거와 커밋을 구분한다. 같은 파일을 연속 수정해도 실패 원인을 합치지 않는다.
4. M1~M4 production 확인이 끝난 뒤 사용자에게 N1 단독 또는 N1+N2 순차 구현 범위를 확인한다.
5. N1과 N2는 한 파일에서 함께 수정돼도 커밋과 검증 증거를 분리한다.
6. 브라우저 localStorage·URL 상태에는 허용값과 크기 제한을 둔다.
7. 모바일 390px, 중간 폭 720px, desktop 1200px·1440px를 실제 브라우저로 측정한다.
8. sidebar를 열 때 tooltip을 닫고, README를 열 때 sidebar와 tooltip을 닫는 overlay coordinator를 보존한다.
9. 카드 높이와 폭을 늘리는 permanent control을 추가하지 않는다.
10. 전체 `npm test`, 의도적 변이, staged added-content 비밀값 스캔 뒤 커밋·push한다.
11. Pages build와 deploy를 모두 확인하고 production에서 다시 검증한다.
12. production 확인 뒤에만 두 README의 현재 기능·로드맵을 함께 갱신한다.
13. 유지보수 라운드 또는 승인된 기능 라운드가 끝나면 다음 후보를 자동 구현하지 말고 사용자 확인을 받는다.

## 다음 라운드 완료 정의

- 승인된 M1~M4가 먼저 완료됐고 기능 후보는 사용자 확인 전 구현되지 않았다.
- 로그인 유지가 reload·new tab·browser restart에서 검증되고 logout은 유지된다.
- 갱신 안내는 사이드바 상단에 한 번만 존재하고 2시간 계산은 동일하다.
- light mode 카드·title box 경계가 분명하고 dark mode가 회귀하지 않았다.
- 왼쪽 edge trigger가 44px 조작 영역, 바깥 클릭, Escape, focus restore, reduced-motion을 충족한다.
- 이후 승인된 기능 ID만 구현됐다.
- 해결하는 문제와 상태 저장 범위가 사용자에게 설명됐다.
- local·cloud 경계가 테스트로 고정됐다.
- URL backward compatibility가 유지됐다.
- 필터·숨김·정렬 조합의 결과가 결정적이다.
- 390/720/1200/1440px에서 가로 넘침과 조작 겹침이 없다.
- 키보드 포커스, Escape, reduced-motion이 회귀하지 않았다.
- 기존 로그인·즐겨찾기·툴팁·2시간 갱신·번역 비용 게이트가 통과했다.
- Node·Python 전체 테스트와 필요한 Firestore Rules 테스트가 통과했다.
- staged 비밀값 검사 결과가 0이다.
- GitHub Pages 배포 성공과 production 동작을 확인했다.
- `HEAD == origin/main`이고 작업트리가 깨끗하다.
- OFA 작업기록과 의사결정 기록이 실제 결과로 갱신됐다.

## 새 세션이 멈춰야 하는 지점

- N1을 local-only가 아니라 Google 계정에 동기화하려면 개인정보·Firestore schema·Rules 결정이므로 먼저 사용자 승인을 받는다.
- M1에서 로그인 유지 실패가 재현되지 않으면 인증 흐름을 추측으로 재작성하지 않고 관측 범위와 남은 불확실성을 보고한다.
- M4 edge tab이 모바일 browser gesture·tooltip rail·접근성에 실제 충돌하면 대안을 임의 확정하지 말고 측정값과 함께 사용자에게 선택을 요청한다.
- N3의 membership 정본과 migration 의미가 합의되지 않으면 구현하지 않는다.
- N4에서 메일이나 web push로 범위가 확대되면 중단하고 운영비·개인정보 설계를 별도 제안한다.
- BYO API key 또는 Codex·Claude OAuth를 다시 제안하려면 기존 기각 근거를 뒤집는 최신 공식 문서가 있어야 한다.
- 자동 갱신이 작업 중 `main`을 전진시키면 push 전에 fetch·diff·ff-only 가능 여부를 다시 판정한다.
