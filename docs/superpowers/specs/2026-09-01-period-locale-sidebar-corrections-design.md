# GitHub Trending 기간·언어·사이드바 교정 설계

- 확정일: 2026-09-01 KST
- 기준 source: `084a657d1bb36c7a79b3005161c50ddabf4938c0`
- 기준 snapshot: `20260831232256-93d42067ab071cda`
- 기준 production manifest SHA-256: `04fd835b5b5071aeda40728e772b82fbbe28eb2b25ef309be18c67dd6b420d04`
- 사용자 승인: 추천안 전체, inline 실행

## 사용자 요구사항 정본

1. 메인에서 언어 선택 시 해당 언어로 요약 번역도 맞춰주면 되니까 요약 툴팁에 언어별 선택 필요 x
2. 탐색 사이드바가 호버돼서 나올 때는 괜찮은데, 호버가 끝나는 순간 여유 시간 없이 바로 부드럽게 닫혔으면 좋겠음.
3. 전체, 일간, 주간, 월간 모두 똑같음. 스타 증가수 집계도 제대로 안 되고 있음.
4. 신규 배지 제대로 안 붙고 있음.
5. 재진입도 제대로 안 붙고 있음.
6. 모바일 버전에서는 손가락으로 오른쪽으로 화면을 넘기는 제스쳐로 사이드바가 나오게 해달라고 지시했는데, 탐색 버튼이 들어가져 있음. 닫힐 때는 왼쪽으로 미는 제스처로 닫힘. 이 부분 수정 필요.

## 확정된 동작

### 사이트 언어와 요약

- 요약은 `github-trending-site-locale-v1`로 저장되는 사이트 locale 하나만 따른다.
- tooltip의 별도 언어 버튼과 별도 summary locale 상태를 제거한다.
- 선택 locale의 `goal`, `usage`, `pros`, `cons`, `fit`이 하나라도 없으면 다른 locale로 조용히 fallback하지 않고 현재 UI 언어로 unavailable 상태를 표시한다.
- 저장 locale, browser locale, 영어 순의 사이트 초기 locale 선택은 유지한다.
- reload와 BFCache에서 별도 summary locale이 생기거나 stale해질 수 없다.

### 데스크톱 hover sidebar

- pointer가 rail과 sidebar의 결합 영역을 벗어나고 focus도 둘 안에 없으면 대기시간 0ms로 닫힘 상태를 시작한다.
- 닫힘 transition은 `210ms`를 유지한다.
- rail에서 sidebar로 직접 이동할 때는 `relatedTarget`으로 결합 영역 안 이동임을 확인해 닫지 않는다.
- hover는 비모달, click/keyboard는 focus trap modal이라는 기존 계약을 유지한다.

### 모바일 sidebar

- 지속적으로 보이는 모바일 탐색 버튼은 제거한다.
- right edge swipe open과 left swipe close가 기본 touch 경로다.
- screen reader와 하드웨어 키보드에는 native button을 visually-hidden 상태로 제공한다.
- 해당 버튼은 `:focus-visible`일 때만 최소 44x44px로 화면에 나타난다.
- 24px edge, 48px commit, vertical intent cancel, pointer cancellation, close button, scrim, Escape 계약은 유지한다.

### 기간별 집합과 증가량

- `all`은 daily, weekly, monthly에 한 번이라도 속한 repository의 합집합이다.
- `daily`, `weekly`, `monthly`는 각각 해당 `rank_*`와 `stars_*`가 모두 유효한 repository만 포함한다.
- period 기본 Trending 순서는 해당 `rank_*` 오름차순이다.
- source 값이 없으면 repository를 해당 period에서 제외하고 `+0`으로 만들지 않는다.
- source의 실제 gain이 0이면 `+0`을 표시할 수 있다.
- `all`에서는 period gain과 HOT을 표시하지 않고 total stars만 표시한다.
- `daily`, `weekly`, `monthly`에서만 exact gain과 HOT을 표시한다.

### 신규·재진입

- 현재 `migration_baseline` 45개를 소급 변경하지 않는다.
- 약 5일 전 legacy membership을 v1의 직전 snapshot으로 연결하지 않는다.
- 첫 v1 refresh는 baseline 대비 `stayed`, `new`, `exited`를 만든다.
- `reentered`는 v1 history에서 과거에 있었고 직전 snapshot에는 없던 repository가 돌아올 때만 만든다.
- 현재 production에 신규·재진입 배지가 나타난다는 주장은 다음 실제 refresh 전에는 하지 않는다.

## 범위 경계

- 새 dependency, framework, server를 추가하지 않는다.
- Daily Refresh, repository/OSS 재수집, SQLite write, LLM 호출, 전체 README 번역, schedule 활성화는 하지 않는다.
- Codex Deep Scan은 사용자 결정으로 폐기한다. 재개·대체·완료 게이트·잔여 위험으로 다루지 않는다.
- Google 로그인 persistence는 deploy-only 전 마지막 필수 완결 게이트다. 현재 production에서 실제 사용자 consent를 거쳐 검증한다.
- production auth가 실패하고 새 auth 코드 수정이 필요하면 아직 배포되지 않은 수정의 production 지속성을 통과로 추정하지 않고 배포 전에 중단한다.

## 배포 안전 경계

- source 작업, commit, push, PR은 이 설계 승인으로 허용됐다.
- PR merge와 deploy-only는 PR/CodeQL 및 Google 로그인 persistence 증거를 보고한 뒤 별도 사용자 확인을 받는다.
- deploy-only는 현재 committed v1 snapshot을 다시 패키징하며 refresh·LLM·DB write를 실행하지 않는다.
- pre-deploy artifact probe 실패 시 Upload와 Deploy는 0이어야 한다.
- post-deploy probe 실패 시 blind retry나 자동 recovery를 하지 않고 실패 evidence를 보존한다.

## 장기 세션 인계

- 이 작업은 Goal 모드로 추적한다.
- 같은 버그나 오류가 두 번의 수정 뒤에도 재발하면 세 번째 국소 수정을 시도하기 전에 `mattpocock-skills:wait-what`을 적용한다.
- `wait-what` 적용 시 현재 위치, 두 수정의 가정, 반복 증상, 더 넓고 단순한 문제 정의를 짧은 기술 문장으로 다시 설명한다.
- 이 저장소에는 현재 `CONTEXT.md`와 `CONTEXT-MAP.md`가 없으므로 spec, canonical handoff, 코드의 기존 용어를 ubiquitous language로 사용한다.
- 컨텍스트 사용량 약 450,000 토큰에서 결정·좌표·diff·RED/GREEN·변이·검증·Git/Actions/Pages/auth 상태·남은 질문·정확한 다음 명령을 상세 handoff로 기록한다.
- handoff에는 `wait-what` 발동 여부와, 발동했다면 반복된 버그·폐기한 접근·새 문제 정의·다음 검증을 포함한다.
- 새 세션은 동일 cwd 경계를 사용해 `agentmemory:handoff`로 최근 세션을 복원한다.
