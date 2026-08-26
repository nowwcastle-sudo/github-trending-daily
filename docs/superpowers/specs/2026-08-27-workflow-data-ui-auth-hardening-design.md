# GitHub Trending 워크플로·데이터·UI·로그인 안정화 설계

- 상태: 대화 설계 승인 완료, 문서 검토 대기
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
  → collect GitHub facts
  → enrich summaries and translations
  → validate candidate facts
  → append candidate observation DB
  → derive page, JSON, Atom and statistics
  → run full verification
  → fetch and compare origin/main
  → install, commit and push exact candidate
  → deploy the same tree with a deployment-only manifest
  → verify production SHA, snapshot and file hashes
```

어느 단계에서든 실패하면 이후 단계를 실행하지 않는다. concurrency group은 하나이며 `cancel-in-progress: false`로 직렬화한다. push 직전 `git fetch origin main` 후 실행 기준 이후 원격이 전진했으면 merge·rebase하지 않고 실패한다. 다음 실행이 새 기준선에서 다시 수집한다.

운영 schedule은 현재 승인된 `cron: 7 */2 * * *`를 유지한다. UI는 이 cron 표현이나 `서울 기준 홀수 시 07분`을 노출하지 않고 production snapshot을 기준으로 계산한 다음 갱신 시각만 보여 준다. `workflow_dispatch`도 schedule과 같은 entry point와 gate를 사용한다.

### 5.2 수집 순서

1. daily, weekly, monthly Trending HTML을 모두 수집·구조 검증한다.
2. 각 source의 원래 ordinal과 visible period gain을 보존한다.
3. daily → weekly → monthly 순서의 안정적인 합집합을 만든다.
4. 합집합의 모든 slug에 대해 GitHub repository metadata를 수집한다.
5. canonical `/repos/{owner}/{repo}/readme` 응답으로 실제 README path와 blob SHA를 얻고, 그 blob을 명시적으로 읽는다.
6. releases baseline/변경과 default-branch commit gap을 수집한다.
7. 모든 current displayed field의 freshness와 provenance를 검증한 뒤에만 LLM 단계로 넘어간다.

README `404`는 repository가 존재하고 canonical README가 실제로 없을 때만 `no_readme`로 분류한다. repository REST `500`, timeout, rate limit, malformed response, README가 있어야 하는데 가져오지 못한 상태는 실행 실패다. Release 목록 200 + 빈 배열은 정상적인 `no_releases`다.

### 5.3 LLM 호출 계약

상세 요약과 README 전체 번역을 별도 호출로 분리한다.

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

README 번역은 Markdown을 입력과 출력으로 사용한다. heading, list, table, fenced code, inline code, link destination을 보존하고 자연어만 한국어로 번역한다. 큰 README는 검증 가능한 heading 경계로 bounded chunking한 뒤 순서를 보존해 결합한다. 줄 수를 이유로 뒷부분을 조용히 버리지 않는다.

두 호출 모두 다음 gate를 통과해야 한다.

- 요청 timeout
- HTTP status와 response content type 검증
- bounded retry와 backoff
- Anthropic `stop_reason == end_turn`
- 필수 필드·문자열 길이·금지 필드 검증
- JSON/Markdown 완결성 검증
- prompt echo, code fence wrapping, 빈 결과 거부
- pending queue 전체 완료 확인

API key가 없거나 처리 상한 때문에 대상이 남으면 workflow는 실패한다. 저장소별 오류를 로그만 남기고 exit 0으로 끝내지 않는다.

LLM 대상은 새 repository, canonical README blob SHA가 바뀐 repository, provenance·schema·품질 검증에 실패한 repository뿐이다. 동일한 blob SHA의 검증된 summary와 translation은 재사용한다. 호출 전 pending count, 입력 byte 수, 최대 호출 수를 secret 없이 log하고, union·README size에서 정한 안전 상한을 넘으면 일부를 잘라 게시하지 않고 실행 전체를 중단한다. 초기 active-set repair도 같은 gate를 쓰는 1회 `workflow_dispatch`로 수행한다.

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
      "blob_sha": "...",
      "content_sha256": "...",
      "model": "...",
      "schema_version": 2
    }
  }
}
```

기존 cache의 `detail`이 품질·source 계약을 충족하면 canonical content 후보로 사용할 수 있지만 compact `summary` 필드는 전부 삭제한다. placeholder, deterministic fallback, compact/detail 동일, source hash 없음, 필수 상세 필드 부족 항목은 invalid로 표시한다. 활성 repository는 모두 유효한 detailed summary가 있어야 게시할 수 있다. 비활성 cache 항목은 재진입할 때 publication 전에 같은 검사를 받는다.

기존 translation JSON의 `{ "html": "..." }` contract는 폐기한다. 이 필드는 실제로 Markdown과 raw HTML을 함께 담으면서 browser의 `innerHTML`에 들어가므로 untrusted README·LLM output 경계를 보장할 수 없다. 새 contract는 translated Markdown과 provenance를 저장한다.

```json
{
  "markdown": "# translated README",
  "source": {
    "blob_sha": "...",
    "content_sha256": "...",
    "model": "...",
    "schema_version": 2
  }
}
```

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

배포 전에는 upload할 artifact 자체를 로컬 HTTP server에서 검증한다. Pages deploy가 실패하면 이전 production이 유지된다. deploy 성공 후 production readback이 불일치하면 해당 run을 성공으로 판정하지 않고 기록된 last-good `source_sha`의 artifact를 즉시 재배포하는 recovery job을 실행한 뒤 다시 검증한다. candidate data commit은 last-good snapshot의 부모로 사용하지 않으며, 다음 publisher가 production manifest의 last-good snapshot에서 후보 DB를 다시 만든다. 자동 history rewrite나 force push는 하지 않는다.

## 6. 유용한 데이터 정본

### 6.1 저장 대상

모든 성공한 2시간 run은 화면 내용이 같아도 snapshot을 남긴다.

- daily·weekly·monthly source ordinal과 period gain
- final display rank
- membership state와 transition
- stars, forks, watchers/subscribers
- GitHub의 `open_issues_count`를 의미 그대로 저장한 `open_issues_and_pull_requests`
- contributor count
- description, topics, license, archived, fork 여부
- primary language와 language color
- field tags와 form tags 및 tag-rule version
- created, updated, pushed 시각
- default branch와 관측된 HEAD SHA
- canonical README path, blob SHA, content SHA256의 변경 이벤트
- public release metadata versions
- 향후 default-branch commit events

language color는 Trending HTML에서 관측한 색을 우선 보존한다. source에 색이 없으면 versioned local language-color map을 사용할 수 있지만, 둘 다 없을 때는 DB에 `null`을 기록한다. UI의 neutral gray fallback을 실제 수집 색으로 저장하지 않는다.

파생 insight는 다음을 포함한다.

- 2시간 stars delta
- daily closing stars와 daily delta
- 7일·30일 velocity와 acceleration
- source period rank timeline
- final display rank timeline
- new·reentered·maintained·exited timeline
- release timeline
- commit timeline
- repository profile change timeline

### 6.2 저장하지 않는 값

- README body
- release body와 asset 목록
- commit patch, changed files, 전체 message, 이메일
- 사용자 UID·인증 토큰·즐겨찾기·숨김 목록·export history
- workflow secret 또는 request header

README 비교를 위해 `data/readme-state.json`에는 slug별 현재·직전 blob SHA, content SHA256, 관측시각만 rolling state로 둔다. DB의 `readme_change_events`에는 old/new hash와 change time만 추가한다.

### 6.3 신규 SQLite schema

`data/repository-observations.sqlite`는 다음 append-only table을 가진다.

| table | 책임 |
|---|---|
| `snapshot_runs` | 성공 run의 시각, KST 날짜, parent, input/output hash |
| `repository_profiles` | metadata가 바뀔 때만 추가되는 profile version |
| `snapshot_items` | snapshot별 slug, 세 source rank, display rank, 정확한 counts와 membership |
| `release_versions` | release id/tag의 public metadata version |
| `commit_events` | baseline 이후 관측한 default-branch commit |
| `readme_change_events` | README hash와 blob 변화, 본문 없음 |
| `repository_insights` | snapshot에서 결정적으로 계산한 delta·velocity·rank 변화 |
| `artifact_hashes` | snapshot과 public artifact SHA256 연결 |

핵심 키는 `snapshot_id`, canonical lowercase slug, GitHub release id, commit SHA다. repository 표시 casing은 별도 field로 보존하되 identity 비교에는 lowercase slug를 쓴다.

### 6.4 release·commit 수집 경계

release는 최초 baseline에서 public release metadata를 page 끝까지 수집한다. 저장 항목은 id, tag, name, target, draft/prerelease, created/published time, HTML URL, metadata hash다. 이후 동일 release id의 metadata hash가 바뀌면 새 version row를 추가한다.

commit은 과거 전체를 backfill하지 않는다. 첫 snapshot의 default branch HEAD를 baseline으로 기록하고 이후 관측 사이의 commit을 overlap pagination으로 수집해 SHA로 dedupe한다. parent 연결이 직전 HEAD와 이어지지 않으면 force-push, branch change, API gap을 구분해 명시적으로 기록하거나 실행을 실패시키며 commit 누락을 정상으로 처리하지 않는다.

### 6.5 append-only와 전체 파일 교체 방어

SQLite trigger로 UPDATE/DELETE를 거부하는 것 외에 다음 검증을 적용한다.

1. last-good DB의 SHA256, size, last snapshot sequence를 읽는다.
2. runner temp에 복제한다.
3. 새 snapshot을 transaction으로 추가한다.
4. `PRAGMA foreign_key_check`, `integrity_check`를 실행한다.
5. 부모 DB의 page/row prefix가 후보에 그대로 존재하는지 비교한다.
6. `parent_snapshot_id`와 snapshot hash chain을 검증한다.
7. 후보 row count와 expected repository count를 대조한다.
8. 검증된 후보만 tracked DB로 승격한다.

과거 DB 복사본으로 파일 전체를 교체해 최신 history가 사라지는 경우도 parent hash와 sequence 불일치로 차단한다.

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

Codex Security는 구현과 production 배포가 끝난 정확한 immutable commit SHA를 대상으로 한다.

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
| LLM truncation/schema 위반 | bounded retry 후 candidate 실패 |
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
- new, reentered, maintained, exited 상태

## 12. 최종 acceptance matrix

| 영역 | 완료 기준 |
|---|---|
| workflow | schedule/manual 동일 경로, 신규 repo, key 누락, LLM/API 실패, midnight, no-change, concurrency, non-FF, Pages 실패 검증 |
| data | 모든 displayed field, source/display ranks, exact 2h snapshots, releases, future commits, README body 미보관, DB continuity |
| LLM | 활성 repo detailed summary 100%, compact field 0, placeholder/fallback 0, translation blob SHA 일치 |
| Atom/export | nonempty Atom summary, XML escaping, CSV formula/quote/newline, JSON field 제한, Blob URL revoke, clipboard failure |
| UI | 390/720/1200/1440, mouse/touch/keyboard, light/dark/reduced-motion, hover rail, edge swipe, second-tap navigation |
| auth | refresh, new tab, browser restart, BFCache, cross-tab logout, guest/account isolation, storage denial, sync failure |
| security | malicious README/DOM/path/shell fixtures, Actions permission, Rules emulator, App Check failure, secret scan |
| production | exact commit manifest, snapshot/file hashes, HTML·JSON·Atom 일치, live browser verification |

Firestore Rules는 기본 test의 skip으로 끝내지 않는다. emulator를 실제로 실행해 Rules test가 skip 없이 pass한 종료 코드를 별도로 확보한다. 실제 Google OAuth와 browser restart 검증은 사용자가 account 선택·동의를 한 번 수행한 뒤 production에서 확인한다. 자동화가 사용자 credential을 입력·출력·저장하지 않는다.

## 13. 구현과 배포 단위

각 단위는 전체 검증, staged secret scan, 분리 commit·push, Pages·production 확인까지 끝낸 후 다음으로 넘어간다.

1. transactional workflow, LLM summary/translation, Atom/date/Pages gates
2. `repository-observations.sqlite`, release baseline, prospective commit timeline, insight derivatives
3. canonical detailed tooltip, sidebar information architecture, desktop rail, mobile gesture와 motion
4. explicit auth persistence와 BFCache lifecycle
5. Codex Security findings와 fixes
6. repository-wide functional/workflow/production acceptance

push 직전마다 `git fetch`와 remote diff를 다시 확인한다. bot 갱신만 확인된 clean worktree에서만 fast-forward한다. force push, history rewrite, broad reset은 하지 않는다.

## 14. 문서와 종료 조건

최종 구현과 production 증거가 확보된 뒤 README 한국어·영어를 실제 동작과 동기화한다. OFA에는 `D:\OFA\OFA\00_원천` 아래 실제 결과와 바뀐 결정만 기록하며 더청춘 vault와 OFA 파생 `wiki`에는 쓰지 않는다.

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
- README body archive보다 rolling hash와 change event
- 암묵적 Firebase default보다 명시적 local persistence
- legacy Pages trigger보다 동일 workflow의 explicit deploy와 production readback

### 버린 것

- LLM 실패를 deterministic placeholder로 덮고 계속 게시하는 방식
- summary와 full translation을 한 JSON 응답에 넣는 방식
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
