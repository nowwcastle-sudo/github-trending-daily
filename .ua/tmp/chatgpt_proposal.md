Title: 이 채팅을 확인해 보세요

URL Source: https://chatgpt.com/share/6a8b1541-a094-83ee-9fe5-c402280fab09

Markdown Content:
## GitHub Trending Daily — 보안·아키텍처 정밀 감사 보고서

검토 기준은 **2026년 8월 23일 현재 `main` 브랜치, commit `1f7caa8ad4b2fefcfb2d0a735cc46360f595bdae`**입니다. 현재 `main`은 branch protection이 비활성화되어 있고, 최신 자동화 커밋도 서명되지 않은 상태입니다.

이번 검토는 단순 README 검토가 아니라 저장소 트리, 프론트엔드 렌더링 경계, Firebase 인증/Firestore Rules, GitHub Actions, 외부 데이터 파이프라인, SQLite 누적 데이터, 테스트 구조, 설계 문서까지 교차 검토했습니다.

다만 **실제 로컬 저장소에서 `npm audit`, 동적 DAST, 브라우저 자동화, Firebase Console의 App Check enforcement 상태 확인까지 실행한 감사는 아닙니다.** 따라서 아래 결과는 **현재 저장소 소스와 공개 설정을 기준으로 한 정밀 정적 감사**입니다.

* * *

## 1. 먼저 결론

현재 코드를 보고 **즉시 악용 가능한 Critical 취약점이나 사용자 간 Firestore 데이터 탈취 경로는 발견하지 못했습니다.**

오히려 데이터 검증, Firestore 사용자 격리, SQLite append-only 처리, 외부 README의 DOMPurify 처리, 자동 생성 파일 whitelist 등은 상당히 신경 써서 구현되어 있습니다.

하지만 프로젝트가 최근 빠르게 확장되면서 이제는 **“작은 정적 페이지” 수준의 보안 모델을 벗어났습니다.** 특히 다음 네 부분은 구조개편 전에 처리하는 것이 좋습니다.

| 영역 | 평가 | 핵심 판단 |
| --- | --- | --- |
| 사용자 데이터 격리 | **양호** | Firestore UID 경계가 명확함 |
| 데이터 파이프라인 무결성 | **매우 양호** | fail-closed 검증이 상당히 강함 |
| 브라우저 공급망 보안 | **개선 시급** | CDN JS + 무SRI + CSP 부재 |
| GitHub Actions 공급망 | **개선 시급** | write token이 너무 일찍 활성화됨 |
| 브랜치/CI 보호 | **취약** | `main` 무보호, PR CI 없음 |
| 테스트 품질 | **양호하지만 보안 게이트 누락** | Rules 테스트가 기본 CI 경로에서 빠짐 |
| 코드 구조 | **확장 한계 도달** | 121KB `index.html`에 UI·데이터·로직 혼재 |
| 향후 기능 확장성 | **보통** | 현재 구조로 기능을 더 붙이면 복잡도가 급증 |

제가 우선순위를 매기면 **신규 기능 추가보다 먼저 보안/CI 정비 → 프론트 구조 분리 → 데이터 모델 정리 → 기능 확장** 순서가 적절합니다.

* * *

## 2. 보안 감사

## SEC-01 — 브라우저 외부 스크립트 공급망 경계

**위험도: High-risk exposure**

**확신도: 높음**

현재 `index.html`에서 다음과 같은 CDN 스크립트를 브라우저가 직접 실행합니다.

```
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
```

여기서 중요한 문제는:

*   `marked@12`

*   `dompurify@3`

처럼 **정확한 patch 버전이 아니라 major alias**를 사용한다는 점입니다.

더 중요한 것은 **SRI(Subresource Integrity)가 없고 CSP도 없습니다.**

`index.html`에는 CSP 설정이 없으며, 외부 README는 `marked.parse()` 후 `DOMPurify.sanitize()`를 거쳐 `innerHTML`에 삽입합니다. 즉 현재 XSS 방어에서 DOMPurify는 중요한 신뢰 경계입니다.

그래서 CDN이나 upstream package가 공격당하면 이런 구조가 됩니다.

```
CDN / package compromise
        ↓
marked 또는 DOMPurify JS 변조
        ↓
github-trending-daily 페이지 Origin에서 실행
        ↓
Firebase Auth 상태 / localStorage / 화면 데이터 접근
        ↓
사용자 즐겨찾기 변조 또는 세션을 이용한 사용자 권한 요청
```

현재 **실제로 CDN이 침해됐다는 뜻은 아닙니다.** 하지만 공급망 사고가 발생했을 때 방어선이 거의 없습니다.

### 권장

가장 좋은 방법은 **Marked와 DOMPurify를 package-lock으로 고정하고 빌드할 때 자체 bundle**하는 것입니다.

차선책은:

*   정확한 버전 고정

*   SRI hash

*   `crossorigin="anonymous"`

*   CSP

입니다.

예:

```
marked@12.x.y
dompurify@3.x.y
```

수준까지 고정해야 합니다.

장기적으로는 외부 CDN JavaScript를 없애는 쪽을 추천합니다.

* * *

## SEC-02 — GitHub Actions의 `contents: write` + dependency install 결합

**위험도: High-risk exposure**

**확신도: 높음**

현재 일일 workflow는 job 전체에:

```
permissions:
  contents: write
```

를 줍니다. 이후:

```
actions/checkout@v4
actions/setup-node@v4
actions/setup-python@v5
npm ci
npm test
...
git push origin HEAD:main
```

순서로 실행됩니다.

여기에는 두 가지 공급망 문제가 결합되어 있습니다.

### 첫 번째

`actions/checkout@v4`는 기본적으로 Git credentials를 checkout 환경에 유지하는 방식으로 사용됩니다.

그 다음에 바로 **336KB 규모 lockfile의 npm dependency graph를 설치**합니다. 현재 직접 dependency 버전은 잘 고정되어 있지만, npm 설치 자체는 많은 transitive dependency 코드를 신뢰하게 됩니다.

어떤 dependency의 공급망이 침해되고 install-time code가 실행될 경우, **write-capable GitHub credential을 노리는 공격 경로**가 생깁니다.

### 두 번째

Actions 자체도:

```
actions/checkout@v4
actions/setup-node@v4
actions/setup-python@v5
```

처럼 tag로 고정되어 있습니다.

GitHub는 third-party action을 가장 강하게 고정하려면 **full-length commit SHA 사용을 권고**하고 있으며, SHA가 사실상 immutable reference입니다. [![Image 1](https://www.google.com/s2/favicons?domain=https://docs.github.com&sz=128)GitHub Docs](https://docs.github.com/en/actions/reference/security/secure-use?learn=getting_started&learnProduct=actions&utm_source=chatgpt.com)

### 권장 구조

가장 좋은 형태는:

```
Job A — build/test
permissions: contents: read

     ↓ 검증된 artifact

Job B — publish
permissions: contents: write
```

입니다.

최소한 현재 workflow를 유지하더라도:

```
uses: actions/checkout@<FULL_SHA>
with:
  persist-credentials: false
```

를 적용하고, **push 순간에만 쓰기 credential을 노출**하는 쪽이 낫습니다.

가능하다면 `npm ci --ignore-scripts`도 검토할 가치가 있습니다. 단, 현재 dependency가 lifecycle script에 의존하지 않는지 테스트한 후 적용해야 합니다.

* * *

## 3. `main` 브랜치 보호가 사실상 없음

**위험도: Medium → 프로젝트 성장 시 High**

현재 GitHub API상:

```
protected: false
required_status_checks: off
```

입니다.

현재 저장소에는 두 개의 Actions workflow가 있지만 모두 기본적으로 **scheduled/manual publisher**입니다.

즉 일반 코드 수정에 대해:

```
PR
 ↓
CI
 ↓
required checks
 ↓
merge
```

라는 방어 계층이 존재하지 않습니다.

더 큰 문제는 GitHub Pages가 `main` 내용을 제공하는 구조이므로, 잘못된 코드가 main에 들어가면 **매일 03시 테스트가 실행되기 전에 이미 사용자에게 배포될 수도 있습니다.**

### 권장

새로운 `.github/workflows/ci.yml`을 만들고:

```
pull_request
push → main
```

에서 최소한 다음을 실행하도록 하는 것이 좋습니다.

```
Node tests
Python tests
Firestore Emulator rules tests
generated-data schema tests
dependency/security checks
```

그 뒤 `main`에:

*   Require pull request

*   Require status checks

*   Block force pushes

*   Block deletion

정도를 적용하면 됩니다.

혼자 개발하는 저장소라면 **PR 자체를 강제할 필요까지는 없더라도 required CI check는 추천**합니다.

* * *

## 4. Firestore Security Rules 자체는 좋은데, CI에서 빠져 있음

이 부분은 꽤 중요한 발견입니다.

`package.json`을 보면:

```
"test": "node --test && python -m unittest ...",
"test:rules": "firebase emulators:exec ...",
"test:all": "npm test && npm run test:rules"
```

입니다.

그런데 daily workflow는:

```
npm test
```

만 실행합니다. `npm run test:all`이 아닙니다.

즉 `firestore.rules`에 보안 회귀가 발생해도 **현재 기본 자동화 게이트가 잡지 않습니다.**

Rules 테스트 자체는 꽤 좋습니다. 현재 다음을 실제 Emulator 테스트 대상으로 두고 있습니다.

*   본인 접근 허용

*   collection listing 차단

*   비인증 사용자 차단

*   다른 UID 차단

*   extra fields 차단

*   timestamp 위조 차단

*   500개 제한

*   duplicate 차단

따라서 테스트가 부족하다기보다는 **좋은 테스트가 배포 게이트에 연결되지 않은 상태**입니다.

### 수정 권장

PR CI에서는 반드시:

```
npm run test:all
```

을 사용해야 합니다.

Daily refresh에서도 가능하다면 `test:all`을 사용하는 것이 좋습니다.

* * *

## 5. Firestore Rules의 요소 단위 schema 검증 부족

**위험도: Low~Medium**

현재 Rules는 상당히 안전합니다.

```
request.auth.uid == uid
favorites is list
favorites.size() <= 500
duplicate 없음
updatedAt == request.time
허용 필드 favorites / updatedAt만
```

따라서 **Alice가 Bob의 favorites를 읽거나 쓰는 공격은 차단됩니다.**

그런데 `favorites` 내부의 각 요소에 대해:

```
string인가?
owner/repository 형식인가?
최대 문자열 길이는?
```

를 Rules에서 검사하지 않습니다.

반면 클라이언트는:

```
/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
```

를 사용해 정상 slug만 받아들입니다.

따라서 일반 UI 사용자는 문제없지만, 인증 토큰을 가진 사용자가 Firestore REST/SDK를 직접 사용하면 자기 문서에 malformed value를 기록할 수 있습니다.

이것으로 **다른 사용자를 공격할 수 있는 경로는 현재 보이지 않습니다.**

하지만:

*   비정상 데이터

*   비정상적으로 큰 문자열

*   Firestore document size 낭비

*   향후 렌더러 변경 시 잠재적 위험

문제가 남습니다.

기능이 계속 확장될 경우에는:

```
users/{uid}/favorites/{owner__repo}
```

같은 **subcollection 모델**로 넘어가는 것이 훨씬 낫습니다.

현재 500개 단순 즐겨찾기만 유지한다면 지금 배열 구조도 충분합니다.

* * *

## 6. Firebase API Key 노출은 취약점이 아님

`firebase-config.json`에는 Firebase API key와 App Check site key가 공개되어 있습니다.

이 자체를 secret leak으로 보지는 않습니다.

Firebase 공식 보안 모델에서도 Firebase 웹 API key는 인증 비밀정보가 아니라 **프로젝트 식별 및 quota routing용 공개 설정**이며, 실제 데이터 보호는 Security Rules, IAM, App Check 등이 담당합니다. [![Image 2](https://www.google.com/s2/favicons?domain=https://firebase.google.com&sz=128)Firebase](https://firebase.google.com/docs/projects/api-keys?authuser=2&utm_source=chatgpt.com)

오히려 현재 코드가:

```
if (config?.projectId !== "github-trending-nowwcastle")
  throw new Error(...)
```

로 프로젝트를 확인하고 App Check도 초기화하는 것은 좋은 설계입니다.

### 다만 제가 저장소만 보고 확인할 수 없는 것

Firebase Console에서 실제로:

*   App Check → Firestore **Enforced**

*   API key restriction

*   Authentication authorized domains

*   API quota

*   Google OAuth 설정

이 어떻게 되어 있는지는 확인할 수 없습니다.

코드에서 App Check를 초기화했다고 해서 **서버 측 enforcement가 자동으로 켜지는 것은 아닙니다.** enforcement가 활성화되어야 미검증 요청이 거부됩니다. [![Image 3](https://www.google.com/s2/favicons?domain=https://firebase.google.com&sz=128)Firebase](https://firebase.google.com/docs/app-check/enable-enforcement?utm_source=chatgpt.com)

그리고 프로젝트 설계문서에도 원래:

> monitor → 정상 요청 확인 → Firestore enforcement

순으로 전환한다고 명시되어 있습니다.

따라서 이건 **취약점 발견이라기보다 운영 확인 필요사항**입니다.

* * *

## 7. README Viewer는 XSS 방어는 좋지만 privacy/DoS 개선 가능

현재 README Viewer의 입력은 완전히 외부 신뢰 경계입니다.

```
raw.githubusercontent.com
       ↓
README.md
       ↓
marked.parse()
       ↓
DOMPurify.sanitize()
       ↓
innerHTML
```

실제 코드도 이 순서를 지키고 있습니다.

이 부분은 잘 구현되어 있습니다.

또 REPOS metadata를 HTML로 넣을 때도 `esc()`를 적용하고 있습니다.

따라서 제가 현재 코드에서 **직접적인 stored/reflected XSS 경로를 찾지는 못했습니다.**

다만 두 가지는 개선할 수 있습니다.

### 외부 이미지 privacy

README 내부에:

```
![tracker](https://example.com/image)
```

같은 이미지가 있으면 DOMPurify는 정상 이미지라고 판단할 수 있고 브라우저가 외부 서버에 직접 요청할 수 있습니다.

그러면 방문자의:

*   IP

*   User-Agent

*   요청 시점

같은 정보가 README 작성자가 지정한 서버로 전달될 수 있습니다.

GitHub 본 사이트의 README 렌더링과 달리 현재 페이지는 자체 렌더링이므로 이 부분을 별도 관리해야 합니다.

### 매우 큰 README

현재 README fetch에 명시적:

*   timeout

*   최대 bytes

*   parsing limit

가 없습니다.

악의적으로 매우 큰 README를 Trending 저장소가 제공하면 브라우저에서 parsing/sanitization 비용이 커질 수 있습니다.

### 추천

예를 들어:

```
timeout: 10 sec
max README size: 1~2 MiB
외부 img 차단 또는 allowlist
referrerpolicy=no-referrer
```

정도면 충분합니다.

* * *

## 8. 데이터 수집 파이프라인은 오히려 강점

`update-trending.mjs`는 외부 HTML/REST 데이터를 꽤 방어적으로 처리하고 있습니다.

확인한 항목은:

*   repository slug whitelist

*   숫자 strict validation

*   duplicate slug 차단

*   minimum repository count

*   union size 10~75 제한

*   GitHub metadata의 `full_name` 재검증

*   request count 제한

*   bounded retry

*   summary schema 검증

*   generated marker 위치 검증

*   HTML script injection을 막기 위한 `<`, `>`, `&` JSON escaping

*   원자적 파일 교체/rollback

입니다.

특히:

```
JSON.stringify(value)
  .replaceAll("&", "\\u0026")
  .replaceAll("<", "\\u003c")
  .replaceAll(">", "\\u003e")
```

처리는 외부 GitHub metadata를 inline script 데이터로 넣는 현재 구조에서 중요한 XSS 방어입니다.

### 다만 구조상 더 나은 방법

애초에 REPOS를 `index.html` 내부 JS constant로 넣지 말고:

```
/data/trending/latest.json
```

으로 분리하면 이런 복잡한 escaping 자체가 줄어듭니다.

이것이 구조개편의 핵심 중 하나입니다.

* * *

## 9. SQLite 데이터 설계는 상당히 좋음

`record_star_observations.py`에서는:

*   parameterized SQL

*   schema fingerprint

*   foreign keys

*   immutable observation

*   no UPDATE trigger

*   no DELETE trigger

*   동일 observation 충돌 방지

*   transaction

*   date/slug validation

*   canonical legacy fingerprint

등을 사용합니다.

설계 문서 역시 SQLite를 **“추후 exact history source로 전환하기 위한 append-only 데이터베이스”**로 명확히 한정하고 있습니다.

이 부분은 지금 구조에서 가장 안정적인 영역 중 하나입니다.

SQL injection이나 데이터 덮어쓰기 문제는 현재 검토 범위에서 발견하지 못했습니다.

* * *

## 10. 중복된 자동화 workflow는 제거하는 편이 좋음

현재:

### Primary

```
daily-refresh.yml
03:17 KST
```

이 안에서 이미:

```
update-trending
record_star_observations
update-star-history
```

를 모두 실행합니다.

그런데 별도로:

```
update-star-history.yml
03:47 KST
```

도 매일 실행됩니다.

즉:

```
03:17
Trending + SQLite + Star History
     ↓
commit

03:47
Star History 다시 실행
     ↓
또 commit 가능
```

구조입니다.

흥미롭게도 프로젝트 자체 설계문서에는 이미:

> star-only workflow becomes a later recovery/manual workflow and cannot race the primary publisher

라고 설계되어 있습니다.

즉 **설계는 맞는데 구현 정리가 끝나지 않은 상태**입니다.

### 추천

`update-star-history.yml`에서:

```
schedule:
```

를 제거하고:

```
workflow_dispatch:
```

만 남겨 **recovery workflow**로 만들 것을 권합니다.

이것만으로도:

*   write-token 실행 횟수 감소

*   불필요한 CI usage 감소

*   중복 commit 감소

*   데이터 race 가능성 감소

효과가 있습니다.

* * *

## 11. dependency 상태

현재 직접 dependency는 모두 exact version입니다.

```
@firebase/rules-unit-testing 5.0.2
firebase                     12.17.1
firebase-tools               15.28.1
```

lockfile도 v3이고 registry integrity hash를 포함합니다.

제가 공개 advisory도 교차 확인해본 결과:

*   알려진 `firebase-tools < 13.6.0` 계열 취약점 범위보다 현재 `15.28.1`이 새 버전입니다. [![Image 4](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/advisories/GHSA-rcm2-22f3-pqv3?utm_source=chatgpt.com)

*   Firebase JS SDK의 공개된 `<10.9.0` 취약 버전보다 현재 `12.17.1`이 새 버전입니다. [![Image 5](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/advisories/GHSA-3wf4-68gx-mph8?utm_source=chatgpt.com)

따라서 확인한 직접 dependency에서 **즉시 “이 버전은 취약하다”고 판단할 항목은 나오지 않았습니다.**

단, 앞에서 밝혔듯 이번 채팅에서는 실제 checkout 후:

```
npm audit
npm ls
```

를 실행한 것은 아니므로 **transitive dependency 전체가 깨끗하다고 보증하는 것은 아닙니다.**

Dependabot을 주 1회 정도 활성화하는 것을 추천합니다.

* * *

## 12. 현재 아키텍처의 가장 큰 문제

현재 repository는 더 이상 단순한 single-page HTML이라고 보기 어렵습니다.

실제로는:

```
GitHub Trending HTML
        │
        ├─ GitHub REST API
        ├─ OSS Insight API
        │
        ▼
Node/Python ETL
        │
        ├─ repo-summaries.json
        ├─ star-history.json
        └─ star-observations.sqlite
        │
        ▼
index.html
        │
        ├─ search/filter
        ├─ README viewer
        ├─ star graph
        ├─ favorites
        ├─ Google OAuth
        └─ Firestore sync
```

가 되어 있습니다.

그런데 파일 구조는 아직:

```
/
index.html
favorites.js
favorite-sync.js
firebase-client.js
star-history.js
ui-motion.js
firebase-config.json
star-history.json
translations/
scripts/
data/
```

입니다. 전체 tree에서도 이 혼합 구조를 확인할 수 있습니다.

특히 `index.html`이 **121,610 bytes**이고 CSS, HTML, application logic, generated REPOS data까지 상당 부분 포함하고 있습니다.

이게 앞으로 가장 큰 유지보수 병목이 될 가능성이 높습니다.

* * *

## 13. 제가 추천하는 목표 구조

React/Next.js까지 갈 필요는 없습니다.

이 프로젝트 특성상 **ES Modules 기반 정적 웹앱**으로 유지하는 것이 오히려 적합합니다.

추천 구조는 이 정도입니다.

```
github-trending-daily/
│
├─ src/
│  ├─ app/
│  │  ├─ main.js
│  │  ├─ render.js
│  │  ├─ filters.js
│  │  ├─ readme-viewer.js
│  │  └─ state.js
│  │
│  ├─ auth/
│  │  ├─ firebase.js
│  │  ├─ favorites.js
│  │  └─ favorite-sync.js
│  │
│  ├─ charts/
│  │  └─ star-history.js
│  │
│  └─ styles/
│     └─ app.css
│
├─ public/
│  ├─ index.html
│  ├─ firebase-config.json
│  └─ data/
│     ├─ trending.json
│     ├─ star-history.json
│     └─ translations/
│
├─ data/
│  ├─ repo-summaries.json
│  └─ star-observations.sqlite
│
├─ scripts/
│  ├─ trending/
│  │  ├─ fetch.mjs
│  │  ├─ parse.mjs
│  │  ├─ enrich.mjs
│  │  └─ generate.mjs
│  │
│  ├─ stars/
│  │  ├─ update-history.mjs
│  │  └─ record-observations.py
│  │
│  └─ validate/
│
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ security/
│  └─ fixtures/
│
├─ docs/
│  ├─ architecture.md
│  ├─ operations.md
│  ├─ security.md
│  └─ adr/
│
└─ .github/workflows/
   ├─ ci.yml
   ├─ daily-refresh.yml
   └─ star-history-recovery.yml
```

핵심은 폴더 이름 자체가 아니라 **책임 분리**입니다.

* * *

## 14. 가장 먼저 분리해야 하는 것은 `REPOS`

현재 생성기가 매일 `index.html` 내부의:

```
const REPOS = [...]
```

를 바꿉니다.

이 방식은 기능적으로는 안정적이지만 장기적으로 좋지 않습니다.

### 현재

```
UI source
+
CSS
+
JS
+
Daily generated data
=
index.html
```

### 추천

```
index.html → immutable application shell

data/trending.json
        ↓
fetch()
        ↓
render()
```

으로 바꾸는 것입니다.

그러면 매일 bot commit은:

```
data/trending.json
data/repo-summaries.json
data/star-observations.sqlite
data/star-history.json
```

정도만 변경합니다.

장점이 큽니다.

*   UI 코드 diff와 데이터 diff 분리

*   git blame 개선

*   XSS injection surface 감소

*   generator 단순화

*   브라우저 caching 개선

*   이후 REST/RSS/API 생성 쉬움

*   E2E 테스트 쉬움

저는 이걸 **구조개편 1순위**로 봅니다.

* * *

## 15. global state도 정리하는 것이 좋음

현재 Firebase bootstrap은:

```
globalThis.Favorites
globalThis.FavoriteSync
globalThis.favoriteController
globalThis.applyFavoriteState
```

등을 전제로 동작합니다.

현재 규모에서는 동작하지만 기능이 더 늘어나면:

```
script load order
global namespace
hidden dependency
test mocking
initialization race
```

가 어려워집니다.

ES module로:

```
import { createFavoriteController } from "./auth/favorite-sync.js";
import { render } from "./app/render.js";
```

형태로 옮기는 것을 추천합니다.

프레임워크 도입 없이 해결할 수 있습니다.

* * *

## 16. Star History는 장기적으로 단일 source로 수렴해야 함

현재 스타 데이터가 사실상 두 층입니다.

```
OSS Insight
   ↓
star-history.json
   ↓
화면

GitHub exact daily observation
   ↓
star-observations.sqlite
   ↓
아직 화면에서 미사용
```

이건 의도된 migration 상태입니다. 설계문서에도 그렇게 명시되어 있습니다.

따라서 지금 바로 고칠 문제는 아닙니다.

하지만 충분한 exact history가 쌓인 후에는:

```
SQLite
   ↓
generate-star-history.mjs
   ↓
star-history.json
   ↓
browser
```

로 변경하고 **OSS Insight dependency를 제거하는 것을 최종 목표**로 잡는 것이 좋습니다.

그러면:

*   외부 API 장애 감소

*   데이터 provenance 개선

*   정확도 향상

*   daily delta 분석 가능

*   trending streak 계산 가능

해집니다.

* * *

## 17. Summary/translation cache에도 lifecycle이 필요함

현재 `repo-summaries.json`은 기존 cache를 복사하고 현재 slug를 갱신하는 구조라, 과거 저장소 정보가 장기간 계속 쌓일 가능성이 있습니다.

`translations/`에도 이미 저장소별 JSON이 많이 존재합니다.

향후에는 metadata를:

```
{
  "slug": "...",
  "sourceReadmeSha": "...",
  "generatedAt": "...",
  "lastSeen": "...",
  "generator": "deterministic-v2"
}
```

같이 가지고 가는 게 좋습니다.

특히 README SHA가 변하면 기존 summary가 오래된 정보인지 판별할 수 있습니다.

* * *

## 18. 기능 확장 제안

구조개편 뒤에는 기존에 이미 수집하고 있는 데이터를 활용하는 기능부터 확장하는 것이 효율적입니다.

| 기능 | 사용자 가치 | 개발 난이도 | 추천 |
| --- | --- | --- | --- |
| **Trending 연속 진입일 / streak** | 높음 | 낮음 | ★★★★★ |
| **어제 대비 순위 상승/하락** | 높음 | 낮음 | ★★★★★ |
| **Repo 2~3개 비교** | 높음 | 중간 | ★★★★★ |
| **Star growth acceleration** | 높음 | 중간 | ★★★★★ |
| **신규 진입 / 재진입 표시** | 높음 | 낮음 | ★★★★★ |
| **Topics 필터** | 높음 | 낮음~중간 | ★★★★☆ |
| **License 필터** | 중간 | 낮음 | ★★★★☆ |
| **최근 push / release 표시** | 높음 | 중간 | ★★★★☆ |
| **공개 RSS / Atom Feed** | 높음 | 낮음 | ★★★★☆ |
| **JSON feed/API** | 높음 | 매우 낮음 | ★★★★★ |
| **Favorite repo 변화 대시보드** | 높음 | 중간 | ★★★★★ |
| **Favorite 알림** | 높음 | 높음 | ★★★☆☆ |
| **개인 태그/메모** | 중간 | 중간 | ★★★☆☆ |
| **AI “왜 뜨는 중인지” 분석** | 높음 | 높음 | ★★★☆☆ |

특히 현재 SQLite를 활용하면 다음 같은 정보는 AI 없이 정확하게 만들 수 있습니다.

```
🔥 3일 연속 Trending
↑ 어제보다 12위 상승
★ 24시간 +2,418
Acceleration +37%
처음 발견: 2026-08-21
```

이런 데이터가 일반적인 GitHub Trending 원본보다 **이 서비스만의 차별점**이 될 가능성이 큽니다.

* * *

## 19. 제가 특히 추천하는 신규 기능 5개

### ① Trending History

repo별로:

```
첫 등장
최근 등장
연속 진입 일수
누적 Trending 등장 일수
일간/주간/월간 최고 순위
```

를 제공하는 기능입니다.

현재 SQLite 설계를 약간 확장하면 충분히 구현 가능합니다.

* * *

### ② Momentum Score

단순 star 수가 아니라:

```
24h growth
7d growth
30d growth
repository size
baseline popularity
```

등을 고려해 **최근 얼마나 빠르게 주목받고 있는지**를 표시할 수 있습니다.

단, 절대 스타 수가 큰 프로젝트만 유리하지 않도록 normalization이 필요합니다.

* * *

### ③ Repository Compare

예:

```
Repo A       Repo B
Stars          25.4k        10.1k
24h            +2.1k        +840
7d             +8.3k        +6.4k
Forks           1.1k         980
Issues           120          54
Contributors      80          32
```

차트까지 보여주면 상당히 유용합니다.

* * *

### ④ “왜 Trending인가?” provenance

AI부터 붙일 필요는 없습니다.

먼저:

```
최근 Release
최근 README 변화
최근 주요 commit
최근 star acceleration
최근 issue/discussion activity
```

를 보여주고, 그다음 AI summary를 optional enrichment로 붙이는 것이 좋습니다.

“AI가 그럴듯하게 설명했다”보다 **근거 URL이 있는 설명**이 훨씬 신뢰도가 높습니다.

* * *

### ⑤ Public RSS / JSON Feed

이미 매일 snapshot을 만들고 있으므로:

```
/feed.xml
/data/latest.json
/data/2026-08-23.json
```

같은 출력은 비용 대비 가치가 큽니다.

나중에는 개인 프로젝트나 다른 서비스에서도 이 저장소의 결과를 소비할 수 있게 됩니다.

* * *

## 20. 인증 기능을 더 확장한다면 Firestore schema부터 바꿔야 함

현재:

```
users/{uid}
  favorites: [...]
```

는 즐겨찾기 하나만 있을 때는 아주 좋은 단순 구조입니다.

하지만 앞으로:

*   메모

*   태그

*   alert 설정

*   watched repositories

*   saved filters

*   per-repo notification configuration

까지 붙이면 배열 기반 단일 document가 한계에 부딪힙니다.

그 시점에는:

```
users/{uid}

users/{uid}/favorites/{repoId}
  slug
  createdAt
  tags

users/{uid}/alerts/{alertId}

users/{uid}/savedFilters/{filterId}
```

처럼 확장하는 것이 좋습니다.

따라서 **지금 favorites 하나 때문에 미리 복잡하게 바꿀 필요는 없지만, 다음 사용자 기능을 추가하는 순간 schema v2로 넘어가는 것**을 권합니다.

* * *

## 21. 보안 측면에서 잘한 부분도 명확함

이번 검토에서 긍정적으로 평가한 부분이 꽤 많습니다.

Firestore는 `request.auth.uid == uid`를 강제하면서 collection query까지 차단합니다.

Favorite Sync에는 계정 전환 race를 막기 위한 generation guard, snapshot unsubscribe, serialized writes가 들어 있습니다.

Star History cache도 strict schema 및 최대 지점 수를 검증합니다.

Daily pipeline은 예상하지 못한 generated file이 생기면 publish 자체를 막고, secret-shaped 값까지 별도로 검사합니다.

SQLite는 append-only trigger와 schema fingerprint까지 사용합니다.

즉 이 프로젝트는 **“보안이 고려되지 않은 코드”가 아니라, 개별 구현은 방어적인데 프로젝트가 커지면서 저장소/공급망/CI 레벨 보안이 그 성장을 따라가지 못하고 있는 상태**에 가깝습니다.

* * *

## 22. 권장 실행 순서

제가 실제로 개편한다면 다음 순서로 진행하겠습니다.

1.   **Security baseline** — `ci.yml` 추가, `npm run test:all`, `main` required checks, Actions full SHA pinning, `persist-credentials:false`, star-history 두 번째 schedule 제거, Firebase App Check enforcement/API restrictions 확인.

2.   **Browser hardening** — CDN Marked/DOMPurify 자체 bundle 또는 exact+SRI, CSP 도입, README size/timeout/external image 정책 추가.

3.   **Frontend decomposition** — `index.html`에서 CSS·application JS를 분리하고 `globalThis` 의존성을 ES modules로 변경.

4.   **Data separation** — inline `REPOS`를 `data/trending.json`으로 분리해 daily data commit과 application code commit을 분리.

5.   **Pipeline decomposition** — `update-trending.mjs`를 fetch / parse / enrich / generate 단계로 나누고 공통 schema validator를 별도 모듈화.

6.   **Data convergence** — 충분한 exact observation이 모이면 SQLite → browser JSON 생성 구조로 전환하고 OSS Insight 의존도를 단계적으로 제거.

7.   **Product expansion** — rank history, streak, momentum, 비교 기능, release/activity signal, RSS/JSON feed 순으로 확장.

8.   **User-data expansion 시점에만 schema v2** — notes, alerts, saved filters가 들어갈 때 favorites 배열을 subcollection 구조로 이전.

* * *

## 최종 판단

현재 프로젝트는 **기능적으로는 생각보다 기반이 상당히 탄탄합니다.** 특히 외부 입력 검증과 데이터 손실 방지 쪽은 이미 좋은 편입니다.

반면 지금 가장 큰 기술부채는 특정 함수 하나가 아니라 **경계(boundary)**입니다.

```
브라우저 코드 ↔ 외부 CDN
CI 테스트 ↔ write 권한
Application source ↔ Daily generated data
Main branch ↔ production deployment
OSS Insight estimate ↔ exact SQLite history
```

이 경계들을 분리하면 프로젝트 품질이 한 단계 올라갑니다.

특히 저는 **지금 바로 React/Next/Supabase 같은 대규모 기술 스택 전환은 권하지 않습니다.** 현재 장점을 그대로 살려 **정적 ES Module 앱 + JSON data plane + GitHub Actions collector + Firebase user plane**으로 정리하는 것이 비용 대비 가장 좋은 방향입니다.

그리고 우선순위를 딱 세 개만 고르면 **① Actions/branch/CI 보안 강화, ② `index.html`에서 generated data 분리, ③ CDN JS 제거 + CSP 도입**입니다. 이 세 가지를 먼저 하면 그다음 기능 확장은 훨씬 안전하고 수월해질 겁니다.
