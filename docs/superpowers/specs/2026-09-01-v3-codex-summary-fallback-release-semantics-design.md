# GitHub Trending v3 Codex 요약 fallback·release 의미 교정 설계

- 상태: 사용자 설계 승인 완료, 구현 전 문서 검토
- 작성일: 2026-09-01 KST
- 기준 source: `8acae091c5ac328e16e8c3d2c602355baee722f4`
- 기준 production source: `084a657d1bb36c7a79b3005161c50ddabf4938c0`
- 기준 production snapshot: `20260831232256-93d42067ab071cda`
- 선택안: 새 v1 snapshot 우선 + 최소 Codex v3 summary fallback
- 우선순위: 이 문서가 기존 설계의 `deploy-only는 현재 committed v1 snapshot을 다시 패키징한다`는 표현을 대체한다.

## 1. 목적

기능 코드가 변경된 뒤 이전 v1 snapshot의 artifact contract로 `deploy-current-pages.yml`을 실행해 배포가 중단됐다. 중단 자체는 손상 방지 불변식이 정상 작동한 결과지만, code release와 finalized artifact redeploy를 같은 작업으로 오해한 운영 의미와 테스트 공백은 교정해야 한다.

동시에 수동 refresh의 frozen facts·events는 완성됐지만 README identity가 변경된 repository 두 개의 v3 summary bundle을 새로 만들어야 한다. 현재 v3 producer는 Claude CLI OAuth에만 연결되어 있고 Claude 한도가 소진됐으므로, 기존 Claude 경로를 바꾸지 않는 Codex CLI fallback을 추가한다.

완료 상태는 다음과 같다.

1. code release는 현재 code bytes로 새 v1 snapshot을 기록·파생·finalize한 뒤에만 배포된다.
2. redeploy는 이미 finalized된 source bytes와 정확히 같은 artifact만 다시 배포한다.
3. source-identical 기존 Claude bundle은 그대로 재사용한다.
4. README identity가 바뀐 exact pending set만 Codex로 생성한다.
5. Claude와 Codex 결과는 각 entry에 실제 provenance를 기록하고 같은 v3 품질 validator를 통과한다.
6. old snapshot hash, DB chain, migration baseline, 5 locale summary contract를 수정하거나 약화하지 않는다.

## 2. 확인된 문제

### 2.1 직접 배포 실패

`PAGES_BASE_ARTIFACT_PATHS`는 데이터 파일뿐 아니라 UI code도 포함한다.

- `firebase-client.js`
- `index.html`
- `repo-filters.js`
- `site-i18n.js`
- `ui-motion.js`

production snapshot은 source `084a657d...`에서 20개 artifact hash를 finalize했다. Git object blob을 DB contract와 직접 비교한 결과는 다음과 같다.

| source | mismatch |
|---|---:|
| `084a657d...` | 0 |
| 기능 병합 `232e1a3...` | 5 |
| 현재 `8acae09...` | 5 |

`deploy-current-pages.yml`이 contract를 export하고 현재 main bytes를 검사했을 때 불일치를 거부한 것은 정상이다. 이 workflow의 interface는 새 code release가 아니라 exact finalized artifact redeploy다.

### 2.2 수동 refresh의 pending summary

보존된 frozen facts에는 active repository 44개가 있다. candidate cache 45개 중 현재 README identity와 producer contract가 맞는 entry는 42개다.

다음 두 entry는 cache 자체는 있지만 README `blob_sha`와 `content_sha256`이 바뀌어 재사용할 수 없다.

- `kaifcodec/user-scanner`
- `handsomestWei/patent-disclosure-skill`

따라서 stale cache를 재라벨링하지 않고 새 summary bundle을 생성해야 한다.

### 2.3 provider 결합

현재 v3 source profile은 다음 구현에서 Claude provenance를 직접 검사한다.

- `scripts/generate-summary-bundles.mjs`
- `scripts/validate-enrichment-coverage.mjs`
- `scripts/update-trending.mjs`
- `scripts/build-pages-artifact.mjs`
- `scripts/record_repository_observations.py`

기존 `scripts/codex-enrichment-adapter.mjs`는 `generate-translations.mjs`의 퇴역한 README 번역 중심 interface를 사용한다. 현재 v3의 5 locale, README evidence, invariant, inference field를 생산하지 않으므로 재사용하지 않는다.

### 2.4 검증 공백

artifact hash mutation을 거부하는 하위 테스트는 존재하고 실제 배포도 그 불변식 때문에 안전하게 중단됐다. 그러나 release 절차에는 다음 시나리오를 직접 실행하는 테스트가 없다.

```text
snapshot finalization
→ Pages code 변경
→ redeploy 시도
→ upload 전에 실패하고 full refresh가 필요하다고 설명
```

따라서 기능 변경 후 deploy-only를 선택한 실행 계획이 구현 전에 걸러지지 않았다.

## 3. 용어와 interface

### 3.1 Code release

현재 code SHA를 production에 처음 게시하는 작업이다.

```text
prepare
→ facts/events
→ source-bound enrichment
→ observation DB snapshot
→ public derivatives
→ 현재 code bytes의 artifact hash finalization
→ full candidate validation
→ generated child commit
→ deploy
→ production probe
```

새 code가 `PAGES_BASE_ARTIFACT_PATHS` 중 하나라도 바꾸면 이 경로를 사용한다.

### 3.2 Finalized artifact redeploy

이미 finalize된 source와 같은 artifact를 다시 Pages에 게시하는 작업이다.

```text
exact origin/main 확인
→ committed snapshot contract export
→ current bytes와 exact 비교
→ artifact build/probe
→ deploy
→ production probe
```

`deploy-current-pages.yml` 파일명은 호환성을 위해 유지하지만 표시 이름·문서·오류 설명에서는 `Redeploy finalized Pages artifact` 의미를 사용한다.

### 3.3 Summary bundle producer profile

summary entry의 `source`는 모델 출력이 아니라 로컬 implementation이 frozen README identity와 실제 runtime provenance를 조합해 만든다.

지원 profile은 두 개뿐이다.

#### Claude profile

```json
{
  "provider": "claude-cli-oauth",
  "interface": "claude-p",
  "auth_method": "oauth_token",
  "api_provider": "firstParty",
  "model": "claude-sonnet-5"
}
```

#### Codex profile

```json
{
  "provider": "codex-cli",
  "interface": "codex-exec",
  "auth_method": "chatgpt_session",
  "api_provider": "openai_first_party",
  "model": "codex-cli/gpt-5.6-sol"
}
```

두 profile 모두 `cli_version`을 실행 시 실제 semver로 측정한다. profile의 모든 값과 README path/blob/content identity, schema version 3, prompt schema version 3, `translation_applicable:false`가 정확히 맞아야 한다.

provider 문자열만 바꾸거나 Codex 결과를 Claude source로 표시하면 실패한다.

## 4. 선택한 architecture

### 4.1 기존 v3 module을 deepening한다

새 범용 provider framework를 만들지 않는다. 기존 `generate-summary-bundles.mjs`가 source binding, reuse planning, quality validation, exact active-set merge, atomic install을 계속 소유한다.

외부 interface는 하나만 확장한다.

```text
node scripts/generate-summary-bundles.mjs <기존 인수> [--prepared-codex FILE]
```

`--prepared-codex`가 없으면 기존 Claude 정상 경로가 그대로 실행된다. 파일이 있으면 Claude preflight나 paid request를 실행하지 않고 exact pending set을 prepared Codex 결과로 채운다.

### 4.2 Source-identical cache reuse

cache reuse는 현재 선택한 producer와 같은지로 결정하지 않는다. 각 entry의 source profile이 지원 profile 중 하나이고 frozen README identity와 exact하게 같은지 독립적으로 검증한다.

따라서 한 snapshot에 다음 조합이 허용된다.

- source-identical Claude entry 42개
- 새 Codex entry 2개

각 entry는 자기 producer provenance를 유지한다. 전체 active set이 완성되기 전에는 output root, tracked checkout, candidate DB에 쓰지 않는다.

### 4.3 JS source profile helper

`scripts/enrichment-models.mjs`에 Claude/Codex runtime profile을 exact하게 판정하는 작은 pure helper를 추가한다. 이미 여러 JS consumer가 이 module을 사용하므로 별도 새 contract package는 만들지 않는다.

Python recorder는 같은 두 profile을 독립적으로 검사한다. 이 중복은 JS admission만 우회해 DB에 잘못된 provenance를 넣지 못하게 하는 cross-language defense다.

## 5. Codex adapter interface

새 `scripts/codex-summary-bundle-adapter.mjs`는 `prepare`와 `complete` 두 entry point만 제공한다.

### 5.1 Prepare

```text
node scripts/codex-summary-bundle-adapter.mjs prepare
  --facts <frozen facts>
  --source-root <candidate source>
  --out-dir <새 temp directory>
```

Prepare의 순서와 불변식:

1. frozen facts를 strict parse하고 `factsSha256`을 재계산한다.
2. 현재 cache entry를 공통 reuse planner로 검증한다.
3. exact pending repository 목록을 계산한다.
4. Codex CLI version과 `Logged in using ChatGPT` 상태를 측정한다.
5. `codex exec`의 output schema, last message, ephemeral, ignore-user-config, read-only sandbox, JSON event 지원을 확인한다.
6. 각 pending item에 기존 `buildSummaryBundleRequest`의 prompt와 JSON schema를 사용한다.
7. temp directory가 새 경로이고 tracked checkout 밖인지 확인한다.
8. `plan.json`, `request-NNN-prompt.txt`, `request-NNN-schema.json`을 `wx`로 쓴다.

Prepare는 model을 호출하지 않고 candidate도 변경하지 않는다.

`plan.json`에는 다음만 들어간다.

- version
- facts SHA-256
- exact pending slug 순서
- repository/README path/blob/content identity
- prompt/schema SHA-256
- measured Codex CLI provenance
- 고정 model

### 5.2 Provider execution

각 request는 빈 임시 cwd에서 실행한다.

```powershell
$responsesRoot = Join-Path $refreshRoot 'codex-responses'
New-Item -ItemType Directory -Path $responsesRoot | Out-Null
foreach ($suffix in @('000','001')) {
  $codexCwd = Join-Path $refreshRoot "codex-empty-cwd-$suffix"
  New-Item -ItemType Directory -Path $codexCwd | Out-Null
  $prompt = [System.IO.Path]::GetFullPath((Join-Path $adapterRoot "request-$suffix-prompt.txt"))
  $schema = [System.IO.Path]::GetFullPath((Join-Path $adapterRoot "request-$suffix-schema.json"))
  $response = [System.IO.Path]::GetFullPath((Join-Path $responsesRoot "response-$suffix.json"))
  $events = [System.IO.Path]::GetFullPath((Join-Path $responsesRoot "events-$suffix.jsonl"))
  Push-Location -LiteralPath $codexCwd
  try {
    Get-Content -LiteralPath $prompt -Raw | codex exec --ephemeral --ignore-user-config --model gpt-5.6-sol --sandbox read-only --output-schema $schema --output-last-message $response --json - 1> $events
    if ($LASTEXITCODE -ne 0) { throw "Codex request $suffix failed" }
  } finally {
    Pop-Location
  }
}
```

`$adapterRoot`에는 plan/request만 두고 `$responsesRoot`에는 response/events만 둔다. prompt는 absolute path에서 stdin으로 전달한다. stdout JSON event stream은 absolute events path에 보존하며 token usage·종료 상태의 근거가 된다. stdout이나 log에 credential, raw auth state, 환경변수 값을 기록하지 않는다.

실행 실패, JSONL 완결성 실패, usage 부재, 마지막 message 부재 시 complete로 넘어가지 않는다.

### 5.3 Complete

```text
node scripts/codex-summary-bundle-adapter.mjs complete
  --facts <frozen facts>
  --source-root <candidate source>
  --plan <plan.json>
  --responses-dir <response directory>
  --out <prepared-codex.json>
```

Complete의 순서와 불변식:

1. facts bytes와 plan의 facts SHA를 대조한다.
2. `--source-root`의 current source cache에서 exact pending을 독립 재계산하고 plan의 pending과 requests를 대조해, 둘을 함께 삭제한 변조도 거부한다.
3. plan의 README identity와 prompt/schema hash를 재계산한다.
4. 현재 Codex CLI provenance가 plan과 같은지 다시 측정한다.
5. 각 JSONL의 성공 종료와 usage를 strict parse한다.
6. 각 response를 기존 `validateSummaryBundleEnvelope`로 검증한다.
7. 5 locale·5 field·README evidence·invariants·inference fields를 모두 확인한다.
8. source를 response가 아니라 local plan identity와 measured provenance로 만든다.
9. output write 직전에 current source cache를 다시 읽어 준비 중 drift를 거부한다.
10. exact pending set 하나의 prepared file을 `wx`로 쓴다.

prepared file shape:

```json
{
  "version": 1,
  "facts_sha256": "<exact facts hash>",
  "producer": {
    "provider": "codex-cli",
    "interface": "codex-exec",
    "cli_version": "<measured semver>",
    "auth_method": "chatgpt_session",
    "api_provider": "openai_first_party",
    "model": "codex-cli/gpt-5.6-sol"
  },
  "usage": {
    "attempts": 0,
    "input_tokens": 0,
    "output_tokens": 0
  },
  "repositories": {}
}
```

실제 usage 값은 JSONL에서 합산하며 음수·비정수·누락을 허용하지 않는다.

## 6. Prepared import contract

`generate-summary-bundles.mjs --prepared-codex`는 다음 순서로 동작한다.

1. frozen facts/events/cache/parent evidence를 기존과 동일하게 검증한다.
2. frozen inputs를 한 번 더 읽어 planning 중 변경되지 않았음을 확인한다.
3. source-identical stored entries를 retained set으로 만든다.
4. 나머지를 pending set으로 만든다.
5. prepared file의 facts SHA와 producer profile을 검증한다.
6. prepared repository key가 pending set과 exact하게 같은지 확인한다.
7. extra, missing, duplicate, case-fold collision을 거부한다.
8. 각 envelope를 현재 frozen README에 대해 다시 검증한다.
9. retained+prepared가 active repository 전체와 exact하게 같은지 확인한다.
10. cache, source registry, enrichment index, usage receipt를 한 candidate operation에서 원자적으로 설치한다.

유효한 Claude entry를 prepared Codex가 덮어쓸 수 없다. 일부 pending만 제공하거나 source-changed entry를 누락하면 실패한다.

## 7. Consumer validation

다음 consumer는 두 exact profile을 허용하되 나머지 계약은 그대로 유지한다.

- `validate-enrichment-coverage.mjs`
- `update-trending.mjs`
- `build-pages-artifact.mjs`
- `record_repository_observations.py`

공통 불변식:

- source object exact keys
- slug lowercase identity
- README path/blob/content SHA
- semver CLI version
- supported exact producer profile
- model/profile 일치
- schema version 3
- prompt schema version 3
- `translation_applicable:false`
- rendered summary가 validated English summary와 일치
- active set missing/stale 0

## 8. Release workflow 의미 교정

### 8.1 Redeploy workflow

`.github/workflows/deploy-current-pages.yml`의 파일명과 dispatch interface는 유지한다. 표시 이름은 finalized artifact redeploy 의미로 바꾼다.

workflow는 다음을 계속 금지한다.

- refresh
- DB write
- summary generation
- Claude/Codex call
- old snapshot contract 수정

contract와 current bytes가 다르면 upload/deploy 0으로 실패하고, 오류는 code release에 full refresh가 필요하다고 명시한다.

### 8.2 Code release

UI·auth·data producer code가 Pages artifact path를 변경하면 다음 경로만 허용한다.

```text
새 frozen run context
→ facts/events
→ exact pending enrichment
→ 새 observation snapshot
→ derivatives
→ current code artifact hash finalization
→ full validators
→ child commit
→ finalized artifact redeploy
```

같은 snapshot ID에 새 code hash를 다시 쓰지 않는다.

## 9. 변경 범위

### 신규

- `scripts/codex-summary-bundle-adapter.mjs`
- adapter prepare/complete·response fixture tests

### 수정

- `scripts/enrichment-models.mjs`
- `scripts/generate-summary-bundles.mjs`
- `scripts/validate-enrichment-coverage.mjs`
- `scripts/update-trending.mjs`
- `scripts/build-pages-artifact.mjs`
- `scripts/record_repository_observations.py`
- `.github/workflows/deploy-current-pages.yml`
- 관련 Node·Python workflow/publication tests
- README와 운영 handoff의 release/redeploy 설명

### 유지

- `derive_repository_artifacts.py`의 old-snapshot conflict와 hash finalization
- DB schema version과 migration baseline
- `daily-refresh.yml`의 Claude 기본 producer
- provider budget·deadline·quality correction 의미
- 기존 `codex-enrichment-adapter.mjs`와 old translation code. 이번 최소 작업에서는 삭제·리팩터링하지 않고 v3용이 아님을 문서에 명시한다.

## 10. 오류 처리

| 상황 | 결과 |
|---|---|
| Codex executable 또는 지원 옵션 없음 | prepare 실패, provider call 0 |
| ChatGPT 로그인 상태 아님 | prepare 실패, provider call 0 |
| facts 또는 README identity drift | complete/import 실패, candidate write 0 |
| prepared extra/missing slug | import 실패, candidate write 0 |
| response JSON/schema/quality 위반 | complete 실패, prepared write 0 |
| usage JSONL 누락·잘림 | complete 실패 |
| unknown/위장 provenance | 모든 JS/Python consumer에서 실패 |
| retained entry를 Codex가 덮어씀 | import 실패 |
| old snapshot + changed code redeploy | upload/deploy 전 실패 |
| current code로 새 snapshot finalize | artifact build/probe 성공 가능 |
| origin/main 전진 | commit/push/deploy 중단 |

실패 산출물은 checkout 밖 temp path에 보존한다. credential·token·auth raw output은 저장하거나 보고하지 않는다.

## 11. TDD와 mutation 요구사항

### 11.1 Adapter

1. prepare가 exact pending set과 기존 request schema를 생성한다.
2. source-identical 42개는 prompt를 만들지 않는다.
3. stale README 두 개만 pending이 된다.
4. wrong facts SHA, prompt hash, schema hash, README identity를 거부한다.
5. truncated JSONL, nonzero exit, missing usage, malformed final message를 거부한다.
6. 5 locale·field·evidence·invariant·inference defect를 기존 validator가 거부한다.
7. response가 provenance를 삽입해도 local measured provenance만 source가 된다.

### 11.2 Prepared import

1. 42 Claude + 2 Codex가 exact active 44 set으로 성공한다.
2. extra/missing/duplicate/case collision을 거부한다.
3. valid retained Claude entry overwrite를 거부한다.
4. prepared 없이 기존 Claude 경로가 동일하게 동작한다.
5. provider failure 때 cache/source/index/DB가 바뀌지 않는다.

### 11.3 Consumer admission

1. exact Claude/Codex profile을 각각 허용한다.
2. provider, interface, auth, API provider, model 중 하나만 바꿔도 거부한다.
3. README identity와 source registry 불일치를 거부한다.
4. JS coverage/render/pages와 Python recorder가 같은 fixture를 독립 판정한다.

### 11.4 Release semantics

1. finalized old snapshot + same code는 redeploy artifact build 성공이다.
2. finalized old snapshot + changed Pages code는 upload 전 실패다.
3. 오류가 full refresh 필요성을 설명한다.
4. current code로 새 snapshot을 finalize하면 artifact build가 성공한다.
5. 기존 artifact hash 비교를 제거하거나 old rows를 덮어쓰는 mutation은 RED다.

### 11.5 Mutation

- exact pending set 비교 제거
- README content SHA 비교 제거
- unknown producer 허용
- Codex 결과를 Claude source로 고정
- full active-set 검증 제거
- artifact hash 비교 제거
- deploy-before-build 순서 변경

각 mutation은 owning test에서 RED가 되어야 한다.

## 12. 검증 순서

1. 관련 focused Node/Python RED·GREEN
2. adapter fixture와 CLI preflight test
3. prepared mixed-provenance integration
4. record→derive→finalize→verify artifact integration
5. workflow/actionlint
6. Node 전체 + Python 전체 + Firestore Rules 9/9
7. production dependency audit
8. `git diff --check`
9. staged DB/secret scan
10. PR head/base와 matching-SHA CodeQL
11. 사용자 merge·deploy 확인
12. 새 v1 snapshot 수동 refresh
13. exact deploy-only 1회
14. production manifest/source/snapshot/files HTTP probe
15. 실제 Google login reload/new tab/BFCache/browser restart/cross-tab logout 재검증

## 13. 범위 밖

- manifest v2와 app-shell/data split contract
- old snapshot hash 재작성
- provider plugin registry 또는 임의 provider 확장
- 새 server/framework/package
- scheduled Daily Refresh 활성화
- Claude 결과 재생성
- README 전체 번역 부활
- Deep Scan 재개
- PR #34 재작업 또는 remote branch 삭제

## 14. 선택한 것·버린 것·뒤집는 조건

### 선택한 것

- code release는 새 v1 snapshot을 요구한다.
- redeploy는 exact finalized bytes만 허용한다.
- Claude 정상 경로는 유지하고 Codex는 exact pending fallback으로만 추가한다.
- mixed provenance는 entry별로 정직하게 기록한다.
- 기존 v3 prompt/schema/quality validator를 두 producer가 공유한다.

### 버린 것

- provider-neutral framework와 candidate-builder 대규모 refactor
- data snapshot과 app-shell을 나누는 manifest v2
- old translation Codex adapter 위에 v3 처리를 겹치는 방식
- stale cache relabeling과 provenance 위장

### 뒤집는 조건

- code-only release가 반복 운영 요구로 확인되면 manifest v2를 별도 설계한다.
- Claude/Codex 외 세 번째 producer가 실제로 필요해지면 두 profile 분기를 general producer seam으로 재평가한다.
- Codex CLI structured output·usage가 안정적으로 검증되지 않으면 fallback을 게시 경로에 넣지 않고 Claude 복구를 기다린다.
- provider call 없이도 같은 v3 summary contract를 충족하는 결정론적 생성 방식이 입증되면 별도 승인 후 대체한다.

## 15. 완료 조건

- 설계·계획·코드·문서에 code release와 redeploy 의미가 일치한다.
- exact pending two가 Codex v3 contract로 생성되고 기존 42개가 보존된다.
- 새 snapshot과 현재 code artifact hash가 하나의 immutable v1 candidate로 finalize된다.
- 전체 tests·mutation·actionlint·Rules·secret scan·CodeQL이 통과한다.
- deploy-only는 exact 새 main에서 한 번만 실행된다.
- production manifest가 새 source SHA와 새 snapshot ID를 제공한다.
- HTTP artifact hash와 production browser/auth matrix가 통과한다.
- worktree가 clean하고 `HEAD == origin/main`이다.
