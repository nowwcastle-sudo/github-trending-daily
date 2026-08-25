# 1차 검토안 — ChatGPT 감사 보고서 대비 코드베이스 실측 검증
**검토 기반**: understand-anything knowledge graph (노드 99, 엣지 123) + 저장소 전수 파일 분석 + ChatGPT 제안 전문

---

## 총평

ChatGPT 보고서는 **전반적으로 정확도가 높다.** 특히 SEC-01~02(공급망), 브랜치 무보호, REPOS 인라인 문제는 코드 실측으로도 동일하게 확인됐다. 다만 일부 제안은 현재 프로젝트 규모·단일 운영자 상황에서 **과투자**이거나, 이미 구현된 것에 대한 재지적이다. 아래 제안별로 판정한다.

---

## A. 보안 제안 (SEC-01 ~ 06)

### SEC-01 CDN 스크립트 공급망 (SRI/CSP 부재)
**판정: ✅ 수용 — High. 실제 확인됨.**
index.html은 `marked@12` / `dompurify@3` major alias를 SRI 없이 로드한다. DOMPurify가 유일한 XSS 방어선인데 그 자체가 CDN 조작 가능 구조. 수정 비용 대비 효과 가장 큼.
**실행안**: exact 버전 고정 + SRI 해시 추가 + CSP meta 태그. (자체 번들링은 빌드 파이프라인 필요해 2순위)

### SEC-02 Actions write token 조기 활성화
**판정: ✅ 수용 — High.**
daily-refresh.yml이 job 전체에 `contents:write`를 주고 checkout→npm ci→push 순서라, transitive dependency 침해 시 push credential 노출 경로가 실재한다.
**실행안**: `persist-credentials: false` + full SHA pinning + test/publish job 분리.

### main 브랜치 무보호
**판정: ✅ 수용 — Medium→High.**
GitHub Pages가 main을 직접 서빙하므로 main 오염 = 즉시 사용자 배포. 단일 운영자라 PR 강제까지는 과하지만 **required CI check는 필요**.
**실행안**: ci.yml 신설(Node+Python 테스트) 후 main에 required status check 설정.

### Firestore Rules CI 미포함
**판정: ✅ 수용 — 발견이 정확하고 중요함.**
실측 확인: package.json에 `test:rules`(firebase emulators)가 있는데 workflow는 `npm test`만 실행. 좋은 Rules 테스트(본인 격리, 500개 제한, timestamp 위조 차단 등)가 게이트에 안 붙어 있음.
**실행안**: daily workflow와 신규 ci.yml 모두 `npm run test:all` 사용.

### Rules 요소 단위 schema 검증 부족
**판정: ⚠️ 부분 수용 — Low.**
클라이언트 slug 정규식(`Favorites.isValidSlug`, 201자 제한)이 이미 있고, 악용 경로는 본인 문서뿐. subcollection 전환은 사용자 기능 확장 시점으로 연기가 맞음.

### Firebase API Key 노출
**판정: ✅ ChatGPT 판단이 올바름 — 취약점 아님.**
Firebase 웹 API key는 공개 식별용이 맞고, 코드의 projectId 고정 검증 + App Check 초기화는 좋은 설계. 다만 **Console에서 App Check enforcement 상태는 직접 확인 필요**(코드만으론 불가) — 운영 체크리스트에 추가.

---

## B. 아키텍처 제안

### index.html 121KB 분리 + REPOS → data/trending.json
**판정: ✅ 수용 — 최우선 과제. 실측으로 심각성 확인.**
knowledge graph 분석 결과 index.html 하나가 UI·렌더·필터·README viewer·favorites UI·번역 로드까지 담당(노드 5개가 전부 index.html 함수). 매일 bot이 이 파일의 REPOS 배열을 bracket-matching으로 교체하는 구조는:
- UI diff와 데이터 diff가 섞여 git blame 무의미
- generator가 HTML 구조를 몰라야 하는 bracket-matching 같은 취약한 파서에 의존 (과거 실제 사고 발생 — page_template 롤백 사건)
- JSON escaping(`&`→`\u0026` 등) 복잡성이 계속 필요

ChatGPT의 "immutable app shell + fetch(data/trending.json)" 방향이 정답.
**실행안**: Phase 4(구조개편) 1순위. ES modules 전환(globalThis 제거)과 함께.

### globalThis 정리 → ES modules
**판정: ✅ 수용 — 단, 즉시성은 낮음.**
현재 favorites.js/favorite-sync.js/firebase-client.js 간 globalThis 계약이 있고 테스트 116개가 이 구조로 통과 중. 구조개편 시 함께 처리.

### Star History dual source 수렴
**판정: ✅ 수용 — 단, 시점은 ChatGPT대로.**
star-history.js의 estimated(OSS Insight)+observed(SQLite) 이중 구조는 설계 문서에 명시된 의도된 migration 상태. SQLite 관측치 충분히 쌓인 뒤 전환.

### 중복 workflow (update-star-history.yml schedule)
**판정: ✅ 수용 — Low cost.**
daily-refresh가 이미 star-history를 포함해 실행하므로 별도 schedule은 race 위험만 추가. workflow_dispatch만 남기면 됨.

### Summary/translation lifecycle 메타데이터
**판정: ⚠️ 부분 수용.**
sourceReadmeSha 추적은 유효(README 변경 시 stale 판별). 다만 lastSeen 등 풀 메타데이터는 데이터량 대비 과함. sha+generatedAt만 추가.

---

## C. 기능 확장 제안 (18~19절)

ChatGPT가 제안한 14개 기능 중 실측 기반 평가:

| 기능 | 판정 | 근거 |
|---|---|---|
| Trending streak/연속 진입일 | ✅ 수용 | star-observations.sqlite가 이미 append-only 일별 스냅샷 보유 — SQL 한 줄로 계산 가능 |
| 어제 대비 순위 변화 | ✅ 수용 | 동일하게 SQLite 기반, 낮은 비용 |
| Momentum Score | ⚠️ 보류 | normalization 설계가 까다로움. streak/순위변화 먼저 |
| Repo 비교 | ✅ 수용 (2기) | UI 추가 필요하나 데이터는 전부 보유 |
| Provenance ("왜 떠오르나") | ⚠️ 부분 | 근거 URL 표시(release/commit)는 좋음. AI 분석은 비용 대비 보류 |
| RSS/JSON Feed | ✅ 수용 | daily snapshot이 이미 존재 — generate만 추가 |
| Favorite 변화 대시보드 | ✅ 수용 (2기) | Firestore sync 데이터 활용 |
| Topics/License 필터 | ⚠️ 보류 | GitHub API enrichment 추가 필요 — 비용 발생 |

**ChatGPT가 빠뜨린 것**: 현재 translations/ 46개 한국어 README가 있는데, 이를 활용한 **"한국어 우선 열람" 모드**는 이미 구현됨(원문/KO 탭). 반면 ChatGPT는 이 자산을 언급하지 않음 — 기존 자산 활용 관점에서 보완 제안할 것.

---

## D. ChatGPT 보고서의 오류·누락

1. **누락: ui-motion.js** — 모바일 터치 툴팁 UX(첫 탭=툴팁, 두 번째 탭=이동) 모듈이 리뷰에서 완전히 빠져 있음. 모바일 사용자 경험의 핵심인데도.
2. **부정확: "test가 배포 게이트에 없음"의 범위** — daily-refresh.yml 내부에는 이미 Node-Python 이중 검증(cross-validation)이 있음. 빠진 건 rules 테스트뿐.
3. **과장: React/Next 전환 필요성** — 언급하지 않지만 독자가 오해할 소지. ES modules 유지 방침이 맞다는 점은 ChatGPT도 동의.

---

## E. 권장 실행 순서 (1차안)

1. SEC 긴급: SRI+CSP, persist-credentials:false, SHA pinning (1일)
2. CI: ci.yml 신설 + test:all + required checks (1일)
3. workflow 중복 제거 (30분)
4. REPOS → data/trending.json 분리 + ES modules 전환 (2~3일, 구조개편 핵심)
5. 기능: streak/순위변화/RSS feed (SQLite 기반이라 저비용)
6. App Check enforcement Console 확인 (운영)
