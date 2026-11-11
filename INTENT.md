# GITHUB INSIGHT 전체 갱신·버그 수정·README 현행화

## 현재 목표와 사용자 지시

- 2026-10-25 원문: "trending 전체 갱신 진행해 그리고 github trending daily 관련해서 버그 있으면 작업 지침 따라서 픽스하고 해당 저장소 README 전체 갱신해."
- 승인: "승인할게 진행해". 대표가 `pstack:interrogate`도 직접 호출했다.
- 대상 저장소: `nowwcastle-sudo/github-trending-daily`.
- 시작 기준: `origin/main=0c7f02139c30753a319ca5e71d7758841de7404a`.
- 작업 경로: `C:/Users/nasca/Documents/Codex/2026-10-13/task/trending-refresh-20261025`.
- 근거 경로: 형제 폴더 `trending-refresh-20261025-evidence/`.

## 작업 방식과 제약

기존 파이프라인의 수집·요약·파생 데이터·게시 검증을 사용한다. 기존 데이터 품질·출처 검증을 유지한다. 재현한 버그만 수정한다. README 3종의 설명을 실제 구현과 맞춘다. 원본 보존, CI 통과 후 PR 병합, 배포·게시의 기존 승인 경계를 유지한다. 인증값은 기록하지 않는다.

## 전체 작업과 현재 상태

- [x] 최신 원격·기존 기록·러너 상태 확인. 최근 전체 갱신 6회 cancelled, 별점 관측 성공, 전용 러너 offline.
- [x] graft 기본 그래프 생성: 파일 99개, 노드 2026개, 간선 5536개.
- [x] 러너 업데이트 후 종료 버그 재현·수정·검증·기존 예약 작업 재가동. 재현 1 fail, 수정 후 1 pass. 설치본 SHA-256 일치. GitHub API online/busy=false 확인.
- [ ] 전체 Trending 갱신 실행과 실제 산출물·운영 검증.
- [ ] 핵심 화면 점검과 재현한 버그 수정.
- [x] README.md·README.en.md·README.ko.md 전체 현행화. 50% 보류 한도·영어 의미검사 한계·실제 예약과 단계별 실패 경계·실제 전체 보기의 별도 일간 지표를 반영.
- [ ] pstack 독립 검토, 관련 테스트·CI, PR 병합, 최종 근거 기록.

## 변경 이력과 다음 한 작업

2026-10-25: 러너 로그에서 자동 업데이트 성공과 listener 종료 코드 3을 확인했다. 기존 `run-sanitized.ps1`가 listener EXE를 직접 실행해 공식 `run.cmd`의 재시작 처리를 건너뛴다. 공식 진입점 재사용을 채택했다. 별도 재시작 루프는 중복이므로 기각했다. 다음 작업은 재현 테스트 후 공식 진입점 호출로 수정하는 것이다.

2026-10-25 검증 마감: Node 867개 중 844 pass/23 skip/0 fail, Python 175 pass. 별도 Windows 회귀 1 pass. skip은 운영체제·Firestore 에뮬레이터 조건이며 전체 무생략 통과를 뜻하지 않는다. 로컬 Python은 3.14.8이고 CI는 3.13이다. 런타임 의존성 audit 0건. 전체 설치 audit의 개발 의존성 경고 31건은 이 변경에서 일괄 업그레이드하지 않았다. pstack 기본 Claude/Grok 모델은 도구가 거절했고 gpt-6-astra와 gpt-6.1-sol 독립 리뷰로 대체했다. 두 리뷰와 별도 보안 리뷰 모두 no findings. 테스트는 공식 launcher 호출·환경 정리·종료코드 전달을 증명하며 실제 자동 업데이트 자체를 재발시키지는 않았다. 다음 한 작업은 PR·CI 통과 후 전체 갱신 워크플로를 실행해 산출물과 운영 상태를 확인하는 것이다.

2026-10-25 CI 수정: PR #101의 첫 CodeQL은 통과했으나 README 재작성 뒤 문서 계약 2건이 실패했다. 기존 언어 링크·README.en의 정본 안내·필수 기능 표기를 복원했다. 고정 1일 내 관측 보장 문구를 강제하던 테스트 1줄은 실제 지연·한도 생략 정책에 맞는 비보장 문구로 바로잡았다. 기능 검증을 제거하지 않았다. 관련 11개 검사는 통과했다. 영어판은 동일 본문을 사용하되 README.en에 정본 안내 1문단을 추가한다. 운영 화면은 일간8/주간15/월간21/전체36과 검색·초기 목록 복원을 확인했다. 다음 한 작업은 수정 커밋의 CI와 문서 독립 리뷰 확인이다.

2026-10-25 문서 검토: 독립 리뷰 B는 no findings, A는 관측 두 점의 36시간 간격 조건 누락을 LOW로 보고했다. 실제 그래프의 단절 조건이므로 채택해 3개 README에 반영했다. 나머지 문서 사실과 테스트 변경은 양쪽 모두 승인했다. e3278a7의 Ubuntu CI는 Node 853 pass/14 skip/0 fail, Python 175 pass, CodeQL 신규 경보 없음이다. 5개 UI 언어 전환·36행 JSON 내보내기·요약 표시를 확인했다. README 뷰어 대기 검사는 존재하지 않는 aria-busy 속성을 기다려 시간 초과했으므로 제품 결함으로 판정하지 않고 페이지를 reload한 뒤 실제 DOM 조건으로 다시 확인한다.

## 이전 작업 기록 보존

아래는 첫 클릭 로그인 수정 당시 기록이다. 과거의 범위 제한은 해당 작업에 적용한 기록이며, 현재 승인 범위는 위 최신 지시를 따른다.

# GITHUB INSIGHT first-click login stability

## Facts

- The target is the static GitHub Pages application at `C:\Users\nasca\AppData\Local\Temp\gh-trending-page`.
- The source baseline for this worktree is `d6c65b3af8cf1ffb60325e81661c9540c143eaa9` on `main`.
- A clean public-browser reproduction showed that a first anonymous click waits for dynamic Firebase bootstrap before calling `signInWithPopup`, so no Google popup opens and the controls become visually inconsistent.
- The same public flow opened the popup after pointer prefetch, and closing that popup restored an actionable cancellation state.
- Existing Firebase Auth persistence, App Check, Firestore rules, guest storage, and popup login remain the selected architecture.

## Decision

This is a bounded bug fix. The anonymous first click prepares the Firebase client only. Once preparation finishes, the button is re-enabled with a localized retry message. A later user click invokes the Firebase module's own popup handler while user activation is fresh. Pointer and focus prefetch retain the current fast path.

## Scope

In scope:

- The deferred anonymous login boundary in `index.html`.
- Five-locale copy for the ready-to-retry state in `site-i18n.js`.
- Deterministic regression coverage in `tests/page-runtime.test.mjs` and `tests/site-i18n.test.mjs`.
- Local verification and source-level browser-flow validation.

Out of scope:

- Switching from popup authentication to redirect authentication.
- Changing Firebase project configuration, App Check policy, Firestore rules, or favorite data semantics.
- GitHub remote writes, deployment, or claiming the public site is fixed before a later release.
- Unrelated changes already present in the original checkout.

## Acceptance criteria

1. An anonymous first click never calls the popup entry point after an awaited client bootstrap.
2. Successful preparation re-enables the login button and exposes a non-empty localized retry message in English, Korean, Chinese, Spanish, and Japanese.
3. A subsequent click reaches the published Firebase login handler exactly once.
4. Existing auth, favorite-sync, page-runtime, locale, full Node, Python, JavaScript syntax, diff, and credential checks pass within their measured scope; this package defines no lint script.
5. The original public first-click reproduction is re-run against a released build before production-fix claims are made; this worktree alone does not satisfy that final release check.

## Unknowns

- A real Google account callback was not completed during diagnosis; popup opening and cancellation were tested without submitting credentials.
- App Check reCAPTCHA warnings and Google popup COOP warnings remain external-browser signals; they were not the cause of the first-click no-popup reproduction and are not changed by this patch.
