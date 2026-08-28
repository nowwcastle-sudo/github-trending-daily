# GitHub Trending 워크플로·데이터·UI·로그인 안정화 설계

- 상태: 사용자 승인 완료, 구현 계획 작성
- 작성일: 2026-08-27
- 대상 저장소: `nowwcastle-sudo/github-trending-daily`
- 설계 기준 SHA: `214e21d9ecf414f993f4516030d3513da657385b`
- 구현 순서: 워크플로·데이터 → UI → 로그인 유지 → Codex Security → 전체 production 검증

## 1. 목적

이 작업은 현재 정적 GitHub Pages 구조를 유지하면서 다음 문제를 한 번에 바로잡는다.

1. 신규 저장소의 상세 한국어 툴팁과 README 한글 번역이 실패해도 workflow가 성공으로 끝나는 문제
2. daily·weekly·monthly 수집, LLM 가공, SQLite 기록, Atom 생성, Pages 배포가 서로 다른 기준시각과 성공 기준을 사용하는 문제
3. 현재 화면이 보여 주는 값과 향후 분석에 유용한 별·순위·릴리스·커밋·membership 이력이 충분한 정밀도로 보존되지 않는 문제
4. desktop·mobile 툴팁 중복, sidebar 배치와 진입 방식, mobile gesture가 사용자 흐름에 맞지 않는 문제
5. Firebase 로그인 유지가 암묵적 기본값에 의존하고 BFCache 복귀 경로가 끊길 수 있는 문제
6. 구현 후 workflow·browser·Firebase·배포 전체를 하나의 acceptance contract로 검증할 수 없는 문제

완료 상태에서는 2시간 갱신 하나가 동일한 `snapshot_id`를 공유하는 원자적 publication transaction이 된다. 수집·LLM·검증·기록·파생물·배포·production 확인 중 하나라도 실패하면 후보를 버리고 마지막 정상 production을 보존한다.

## 2. 설계 착수 시 확인된 기준선

설계 착수 시 작업트리는 clean이었고 `HEAD == origin/main == 214e21d9ecf414f993f4516030d3513da657385b`였다. 기준 테스트는 `npm test` exit 0, Node 194개 중 185 pass·9 Firestore Rules skip·0 fail, Python 41 pass였다. 구현 직전에는 2시간 bot 갱신으로 SHA와 테스트 수가 바뀔 수 있으므로 이 수치를 다시 측정한다.

독립적인 적대적 workflow 리뷰에서 다음 결함을 확인했다.

- `generate-translations.mjs`가 저장소별 실패와 `ANTHROPIC_API_KEY` 누락을 성공으로 처리한다.
- 실제 Actions run `32983352219`는 JSON 잘림 3건, `32972697340`은 9건 중 6건 실패가 있었지만 성공·커밋으로 끝났다.
- 현재 활성 41개 중 translation/source provenance 누락 3개, deterministic fallback 13개, placeholder 계열 21개, compact와 detail 핵심 5필드가 같은 항목 22개가 관측됐다.
- summary와 README 전체 번역을 하나의 8,000-token JSON 응답으로 요청하고 `stop_reason`을 검증하지 않는다.
- `update-latest-feed.mjs`는 `desc`를 내보내지만 `generate_atom_feeds.py`는 `description`을 읽어 production `feed.xml`의 41개 summary가 비어 있었다.
- KST 자정을 넘은 한 실행에서 page·membership와 star-history의 날짜가 갈렸다.
- GitHub REST 실패 시 이전 metadata를 재사용하면서 `_stats_date`만 현재로 바꿀 수 있다.
- `star-observations.sqlite`의 `(slug, observed_date, source)` 유일성 때문에 같은 날 2시간 단위 변화가 보존되지 않는다.
- unchanged run은 `generatedAt` 비교에서 제외되어 성공한 관측 자체가 기록되지 않을 수 있다.
- legacy Pages build/deploy가 새 main SHA를 production에 제공한다는 검증이 workflow 안에 없다.

이 문서는 위 관측과 사용자가 승인한 여섯 설계 부문을 합친 새 정본이다. 이전 설계 문서는 역사적 배경으로 남기되, 이 문서와 충돌하는 fallback·publication·인증 지속성 정책은 이 문서가 우선한다.

## 3. 범위와 제외 범위

### 3.1 포함

- 2시간 단위 transactional refresh와 명시적 Pages 배포
- canonical README blob 기반 상세 한국어 요약과 README 한글 번역
- 활성 저장소의 compact tooltip 폐기와 상세 tooltip 단일화
- 현재 화면에 쓰는 모든 public repository metadata의 정밀 관측
- daily·weekly·monthly source rank와 최종 display rank 이력
- stars·forks·open issues and pull requests·contributors·subscribers 이력
- release metadata 전체 baseline과 이후 변경 이력
- 현재 default branch HEAD를 기준으로 한 향후 commit timeline
- README 본문을 보관하지 않는 변경 이벤트 이력
- desktop hover rail, 재배치된 dashboard sidebar, mobile edge swipe
- 명시적 Firebase local auth persistence와 BFCache lifecycle
- Codex Security repository-wide scan과 전체 acceptance matrix

### 3.2 제외

- 새 서버, 새 frontend framework, 영구 dependency, 유료 API 추가
- 이메일·web push·분야별 feed·언어별 feed
- README 본문 장기 archive 또는 분석 DB 저장
- release body·asset 목록, commit patch·파일 목록·전체 메시지·이메일
- 과거 default-branch commit 전체 backfill
- GitHub가 공개하지 않는 stargazer 신원·정확한 과거 시점 우회 수집
- 사용자 UID·인증 토큰·전체 즐겨찾기·전체 숨김 목록·localStorage key의 export
- Firebase 프로젝트·인증 제공자·Rules를 근거 없이 재설계하는 작업
- L1~L5 또는 다음 확장 후보의 자동 착수

## 4. 핵심 원칙

### 4.1 한 실행, 한 시계, 한 스냅샷

workflow 시작 시 다음 값을 한 번만 계산해 모든 단계에 전달한다.

- `observed_at_utc`: ISO 8601 UTC 시각
- `observed_at_kst`: 같은 순간의 Asia/Seoul 표현
- `stats_date_kst`: `observed_at_kst`에서 파생한 날짜
- `snapshot_id`: 시각과 입력 계약 버전을 결합한 충돌 없는 식별자
- `parent_snapshot_id`: 마지막 production 성공 스냅샷

스크립트가 각자 현재 시각이나 날짜를 다시 계산하지 않는다. KST 자정이 실행 중 지나가도 page, SQLite, membership, Atom, manifest는 같은 값을 사용한다.

### 4.2 fail-closed publication

수집·LLM·검증·DB·파생물·test·push·deploy·production probe를 하나의 transaction으로 취급한다.

- 후보는 runner의 임시 디렉터리에서 만든다.
- tracked last-good 파일을 생성 도중 덮어쓰지 않는다.
- 모든 gate를 통과한 후보만 작업트리에 설치한다.
- API 실패 값을 과거 값으로 대신하고 날짜만 새것으로 바꾸지 않는다.
- legitimate absence와 transient failure를 구분한다.
- 실패 실행은 GitHub Actions log에 실패 원인을 남기되 production DB에는 성공처럼 기록하지 않는다.

### 4.3 기존 이력 보존

`data/star-observations.sqlite`와 `data/trending-membership.sqlite`의 schema와 과거 row는 변경하지 않는다. 신규 `data/repository-observations.sqlite`가 정확한 2시간 관측의 정본이 된다.

legacy DB는 새 DB의 baseline provenance로 연결하고 과거를 다시 쓰지 않는다. 새 파생물은 필요할 때 legacy history와 신규 snapshot을 읽어 연속된 결과를 만든다. 첫 신규 snapshot의 현재 저장소를 모두 `new`로 표시하지 않고 `baseline_present`로 기록한다.

### 4.4 최소한의 구조 변경

정적 `index.html`, 현재 vanilla JavaScript, Firebase 공식 browser module을 유지한다. 새 서버·framework·영구 package를 넣지 않는다. 각 책임은 작은 script/module로 분리하되 한 구현뿐인 추상 계층은 만들지 않는다.

## 5. 2시간 workflow architecture

### 5.1 실행 상태 기계

```text
prepare context
  → collect Trending sources
  → collect and validate canonical GitHub facts, releases and prospective commits
  → enrich summaries and translations
  → validate the complete fact/event/enrichment set
  → append candidate observation DB
  → derive page, JSON, Atom and statistics from the DB snapshot joined to the exact validated enrichment set
  → run full verification
  → fetch and compare origin/main
  → install, commit and push exact candidate
  → deploy the same tree with a deployment-only manifest
  → verify production SHA, snapshot and file hashes
```

어느 단계에서든 실패하면 이후 단계를 실행하지 않는다. concurrency group은 하나이며 `cancel-in-progress: false`로 직렬화한다. push 직전 `git fetch origin main` 후 실행 기준 이후 원격이 전진했으면 merge·rebase하지 않고 실패한다. 다음 실행이 새 기준선에서 다시 수집한다.

운영 schedule은 현재 승인된 `cron: 7 */2 * * *`를 유지한다. UI는 이 cron 표현이나 `서울 기준 홀수 시 07분`을 노출하지 않고 production snapshot을 기준으로 계산한 다음 갱신 시각만 보여 준다. Scheduled entry는 repository variable `GH_TRENDING_REFRESH_SCHEDULE`가 정확히 `enabled`일 때만 RunContext 생성과 외부 fetch로 진입한다. 변수 부재, `hold`, 대소문자·공백·부분·숫자 등 그 밖의 값은 외부 fetch·commit 0으로 종료한다. `workflow_dispatch`는 이 변수를 우회하거나 입력으로 변경하지 않으며 별도의 immutable bootstrap identity/policy gate를 사용하되 이후 transactional build 경로는 공유한다. 최종 acceptance의 유일한 실행 주체인 security-production Task 5는 activation 전에 이 변수를 `hold`로 설정·readback하고, 단일 manual run·browser·login·post-production security·OFA 증거가 모두 끝난 뒤에만 `enabled`로 되돌려 readback한다. 실패·중단 시에는 `hold`를 유지하고 변경 시각과 값을 비밀값 없는 외부 receipt에 기록한다.

### 5.2 수집 순서

1. daily, weekly, monthly Trending HTML을 모두 수집·구조 검증한다.
2. 각 source의 원래 ordinal과 visible period gain을 보존한다.
3. daily → weekly → monthly 순서의 안정적인 합집합을 만든다.
4. 합집합의 모든 slug에 대해 GitHub repository metadata를 수집한다.
5. canonical `/repos/{owner}/{repo}/readme` 응답으로 실제 README path와 blob SHA를 얻고, 그 blob을 명시적으로 읽는다.
6. 전체 release inventory, 공식 `/releases/latest` identity와 default-branch prospective commit gap을 수집·검증한다.
7. 모든 current displayed field와 event inventory의 freshness·provenance·request budget을 검증한 뒤에만 유료 LLM 단계로 넘어간다. release/commit cap·continuity·deadline 실패는 Anthropic fetch 0이어야 한다.

README `404`는 repository가 존재하고 canonical README가 실제로 없을 때만 `no_readme`로 분류한다. repository REST `500`, timeout, rate limit, malformed response, README가 있어야 하는데 가져오지 못한 상태는 실행 실패다. Release 목록 200 + 빈 배열은 정상적인 `no_releases`다.

### 5.3 LLM 호출 계약

상세 요약과 README 전체 번역은 freshness와 검증을 독립적으로 유지한다. 둘 다 pending이고 16,000-token 상한에 들어오는 첫 bounded translation chunk가 있을 때만 그 chunk와 summary를 한 응답에 결합하며, 그렇지 않으면 별도 summary 호출로 분리한다.

상세 요약 응답은 다음 필드만 가진 구조화 JSON이다.

```json
{
  "goal": "string",
  "usage": "string",
  "pros": "string",
  "cons": "string",
  "fit": "string"
}
```

`stars_note`는 LLM에 맡기지 않는다. 현재 stars, period gains, source ranks, membership status로 deterministic하게 생성한다. LLM은 API key, workflow token, 로컬 파일, 다른 저장소의 내용에 접근하지 않으며 README와 허용된 public metadata만 입력으로 받는다.

README 번역은 Markdown을 입력과 출력으로 사용한다. heading, list, table, fenced code, inline code, link destination을 보존하고 자연어만 한국어로 번역한다. 큰 README는 검증 가능한 heading 경계로 bounded chunking한 뒤 순서를 보존해 결합한다. 줄 수를 이유로 뒷부분을 조용히 버리지 않는다. 먼저 raw normalized atomic block의 64 KiB 구조 상한을 검사하고, sentinel 처리 후 paid-request 상한을 별도로 적용한다. `translationTokens = max(1,024, ceil(chunkBytes / 2) + 1,024)`이며 첫 chunk에 summary를 결합할 때만 4,096을 더한다. 이 계산값이 16,000을 넘지 않도록 combined first chunk는 21,760 UTF-8 bytes 이하, 나머지 translation chunk는 29,952 bytes 이하로 묶는다. 첫 sentinelized atomic block이 combined 상한만 넘으면 summary를 분리하고, 29,952 bytes도 넘는 단일 sentinelized atomic block은 유료 호출 전에 실패한다. 응답의 `segment_bindings`는 로컬 계획의 `index`와 `input_sha256`만 되돌려 주며 번역 본문을 중복하지 않는다. `translated_markdown`에서 clause를 다시 추출해 같은 위치의 로컬 source binding과 대조하고, chunk와 전체 문서의 clause 수·순서·hash·prose·sentinel·fingerprint를 모두 검증한다.

두 호출 모두 다음 gate를 통과해야 한다.

- 요청별 60초 timeout과 build 첫 executable step의 immutable job origin에서 계산한 최대 70분 enrichment absolute deadline
- HTTP status와 response content type 검증
- bounded retry와 backoff
- Anthropic `stop_reason == end_turn`
- 필수 필드·문자열 길이·금지 필드 검증
- JSON/Markdown 완결성 검증
- prompt echo, code fence wrapping, 빈 결과 거부
- pending queue 전체 완료 확인
- 결과를 확정할 수 없는 timeout·fetch·HTTP·body 오류의 input/output request allocation을 unresolved usage로 보존
- 모든 logical request의 frame id·prompt·JSON body를 유료 호출 전에 한 번만 만들고 실제 fetch와 retry가 같은 `bodyText`를 byte-for-byte 재사용
- first-attempt exact input/output reservation 합과 각 request를 두 번 복제한 후보 중 큰 12개 retry margin을 독립 계산하고 선택된 고정 policy를 넘으면 fetch 0

API key가 없거나 처리 상한 때문에 대상이 남으면 workflow는 실패한다. 저장소별 오류를 로그만 남기고 exit 0으로 끝내지 않는다. 구조화된 failure log에는 고정 failure code와 numeric usage snapshot을 남기며, 유료 요청 전 실패의 usage는 0이다. 유료 요청 진단에는 public repository slug, request kind, chunk index, attempt, prompt/body byte 수, `max_tokens`, 경과시간, confirmed/unresolved usage 숫자만 허용하고 prompt·README·response body·header·raw provider error·비밀값은 넣지 않는다.

LLM 대상은 새 repository, canonical README blob SHA가 바뀐 repository, provenance·schema·품질 검증에 실패한 repository뿐이다. 동일한 blob SHA의 검증된 summary와 translation은 재사용한다. 호출 전 pending count, 입력 byte 수, 최대 호출 수를 secret 없이 log하고, union·README size에서 정한 안전 상한을 넘으면 일부를 잘라 게시하지 않고 실행 전체를 중단한다. 초기 active-set repair도 같은 gate를 쓰는 1회 `workflow_dispatch`로 수행한다.

2026-08-28 첫 production bootstrap run `33121119785`는 현재 canonical README가 31,475 bytes인 저장소를 처리하다 non-streaming Anthropic status 없는 fetch 예외로 끝났다. 약 204초의 경과는 60초 timeout 세 번과 bounded retry delay에 부합하지만 기존 로그는 정확한 request kind를 남기지 않았다. README 전체 크기는 진단 맥락이며 실제 request admission은 post-sentinel atomic block과 packed request bytes로 판정한다. candidate 검증·commit·deploy는 시작되지 않아 production은 보존됐다. 이 실측 때문에 timeout만 늘리지 않고 token-safe repacking, unresolved input 회계, content-free 실패 감사, build-job anchored enrichment deadline을 publication 선행조건으로 추가한다. SSE streaming은 작은 bounded chunk에서도 같은 timeout이 재현될 때 별도 설계한다.

같은 날 current-main plan-only 재측정은 active/pending 41, logical calls 81, worst-case per-call attempts 243, canonical README 1,430,903 bytes, first-attempt output allocation 965,180 tokens이었다. Normal policy의 250,000 output ceiling으로는 실제 usage가 allocation의 25.9% 미만이어야만 완주하므로 운영 gate는 NO-GO다. Normal은 input/output `1,000,000/250,000`, retry margin 12를 유지한다. Verified version-0 manual bootstrap은 별도의 immutable `bootstrap_v0_approved` policy로만 활성화하고, workflow 기본값은 모든 구현 plan과 최종 보안·기능 검증이 끝날 때까지 `bootstrap_v0_pending_approval`로 유지한다. Pending mode는 Anthropic fetch 0으로 실패해야 한다. Bootstrap identity는 두 manual case만 허용한다: production manifest 404에서는 explicit input이 verified Pages build/hydration SHA와 같고, valid recovery v0 manifest에서는 input 없이 manifest `sourceSha`가 canonical manual/hydration SHA와 같다. 둘 다 `workflow_dispatch`와 approved immutable policy가 필요하다. Schedule+recovery v0, 부분 설정, 숫자형 cap override, 기존 v0/v1 manifest와 함께 온 bootstrap input, v1에 approved mode를 강제하는 경우는 거부한다. Verified recovery v1은 bootstrap policy가 아니라 normal policy를 선택하며, schedule은 별도의 exact `enabled` hold gate까지 통과해야 한다.

응답 번역 본문 중복 제거와 exact execution plan 구현 뒤 같은 41개 current-main active set을 GitHub canonical README로 다시 측정했다. Anthropic fetch는 0이었다. first-attempt input reservation은 `8,133,863`, output allocation은 `965,180`; 큰 12개 retry margin은 input `3,260,464`, output `191,540`; required total은 input `11,394,327`, output `1,156,720`이었다. 측정 receipt는 verified legacy source SHA, run-context snapshot, source-set hash와 결합되고 repository·README·prompt·body를 출력하지 않는다. 승인된 fixed bootstrap cap은 측정값을 자동 반영하지 않고 각각 올림한 input `11,500,000`, output `1,200,000`이며 runtime 변경이 불가능하다. Haiku 4.5 공식 단가의 보수식으로 최대 `$17.50`이며 실제 예상 청구액이 아니라 body-byte 기반 input reservation과 output allocation의 fail-closed ceiling이다. 81개 first attempt와 최대 12개 additional attempt가 모두 60초 timeout을 쓰면 70분 enrichment deadline을 넘으므로, provider가 극단적으로 느리면 비용 일부가 발생해도 publication은 0일 수 있다. 사용자는 모든 구현 plan 뒤 최초 workflow를 agent가 직접 한 번 실행해 production까지 검증하도록 지시했다. Workflow의 pending mode 해제와 실제 1회 실행은 최종 적대적 리뷰·staged 검증 뒤에만 하며, 실패 시 자동 재실행하지 않는다.

README가 없는 repository는 public metadata를 입력으로 같은 상세 schema를 생성하고 provenance를 `metadata-only`로 기록한다. README 번역은 `not_applicable:no_readme`로 명시한다.

### 5.4 compact summary 제거와 migration

`summary`와 `detail`의 이중 계약을 폐기한다. 새 `data/repo-summaries.json`은 slug별 canonical detailed summary 하나와 provenance만 가진다.

```json
{
  "owner/repo": {
    "content": {
      "goal": "...",
      "usage": "...",
      "pros": "...",
      "cons": "...",
      "fit": "..."
    },
    "source": {
      "kind": "readme",
      "slug": "owner/repo",
      "path": "README.md",
      "blob_sha": "...",
      "content_sha256": "...",
      "model": "...",
      "schema_version": 2,
      "translation_applicable": true
    }
  }
}
```

README가 없는 summary의 source union은 정확히 `{ "kind":"metadata_only", "slug":"owner/repo", "profile_sha256":"...", "model":"...", "schema_version":2, "translation_applicable":false }`다. README source와 metadata-only source의 key를 섞거나 생략하면 invalid다.

기존 cache의 `detail`이 품질·source 계약을 충족하면 canonical content 후보로 사용할 수 있지만 compact `summary` 필드는 전부 삭제한다. placeholder, deterministic fallback, compact/detail 동일, source hash 없음, 필수 상세 필드 부족 항목은 invalid로 표시한다. 활성 repository는 모두 유효한 detailed summary가 있어야 게시할 수 있다. 비활성 cache 항목은 재진입할 때 publication 전에 같은 검사를 받는다.

기존 translation JSON의 `{ "html": "..." }` contract는 폐기한다. 이 필드는 실제로 Markdown과 raw HTML을 함께 담으면서 browser의 `innerHTML`에 들어가므로 untrusted README·LLM output 경계를 보장할 수 없다. 새 contract는 translated Markdown과 provenance를 저장한다.

```json
{
  "markdown": "# translated README",
  "source": {
    "kind": "readme",
    "slug": "owner/repo",
    "path": "README.md",
    "blob_sha": "...",
    "content_sha256": "...",
    "model": "...",
    "schema_version": 2,
    "translation_applicable": true
  }
}
```

`data/translation-sources.json`의 slug source는 해당 translation file의 `source` object와 canonical byte/hash까지 같아야 한다. Metadata-only와 README-present no-prose repository에는 translation file/source entry가 없다. 전자는 `not_applicable:no_readme`, 후자는 readme summary source의 `translation_applicable:false`와 `not_applicable:no_prose` status를 가진다.

browser는 raw HTML을 먼저 escape하고 heading, paragraph, list, blockquote, table, fenced/inline code, link, image의 필요한 Markdown subset만 deterministic하게 렌더링한다. `script`, `style`, `iframe`, embedded SVG, event attribute와 `javascript:`·위험한 `data:` URL은 생성할 수 없다. 상대 link는 source repository와 blob SHA에 고정해 해석하고 외부 link에는 안전한 `rel`을 붙인다. code는 항상 text로 취급한다.

`data/translation-sources.json`은 canonical README blob SHA, content SHA256, schema version, 생성 model을 기록하도록 올린다. baseline을 확인하지 않고 source 완료로 표시하지 않는다.

### 5.5 파생물과 명시적 Pages 배포

candidate DB가 확정된 뒤 다음 산출물을 같은 snapshot에서 생성한다.

- `index.html`
- `data/latest.json`
- `data/membership-status.json`
- `feed.xml`
- `changes.xml`
- `star-history.json`
- `translations/*.json`
- README rolling state와 summary/translation provenance

Atom 생성기는 실제 latest JSON fixture를 직접 받아 integration test한다. `desc`/`description` 같은 producer-consumer drift를 두 구현 사이의 contract test로 차단한다.

commit을 만든 뒤 그 commit SHA, `snapshot_id`, 주요 artifact SHA256을 포함한 deployment-only manifest를 Pages artifact에 추가한다. manifest는 자기 SHA를 포함할 수 없는 Git commit에 넣지 않고, commit 후 upload할 artifact에만 넣는다. `actions/upload-pages-artifact`와 `actions/deploy-pages`로 같은 workflow에서 명시적으로 배포한다.

배포 후 cache-busting query로 production manifest, HTML, latest JSON, Atom을 읽어 다음을 대조한다.

- deployed `source_sha == pushed commit`
- deployed `snapshot_id == candidate snapshot`
- 주요 file hash 일치
- HTML·JSON·Atom의 기준시각과 repository 수 일치
- Atom summary 비어 있지 않음

custom Pages artifact는 site allowlist로 만든다. HTML, CSS/JS, public JSON, translation Markdown, Atom, 필요한 image만 포함하고 SQLite, workflow, docs, test, 임시 파일은 배포하지 않는다.

배포 전에는 upload할 artifact 자체를 로컬 HTTP server에서 검증한다. Probe의 각 idempotent GET은 그 사이에 수행되는 동기식 Git 검증 시간과 server keep-alive timeout이 경합하지 않도록 독립 연결(`Connection: close`)을 사용한다. Pages deploy가 실패하면 이전 production이 유지된다. deploy 성공 후 production readback이 불일치하면 해당 run을 성공으로 판정하지 않고 기록된 last-good `source_sha`의 artifact를 즉시 재배포하는 recovery job을 실행한 뒤 다시 검증한다. candidate data commit은 last-good snapshot의 부모로 사용하지 않으며, 다음 publisher가 production manifest의 last-good snapshot에서 후보 DB를 다시 만든다. 자동 history rewrite나 force push는 하지 않는다.

## 6. 유용한 데이터 정본

### 6.1 저장 대상

모든 성공한 2시간 run은 화면 내용이 같아도 snapshot을 남긴다.

- daily·weekly·monthly source ordinal과 period gain
- final display rank
- membership state와 transition
- stars, forks, GitHub `watchers_count`, subscribers
- GitHub의 `open_issues_count`를 의미 그대로 저장한 `open_issues_and_pull_requests`
- contributor count
- description, topics, license, archived, fork 여부
- primary language, daily·weekly·monthly source language color, selected language color와 선택 source period
- field tags와 form tags 및 tag-rule version
- created, updated, pushed 시각
- default branch와 관측된 HEAD SHA
- canonical README path, blob SHA, content SHA256의 변경 이벤트
- public release metadata versions
- 향후 default-branch commit events
- 기존 OSS Insight historical star estimate와 exact GitHub 관측의 분리된 provenance
- canonical detailed summary·translation envelope를 연결하는 source/content hash identity

daily·weekly·monthly에서 관측한 language color는 각각 보존한다. selected color는 daily → weekly → monthly의 첫 non-null source와 그 period를 함께 기록한다. v1에는 local language-color map을 넣지 않는다. 세 source 모두 색이 없으면 selected color와 source period를 모두 DB `null`로 기록하고 UI만 neutral gray fallback을 렌더한다. 이 fallback은 수집 데이터가 아니다.

파생 insight는 다음을 포함한다.

- 이전 성공 관측 이후 stars delta와 실제 관측 간격
- KST 일별 마지막 성공 관측 stars와 daily delta (`provisional`/`finalized` 구분)
- 7일·30일 velocity와 acceleration
- source period rank timeline
- final display rank timeline
- new·reentered·stayed·exited timeline
- release timeline
- commit timeline
- repository profile change timeline

### 6.2 저장하지 않는 값

- original README body (published Korean translation envelope은 기존 public JSON 정본에 유지)
- release body와 asset 목록
- commit patch, changed files, message/subject, 이메일
- 사용자 UID·인증 토큰·즐겨찾기·숨김 목록·export history
- workflow secret 또는 request header

README 비교를 위해 `data/readme-state.json`에는 slug별 현재·직전 path, immutable blob SHA, content SHA256, 관측시각만 rolling state로 둔다. Original source README body는 tracked file, JSON, SQLite 어디에도 영구 저장하지 않는다. Published Korean translated Markdown은 기존 translation envelope에 유지한다. 변경 대조가 필요할 때 직전 blob SHA를 GitHub immutable blob endpoint에서 run temp로 다시 읽고 사용 후 폐기한다. 이 방식은 working tree와 Git history에 과거 original README body가 누적되는 것을 피하며, repository가 삭제되거나 public blob 접근이 사라지면 과거 본문 대조가 불가능하다는 한계를 명시한다. DB의 `readme_change_events`에는 old/new identity와 change time만 추가한다.

### 6.3 신규 SQLite schema

`data/repository-observations.sqlite`는 다음 14개 append-only table을 가진다.

| table | 책임 |
|---|---|
| `schema_meta` | schema version·append-only policy singleton |
| `baseline_sources` | cutover 시 frozen legacy DB의 file/schema/logical-row identity |
| `baseline_membership_slugs` | legacy membership에서 한 번이라도 관측된 slug identity; 과거 snapshot backfill 아님 |
| `snapshot_runs` | 성공 run의 시각, KST 날짜, parent, input/output hash |
| `repository_profiles` | metadata가 바뀔 때만 추가되는 profile version |
| `snapshot_items` | snapshot별 slug, 세 source rank, display rank, 정확한 counts·색·HEAD·membership·release inventory proof |
| `release_versions` | release id/tag의 public metadata version |
| `snapshot_release_items` | snapshot별 완주된 release inventory의 ordinal과 version reference |
| `historical_star_estimates` | OSS Insight에서 얻은 날짜별 estimate version; exact GitHub 관측과 source 분리 |
| `historical_star_observations` | cutover 전 공개 observed series와 legacy exact DB rows를 source별로 손실 없이 보존 |
| `commit_events` | baseline 이후 관측한 default-branch commit |
| `readme_change_events` | README hash와 blob 변화, 본문 없음 |
| `repository_insights` | 이전 관측 reference·실제 gap·stars/rank delta; 일별 종가·velocity는 raw snapshot에서 파생 |
| `artifact_hashes` | snapshot과 public Pages artifact SHA256 연결; DB 자신과 manifest 제외 |

핵심 키는 `snapshot_seq`/`snapshot_id`, canonical lowercase slug, GitHub release id, commit SHA다. repository 표시 casing은 별도 field로 보존하되 identity 비교에는 lowercase slug를 쓴다. Original README/translation 본문과 detailed summary 본문은 observation DB에 넣지 않는다. 기존 검증된 JSON/translation envelope를 콘텐츠 정본으로 유지하고, `snapshot_items`가 summary source/content/envelope SHA256와 translation source/envelope SHA256·적용 상태를 결합한다. 따라서 public render의 정확한 입력은 **DB snapshot + 그 hash에 일치하는 validated enrichment set**이다.

#### 6.3.1 schema v1 exact matrix

모든 table은 `STRICT`다. 아래 표는 DDL-equivalent exact matrix다. `IPK`는 `INTEGER PRIMARY KEY`, `I!`/`I?`는 `INTEGER NOT NULL`/nullable `INTEGER`, `T!`/`T?`는 `TEXT NOT NULL`/nullable `TEXT`다. 어떤 column에도 `DEFAULT`나 `COLLATE` clause가 없으므로 text 비교는 SQLite 기본 BINARY이고, 아래에 없는 column은 허용하지 않는다. 모든 FK는 `ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`다.

| table | exact typed columns | exact key·reference·check |
|---|---|---|
| `schema_meta` | `schema_version IPK`, `creation_policy T!`, `schema_fingerprint_sha256 T!` | singleton `schema_version=1`; policy exact `append_only`; SHA256 check |
| `baseline_sources` | `source_name T!`, `repo_relative_path T!`, `byte_size I!`, `file_sha256 T!`, `schema_fingerprint_sha256 T!`, `logical_row_count I!`, `logical_rows_sha256 T!`, `last_logical_key_json T?`, `cutover_snapshot_seq I!` | PK `source_name`; unique `(source_name,cutover_snapshot_seq)`; enum `legacy_star_observations|legacy_trending_membership|legacy_public_star_history`; unique path; FK cutover run; size/count ≥0; `last_logical_key_json IS NULL` iff count=0 |
| `baseline_membership_slugs` | `slug T!`, `source_name T!`, `cutover_snapshot_seq I!` | PK lowercase `slug`; `source_name='legacy_trending_membership'`; composite FK `(source_name,cutover_snapshot_seq)` to baseline source plus FK cutover run |
| `snapshot_runs` | `snapshot_seq IPK`, `snapshot_id T!`, `run_kind T!`, `observed_at_utc T!`, `observed_at_kst T!`, `stats_date_kst T!`, `parent_snapshot_seq I?`, `parent_snapshot_id T?`, `input_source_sha T!`, `input_manifest_sha256 T?`, `core_payload_sha256 T!`, `parent_chain_sha256 T?`, `chain_sha256 T!`, `repository_count I!` | unique id, UTC time, chain, `(snapshot_seq,snapshot_id)`, and nullable parent pair; composite parent FK; `migration_baseline` requires seq=1 and all three parent fields null, `refresh` requires all three parent fields nonnull; manifest hash is null iff the verified production manifest response was 404 and the explicit bootstrap source was used, otherwise it is the exact validated v0/v1 manifest bytes SHA256; snapshot-id/ISO/KST-date exact format; count 1..75; seq=parent+1 validator |
| `repository_profiles` | `profile_id IPK`, `slug T!`, `display_slug T!`, `captured_snapshot_seq I!`, `description T?`, `primary_language T?`, `topics_json T!`, `license_spdx T?`, `archived I!`, `is_fork I!`, `default_branch T!`, `created_at T!`, `field_tags_json T!`, `form_tags_json T!`, `tag_rule_version I!`, `profile_sha256 T!` | unique `(slug,profile_sha256)` and `(profile_id,slug)`; FK captured run; booleans 0/1; tag rule version >0; canonical JSON/tag checks; no AI-specific column |
| `snapshot_items` | `snapshot_seq I!`, `slug T!`, `profile_id I!`, `display_rank I!`, `rank_daily I?`, `rank_weekly I?`, `rank_monthly I?`, `gain_daily I?`, `gain_weekly I?`, `gain_monthly I?`, `language_color_daily T?`, `language_color_weekly T?`, `language_color_monthly T?`, `selected_language_color T?`, `selected_language_color_source_period T?`, `stars I!`, `forks I!`, `watchers_count I!`, `subscribers I!`, `open_issues_and_pull_requests I!`, `contributors I!`, `updated_at T!`, `pushed_at T?`, `default_branch_head_sha T!`, `previous_default_branch_head_sha T?`, `head_transition T!`, `readme_status T!`, `readme_path T?`, `readme_blob_sha T?`, `readme_content_sha256 T?`, `membership_status T!`, `release_count I!`, `release_inventory_sha256 T!`, `latest_release_id I?`, `estimate_collection_status T!`, `estimate_source_payload_sha256 T!`, `estimate_point_count I!`, `summary_source_sha256 T!`, `summary_content_sha256 T!`, `summary_envelope_sha256 T!`, `translation_status T!`, `translation_source_sha256 T?`, `translation_envelope_sha256 T?` | PK `(snapshot_seq,slug)`; FKs run and `(profile_id,slug)`; unique `(snapshot_seq,display_rank)`; rank/gain, color, HEAD, README/enrichment, release and estimate cross-checks below; nonnegative counts; `pushed_at` null or exact UTC; exact enums below |
| `release_versions` | `slug T!`, `release_id I!`, `metadata_sha256 T!`, `first_observed_snapshot_seq I!`, `tag_name T!`, `name T?`, `target_commitish T!`, `draft I!`, `prerelease I!`, `created_at T!`, `published_at T?`, `html_url T!` | PK `(slug,release_id,metadata_sha256)`; FK first-observed run; release id >0; booleans 0/1; no body/assets |
| `snapshot_release_items` | `snapshot_seq I!`, `slug T!`, `release_id I!`, `metadata_sha256 T!`, `release_ordinal I!` | PK `(snapshot_seq,slug,release_id)`; unique `(snapshot_seq,slug,release_ordinal)`; FK snapshot item and exact release version; ordinal ≥0, contiguous validator |
| `historical_star_estimates` | `source T!`, `slug T!`, `estimate_date T!`, `is_present I!`, `stars I?`, `point_sha256 T!`, `source_payload_sha256 T!`, `first_observed_snapshot_seq I!` | PK `(source,slug,estimate_date,first_observed_snapshot_seq)`; enum `legacy_star_history_cache|ossinsight_api`; FK first-observed run; boolean; present requires stars ≥0, tombstone requires stars null; date/hash checks; new API row for new/value-change/removal/reappearance |
| `historical_star_observations` | `source T!`, `legacy_row_id I?`, `slug T!`, `observation_date T!`, `stars I!`, `stars_delta I?`, `legacy_source T?`, `source_row_sha256 T!`, `first_observed_snapshot_seq I!` | PK `(source,slug,observation_date,source_row_sha256)`; unique `(source,legacy_row_id)`; enum `legacy_public_star_history|legacy_star_observations_db`; FK first-observed run; stars ≥0; exact source-specific checks/preimages below |
| `commit_events` | `slug T!`, `commit_sha T!`, `first_observed_snapshot_seq I!`, `first_observed_ordinal I!`, `branch_name T!`, `authored_at T!`, `committed_at T!`, `author_login T?`, `parent_shas_json T!`, `html_url T!` | PK `(slug,commit_sha)`; unique `(first_observed_snapshot_seq,slug,first_observed_ordinal)`; FK first-observed run; ordinal ≥0; no subject/message/name/email/files/patch |
| `readme_change_events` | `snapshot_seq I!`, `slug T!`, `old_path T?`, `new_path T?`, `old_blob_sha T?`, `new_blob_sha T?`, `old_content_sha256 T?`, `new_content_sha256 T?`, `change_kind T!` | PK `(snapshot_seq,slug)`; FK snapshot item; enum `baseline|added|changed|removed`; exact tuple/null transition checks below |
| `repository_insights` | `snapshot_seq I!`, `slug T!`, `previous_observed_snapshot_seq I?`, `observation_gap_milliseconds I?`, `stars_delta_since_previous_observation I?`, `display_rank_delta I?`, `rank_daily_delta I?`, `rank_weekly_delta I?`, `rank_monthly_delta I?`, `insight_rule_version T!`, `insight_sha256 T!` | PK `(snapshot_seq,slug)`; FK current item and nullable `(previous_observed_snapshot_seq,slug)`; exact rule version `repository-insight-v1`; first observation has all previous/gap/deltas null, later has positive exact millisecond gap and deltas below |
| `artifact_hashes` | `snapshot_seq I!`, `artifact_path T!`, `sha256 T!`, `byte_size I!` | PK `(snapshot_seq,artifact_path)`; FK run; size ≥0; normalized exact Pages allowlist; rejects DB/readme-state/legacy receipt/manifest |

Common checks are exact. Canonical slug matches lowercase ASCII `^[a-z0-9_.-]+/[a-z0-9_.-]+$`; snapshot id matches `^[0-9]{14}-[a-f0-9]{16}$`; UTC/KST/date strings are respectively exact `YYYY-MM-DDTHH:MM:SS.sssZ`, the same instant with `+09:00`, and its `YYYY-MM-DD`. SHA-1/SHA256 checks are described below. Every rank is null or ≥1, each source rank and gain are both null or both nonnull, and at least one source rank exists. Display rank is ≥1 and all source/display ranks are separately gapless. Colors are null or lowercase `#[0-9a-f]{6}`. Selected color/source are both null only when all three source colors are null; otherwise they equal the first nonnull daily→weekly→monthly color and source enum `daily|weekly|monthly`. Head transition enum is `baseline|unchanged|fast_forward|branch_changed|history_rewritten`; baseline alone has previous HEAD null, every other value requires it nonnull, and `unchanged` requires equal HEADs while transitions require the validated relationship. Membership enum is `baseline_present|new|reentered|stayed`.

README/enrichment checks are bidirectional. `readme_status='present'` requires path/blob/content all nonnull and either (a) `translation_status='applicable'` with both translation hashes nonnull and source `translation_applicable=true`, or (b) a locally proven zero-translatable-prose document with `translation_status='not_applicable:no_prose'`, both hashes null and source `translation_applicable=false`. `readme_status='absent'` requires all three README identity fields null, `translation_status='not_applicable:no_readme'`, both translation hashes null and metadata source `translation_applicable=false`. No-prose validation is deterministic from the same Markdown segment extractor; LLM judgment cannot mark it. All snapshot items, including metadata-only summaries, require all three detailed-summary hashes nonnull. `baseline` README events have old tuple null and new tuple matching status; `added`, `removed`, and `changed` require respectively null→nonnull, nonnull→null, and two nonnull unequal identity tuples. Release count is ≥0 and equals the contiguous inventory length. `release_inventory_sha256` hashes the no-LF canonical JSON array ordered by `release_ordinal`, with each element exact `{release_id,metadata_sha256}`; the empty inventory hash is SHA256 of ASCII `[]`. Latest id is null or present in that exact inventory. Estimate collection status is exact `complete_nonempty|complete_empty`, point count is 0..10,000, `complete_empty` iff count=0, and payload hash always names the validated full response; failure has no successful snapshot row.

Enrichment hash preimages are fixed canonical UTF-8 JSON with sorted object keys and compact separators. For README present, the source object is `{kind:"readme",slug,path,blob_sha,content_sha256,model,schema_version,translation_applicable}`; for README absent it is `{kind:"metadata_only",slug,profile_sha256,model,schema_version,translation_applicable:false}`. `summary_source_sha256` hashes that source object without newline. `summary_content_sha256` hashes the exact validated `{goal,usage,pros,cons,fit}` object without newline. `summary_envelope_sha256` hashes the exact tracked `{content:<that object>,source:<that object>}` entry canonical bytes without newline. For applicable translation, `translation_source_sha256` hashes the same README source object and `translation_envelope_sha256` hashes exact tracked `{markdown:<validated translated Markdown>,source:<that object>}` canonical bytes plus one trailing LF. `data/translation-sources.json` must carry the byte-equivalent source object. No rendered HTML enters the envelope or DB preimage. The enrichment index binds each preimage to snapshot id and active-set SHA256; recorder recomputes every hash rather than trusting supplied digest text.

`profile_sha256` is SHA256 of canonical `{slug,display_slug,description,primary_language,topics,license_spdx,archived,is_fork,default_branch,created_at,field_tags,form_tags,tag_rule_version}` using parsed arrays/booleans/integers, not the database JSON text or mutable snapshot counts/times. It excludes `profile_id`, `captured_snapshot_seq` and itself. The recorder and independent validator recompute it; metadata-only summary source must name exactly this hash, so tag-rule or public metadata drift invalidates stale enrichment.

Legacy exact-observation rows also have exact preimages. `legacy_public_star_history` requires `legacy_row_id`, `stars_delta`, and `legacy_source` all null; `source_row_sha256` is SHA256 of canonical `{source,slug,observation_date,stars}`. `legacy_star_observations_db` requires positive `legacy_row_id`, `legacy_source` exact `legacy_inline|github_rest`, nullable integer `stars_delta`, and hashes canonical `{source,legacy_row_id,slug,observation_date,stars,stars_delta,legacy_source}`. The recorder recomputes these hashes from the frozen source and the independent validator proves 168 public rows and every 325 DB row map one-for-one for the reviewed fixture; conflicts remain separate rows.

SHA-1은 length 40, SHA256은 length 64이며 둘 다 `value = lower(value)`와 `value NOT GLOB '*[^0-9a-f]*'`을 동시에 강제한다. `topics_json`은 Unicode code-point lexical order의 중복 없는 string array, parent SHA는 API parent order의 중복 없는 lowercase array, field/form tag는 definition order의 known-id 중복 없는 array다. `field_tags_json`의 `unclassified`는 다른 field와 공존하지 않고 `form_tags_json=[]`는 허용한다. AI truth는 exact `ai-ml` membership뿐이며 `is_ai`, `ai_tag`, `ai_related` column은 schema fingerprint가 거부한다. 모든 JSON은 UTF-8, sorted object keys, compact separators, newline 없음으로 canonicalize한 뒤 hash한다.

Exact indexes는 `idx_snapshot_runs_stats_date_seq(stats_date_kst,snapshot_seq)`, `idx_repository_profiles_slug_captured_seq(slug,captured_snapshot_seq)`, `idx_snapshot_items_slug_seq(slug,snapshot_seq)`, `idx_snapshot_items_seq_membership(snapshot_seq,membership_status)`, source별 nullable rank partial unique 3개, `idx_release_versions_slug_release_first(slug,release_id,first_observed_snapshot_seq)`, `idx_snapshot_release_items_slug_seq(slug,snapshot_seq)`, `idx_historical_star_estimates_slug_date_first(slug,estimate_date,first_observed_snapshot_seq)`, `idx_historical_star_observations_slug_date_source(slug,observation_date,source)`, `idx_commit_events_slug_committed_sha(slug,committed_at,commit_sha)`, `idx_readme_change_events_slug_seq(slug,snapshot_seq)`, `idx_repository_insights_slug_seq(slug,snapshot_seq)`다. Source/display ranks의 gapless `1..N`, release count/hash/latest id, enrichment hash join, artifact set equality는 transaction validator가 검증한다.

모든 immutable table에는 UPDATE·DELETE 거부 trigger와 natural-key conflicting INSERT 거부가 있다. Writer는 먼저 existing row를 읽고 canonical-equivalent면 새 INSERT 없이 재사용하며 한 field라도 다르면 실패한다. `INSERT OR REPLACE`와 `INSERT OR IGNORE`는 source/test가 거부한다. 같은 snapshot id와 core/artifact/enrichment hash가 모두 같을 때만 verified no-op이고 하나라도 다르면 실패한다. 다른 snapshot id는 visible data가 같아도 append한다.

`core_payload_sha256`는 자기 자신과 이후 파생되는 `repository_insights`/`artifact_hashes`만 제외한다. Preimage는 schema fingerprint, hash field를 제외한 `snapshot_runs` input identity, 그리고 그 snapshot이 새로 추가하거나 exact natural key로 참조한 `baseline_sources`, `baseline_membership_slugs`, `repository_profiles`, `snapshot_items`(모든 enrichment hash 포함), `release_versions`, `snapshot_release_items`, `historical_star_estimates`, `historical_star_observations`, `commit_events`, `readme_change_events`의 전체 logical rows를 table name→natural-key 순으로 canonical JSON 배열화한 object다. Migration baseline은 세 baseline source와 모든 imported static rows를 포함하고, refresh는 이번 snapshot이 참조한 기존 profile/release version도 그 실제 canonical row로 포함한다. `parent_chain_sha256`는 정확히 parent run의 `chain_sha256`; `chain_sha256`는 canonical `{schema_fingerprint_sha256,parent_chain_sha256,core_payload_sha256,snapshot_id,snapshot_seq}` SHA256다. Candidate writer와 독립 verifier가 같은 preimage를 각각 재계산한다.

### 6.4 release·commit 수집 경계

release는 최초 baseline과 이후 모든 성공 snapshot에서 public release metadata를 page 끝까지 수집한다. 저장 항목은 id, tag, name, target, draft/prerelease, created/published time, HTML URL, metadata hash다. `metadata_sha256` hashes the no-LF canonical `{slug,release_id,tag_name,name,target_commitish,draft,prerelease,created_at,published_at,html_url}` using normalized DB values; it excludes first-observed sequence and itself. body·assets는 collector allowlist에 들어오지 않는다. `Link rel=next`의 HTTPS origin/path/query와 page 단조 증가를 검증하고 release id 중복·20-page cap 초과는 truncate하지 않고 실패한다. 첫 pass의 방문 page URL·ETag·ordered id/metadata-hash·next identity를 모두 보존하고, 모든 page를 같은 URL로 conditional revalidation한다. 강한 ETag가 있으면 304를 요구하고, 없으면 두 번째 full body의 identity를 요구한다. page 1만 같은 중간-page mutation도 실패한다. REST pagination이 완전한 point-in-time snapshot을 보장하지 않는 한계는 남는다.

공식 `/releases/latest`를 별도로 읽어 nullable `latest_release_id`로 snapshot에 연결하고, non-null이면 완주한 inventory에 같은 id/version이 있어야 한다. 공식 404는 stable release 없음이며 prerelease-only inventory와 구분한다. `snapshot_items.release_count`와 ordered inventory SHA256가 `snapshot_release_items` row count/ordinal/hash와 일치해야 하므로 정상 0건과 누락을 구분한다. 동일 release id의 metadata hash가 바뀌면 새 version row를 추가하며 A→B→A는 세 snapshot inventory가 원래 두 version을 참조한다.

commit은 과거 전체를 backfill하지 않는다. 첫 관측의 default branch HEAD를 `baseline`으로 기록하고 HEAD가 같으면 `unchanged`, 이후 관측 사이의 commit을 overlap pagination으로 수집해 SHA로 dedupe한다. 저장값은 SHA, first-observed ordinal, branch, authored/committed time, nullable public author login, parent SHA array, HTML URL뿐이며 message/subject·name/email·files·patch는 저장하지 않는다. parent 연결이 직전 HEAD와 이어지지 않으면 allowlisted compare/ref endpoint의 exact status mapping으로 force-push, branch change, API gap을 구분해 명시적으로 기록하거나 실행을 실패시키며 commit 누락을 정상으로 처리하지 않는다.

event collection은 repository 최대 75, release repository별 20 page의 2-pass 검증, commit repository별 20 page, continuity compare/ref 최대 2 logical request를 허용한다. run 전체는 canonical fact와 OSS Insight 요청을 포함해 logical request 3,600, 실제 HTTP attempt 4,500을 넘지 않는다. retry는 timeout·429·5xx에만 최대 3 attempts, 2s/8s bounded delay이며 모든 attempt가 4,500에 포함된다. request timeout은 30초다. 숫자형 runtime override는 금지한다.

Build job의 `timeout-minutes`는 120이지만 내부 절대 clock은 첫 executable step에서 한 번 고정한다. 그 step이 checkout보다 먼저 `JOB_BUDGET_ORIGIN_EPOCH_MS`와 `JOB_HARD_DEADLINE_EPOCH_MS = origin + 115분`을 기록하여 runner/job 시작 overhead용 5분을 남긴다. Checkout, setup, canonical facts와 events는 모두 절대 `EVENT_DEADLINE = origin + 15분` 안에 끝나야 한다. Enrichment deadline은 event 성공 순간 한 번 `min(event_success + 70분, hard_deadline - 30분)`으로 고정한다. 따라서 DB/검증/commit에는 내부 hard deadline 전 최소 30분이 남고 workflow timeout까지 추가 5분 teardown cushion이 있다. 모든 request/retry/sleep admission은 같은 monotonic-derived remaining budget을 사용한다. Event request admission reserve는 exact 5초이며, 30초 attempt는 최소 35초가 남을 때만 시작하고 retry sleep은 delay+35초가 남을 때만 허용한다. LLM reserve는 exact 30초이며, 60초 attempt는 최소 90초가 남을 때만 시작하고 retry sleep은 delay+90초가 남을 때만 허용한다. cap/deadline 초과는 partial inventory를 게시하지 않으며 event 단계면 LLM fetch 0으로 실패한다. Tests freeze the clock and prove late checkout, transition overhead, retry delay and clock-wall changes cannot reset a phase deadline. 2026-08-28 read-only GraphQL preflight에서 current 41 repos는 release 70 pages total, max 10 pages/1,000 releases, 1-page 초과 8 repos였다.

OSS Insight는 active repository의 전체 반환 series를 매 성공 후보에서 다시 검증한다. API `source_payload_sha256`는 그 repository/run의 validated full response canonical bytes provenance이고 row identity가 아니다. Baseline `legacy_star_history_cache`의 모든 row는 immutable `data/legacy-public-star-history.json` exact file bytes의 SHA256을 `source_payload_sha256`로 사용하며, 이 값은 `baseline_sources.source_name='legacy_public_star_history'`의 `file_sha256`와 반드시 같다. 각 date version의 `point_sha256`는 canonical `{slug,date,is_present,stars}` hash다. Baseline `star-history.json.estimated`는 `legacy_star_history_cache`, `is_present=1`; 이후 API는 `ossinsight_api`다. API source별로 target snapshot 이전의 가장 큰 `first_observed_snapshot_seq`를 date별 previous version으로 본다. 새 date/value change는 present row, prior-present date가 full response에서 사라지면 `is_present=0,stars=null` tombstone, 재등장은 present row를 append한다. 값이 A→B→removed→A면 네 sequence가 남는다. Target display는 date별 latest API version이 present일 때만 사용하고, latest API tombstone이면 그 date를 생략하며, API version이 한 번도 없을 때만 legacy cache row를 사용한다. Exact GitHub observations와는 결합·대체하지 않는다. Tests replace one legacy row's payload hash with its per-repository series hash and must reject it.

OSS endpoint는 exact `GET https://api.ossinsight.io/v1/repos/{owner}/{repo}/stargazers/history`이며 owner/repo path segment는 validated ASCII slug를 `encodeURIComponent`로 각각 인코딩한다. Query, redirect, 다른 origin/path는 거부한다. `Accept: application/json`, status 200, JSON-compatible content type, body ≤2 MiB를 요구한다. Top-level keys는 exact `data,type` with `type='sql_endpoint'`; `data` keys are exact `columns,result,rows`. `columns` is exactly the two ordered objects `{col:'date',data_type:'VARCHAR',nullable:true}` and `{col:'stargazers',data_type:'DECIMAL',nullable:true}`. `result` keys are exact `code,message,start_ms,end_ms,latency,row_count,row_affect,limit`; require code 200, message string, nonnegative numeric start/end with end≥start, latency string, row_count equal rows length, row_affect 0, and integer limit≥row_count. Every row keys are exact `date,stargazers`; despite upstream nullable/DECIMAL metadata, successful stored values are only a nonnegative JavaScript safe integer number or an ASCII string matching exact `^(0|[1-9][0-9]*)$` whose parsed value is also ≤`Number.MAX_SAFE_INTEGER`. Both forms normalize to the same INTEGER before point hashing/storage. Fractional, signed, whitespace-padded, leading-zero, exponent, unsafe-range and null values fail rather than round/coerce. Normalized stored rows are unique ascending date maximum 10,000. Public chart payload만 latest 500 estimates로 제한하고 DB의 유효 과거 points는 자르지 않는다. 10,001개 이상, duplicate/conflicting date, unknown key, malformed columns/result/row는 slice/coerce하지 않고 실패한다. OSS도 30초 timeout, 최대 3 attempts, 2s/8s delay, global logical/attempt/absolute event deadline을 공유한다. 어느 active repository든 terminal failure면 prior estimate를 stale carry-forward해 성공시키지 않고 전체 candidate를 LLM fetch 0으로 중단한다. 따라서 successful snapshot의 `estimate_collection_status`/payload hash/count가 정상 0건과 미수집을 구분한다. 2026-08-28 read-only current-set preflight는 41/41 status 200, exact envelope shape 41/41, total 643 rows, per-repo max 126, response max 5,807 bytes였고 paid/API secret 사용은 0이었다.

Cutover exact-observation display precedence도 고정한다. `data/legacy-public-star-history.json`은 cutover 직전 `star-history.json`의 immutable canonical copy다. 그 `observed` 168-point series는 cutover 전 primary public series로 의미상 동일하게 유지한다. `data/star-observations.sqlite`의 모든 exact rows는 별도 `legacy_star_observations_db` provenance로 보존하고 충돌을 덮지 않지만, 기존 public point가 없는 날짜의 auxiliary/internal series로만 노출한다. Cutover 이후 primary exact series는 target snapshot까지 finalized된 KST daily close이며, 같은 date에서는 post-cutover finalized close가 legacy public point보다 우선한다; provisional current-day point는 별도 provisional marker라 finalized legacy point를 과거 값으로 덮지 않는다. Estimate series는 항상 별도다.

`data/trending-membership.sqlite`의 hash-pinned 7 legacy snapshots와 287 member rows는 새 DB로 fabricated backfill하지 않는다. Membership/rank history deriver는 매번 `baseline_sources` identity와 frozen DB의 schema/logical hash를 재검증한 뒤 legacy `(generated_at,stats_date,ordinal,slug,slug_set_sha256)` timeline을 provenance `legacy_snapshot`으로 새 DB timeline 앞에 union한다. 첫 legacy snapshot은 `legacy_observed`로 표시하고 consecutive legacy rows에서 계산 가능한 stay/entry/exit만 legacy transition으로 표시한다. Cutover `migration_baseline`의 current rows는 모두 `baseline_present`이며 boundary를 new/reentered/exit로 추측하지 않는다. `membership-status.json`, membership-history UI input and historical Atom derivation preserve the exact 7/287 identities and ordinals; future new-DB events follow after that boundary.

### 6.4.1 daily close와 velocity

2시간 원시 `snapshot_items`가 정본이다. `(slug, stats_date_kst)`별 가장 큰 snapshot sequence를 그 날짜의 마지막 성공 관측으로 파생한다. 더 늦은 KST 날짜의 성공 snapshot이 하나라도 있을 때만 이전 날짜를 `finalized`로 표시하고 현재 날짜는 `provisional`이다. repository가 중간에 이탈한 날짜의 값은 자정 값이 아니라 그날 마지막 관측값임을 표시한다.

`velocity_7d(D) = (close(D) - close(D-7)) / 7`, `velocity_30d(D) = (close(D) - close(D-30)) / 30`이다. `acceleration_7d(D) = velocity_7d(D) - ((close(D-7)-close(D-14))/7)`, `acceleration_30d(D) = velocity_30d(D) - ((close(D-30)-close(D-60))/30)`이다. 각 식의 모든 endpoint가 exact finalized date여야 하며 하나라도 없으면 null이고 가장 가까운 날짜로 보간하지 않는다. `stars_delta_since_previous_observation = current.stars - previous.stars`. `observation_gap_milliseconds` is the exact difference between parsed UTC instants; gap이 정확히 `7,200,000`일 때만 UI가 이를 2시간 변화로 표현한다. `display_rank_delta = previous.display_rank - current.display_rank`, so positive means improvement. Each source rank delta uses the same previous-minus-current sign only when both ranks are nonnull; otherwise that source delta is null. First observation has previous reference, gap and all deltas null. `insight_rule_version` is exact `repository-insight-v1`; `insight_sha256` hashes no-LF canonical `{snapshot_seq,slug,previous_observed_snapshot_seq,observation_gap_milliseconds,stars_delta_since_previous_observation,display_rank_delta,rank_daily_delta,rank_weekly_delta,rank_monthly_delta,insight_rule_version}` and excludes itself.

### 6.5 append-only와 전체 파일 교체 방어

SQLite trigger로 UPDATE/DELETE를 거부하는 것 외에 다음 검증을 적용한다.

1. last-good DB의 외부 SHA256, size, last snapshot sequence와 table별 PK순 canonical row count/hash를 읽는다.
2. runner temp에 복제한다.
3. 새 snapshot을 transaction으로 추가한다.
4. `PRAGMA foreign_key_check`, `integrity_check`를 실행한다.
5. parent DB의 모든 table natural key와 canonical row hash를 PK순으로 열거하고, candidate에서 같은 key를 직접 재조회해 count/hash와 각 row가 완전히 같은지 비교한다. static baseline table도 제외하지 않는다. SQLite byte/page prefix나 table별로 다른 sequence selector는 검증 근거로 사용하지 않는다.
6. 새 snapshot sequence가 parent+1인지, 같은 parent의 child가 하나뿐인지, `parent_snapshot_id`와 snapshot hash chain이 일치하는지 검증한다.
7. 후보 row count와 expected repository count를 대조한다.
8. 검증된 후보만 tracked DB로 승격한다.

과거 DB 복사본으로 파일 전체를 교체해 최신 history가 사라지는 경우도 parent file identity, logical-row prefix와 sequence 불일치로 차단한다. DB를 닫고 sidecar 부재를 확인한 뒤 계산한 최종 DB SHA256/size는 DB 내부가 아니라 외부 workflow receipt에만 기록한다. `artifact_hashes`에는 public Pages allowlist만 들어가며 `data/repository-observations.sqlite`와 deploy manifest 자체는 절대 넣지 않는다.

## 7. UI와 interaction 설계

UI는 `impeccable`의 정보 구조·접근성 바닥과 `apple-design`의 motion·material·typography 원칙을 함께 적용한다. `frontend-design`은 사용하지 않는다.

### 7.1 상세 tooltip 단일화

desktop과 mobile은 같은 canonical detailed content를 사용한다. 차이는 내용이 아니라 container뿐이다.

- desktop: card에 anchored된 floating tooltip
- mobile: 읽기 쉬운 bottom sheet
- 표시 순서: 목표 → 실행 방법 → 장점 → 단점·주의점 → 어울리는 상황 → deterministic trend note → README/숨김 action
- mobile 첫 tap: 상세 열기
- 같은 card의 두 번째 tap: GitHub repository로 이동
- README, 즐겨찾기, 숨김 등 명시적 control tap은 각 control 동작만 수행
- outside tap과 Escape: 상세 닫기

mobile용 compact content와 `detailed` boolean branch를 제거한다.

### 7.2 sidebar 정보 구조

sidebar title은 `대시보드 메뉴`로 바꾼다. 위에서 아래 순서는 다음과 같다.

1. 갱신 정보
2. 계정·로그인
3. 전체·즐겨찾기 보기
4. 기간
5. 언어
6. 분야
7. 형태
8. 정렬
9. 결과 수·필터 초기화
10. 숨긴 저장소
11. 최근 이탈
12. 내보내기

`AI 분야 제외`와 `신규 저장소만`은 분야 선택보다 먼저 보이는 빠른 필터 한 묶음으로 둔다.

갱신 정보는 정확히 세 줄이다.

1. 최근 갱신 시각
2. 다음 갱신 시각
3. `2시간마다 갱신`

`서울 기준 홀수 시 07분` 표현은 제거한다. 다음 갱신은 현재 production snapshot과 schedule에서 계산한 실제 시각을 표시한다.

### 7.3 desktop rail

fine pointer desktop에서만 왼쪽 전체 높이 `100dvh` rail을 표시한다.

- 기존 돌출 폭은 유지한다.
- page background와 식별되는 accent를 사용한다.
- rail 또는 열린 sidebar로 pointer가 들어오면 non-modal hover open
- pointer가 둘 다 벗어나면 약 180ms intent delay 후 close
- hover open은 focus를 빼앗거나 scrim, inert, scroll lock을 적용하지 않는다.
- click 또는 keyboard로 연 경우에는 modal fallback으로 동작하고 focus trap, focus restore, Escape, scrim을 적용한다.

hover와 click state를 하나의 boolean으로 섞지 않고 open reason을 구분해 modality를 결정한다.

### 7.4 mobile gesture

coarse pointer/mobile에서는 desktop rail과 hamburger button을 표시하지 않는다.

- 화면 왼쪽 24px 안에서 touch 시작
- 오른쪽 이동 48px을 넘으면 open commit
- vertical movement가 우세하면 gesture 취소
- drag 중 sidebar transform이 손가락을 따라감
- 열린 sidebar를 왼쪽으로 swipe하면 close
- close button, scrim, Escape도 유지
- card/link/control의 정상 tap과 browser back gesture 충돌을 최소화

gesture 판정은 passive scroll을 불필요하게 막지 않고, 실제 horizontal intent가 확인된 뒤에만 기본 동작을 제한한다.

### 7.5 motion과 접근성

- sidebar open 260ms, close 210ms
- tooltip/bottom sheet 160ms
- drag 중 transition 없음, release 후 남은 거리만 easing
- transform과 opacity 중심으로 layout thrashing 방지
- `prefers-reduced-motion: reduce`에서는 이동 animation을 제거하고 즉시 상태 전환
- light/dark에서 contrast와 focus ring 유지
- 390, 720, 1200, 1440px 실제 browser 검증
- mouse, touch emulation, keyboard-only, reduced-motion을 각각 검증

### 7.6 신규 저장소만 필터

`AI 분야 제외` 옆에 `신규 저장소만` native checkbox를 추가하고 두 항목을 하나의 `fieldset` 빠른 필터로 묶는다. 일반 sidebar에서는 같은 행, 390px·200% zoom처럼 폭이 부족하면 한 열로 자연스럽게 wrap하며 label 전체 hit target은 최소 44px이다.

URL canonical key는 `membership=new` 하나다. 기본값은 `newOnly:false`이고 exact 값만 true로 읽으며 true일 때만 serialize한다. 의미는 현재 확정 snapshot에서 membership status가 exact `new`인 repository만 표시하는 것이다. `reentered`, `stayed`, `baseline_present`는 제외하고 첫 baseline은 0건이 정상이다. 검색·언어·분야·형태·AI 제외·즐겨찾기와는 AND로 결합하며 선택 기간은 membership 의미를 바꾸지 않는다. active filter count, summary, 초기화, popstate, current-view 공유 URL에 포함한다.

membership join이 아직 끝나지 않았으면 전체 repository를 잠깐 보여 주지 않고 결과 영역을 loading 상태로 둔다. load/schema 실패 시 필터를 조용히 무시하지 않고 0건과 `신규 상태를 불러오지 못해 필터를 적용할 수 없습니다.`를 표시한다. export에는 개인 상태가 아니라 공개 row의 canonical `membership_status`만 허용한다.

### 7.7 카드 분류 배지와 데이터 정본

기존 신규·재진입·연속·HOT 신호와 별도로 카드에 `저장소 분류` list를 두고 **형태 → 분야·기술 → AI** 순으로 표시한다.

- 형태: canonical `form_tags`의 모든 값
- 분야·기술: canonical `field_tags`의 모든 값 중 `ai-ml` 제외
- AI: `field_tags`에 `ai-ml`이 있을 때 정확히 한 개, 아니면 없음
- `unclassified`는 숨기지 않고 `미분류`로 표시

분류 truth는 수집 단계 `classifyRepository` 결과뿐이다. client는 slug, description, topic, LLM summary를 regex로 다시 분류하지 않는다. AI 제외 filter와 AI badge는 모두 `field_tags.includes("ai-ml")`에서 파생하며 별도 `is_ai` fact는 저장하지 않는다.

`repository_profiles`에는 canonical JSON `field_tags`, `form_tags`, `tag_rule_version`을 NOT NULL로 저장하고 profile fact hash에 포함한다. 배열은 definition order, 중복 없음, known id만 허용하며 `unclassified`는 다른 field id와 공존하지 않는다. metadata가 같아도 rule version이나 결과가 달라지면 append-only 새 profile version이다. `snapshot_items`는 그 version을 참조하고 `index.html` REPOS와 `data/latest.json`은 세 값을 손실 없이 전달한다. candidate validator는 missing, unknown, duplicate, noncanonical order, version mismatch를 publication 전에 실패시킨다.

배지는 축약하거나 `+N`으로 감추지 않고 모두 wrap한다. chip은 `max-width:100%`와 safe wrapping으로 수평 overflow를 만들지 않는다. 세 종류는 색만으로 구분하지 않고 visible label과 screen-reader prefix `형태:`, `분야·기술:`, `AI 관련:`를 제공한다. badge별 animation은 두지 않고 card 출현·재배치 같은 의미 있는 container feedback만 사용한다.

### 7.8 scroll-to-top

우측 하단에 `<button type="button" aria-label="페이지 맨 위로 이동">`을 fixed control로 추가한다. `scrollY > innerHeight`일 때만 접근성 tree와 tab order에 나타나고 resize·orientation 뒤 임계를 다시 계산한다. hit target은 최소 48px이며 right/bottom은 safe-area를 포함해 16–20px, undo bar가 보이면 그 높이와 간격만큼 위로 이동한다. sidebar나 README overlay가 main을 inert로 만들 때 이 button도 함께 inert다.

passive scroll listener와 `requestAnimationFrame` 한 번으로 visibility를 갱신한다. click과 native Enter/Space는 같은 동작이며 filter·sort·favorite 상태를 바꾸지 않는다. normal motion은 opacity와 8px translate의 160–200ms overshoot 없는 전환 후 smooth scroll, `prefers-reduced-motion:reduce`는 translate와 smooth scroll 없이 즉시 top으로 이동한다.

mobile edge gesture는 interactive target(`button`, `a`, `input`, `select`, `textarea`, `[role=button]`)에서 시작하지 않고 horizontal intent 확정 전 vertical scroll을 막지 않는다. 우하단 button은 왼쪽 24px open edge와 겹치지 않는다.

### 7.9 title surface

`.title-box`는 border, backdrop filter, shadow를 제거하고 background를 body와 같은 `var(--bg)`로 맞춘다. padding, typography, title reset의 `:focus-visible` ring은 유지한다. light/dark 모두 computed background가 body와 같아 별도 card seam이 없어야 한다.

## 8. 로그인 유지 설계

### 8.1 정책

같은 browser와 같은 Pages origin에서는 refresh, new tab, browser close/reopen 뒤에도 사용자가 명시적으로 logout할 때까지 Firebase 인증을 유지한다. private mode, site data 삭제, local storage 차단 환경에서 유지된다고 표시하지 않는다. 다른 browser·device 간 auth session 공유는 범위가 아니다.

### 8.2 persistence 선택

현재 `getAuth(app)` 흐름을 유지하고 `await setPersistence(auth, browserLocalPersistence)`를 명시한다. `initializeAuth()`로 popup resolver와 persistence dependency 전체를 재조립하는 방식은 현재 요구보다 복잡해 제외한다.

초기화 순서는 다음과 같다.

1. Firebase App
2. App Check
3. Auth와 Firestore
4. local persistence 설정 완료
5. favorite cloud controller
6. `onAuthStateChanged`
7. auth UI 활성화

persistence 완료 전에는 login button과 popup을 활성화하지 않는다. persistence 설정 실패 시 session/memory auth로 조용히 낮추지 않고 guest controller를 유지하며 `이 브라우저에서 로그인 상태를 저장할 수 없어 브라우저 저장으로 사용합니다.`를 표시한다.

Firestore sync 실패와 auth session 실패는 분리한다. 계정 sync가 잠시 실패해도 임의 logout하지 않고 로그인 상태와 복구 가능한 오류를 함께 표시한다.

### 8.3 BFCache lifecycle

현재 무조건적인 `pagehide` dispose를 다음으로 바꾼다.

- `pagehide.persisted == true`: observer와 controller 유지
- `pagehide.persisted == false`: observer와 Firestore subscription dispose
- `pageshow.persisted == true`: 현재 auth와 controller state로 controls 재동기화
- lifecycle start/dispose는 idempotent하게 만들어 listener 중복을 막음

### 8.4 사용자 데이터 경계

- guest favorites와 account favorites는 계속 분리한다.
- 최초 login에서만 guest와 remote를 union한다.
- logout은 cloud subscription을 끊고 guest 목록으로 돌아간다.
- account favorites를 guest에 복사하지 않는다.
- account switch 중 이전 async 응답이 새 account state를 덮지 못하게 generation gate를 유지한다.
- UID, Firebase storage key, auth token은 URL·CSV·JSON export에 포함하지 않는다.

## 9. 보안 설계

Codex Security는 Plans 1~4 구현과 전체 로컬 기능 검증이 끝난 정확한 immutable candidate commit SHA를 대상으로 한다. 차단 finding을 모두 수정·재검증한 뒤에만 workflow를 활성화하고 단 한 번의 production 실행·Pages 검증으로 넘어간다.

### 9.1 보호 자산과 신뢰 경계

| 경계 | 보호 자산 | 현실적인 공격 입력 |
|---|---|---|
| GitHub Actions | `GITHUB_TOKEN`, Anthropic key, Pages 권한 | public README, metadata, workflow trigger |
| LLM pipeline | publication integrity, API cost | prompt injection, malformed/truncated output |
| browser UI | same-origin page와 사용자 동작 | URL state, repository text, translated HTML |
| Firebase | auth session, UID별 favorites | authenticated document writes, cross-tab lifecycle |
| data/deploy | append-only history, exact artifact SHA | stale DB, mixed artifacts, non-FF remote update |

공개 repository owner는 README·description·topic·release·commit text를 통제할 수 있지만 workflow secret이나 operator account를 이미 가진 것으로 가정하지 않는다. 위협 가설과 검증된 finding을 분리한다.

### 9.2 불변식

- public repository content는 data이며 command, path, shell, secret recipient를 바꾸지 못한다.
- LLM output은 untrusted text로 처리하고 DOM에 실행 가능한 HTML로 직접 넣지 않는다.
- workflow secret은 prompt body, log, JSON, SQLite, Pages artifact에 들어가지 않는다.
- production secret을 쓰는 publication은 untrusted pull request에서 실행되지 않는다.
- Actions permission은 job별 최소 범위이며 third-party action은 가능한 immutable SHA로 고정한다.
- Firestore Rules가 `request.auth.uid == {uid}`와 schema/size 제한을 강제한다.
- App Check를 Authentication과 Rules의 대체물로 취급하지 않는다.
- CSV는 leading formula injection과 quoting/newline을 방어한다.
- DB는 부모 history의 정확한 연장일 때만 게시한다.
- manifest SHA와 snapshot이 test·push·deploy한 대상과 같아야 한다.

### 9.3 Codex Security 절차

1. repository inventory와 적용되는 `SECURITY.md`/정책 확인
2. 실제 source evidence 기반 threat model
3. fresh-context 독립 architecture review 위임
4. repository-wide deep security scan
5. candidate별 reachability, privilege gain, impact 검증
6. 성립하는 finding의 attack-path 분석과 severity 판정
7. finding별 RED test와 최소 fix
8. fix diff security scan
9. 원래 finding validation
10. full rescan과 staged secret scan

Critical·High는 완료를 차단한다. auth isolation, secret, publication integrity, history loss와 관련된 Medium도 차단한다. source evidence와 실제 attack path가 없는 hardening 제안은 vulnerability와 구분한다. 빈 findings는 해당 SHA와 검토 범위 안에서 reportable finding을 찾지 못했다는 뜻으로만 보고한다.

## 10. 오류 처리 계약

| 상황 | 처리 |
|---|---|
| Trending HTML 구조 이탈 | candidate 실패, last-good 유지 |
| GitHub 429/5xx/timeout | bounded retry 후 candidate 실패 |
| canonical README 없음 | metadata-only summary, translation N/A |
| README fetch 장애 | candidate 실패 |
| Anthropic key 누락 | candidate 실패 |
| LLM truncation/application schema 위반 | 즉시 candidate 실패, 해당 유료 attempt의 input/output reservation은 unresolved usage로 유지하고 retry하지 않음 |
| release 없음 | 정상 빈 release state |
| commit continuity 불명 | gap/branch change를 증명하지 못하면 candidate 실패 |
| DB prefix/hash chain 불일치 | candidate 실패 |
| origin/main 전진 | push하지 않고 candidate 실패 |
| Pages deploy 실패 | workflow 실패, 이전 production 유지 |
| production manifest 불일치 | workflow 실패와 운영 경고, 완료로 판정하지 않음 |
| Firebase persistence 불가 | guest 유지, 로그인 유지 불가를 명시 |
| Firestore sync 실패 | auth 유지, account sync 오류 표시 |

## 11. 테스트와 의도적 변이

모든 변경 단위는 RED → 최소 구현 → 관련 test → 전체 test → mutation → browser/workflow 검증 순서를 따른다.

### 11.1 workflow/data mutation

- 저장소별 LLM 오류를 catch 후 exit 0으로 바꾸면 test 실패
- `stop_reason` 검사를 제거하면 test 실패
- Atom producer의 `desc`를 consumer가 다른 이름으로 읽으면 integration test 실패
- 실행 중 날짜를 다시 계산하면 KST midnight test 실패
- stale metadata에 새 stats date를 붙이면 freshness test 실패
- unchanged snapshot 기록을 생략하면 DB test 실패
- legacy DB로 후보 DB를 교체하면 prefix/hash-chain test 실패
- deployment manifest SHA를 바꾸면 production probe test 실패

### 11.2 UI/auth mutation

- mobile compact branch가 다시 생기면 schema/UI test 실패
- hover open이 focus를 이동하면 accessibility test 실패
- mobile edge 조건을 제거하면 gesture conflict test 실패
- reduced-motion에서 transform animation이 남으면 test 실패
- client가 summary/description regex로 AI·분야·형태를 다시 분류하면 canonical-tag test 실패
- `newOnly`가 baseline, stayed, reentered를 포함하거나 membership loading 중 전체 결과를 먼저 그리면 filter test 실패
- 분류 배지가 canonical 전체 배열을 축약·누락·재정렬하거나 390px·200% zoom에서 수평 overflow를 만들면 UI test 실패
- scroll-to-top이 첫 viewport 안에서 focusable하거나 reduced-motion에서 smooth scroll을 쓰거나 undo·overlay와 겹치면 interaction test 실패
- title surface가 light/dark 중 하나에서 body와 다른 background, border, backdrop, shadow를 가지면 style test 실패
- persistence 설정보다 observer/login이 먼저 실행되면 auth test 실패
- BFCache pagehide에서 controller를 dispose하면 lifecycle test 실패
- logout 후 account favorites가 guest에 남으면 isolation test 실패
- account generation gate를 제거하면 race test 실패

### 11.3 실제 표본

합성 fixture 외에 현재 활성 repository에서 다음 표본을 확인한다.

- 긴 README와 표·code fence·상대 링크가 있는 README
- README가 다른 확장자·경로·대소문자를 쓰는 repository
- release가 없는 repository와 release가 많은 repository
- fallback/placeholder였던 summary
- 동일 repository가 여러 Trending period에 있는 경우
- new, reentered, stayed, exited 상태

## 12. 최종 acceptance matrix

| 영역 | 완료 기준 |
|---|---|
| workflow | schedule/manual 동일 경로, 신규 repo, key 누락, LLM/API 실패, midnight, no-change, concurrency, non-FF, Pages 실패 검증 |
| data | 모든 displayed field, source/display ranks, exact 2h snapshots, releases, future commits, README body 미보관, DB continuity |
| LLM | 활성 repo detailed summary 100%, compact field 0, placeholder/fallback 0, translation blob SHA 일치 |
| Atom/export | nonempty Atom summary, XML escaping, CSV formula/quote/newline, JSON field 제한, Blob URL revoke, clipboard failure |
| UI | 390/720/1200/1440과 200% zoom, mouse/touch/keyboard, light/dark/reduced-motion, hover rail, edge swipe, second-tap navigation, exact 신규 filter, canonical 전체 분류 배지, scroll-to-top, title/background 일치 |
| auth | refresh, new tab, browser restart, BFCache, cross-tab logout, guest/account isolation, storage denial, sync failure |
| security | malicious README/DOM/path/shell fixtures, Actions permission, Rules emulator, App Check failure, secret scan |
| production | exact commit manifest, snapshot/file hashes, HTML·JSON·Atom 일치, live browser verification |

Firestore Rules는 기본 test의 skip으로 끝내지 않는다. emulator를 실제로 실행해 Rules test가 skip 없이 pass한 종료 코드를 별도로 확보한다. 실제 Google OAuth와 browser restart 검증은 사용자가 account 선택·동의를 한 번 수행한 뒤 production에서 확인한다. 자동화가 사용자 credential을 입력·출력·저장하지 않는다.

## 13. 구현과 배포 단위

각 단위는 전체 local 검증, staged secret scan, 분리 commit·push까지 끝낸 후 다음으로 넘어간다. 최신 사용자 지시에 따라 paid bootstrap과 새 Pages·production 확인은 1~5단위 및 repository-wide security/functional gate가 모두 끝난 뒤 단 한 번의 통합 workflow로 수행한다. 그전에는 checked-in workflow를 `bootstrap_v0_pending_approval`로 유지하고 plan-only/fake-provider 검증만 수행한다.

1. transactional workflow, LLM summary/translation, Atom/date/Pages gates
2. `repository-observations.sqlite`, release baseline, prospective commit timeline, insight derivatives
3. canonical detailed tooltip, sidebar information architecture, desktop rail, mobile gesture와 motion, 신규 저장소 filter, canonical 형태·분야/기술·AI 배지, scroll-to-top, title surface 정리
4. explicit auth persistence와 BFCache lifecycle
5. Codex Security findings와 fixes
6. repository-wide functional/workflow/production acceptance

push 직전마다 `git fetch`와 remote diff를 다시 확인한다. bot 갱신만 확인된 clean worktree에서만 fast-forward한다. force push, history rewrite, broad reset은 하지 않는다.

## 14. 문서와 종료 조건

최종 구현과 로컬 acceptance가 확보되면 README 한국어·영어를 실제 구현 계약과 동기화하고 그 docs-inclusive SHA를 다시 보안 scan한 뒤 최초 production workflow를 실행한다. production 뒤 새 tracked edit·commit·push는 만들지 않는다. 검증된 bot child를 가져오는 `git fetch`와 `git merge --ff-only` local synchronization만 허용하며, OFA에는 `D:\OFA\OFA\00_원천` 아래 실제 run 결과와 바뀐 결정을 기록한다. 더청춘 vault와 OFA 파생 `wiki`에는 쓰지 않는다.

다음을 모두 만족해야 완료다.

- real workflow run과 explicit Pages deploy 성공
- production manifest의 exact commit·snapshot·hash 일치
- 활성 repository 전체 summary·translation contract 충족
- 신규 observation DB와 파생물 무결성
- UI·gesture·accessibility 실제 browser 검증
- production Google 로그인 유지 검증
- 차단 Codex Security finding 0
- Node·Python·Firestore Rules 전체 test 통과
- README 한·영 동기화와 OFA 실제 결과 갱신
- clean `HEAD == origin/main`

완료 후에는 다음 확장 기능을 자동으로 시작하지 않는다. 결과와 남은 비차단 불확실성을 보고하고 사용자와 함께 다음 후보를 고르는 지점에서 멈춘다.

## 15. 선택한 것, 버린 것, 뒤집는 조건

### 선택한 것

- silent fallback보다 last-good을 지키는 fail-closed publication
- legacy DB 변경보다 신규 exact 2-hour observation DB
- summary/detail 이중 계약보다 canonical detailed summary 하나
- README body archive보다 current/previous immutable identity와 body 없는 change event
- 암묵적 Firebase default보다 명시적 local persistence
- legacy Pages trigger보다 동일 workflow의 explicit deploy와 production readback
- summary와 translation의 freshness·재사용은 독립적으로 유지하되, 둘 다 필요한 경우 16,000-token 계산 상한 안의 첫 translation chunk만 detailed summary와 결합

### 버린 것

- LLM 실패를 deterministic placeholder로 덮고 계속 게시하는 방식
- summary와 full translation을 항상 한 JSON 응답에 넣어 두 component의 freshness·검증·재사용을 결합하는 방식. 두 component는 독립적으로 계획하되, 둘 다 필요한 경우에만 첫 bounded translation chunk와 summary를 한 응답에서 각각 검증한다.
- 과거 commit 전체 backfill
- mobile hamburger와 화면 전체 시작 swipe
- hover sidebar를 modal로 취급해 매번 focus/inert/scrim을 적용하는 방식
- persistence 실패를 session/memory login으로 조용히 낮추는 방식

### 뒤집는 조건

- GitHub가 공식 Trending API를 제공하면 HTML scraper를 교체한다.
- GitHub가 exact public historical star events를 제공하면 자체 관측 이전 구간의 출처를 재평가한다.
- Anthropic structured output 또는 translation 계약이 운영 비용·성공률 기준을 지속적으로 충족하지 못하면 provider 변경을 별도 결정으로 검토한다. silent fallback으로 되돌리지는 않는다.
- static Pages에서 요구 기능을 안전하게 유지할 수 없다는 실제 증거가 생길 때만 server/framework 전환을 새 설계로 검토한다.
- Firebase 비용·정책·가용성이 운영 기준을 벗어나면 데이터 export와 대체 인증을 별도 승인 후 검토한다.
