# GitHub Trending Daily multilingual production closure handoff

- 최초 작성: 2026-08-30 KST
- 현재 개정: 2026-08-31 KST
- 저장소: `https://github.com/nowwcastle-sudo/github-trending-daily`
- 운영 페이지: `https://nowwcastle-sudo.github.io/github-trending-daily/`
- 작업 worktree: `C:\Users\nasca\.codex\worktrees\3a3b\transactional-refresh-20260827`
- production RED source SHA: `0aa617016c0e832909f74e3d9a70bbe210c10d60`
- 2026-08-31 첫 controlled dispatch 좌표: clean `HEAD == origin/main == c33b7e449aa3b225130e771b530215c7ee2a75cf`, workflow run `33337114759` (remote write 직전 다시 fetch)
- 2026-08-31 두 번째 controlled dispatch 좌표: clean `HEAD == origin/main == 6e6f4749178094782557987d86da2e3385a60b08`, workflow run `33338119441`
- 2026-08-31 세 번째 controlled dispatch 좌표: clean `HEAD == origin/main == d3c8fdc3f61ca816104985d7bda40c9e725954be`, workflow run `33340906781`
- 2026-08-31 네 번째~여섯 번째 controlled dispatch 좌표: clean `HEAD == origin/main == dfa3bd387c40c104b15abf861bb9f4c003fb7902`, workflow runs `33353784160`, `33355529363`, `33356905445`
- 2026-08-31 일곱 번째 controlled dispatch 좌표: clean `HEAD == origin/main == c83aa52c4f9fb7c79742a217a0ccae91a4726be6`, workflow run `33358622337`
- 2026-08-31 여덟 번째 controlled dispatch 좌표: clean `HEAD == origin/main == a1d04d5505929d298a2030e75eec01fb288ded3f`, workflow run `33360314788`
- 2026-08-31 아홉 번째 controlled dispatch 좌표: clean `HEAD == origin/main == 49596f97fad19cb5b4b732388165b9f9b37b3824`, workflow run `33361877370`
- 2026-08-31 열세 번째 controlled dispatch 좌표: clean `HEAD == origin/main == 3e4ac55d3d2a0e7a153750a75133dcc692312482`, workflow run `33367283210`
- 2026-08-31 열네 번째 controlled dispatch 좌표: clean `HEAD == origin/main == bf5c28f97a577d3ade412e4ef7d06bd078e3a312`, workflow run `33370143480`
- AgentMemory handoff: `mem_mtfb5jzh_7ddf0a27f5dc`
- 원본 task: `01a03d80-1266-76e1-896d-16648967d258`

## 0. 이 문서의 지위

이 문서는 2026-08-30 production closure의 최신 정본이다. 오래된 progress·ledger·이전 README 번역 계획보다 현재 사용자 결정, 코드, 테스트, Actions, Pages, production 실측을 우선한다. 원격 자동 갱신이 있을 수 있으므로 push와 배포 직전에 `git fetch --prune origin`으로 좌표를 다시 확정한다.

## 1. 현재 사용자 결정

1. `README.md`는 영문 정본으로, `README.ko.md`는 전체 한글판으로 유지한다. `README.en.md`는 기존 링크 호환 안내만 둔다.
2. 사이트의 안정적인 기본 틀은 영어·한국어·중국어 간체·스페인어·일본어 5개 언어로 전환한다. 갱신 때 바뀌는 repository card 원천 데이터는 자동 번역하지 않는다.
3. repository README 전체 생성 번역은 폐기한다. README viewer에는 upstream 저장소가 실제 제공하는 언어판만 표시한다.
4. summary tooltip은 영어·한국어·중국어 간체·스페인어·일본어 5개 언어를 원자적 묶음으로 제공한다. 웹과 모바일의 내용·품질은 동일하고 layout만 반응형으로 바뀐다.
5. summary 언어 버튼은 첫 줄, **View README**는 두 번째 줄, `goal/usage/pros/cons/fit`은 그 아래에 둔다.
6. sidebar는 사용자가 선택한 B안인 **Compact Rail**로 확정한다. 데스크톱 hover는 비모달, click·keyboard 실행은 focus trap 모달, 모바일은 명시 버튼과 edge swipe를 유지한다.
7. summary producer는 Windows self-hosted runner의 `claude -p --model claude-sonnet-5`와 first-party OAuth subscription을 사용한다. direct Anthropic Messages API, API key, dollar-cost planning은 폐기한다.
8. runner는 repository 전용 label `gh-trending-claude`를 요구하며, 사용자 범위 `CLAUDE_CODE_OAUTH_TOKEN`만 Claude step 안에서 가져온다. Claude 자식 환경은 positive allowlist이고 도구·slash command·Chrome·session persistence를 끈다.
9. controlled workflow와 Pages 배포는 로컬 검증·비밀값 검사·remote drift·runner online/OAuth preflight가 모두 통과한 뒤 6단계 말미에 수행한다. 사용자는 publication blocker를 역추적해 고친 뒤 전체 workflow와 Pages가 안정적으로 완주할 때까지 필요한 controlled dispatch를 승인했다. 실패 로그를 읽지 않은 blind retry는 금지한다.
10. repository observation DB에는 README 전체 본문을 저장하지 않는다. source identity, hash, schema, state만 저장한다.
11. Codex Security Deep Scan `21f276c1-3f0e-4e13-83ae-901cc307a4c6`은 명시적으로 보류한다. 재개·취소·신규 생성·통과 취급을 하지 않고 잔여 보안 위험으로 보고한다.
12. Deep Scan만 보류한다. CodeQL, 정적·의존성·비밀값 검사, Firestore Rules, 실제 로그인과 나머지 production 인수시험은 생략하지 않는다.

## 2. production RED 기준선

- 기준선 당시 clean `HEAD == origin/main == ls-remote main == 0aa617016c0e832909f74e3d9a70bbe210c10d60`.
- production manifest version 0, `legacyBootstrap: true`, `sourceSha: 0aa6170…`, `snapshotId: null`.
- active repository 49개 중 49개가 정확히 `구체적인 설치 및 사용 절차는 저장소 README 원문을 확인한다.`라는 metadata-only 일반 summary를 사용한다.
- 49개 모두 유효한 `readme_path`, `readme_blob_sha`, `readme_content_sha256`, `default_branch_head_sha` provenance가 없다.
- legacy translation file은 33개이고 16개가 없지만, 새 설계에서는 이 full README translation을 성공 조건으로 사용하지 않는다.
- active source registry는 version 2 legacy이며 `model/blob_sha/translation_applicable`가 null이다. v3 summary provenance 성공 증거가 아니다.
- migration gate는 위 상태를 정확한 `legacy_red`로만 인정하며 production success로 승격하지 않는다.

## 3. summary 품질 정본

이 사양은 `mattpocock-skills:grilling`로 사용자와 공동 확정했다.

1. 사용자가 30~60초 안에 기술적 적합성을 판단할 수 있는 요약이다.
2. 필드는 정확히 `goal`, `usage`, `pros`, `cons`, `fit`이며 서로 중복하지 않는다.
3. 영어 환산 전체 180~280단어, 목표 200~240단어다.
4. README 사실과 직접적이고 신중한 함의만 허용한다.
5. README에 실제 있는 핵심 명령만 1~2개 포함한다.
6. 중립적 기술 문체를 사용하고 홍보성 최상급 표현은 거부한다.
7. 5개 locale의 command, URL, version, number, product name, warning은 정확히 같아야 한다.
8. 5개 언어는 한 묶음이며 한 언어의 결함도 repository와 candidate 전체를 실패시킨다.
9. `insufficient_source`는 candidate 실패다. metadata fallback이나 “README 참고” 문구로 통과시키지 않는다.
10. 기존 전체 12 retry와 input/output cap 안에서 repository별 품질 교정은 최대 2회다. deterministic validator가 허용된 locale/field를 특정하면 해당 위치만 보정 prompt에 전달한다.
11. 모델은 내부 evidence의 README line range와 invariant의 `kind`/`value`만 반환한다. section heading은 frozen README의 ATX/Setext 구조에서, invariant field 위치는 실제 5-locale summary에서 결정적으로 파생해 저장하며 기존 cache의 파생값이 다르면 거부한다. README 전체 본문은 observation DB에 넣지 않는다.
12. UI에는 “verified repository README를 바탕으로 AI가 생성”했다고 표시하고 human verified라고 하지 않는다.
13. reuse는 동일 README blob/content hash, prompt schema, `claude -p` provider/interface, CLI version, OAuth auth method일 때만 허용한다.
14. 첫 production은 automated full census와 층화 10-repository × 5-locale 수동 표본을 web/mobile 양쪽에서 수행한다.

## 4. 구현된 계약

- `site-i18n.js`: exact locales `en`, `ko`, `zh-CN`, `es`, `ja`; 저장값 → browser locale → English 순으로 선택한다.
- `index.html`: 64px Compact Rail, 5-locale UI, 5개 summary tabs, 두 번째 줄 View README, 동일 field 구조와 AI disclosure.
- `scripts/readme-variants.mjs`: 같은 디렉터리의 deterministic upstream README aliases만 수집하고 exact path/blob/head/content hash를 검증한다.
- `scripts/claude-cli-runtime.mjs`: Claude Code 2.1.211 이상, first-party OAuth, positive-allowlist child environment, tool-free structured output, 8 MiB stdin, timeout·output cap·Windows process-tree 강제 종료를 구현한다.
- `scripts/generate-summary-bundles.mjs`: `claude -p` Sonnet 5, schema v3, prompt schema v3, atomic 5-locale output, 최대 두 번의 field-specific correction, 전체 retry cap과 CLI/OAuth provenance를 구현한다. 모델은 `start_line`/`end_line`과 invariant `kind`/`value`만 반환하고, section heading과 invariant field 위치는 frozen README와 실제 5-locale summary에서 결정적으로 파생한다. inference field는 5개 locale 모두 자연어 hedge를 명시해야 하며 누락 시 exact locale/field와 그 언어의 허용 강도 예시를 correction에 전달한다. 한 repository가 영구 실패하면 다른 worker는 새 repository 요청을 시작하지 않는다.
- `scripts/collect-repository-events.mjs`: 최대 75개 repository와 각각 최대 2 MiB canonical README 및 envelope 여유분을 수용하는 320 MiB frozen-facts 상한과 strict parser를 단일 정의하며, enrichment·render·coverage·Codex adapter 등 모든 consumer가 같은 parser를 사용한다. upstream variant는 identity metadata만 frozen facts에 포함되고 본문은 포함하지 않는다. GitHub 요청은 기존 3회(2초·8초), 반복 500이 관측된 OSS Insight 요청만 5회(2초·8초·30초·60초)로 bounded retry하며 끝까지 실패하면 candidate 전체를 fail closed한다.
- `scripts/update-trending.mjs`: canonical README 개별 상한은 2 MiB이고, immutable blob/path/head/content hash와 strict UTF-8/control-character gate를 요구한다.
- `scripts/update-trending.mjs`: v3 source와 exact 5-locale summary bundle만 render하며 metadata fallback을 허용하지 않는다.
- `scripts/validate-enrichment-coverage.mjs`: active page/facts/cache/source exact set, full envelope, locale completeness, stale/missing/insufficient source, translation residue를 fail closed로 검사한다.
- `scripts/build-pages-artifact.mjs`: source registry v3와 `site-i18n.js`를 exact artifact에 포함하고 legacy translation artifact를 제외한다.
- workflow는 GitHub-hosted `prepare` → Windows self-hosted `enrich` → GitHub-hosted `publish`로 분리한다. self-hosted runner는 tracked checkout·DB·page·commit·Pages 권한이 없고 네 개의 allowlisted enrichment 파일만 내보낸다. manual bootstrap gate는 승인 상태이고 schedule은 계속 hold한다. 열네 controlled run 모두 publish 전 fail-closed로 종료됐다.
- runner `nasca-gh-trending-claude`는 `C:\actions-runner-gh-trending`의 공식 Actions Runner 2.337.0으로 등록했다. Task Scheduler 경로에서는 listener가 job을 받은 뒤 Worker IPC가 44초간 멈춰 `steps=0`으로 실패했지만, interactive listener에서는 Worker·checkout·Claude step이 정상 실행됐다. 현재 production closure 동안은 interactive listener를 사용하고 schedule은 hold한다.
- `README.md`, `README.ko.md`, `README.en.md`와 2026-08-31 candidate screenshots를 새 구조에 맞췄다.

## 5. canonical 실행 계획

1. **Baseline·RED — 완료**: npm/Python 기준선, 49/49 generic, 0/49 provenance, 33/49 legacy translation, same-run ordering 실패를 자동 계약으로 고정한다.
2. **B Compact Rail·5-locale shell·영문 기본 문서 — 완료**: UI와 정적 문서를 새 구조로 전환한다.
3. **Upstream README variants — 구현 완료, production data 대기**: 실제 존재하는 언어판만 exact source identity로 표시하고 full README translation path를 폐기한다.
4. **Grilling 기반 summary 사양 — 완료**: 위 품질·길이·근거·동일성·실패 계약을 공동 확정한다.
5. **Sonnet 5 producer·coverage gates — 코드·로컬 검증 완료**: local `claude -p`, first-party OAuth, 고정 byte/retry/timeout cap, producer provenance, atomic 5-locale bundle 계약을 사용한다.
6. **검증·commit/push·controlled workflow·Pages — 여덟 번째 dispatch의 inference-order correction repair 검증 완료**: 기존 390/720/1200/1440, 5 locale, hover/click/focus/Escape, light/dark, tooltip, README legacy failure UI, export privacy, Atom/membership 실브라우저 검증을 보존한다. 첫 일곱 run의 원인과 frozen evidence는 위 이력대로 유지한다. 여덟 번째 run `33360314788`은 prepare를 5분 39초에 완주하고 interactive runner에서 실제 Claude enrichment를 8분 48초 수행한 뒤 `Summary bundle inference field set is invalid`로 fail-closed 종료됐다. structured-output schema는 `inference_fields`의 enum·unique만 보장하지만 validator는 `goal, usage, pros, cons, fit` canonical order를 요구했고, 기존 initial/correction prompt는 그 순서를 설명하지 않았다. exact completed model calls와 tokens는 usage receipt가 없어 `unknown`이며 DB·commit·Pages·probe는 0이다. 해당 frozen input은 snapshot `20260831052234-795cef5ad0be9d73`, repositories `50`, `sourceSetSha256=a8f5411c72c0128ed980955f1508f0a4c97c26921ff6d72a1949ab21d91364da`, `runContextSha256=7ff72823815f7bcea372a62e4c913d2cad31c927460df08872192588ffa588f5`, `factsSha256=69bea7ba4c78fc70f55914704a24fadcb73162483b48387e59835230801b70e3`, `eventsSha256=dfb2fda15402588f34669356947bfd7c2e7cf65f8d56d3f78ba4f8de0b9f7642`다. 새 RED는 두 번의 out-of-order inference set 뒤 canonical set을 요구하며 기존 prompt에서 실패했고, initial prompt와 exact correction에 canonical order를 명시해 green이 됐다. 전용 correction을 무력화한 변이는 RED를 다시 실패시켰다. 최종 local 기준선은 Node 519개(507 pass, 12 intentional skip), Python 146 pass, Firestore Rules 9 pass다.

**6단계 최신 후속 — 아홉 번째 dispatch의 concrete-cons repair 검증 완료**: run `33361877370`은 prepare를 5분 26초에 완주하고 실제 Claude enrichment를 10분 32초 수행한 뒤, 두 번의 기존 locale/field correction에도 `Summary bundle contains a generic or placeholder es.cons`로 fail-closed 종료됐다. 기존 correction은 위치와 “README를 보라고 하지 말라”는 금지만 전달해 source가 명시적 단점을 주지 않을 때 대체할 `cons` 유형을 제시하지 못했다. retry/cap/validator를 바꾸지 않고 initial/correction prompt에 source-supported prerequisite, limitation, operational trade-off, cautiously worded documentation gap 중 하나를 쓰도록 명시했다. tight RED는 같은 invalid `es.cons`가 두 번 이어진 뒤 valid response를 요구하며 새 구체 지침을 검사하고, cons 전용 correction을 무력화한 변이는 다시 실패했다. frozen input은 snapshot `20260831054926-fed9cec3abd9f8d9`, repositories `50`, `sourceSetSha256=b0beee6143ea9a0a925eb7ce65fa7009dad3ed7b9dcedb6d4843188820b948be`, `runContextSha256=93cb15e562b7edc516c5e0225f139cae96045c9d9256ad2e53d3da717cd44f8e`, `factsSha256=55717ab6913daea38711f8f3e0deeab9c059335098afe06c7cb76d8a07c1ca6b`, `eventsSha256=85db27b6777121be4f0e18b3e415c224807e5df38acbfd6a0d51eccdca300ef8`다. usage receipt 전 실패해 exact calls/tokens는 `unknown`이고 DB·commit·Pages·probe는 0이다. local 기준선은 Node 519개(507 pass, 12 intentional skip), Python 146 pass, Firestore Rules 9 pass다.

**6단계 최신 후속 — 열 번째·열한 번째 dispatch의 OSS Insight 반복 500 안정화 검증 완료**: main `f13c97c8ab9c51eea1f9b0f59d3f3c47697722c6`은 CodeQL run `33363330706`에서 JavaScript/TypeScript 87규칙·Python 43규칙의 실제 analysis 2건, results 0, open alerts 0을 통과했다. run `33363575020`은 snapshot `20260831061716-b2876a057ffd00d2`, `sourceSetSha256=29002662de9803f53c18af5f28a8be0408e71ffc66dfbc4817a32ad7cb3fbe8d`, `runContextSha256=8b8cddb50664252c5fb6d00a7a6e99b2875db05da23f438d00285f4d25af2d20`에서 `tashfeenahmed/freellmapi` OSS Insight 500으로 종료됐다. endpoint가 200으로 회복한 것을 상태·길이·SHA-256만으로 확인한 뒤 실행한 run `33363947539`도 snapshot `20260831062244-7cb96fb7e0200576`, `sourceSetSha256=abbefe9543b2a4783d61f548f97c566cf2f5f383020abd546241ec361c82eb43`, `runContextSha256=daefaafa3108042370d84391e00d8c00d92417e6e4ba33ae3f45121b55675a02`에서 다른 `earendil-works/pi` OSS Insight 500으로 종료됐다. 둘 다 prepare 실패라 Claude·DB·commit·Pages·probe는 0이고 refresh-input artifact도 생성 전이라 facts/events digest는 없다. 데이터 누락을 허용하지 않고 OSS 요청에만 5회 bounded recovery schedule을 적용했으며, 4회 500 뒤 5회째 성공과 5회 전부 500인 terminal failure를 RED로 고정했다. 기존 3회 policy 변이를 주입하면 새 테스트가 실패함을 확인했다. 최종 local 기준선은 Node 520개(508 pass, 12 intentional skip), Python 146 pass, Firestore Rules 9 pass, actionlint 1.7.12 pass, production dependency audit 0이다.

**6단계 최신 후속 — 열두 번째 dispatch의 locale inference-strength repair 검증 완료**: OSS retry repair는 PR #12와 main `64a840f8055fa04e2bbf5b8e0d67528d7872b006`의 CodeQL 실제 analysis 2건(87·43규칙), results 0, open alerts 0을 통과했다. run `33365422799`은 prepare를 5분 24초에 성공해 반복 OSS 500 blocker가 production 입력에서 제거됐음을 증명했고 Claude enrichment를 8분 15초 수행한 뒤 `Summary bundle inference strength is missing in ja.cons`로 fail-closed 종료됐다. validator는 inference field의 모든 locale에 명시적 hedge를 요구하지만 기존 correction은 이 오류를 `OUTPUT_SCHEMA`로만 전달해 exact locale/field와 수정 강도를 잃었다. initial prompt에 every-locale explicit hedging 계약을 명시하고, correction에 exact locale/field와 해당 언어의 허용 hedge 예시를 전달했다. 같은 invalid `ja.cons`가 두 번 이어진 뒤 valid 일본어 hedge를 요구하는 RED를 추가했고 inference 전용 branch를 무력화한 변이에서 실패함을 확인했다. frozen evidence는 `C:\Users\nasca\AppData\Local\Temp\gh-trending-run-33365422799-67e19ba5f0ce49a2b762475c8e9ac33a`, snapshot `20260831064441-0aafed2299191a62`, repositories `50`, `sourceSetSha256=c2ed48eb92384f62d22419ed4aa36ca37e0798fa51a83a65cf94190d4ccc0f85`, `runContextSha256=6aa69942359a266a8c238c06d7f7e6a945c6f5dd5557c51d2a45ba552c0fce2a`, `factsSha256=f092f2776bba5e816a44e98c242583e19f6b94885ca2f299d4aadd93154601f7`, `eventsSha256=f7bfc47d3521c632c68b6e899f3d06bf4899ba4133d82bf43a8d4ac17a8b9350`이다. usage receipt 전 실패해 exact calls/tokens는 `unknown`이고 DB·commit·Pages·probe는 0이다. 최종 local 기준선은 Node 521개(509 pass, 12 intentional skip), Python 146 pass, Firestore Rules 9 pass, actionlint pass, production dependency audit 0이다.

**6단계 최신 후속 — 열세 번째 dispatch의 invariant-field correction 검증 완료**: inference-strength repair는 PR #13과 main `3e4ac55d3d2a0e7a153750a75133dcc692312482`에서 CodeQL 실제 analysis 2건(JavaScript/TypeScript 87규칙, Python 43규칙), results 0, open alerts 0을 통과했다. run `33367283210`은 prepare를 5분 29초에 성공하고 Claude enrichment를 11분 58초 수행한 뒤 `Summary bundle invariant fields mismatch in ja`로 fail-closed 종료됐으며 publish·Pages·probe·recovery는 모두 skipped다. validator는 mismatch를 정확히 차단했지만 correction prompt에는 `LOCALE_INVARIANT`만 전달되어 invariant 값과 기대/실제 필드 위치를 잃었다. initial prompt에 각 invariant를 5개 locale의 같은 named field에 두도록 명시하고, correction에는 exact invariant 값·locale·expected/actual field set을 `PREVIOUS_OUTPUT_DIAGNOSTIC_JSON` untrusted data로 격리해 전달했다. 같은 `ja` mismatch가 두 번 이어진 뒤 valid response를 요구하는 RED를 추가했고 전용 correction branch를 무력화한 변이에서 실패함을 확인했다. frozen evidence는 `C:\Users\nasca\AppData\Local\Temp\gh-trending-run-33367283210-35bb462005e34e9e8e3d1ab00ddfd2e5`, snapshot `20260831071138-579622d4ed2937bd`, repositories/readmes `50/50`, `sourceSetSha256=b7a70661e7288bfc6e612385a7ba4ba0123479e00a6e10ec4647afef580176b0`, `runContextSha256=96d42a861fb4e1c50f2e50dff2c00d1168c7fe6c99c13a755421a6fd9a2100e9`, `factsSha256=7e0c8022ee35d4e2d0408bbb53eba119d27524127a3c3d9a08a8c04ee42e9a2e`, `eventsSha256=d14699250664cce01f67fa1ef05efdb6d66b0507805adca3e89313ceb418bad3`이다. usage receipt 전 실패해 exact calls/tokens는 `unknown`이고 DB·commit·Pages·probe는 0이다. 최종 local 기준선은 Node 522개(510 pass, 12 intentional skip), Python 146 pass, Firestore Rules 9 pass, actionlint pass, production dependency audit 0이다.

**6단계 최신 후속 — 열네 번째 dispatch의 marketing-field correction 검증 완료**: invariant-field repair는 PR #14와 main `bf5c28f97a577d3ade412e4ef7d06bd078e3a312`에서 PR potential merge와 main 각각 CodeQL 실제 analysis 2건(87·43규칙), results 0, open alerts 0을 통과했다. run `33370143480`은 prepare를 5분 9초에 성공하고 Claude enrichment를 6분 52초 수행한 뒤 `Summary bundle contains unsupported marketing language in en.fit`로 fail-closed 종료됐으며 publish·Pages·probe·recovery는 모두 skipped다. validator와 initial prompt는 홍보성 최상급 표현을 금지했지만 correction은 `UNSUPPORTED_MARKETING`만 전달해 exact locale/field를 잃었다. correction에 `en.fit`과 neutral source-supported rewrite 지침을 전달하는 최소 수정을 적용했다. 같은 invalid `en.fit`이 두 번 이어진 뒤 valid response를 요구하는 RED를 추가했고 전용 branch를 무력화한 변이에서 실패함을 확인했다. frozen evidence는 `C:\Users\nasca\AppData\Local\Temp\gh-trending-run-33370143480-d32005ee4f604503973eaca09c02c6e5`, snapshot `20260831075026-107b468d98479b2a`, repositories/readmes `50/50`, `sourceSetSha256=5dd99a1e5d5d3834947d7c92237c6d574eb29c83bfd134d129125421bde555bb`, `runContextSha256=c8c6528a590dfcc28f24e5b8bfcf4fc637d15cc94b8f076e7b1fb5eca9d7bebc`, `factsSha256=b7db52d910150e242eaeb41360b0c1816d4e3c0d95a8581a83596a0481771e29`, `eventsSha256=d4a787e1a1c8dea2f211a523b2235174728dc385ef0008f3f22e0a2b0067b507`이다. usage receipt 전 실패해 exact calls/tokens는 `unknown`이고 DB·commit·Pages·probe는 0이다. 최종 local 기준선은 Node 523개(511 pass, 12 intentional skip), Python 146 pass, Firestore Rules 9 pass, actionlint pass, production dependency audit 0이다.

## 6. 적대적 검증 범위

- collector 성공 전 provider 0회
- incomplete enrichment이면 DB/page/commit/Pages 0
- candidate 실패 시 tracked tree 불변
- missing/0-byte/oversized/malicious README, invalid UTF-8
- GitHub 404/429/500, timeout, retry, pagination 이상
- mutable contents/blob mismatch, head/blob/content hash mismatch, stale cache
- incomplete chunk, schema-invalid model output, locale invariant mismatch, insufficient source
- candidate residue, install collision, duplicate execution, damaged state
- tooltip·README focus trap, BFCache/overlay, keyboard, touch/swipe, light/dark/reduced motion
- CSV/JSON privacy, Atom current/membership split
- secret는 값 대신 존재·길이·digest prefix만 확인

## 7. 현재 browser 증거

- 390px: horizontal overflow 없음, mobile toggle 표시, rail 숨김, modal open, focus `sidebarClose`, Escape 후 focus `mobileNavToggle` 복귀.
- 720px: horizontal overflow 없음, mobile toggle 표시, rail 숨김.
- 1200/1440px: 64px rail 표시, mobile toggle 숨김.
- desktop hover: `openMode=hover`, scrim 없음, main inert 아님.
- desktop click: `openMode=modal`, `aria-modal=true`, scrim on, main inert, focus trap 동작.
- site locales: English, Korean, Simplified Chinese, Spanish, Japanese의 `html lang`, subtitle, search, Explore label 실제 전환.
- light/dark: light와 Gruvbox dark의 실제 computed colors 확인.
- legacy tooltip: 5개 tabs는 보이지만 데이터가 없는 locale은 disabled. production v3 성공으로 세지 않는다.
- legacy README: provenance가 없어 `README is unavailable`과 direct GitHub link로 안전 실패. upstream variant 성공으로 세지 않는다.
- export: 공개 필드만 사용한다는 privacy note와 CSV/JSON/link controls 확인.
- Atom: `feed.xml`, `changes.xml` link와 New/Re-entered badges 확인.
- console error는 없는 favicon의 local 404 하나뿐이며 application runtime error는 관측되지 않았다.

## 8. 종료 조건

- 두 번째·세 번째·여섯 번째·일곱 번째·여덟 번째·아홉 번째·열두 번째·열세 번째·열네 번째 run에서 실제 Claude enrichment 요청은 시작됐지만 validator 실패로 완성 bundle과 usage receipt가 남지 않아 token count는 `unknown`이다. 열 번째·열한 번째는 collector에서 종료돼 Claude 호출이 0회였다. production DB·commit·Pages publication은 열네 run 모두 0회다.
- full tests, adversarial review, mutation, staged/working-tree secret scan이 통과한다.
- push 직전 remote drift를 fetch 후 재판정하고 사용자 변경을 보존한다.
- controlled workflow `33337114759`, `33338119441`, `33340906781`, `33353784160`, `33355529363`, `33356905445`, `33358622337`, `33360314788`, `33361877370`, `33363575020`, `33363947539`, `33365422799`, `33367283210`, `33370143480`은 각각 prepare test, enrichment evidence gate, enrichment invariant gate, runner Worker handoff, reboot 후 runner handoff, Spanish placeholder gate, raw README invariant substring gate, inference field order gate, repeated Spanish cons fallback gate, OSS Insight `freellmapi` 500, OSS Insight `pi` 500, Japanese inference-strength gate, Japanese invariant field gate, English marketing language gate에서 publish 전에 종료됐다. 필요한 후속 dispatch는 승인됐지만 cap 상향·direct API·새 유료 provider는 승인되지 않았다.
- production manifest와 exact file hashes가 deployed source SHA에 묶인다.
- 모든 active repository가 detailed 5-locale summary, valid README provenance, canonical/upstream README variants를 전수 통과한다.
- 하나라도 generic fallback, missing locale, stale source, variant mismatch면 recovery/hold를 유지한다.
- CodeQL analysis는 matching commit과 results count가 있는 실제 analysis로 확인하며 0 analyses를 통과로 세지 않는다.
- 실제 Google 계정 persistence·isolation matrix와 나머지 production acceptance를 완료한다.
- 마지막 clean `HEAD == origin/main == deployed sourceSha`와 schedule 상태를 확인한다.
- Deep Scan deferred risk를 명시하고 완료 보고에서 멈춘다. L1-L5, M1 재설계, 새 확장 후보를 자동 시작하지 않는다.
