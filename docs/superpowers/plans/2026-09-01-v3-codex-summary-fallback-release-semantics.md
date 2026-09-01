# GitHub Trending v3 Codex Summary Fallback 및 Release 의미 교정 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 Claude v3 요약 경로를 유지하면서 source identity가 바뀐 repository만 Codex CLI로 보충하고, 현재 code bytes로 새 v1 snapshot을 finalize한 뒤 exact artifact를 배포한다.

**Architecture:** `generate-summary-bundles.mjs`가 source binding, cache reuse, exact active-set merge, atomic install을 계속 소유한다. 새 adapter는 checkout 밖의 새 temp directory에서 Codex request를 준비하고 수동 실행 결과를 검증된 prepared file로 바꾸며, 기존 producer는 `--prepared-codex`가 있을 때만 그 파일을 가져온다. Code release는 새 snapshot을 만들고, `deploy-current-pages.yml`은 이미 finalize된 bytes만 재배포한다.

**Tech Stack:** Node.js 24 표준 라이브러리, Python 3.13 표준 라이브러리, Codex CLI `exec --json`, SQLite, GitHub Actions, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-09-01-v3-codex-summary-fallback-release-semantics-design.md`

## Global Constraints

- Claude profile은 `claude-cli-oauth / claude-p / oauth_token / firstParty / claude-sonnet-5`다.
- Codex profile은 `codex-cli / codex-exec / chatgpt_session / openai_first_party / codex-cli/gpt-5.6-sol`이다.
- 두 profile의 `cli_version`은 실행 시 측정한 `major.minor.patch`다.
- v3 contract는 locales `en`, `ko`, `zh-CN`, `es`, `ja`와 fields `goal`, `usage`, `pros`, `cons`, `fit`을 유지한다.
- schema version과 prompt schema version은 모두 `3`, `translation_applicable`은 `false`다.
- 새 package, provider registry, manifest v2, old snapshot hash 재작성, stale cache relabeling을 추가하지 않는다.
- 기존 `scripts/codex-enrichment-adapter.mjs`와 retired translation code는 이번 변경에서 편집하지 않는다.
- `derive_repository_artifacts.py`의 old-snapshot conflict, artifact hash finalization, migration baseline을 약화하지 않는다.
- production code를 쓰기 전에 그 동작을 잡는 RED test를 실행하고 예상한 이유로 실패한 것을 기록한다.
- 각 mutation은 owning test가 RED임을 확인한 즉시 원복하고 같은 focused test를 GREEN으로 다시 실행한다.
- push 직전 `git fetch --prune origin`에서 원격 전진이 보이면 자동 병합·rebase·reset 없이 중단한다.
- 비밀값·raw auth output·README 본문을 터미널이나 커밋에 출력하지 않는다.

---

## Common Commit Gate

모든 task의 Commit step은 명시된 파일만 stage한 뒤 다음 PowerShell 검사를 실행한다.

```powershell
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged diff check failed' }
$stagedDiff = @(git diff --cached --no-ext-diff --unified=0 --no-color -- .)
if ($LASTEXITCODE -ne 0) { throw 'Unable to read staged diff for secret scan' }
$stagedAddedLines = @($stagedDiff | Where-Object { $_ -match '^\+(?!\+\+\+)' } | ForEach-Object { $_.Substring(1) })
$secretPattern = '(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
$secretHits = @($stagedAddedLines | Select-String -Pattern $secretPattern -AllMatches)
if ($secretHits.Count) { throw 'Potential secret detected in staged additions' }
```

---

## File Structure

### 신규 파일

- `scripts/codex-summary-bundle-adapter.mjs`: Codex preflight, request plan, JSONL usage 검증, prepared bundle 생성.
- `tests/codex-summary-bundle-adapter.test.mjs`: prepare/complete, drift, JSONL, path, provenance 회귀.

### 수정할 production 파일

- `scripts/enrichment-models.mjs`: 두 exact producer profile과 공통 admission helper.
- `scripts/generate-summary-bundles.mjs`: profile-independent reuse planner, prepared admission, optional CLI argument.
- `scripts/validate-enrichment-coverage.mjs`: mixed producer source admission.
- `scripts/update-trending.mjs`: frozen source reuse와 render admission.
- `scripts/build-pages-artifact.mjs`: Pages source admission과 full-refresh 오류 의미.
- `scripts/record_repository_observations.py`: Python 독립 producer profile 검증.
- `.github/workflows/deploy-current-pages.yml`: finalized artifact redeploy 표시 이름.

### 수정할 test·문서 파일

- `tests/summary-bundle-pipeline.test.mjs`
- `tests/pages-publication.test.mjs`
- `tests/update-trending.test.mjs`
- `tests/test_repository_observations.py`
- `tests/deploy-current-pages-workflow.test.mjs`
- `README.md`
- `README.ko.md`
- `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md`

---

### Task 1: JavaScript producer profile을 하나의 exact admission으로 고정

**Files:**
- Modify: `scripts/enrichment-models.mjs:1-14`
- Modify: `tests/summary-bundle-pipeline.test.mjs:1-18`

**Interfaces:**
- Produces: `CLAUDE_SUMMARY_PRODUCER_PROFILE`, `CODEX_SUMMARY_PRODUCER_PROFILE`.
- Produces: `isSupportedSummaryProducer(value): boolean`; `value`는 provenance field와 `cli_version`을 가진 object다.
- Consumes: 현재 `DEFAULT_ENRICHMENT_MODEL`과 `isEnrichmentModel` 계약.

- [ ] **Step 1: 현재 baseline을 실행한다**

Run:

```powershell
node --test tests\summary-bundle-pipeline.test.mjs
```

Expected: 기존 summary bundle test가 모두 PASS다.

- [ ] **Step 2: 두 profile과 pairwise mutation을 잡는 RED test를 쓴다**

`tests/summary-bundle-pipeline.test.mjs`의 import에 세 export를 추가하고 다음 test를 넣는다.

```javascript
test("summary producer admission accepts exact Claude and Codex profiles only", () => {
  const claude = { ...CLAUDE_SUMMARY_PRODUCER_PROFILE, cli_version: "2.1.241" };
  const codex = { ...CODEX_SUMMARY_PRODUCER_PROFILE, cli_version: "0.151.0" };
  assert.equal(isSupportedSummaryProducer(claude), true);
  assert.equal(isSupportedSummaryProducer(codex), true);
  for (const key of ["provider", "interface", "auth_method", "api_provider", "model"]) {
    assert.equal(isSupportedSummaryProducer({ ...codex, [key]: `${codex[key]}-wrong` }), false, key);
  }
  assert.equal(isSupportedSummaryProducer({ ...codex, cli_version: "0.151" }), false);
  assert.equal(isSupportedSummaryProducer({ ...codex, extra: true }), false);
});
```

- [ ] **Step 3: RED가 missing export 때문에 실패하는지 확인한다**

Run:

```powershell
node --test tests\summary-bundle-pipeline.test.mjs
```

Expected: 새 export가 없어서 FAIL하며 기존 test failure는 없다.

- [ ] **Step 4: 최소 profile helper를 구현한다**

`scripts/enrichment-models.mjs`에 다음 shape를 추가한다. profile의 key는 다섯 개만 허용하고, admission input은 그 다섯 개와 `cli_version`만 허용한다.

```javascript
export const CLAUDE_SUMMARY_PRODUCER_PROFILE = Object.freeze({
  provider: "claude-cli-oauth",
  interface: "claude-p",
  auth_method: "oauth_token",
  api_provider: "firstParty",
  model: DEFAULT_ENRICHMENT_MODEL,
});

export const CODEX_SUMMARY_PRODUCER_PROFILE = Object.freeze({
  provider: "codex-cli",
  interface: "codex-exec",
  auth_method: "chatgpt_session",
  api_provider: "openai_first_party",
  model: "codex-cli/gpt-5.6-sol",
});

const SUMMARY_PRODUCER_KEYS = Object.freeze([
  "provider", "interface", "cli_version", "auth_method", "api_provider", "model",
]);

export function isSupportedSummaryProducer(value) {
  if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).sort().join("\0") !== [...SUMMARY_PRODUCER_KEYS].sort().join("\0")
      || !/^\d+\.\d+\.\d+$/.test(value.cli_version)) return false;
  return [CLAUDE_SUMMARY_PRODUCER_PROFILE, CODEX_SUMMARY_PRODUCER_PROFILE]
    .some(profile => Object.entries(profile).every(([key, expected]) => value[key] === expected));
}
```

- [ ] **Step 5: GREEN과 mutation을 확인한다**

Run the focused test. Then temporarily remove `CODEX_SUMMARY_PRODUCER_PROFILE` from the `.some(...)` array, confirm the new test is RED, restore it, and run the focused test again.

- [ ] **Step 6: Task 1을 commit한다**

```powershell
git add -- scripts/enrichment-models.mjs tests/summary-bundle-pipeline.test.mjs
```

Run the Common Commit Gate, then:

```powershell
git commit -m "feat: Claude와 Codex 요약 provenance를 정확히 구분"
```

---

### Task 2: Source-identical reuse와 prepared admission을 pure contract로 분리

**Files:**
- Modify: `scripts/generate-summary-bundles.mjs:391-499,657-701,1128-1244`
- Modify: `tests/summary-bundle-pipeline.test.mjs`

**Interfaces:**
- Produces: `summaryItemsFromFacts(facts): SummaryItem[]`.
- Produces: `planSummaryBundleReuse(items, cacheValue): { retained: Map<string, StoredEntry>, pending: SummaryItem[] }`.
- Produces: `buildSummarySource(item, producer): SummarySource`.
- Produces: `admitPreparedCodexSet({ value, factsSha256, pending }): { results, usage, runtime }`.
- Consumes: Task 1의 `isSupportedSummaryProducer`와 Codex profile.

- [ ] **Step 1: Mixed reuse와 exact pending RED test를 쓴다**

기존 `item`, `envelope()`, `oauthRuntime` fixture를 재사용해 Claude entry, Codex entry, stale README entry 세 개를 만든다. 새 test의 핵심 assertion은 다음과 같다.

```javascript
const planned = planSummaryBundleReuse(items, cache);
assert.deepEqual([...planned.retained.keys()], ["owner/claude", "owner/codex"]);
assert.deepEqual(planned.pending.map(value => value.slug), ["owner/stale"]);
assert.equal(planned.retained.get("owner/codex").source.provider, "codex-cli");
```

Claude entry의 README SHA를 한 글자 바꾼 경우와 Codex model만 `codex-cli/gpt-5.6-terra`로 바꾼 경우는 각각 pending으로 이동해야 한다.

- [ ] **Step 2: Prepared set admission RED test를 쓴다**

test file에 다음 literal fixture helper를 먼저 둔다. expected source는 production helper로 계산하지 않는다.

```javascript
function preparedCodexFixture(entries) {
  const producer = {
    provider: "codex-cli",
    interface: "codex-exec",
    cli_version: "0.151.0",
    auth_method: "chatgpt_session",
    api_provider: "openai_first_party",
    model: "codex-cli/gpt-5.6-sol",
  };
  return {
    version: 1,
    facts_sha256: "f".repeat(64),
    producer,
    usage: { attempts: entries.length, input_tokens: 11, output_tokens: 7 },
    repositories: Object.fromEntries(entries.map(([entryItem, value]) => [entryItem.slug, {
      content: value.summaries.en,
      summaries: value.summaries,
      evidence: value.evidence,
      invariants: value.invariants,
      inference_fields: value.inference_fields,
      source: {
        kind: "readme",
        slug: entryItem.slug.toLowerCase(),
        path: entryItem.readme_path,
        blob_sha: entryItem.readme_blob_sha,
        content_sha256: entryItem.readme_content_sha256,
        ...producer,
        schema_version: 3,
        prompt_schema_version: 3,
        translation_applicable: false,
      },
    }])),
  };
}
```

```javascript
const admitted = admitPreparedCodexSet({
  value: preparedCodexFixture([[staleItem, envelope()]]),
  factsSha256: "f".repeat(64),
  pending: [staleItem],
});
assert.equal(admitted.runtime.provider, "codex-cli");
assert.equal(admitted.results.length, 1);
assert.deepEqual(admitted.usage, {
  inputTokens: 11,
  outputTokens: 7,
  logicalCalls: 1,
  attempts: 1,
  retries: 0,
});
```

같은 fixture에서 facts SHA, slug missing, extra slug, case-fold collision, README identity, producer model을 각각 하나씩 바꾼 table은 모두 throw해야 한다.

- [ ] **Step 3: RED가 missing functions 때문에 실패하는지 확인한다**

Run:

```powershell
node --test tests\summary-bundle-pipeline.test.mjs
```

Expected: 새 helper export가 없어서 FAIL한다.

- [ ] **Step 4: 기존 private logic을 이동해 최소 helper를 구현한다**

`sourceFor`는 `buildSummarySource`로 export하고 producer exact key를 검사한다. `reusableEntry`는 runtime 동등성이 아니라 다음 두 조건을 사용한다.

```javascript
const producer = Object.fromEntries([
  "provider", "interface", "cli_version", "auth_method", "api_provider", "model",
].map(key => [key, value.source[key]]));
return isSupportedSummaryProducer(producer)
  && validSourceIdentity(value.source, item)
  && validateStoredSummaryBundleEnvelope(/* exact stored fields */, item);
```

`planSummaryBundleReuse`는 case-fold cache를 한 번 만들고 facts 순서대로 retained/pending을 계산한다. `admitPreparedCodexSet`는 exact object keys, facts SHA, Codex producer, exact pending key set, 각 stored envelope와 source identity를 모두 다시 검사한다.

- [ ] **Step 5: GREEN과 세 mutation을 확인한다**

Run the focused test. Then one at a time remove README content SHA comparison, allow an unknown producer, and change exact pending equality to subset inclusion. Each mutation must make its owning test RED. Restore after each mutation and finish GREEN.

- [ ] **Step 6: Task 2를 commit한다**

```powershell
git add -- scripts/generate-summary-bundles.mjs tests/summary-bundle-pipeline.test.mjs
```

Run the Common Commit Gate, then:

```powershell
git commit -m "refactor: 요약 재사용과 prepared admission을 source 기준으로 분리"
```

---

### Task 3: Codex prepare/complete adapter를 checkout 밖에 구현

**Files:**
- Create: `scripts/codex-summary-bundle-adapter.mjs`
- Create: `tests/codex-summary-bundle-adapter.test.mjs`
- Read only: `scripts/claude-cli-runtime.mjs:63-169`

**Interfaces:**
- Consumes: Task 2의 `summaryItemsFromFacts`, `planSummaryBundleReuse`, `buildSummaryBundleRequest`, `buildSummarySource`.
- Consumes: Complete는 `sourceRoot`의 current source cache에서 exact pending을 독립 재계산하고 plan의 pending/requests와 대조한다.
- Produces: `runCodexSummaryPreflight({ runProcess, environment, cwd }): Promise<Producer>`.
- Produces: `parseCodexTurnEvents(bytes): { inputTokens, outputTokens }`.
- Produces: `prepareCodexSummaryBundle({ factsPath, sourceRoot, outDir, preflight }): Promise<Result>`.
- Produces: `completeCodexSummaryBundle({ factsPath, sourceRoot, planPath, responsesDir, outPath, preflight }): Promise<Result>`.
- Produces: CLI `prepare`와 `complete`; 두 command 모두 required `--source-root`를 받는다.

- [ ] **Step 1: Official JSONL usage fixture RED test를 쓴다**

OpenAI Codex tag `rust-v0.151.0`의 `codex-rs/exec/src/exec_events.rs`와 같은 fixture를 쓴다.

```javascript
const events = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  { type: "turn.completed", usage: {
    input_tokens: 11,
    cached_input_tokens: 2,
    cache_write_input_tokens: 0,
    output_tokens: 7,
    reasoning_output_tokens: 3,
  } },
].map(value => JSON.stringify(value)).join("\n") + "\n";
assert.deepEqual(parseCodexTurnEvents(Buffer.from(events)), { inputTokens: 11, outputTokens: 7 });
```

`turn.completed` 제거, `turn.failed` 삽입, negative token, duplicate JSON key, 마지막 JSON 절단은 각각 throw해야 한다.

- [ ] **Step 2: Preflight RED test를 쓴다**

Injected `runProcess`는 세 호출에 차례로 `codex-cli 0.151.0`, `Logged in using ChatGPT`, 실제 help flag 목록을 반환한다. assertion은 command가 `codex`, args가 `--version`, `login status`, `exec --help` 순서이고 반환 producer가 exact Codex profile인지 검사한다. 로그인 문자열이나 `--output-schema` flag가 빠진 fixture는 provider call 없이 throw해야 한다.

- [ ] **Step 3: Prepare RED test를 쓴다**

temp source에 source-identical entry 하나와 stale entry 하나를 둔다. `prepareCodexSummaryBundle` 실행 후 다음을 검사한다.

```javascript
async function exists(file) {
  return access(file).then(() => true, () => false);
}

assert.deepEqual(result.pending, ["owner/stale"]);
assert.equal(await exists(join(outDir, "request-000-prompt.txt")), true);
assert.equal(await exists(join(outDir, "request-000-schema.json")), true);
assert.equal(await exists(join(outDir, "request-001-prompt.txt")), false);
```

existing out-dir, checkout 내부 out-dir, sourceRoot로 resolve되는 symlink parent는 모두 write 전에 실패해야 한다.

- [ ] **Step 4: Complete RED test를 쓴다**

Prepare가 만든 plan, valid response JSON, Step 1 JSONL을 사용한다. complete output은 exact keys `version`, `facts_sha256`, `producer`, `usage`, `repositories`이고 repository entry는 `content`, `summaries`, `evidence`, `invariants`, `inference_fields`, `source`를 가진다. `sourceRoot`의 current source cache로 exact pending을 독립 재계산하므로 plan pending/requests를 함께 삭제한 변조도 output 전에 거부한다. plan의 facts, prompt, schema, README hash, 현재 CLI version을 각각 바꾼 fixture는 output file을 만들지 않아야 한다.

- [ ] **Step 5: RED를 실행한다**

```powershell
node --test tests\codex-summary-bundle-adapter.test.mjs
```

Expected: 새 module이 없어서 FAIL한다.

- [ ] **Step 6: 최소 adapter를 구현한다**

`runBoundedClaudeProcess`는 다음 import alias로 재사용한다. generic runner refactor는 하지 않는다.

```javascript
import { runBoundedClaudeProcess as runBoundedCliProcess } from "./claude-cli-runtime.mjs";
```

Prepare는 model을 호출하지 않고 `mkdir(..., { recursive: false })`와 `writeFile(..., { flag: "wx" })`만 사용한다. Complete는 모든 plan/hash/event/response를 검증한 뒤 마지막 한 번만 prepared output을 `wx`로 쓴다. response가 보낸 provenance는 읽지 않고 measured producer와 frozen item으로 source를 만든다.

- [ ] **Step 7: GREEN과 mutation을 확인한다**

Run the focused test. Then remove `turn.failed` rejection, replace exact pending equality with subset, and trust response provenance one at a time. Each mutation must be RED, followed by restore and GREEN.

- [ ] **Step 8: 실제 CLI preflight만 실행한다**

```powershell
codex --version
codex login status
codex exec --help | Select-String -Pattern 'ephemeral|ignore-user-config|output-schema|output-last-message|json|sandbox'
```

Expected: semver, ChatGPT login, 여섯 flag가 확인된다. 모델 request는 0회다.

- [ ] **Step 9: Task 3을 commit한다**

```powershell
git add -- scripts/codex-summary-bundle-adapter.mjs tests/codex-summary-bundle-adapter.test.mjs
```

Run the Common Commit Gate, then:

```powershell
git commit -m "feat: Codex v3 요약 prepare와 complete adapter 추가"
```

---

### Task 4: `--prepared-codex`를 기존 frozen pipeline에 연결

**Files:**
- Modify: `scripts/generate-summary-bundles.mjs:1128-1285`
- Modify: `tests/summary-bundle-pipeline.test.mjs`

**Interfaces:**
- Consumes: Task 2의 pure admission과 Task 3 prepared file shape.
- Produces: `runFrozenSummaryBundlePipeline({ preparedCodexPath })` optional input.
- Produces: CLI optional pair `--prepared-codex FILE`.
- Preserves: prepared option이 없을 때 기존 Claude preflight/request/usage contract.

- [ ] **Step 1: CLI와 branch-selection RED test를 쓴다**

Prepared path가 있을 때 injected Claude `preflight`와 `executeClaude` 호출 수가 모두 0이고, 없을 때 기존 Claude path가 1회 preflight되는 test를 추가한다. prepared file에 missing/extra entry를 넣은 경우 candidate cache, source registry, enrichment index bytes가 생성되지 않아야 한다.

- [ ] **Step 2: Mixed 42+2 contract RED test를 쓴다**

현재 cardinality와 같은 synthetic active set 44개를 만들고, source-identical 42개와 stale 두 slug를 계산하는 fixture를 사용해 다음을 고정한다. 이 test는 network나 시간에 의존하지 않는다.

```javascript
assert.equal(result.repositories, 44);
assert.equal(result.pending, 2);
assert.equal(result.runtime.provider, "codex-cli");
assert.equal(result.usage.logicalCalls, 2);
assert.deepEqual(Object.keys(result.index.repositories).sort(), activeSlugs.sort());
```

stale slug는 `kaifcodec/user-scanner`, `handsomestwei/patent-disclosure-skill`의 lowercase exact set이어야 한다.

- [ ] **Step 3: RED가 optional input 부재 때문에 실패하는지 확인한다**

```powershell
node --test tests\summary-bundle-pipeline.test.mjs
```

- [ ] **Step 4: Pipeline branch를 최소 변경한다**

공통 planning까지는 한 경로를 사용한다. `preparedCodexPath`가 있으면 Claude preflight 전에 prepared file을 strict parse하고 `admitPreparedCodexSet`을 호출한다. 없으면 기존 preflight와 `runClaudeSummaryBundleRequests`를 그대로 실행한다. 마지막 active-set loop는 각 entry 자기 source에 대해 `reusableEntry(entry, item)`을 호출한다.

Prepared usage는 기존 result shape로 다음처럼 변환한다.

```javascript
{
  inputTokens: prepared.usage.input_tokens,
  outputTokens: prepared.usage.output_tokens,
  logicalCalls: pending.length,
  attempts: prepared.usage.attempts,
  retries: 0,
}
```

- [ ] **Step 5: GREEN과 regression mutation을 확인한다**

Run the focused test. Then remove the prepared exact-set check and confirm RED. Restore it. Run the existing OAuth-preflight-failure test to prove the Claude default path still fails before model calls.

- [ ] **Step 6: Task 4를 commit한다**

```powershell
git add -- scripts/generate-summary-bundles.mjs tests/summary-bundle-pipeline.test.mjs
```

Run the Common Commit Gate, then:

```powershell
git commit -m "feat: frozen 요약 pipeline에 exact Codex prepared import 연결"
```

---

### Task 5: 모든 JS/Python consumer가 같은 두 profile을 독립 판정

**Files:**
- Modify: `scripts/validate-enrichment-coverage.mjs:8-52,84-115`
- Modify: `scripts/update-trending.mjs:896-922`
- Modify: `scripts/build-pages-artifact.mjs:6-130`
- Modify: `scripts/record_repository_observations.py:1371-1397`
- Modify: `tests/pages-publication.test.mjs:157-182,511-546`
- Modify: `tests/update-trending.test.mjs:868-921`
- Modify: `tests/test_repository_observations.py:347-361,1401-1466`

**Interfaces:**
- JS consumers import `isSupportedSummaryProducer` and keep their own exact source identity/key checks.
- Python recorder defines `_SUMMARY_PRODUCER_PROFILES` and `_supported_summary_producer(source)` independently.
- Every consumer admits exact Claude and Codex profiles and rejects a one-field hybrid.

- [ ] **Step 1: JS consumer mixed-profile RED tests를 쓴다**

`sourceEntry` fixture에 `producer = "claude"` option을 추가한다. 두 repository candidate에서 하나는 Claude, 하나는 Codex로 만들어 `buildPagesArtifact`와 `validateEnrichmentRoot`가 성공해야 한다. provider/interface/auth/API provider/model 중 하나만 서로 섞은 five-row mutation table은 두 consumer 모두 reject해야 한다.

- [ ] **Step 2: Render-only mixed-profile RED test를 쓴다**

`tests/update-trending.test.mjs`의 frozen render fixture에서 repository 두 개의 source를 각각 Claude/Codex로 둔다. rendered snapshot과 cache가 두 source를 그대로 보존하고 fetch count가 0인지 검사한다. Codex source를 Claude model로 바꾸면 render 전에 reject해야 한다.

- [ ] **Step 3: Python recorder RED test를 쓴다**

`writer_payload`에 optional `summary_source`를 받아 fixture source만 교체할 수 있게 한다. exact Codex source로 `_enrichment_hashes`와 candidate record가 성공하는 test, 다섯 provenance field를 하나씩 바꿔 모두 `ValueError`가 나는 subTest를 추가한다.

- [ ] **Step 4: Focused RED를 실행한다**

```powershell
node --test tests\pages-publication.test.mjs tests\update-trending.test.mjs
python -m unittest tests.test_repository_observations.RepositoryObservationTests
```

Expected: Codex profile admission test만 FAIL한다.

- [ ] **Step 5: JS consumer를 공통 helper로 최소 교체한다**

각 JS consumer는 identity, exact keys, schema/prompt/translation checks를 그대로 두고 여섯 provenance field만 다음 shape로 공통 판정한다.

```javascript
const producer = Object.fromEntries([
  "provider", "interface", "cli_version", "auth_method", "api_provider", "model",
].map(key => [key, source[key]]));
if (!isSupportedSummaryProducer(producer)) return false;
```

- [ ] **Step 6: Python에 독립 exact pair를 구현한다**

Python은 JS를 호출하지 않는다. 두 tuple profile과 exact semver를 검사하고 나머지 source identity/schema contract는 현 함수가 계속 검사한다.

- [ ] **Step 7: GREEN과 cross-language mutation을 확인한다**

Run the focused commands. Then JS에서 unknown producer를 허용하는 mutation과 Python에서 Codex model check를 제거하는 mutation을 각각 실행해 owning test가 RED인지 확인하고 원복한다.

- [ ] **Step 8: Task 5를 commit한다**

```powershell
git add -- scripts/validate-enrichment-coverage.mjs scripts/update-trending.mjs scripts/build-pages-artifact.mjs scripts/record_repository_observations.py tests/pages-publication.test.mjs tests/update-trending.test.mjs tests/test_repository_observations.py
```

Run the Common Commit Gate, then:

```powershell
git commit -m "feat: mixed Claude Codex 요약을 전 consumer에서 검증"
```

---

### Task 6: Code release와 finalized artifact redeploy 의미를 실행 결과로 구분

**Files:**
- Modify: `.github/workflows/deploy-current-pages.yml:1-80`
- Modify: `tests/deploy-current-pages-workflow.test.mjs:5-26`
- Modify: `tests/pages-publication.test.mjs:594-622`
- Modify: `scripts/build-pages-artifact.mjs:350-385`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md`

**Interfaces:**
- Workflow display name: `Redeploy finalized Pages artifact`.
- Behavior: old finalized contract + changed Pages byte는 artifact output 전에 `full refresh` 의미가 포함된 error로 실패.
- Behavior: current code로 새 contract를 만들면 build/probe가 성공.

- [ ] **Step 1: Release semantics RED integration test를 쓴다**

`tests/pages-publication.test.mjs`에서 valid contract를 만든 뒤 `index.html` 한 byte를 바꾼다.

```javascript
await writeFile(join(source, "index.html"), `${validPage}\nchanged code\n`);
await assert.rejects(
  buildPagesArtifact({ sourceRoot: source, outDir: oldOut, sourceSha, snapshotId, artifactContract: oldContract }),
  /full refresh/i,
);
await assert.rejects(readFile(join(oldOut, "deployment-manifest.json")));
const newContract = await artifactContract(source, latest, sources);
await buildPagesArtifact({ sourceRoot: source, outDir: newOut, sourceSha, snapshotId, artifactContract: newContract });
```

- [ ] **Step 2: Workflow name RED test를 바꾼다**

`tests/deploy-current-pages-workflow.test.mjs`는 새 display name을 요구하고 refresh, DB write, Claude/Codex 문자열이 workflow에 없음을 계속 검사한다.

- [ ] **Step 3: Focused RED를 실행한다**

```powershell
node --test tests\pages-publication.test.mjs tests\deploy-current-pages-workflow.test.mjs
```

- [ ] **Step 4: Error와 workflow 표시를 최소 수정한다**

Artifact path/hash/size mismatch error는 finalized snapshot bytes가 바뀌었고 code release에는 full refresh가 필요하다는 문장을 포함한다. Workflow의 파일명, trigger, permissions, build-before-upload 순서는 바꾸지 않는다.

- [ ] **Step 5: 운영 문서를 동기화한다**

두 README와 handoff에 다음 두 문장을 같은 의미로 적는다.

```text
Code release: 현재 Pages code bytes로 새 v1 snapshot을 record, derive, finalize한 뒤 배포한다.
Finalized artifact redeploy: 이미 finalize된 source와 byte-for-byte 같은 artifact만 다시 배포한다.
```

Codex fallback은 exact pending repository에만 쓰고 scheduled Daily Refresh의 Claude 기본 producer는 유지한다고 명시한다. 과거 production 성공 기록은 수정하지 않고 2026-09-01 superseding section을 추가한다.

- [ ] **Step 6: GREEN과 deploy-order mutation을 확인한다**

Run the focused tests. Then workflow에서 Upload step을 Build step 앞으로 옮긴 mutation이 workflow test를 RED로 만드는지 확인하고 원복한다. Artifact hash 비교를 제거한 mutation은 release integration test를 RED로 만들어야 한다.

- [ ] **Step 7: Task 6을 commit한다**

```powershell
git add -- .github/workflows/deploy-current-pages.yml scripts/build-pages-artifact.mjs tests/deploy-current-pages-workflow.test.mjs tests/pages-publication.test.mjs README.md README.ko.md docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md
```

Run the Common Commit Gate, then:

```powershell
git commit -m "docs: code release와 finalized artifact 재배포를 분리"
```

---

### Task 7: 전체 검증, review, branch push와 matching-SHA CodeQL

**Files:**
- Review: Task 1-6 전체 diff
- No production mutation after this task starts

**Interfaces:**
- Produces: focused/full test evidence, mutation evidence, clean staged secret scan, reviewable branch.
- Stops before: merge, refresh, Pages deploy.

- [ ] **Step 1: Focused matrix를 fresh 실행한다**

```powershell
node --test tests\summary-bundle-pipeline.test.mjs tests\codex-summary-bundle-adapter.test.mjs tests\pages-publication.test.mjs tests\update-trending.test.mjs tests\deploy-current-pages-workflow.test.mjs
python -m unittest tests.test_repository_observations.RepositoryObservationTests
```

Expected: exit code 0, fail 0.

- [ ] **Step 2: 전체 repository matrix를 실행한다**

```powershell
npm test
npm run test:rules
npm audit --omit=dev --audit-level=high
git diff --check
```

Expected: 모든 command exit code 0. `npm audit`의 production vulnerability는 0이다.

- [ ] **Step 3: actionlint 1.7.12를 digest 검증 후 실행한다**

```powershell
$actionlintRoot = Join-Path $env:TEMP 'actionlint-1.7.12-windows-amd64'
$actionlintZip = Join-Path $env:TEMP 'actionlint_1.7.12_windows_amd64.zip'
if (-not (Test-Path -LiteralPath $actionlintZip)) {
  Invoke-WebRequest -Uri 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_windows_amd64.zip' -OutFile $actionlintZip
}
$digest = (Get-FileHash -LiteralPath $actionlintZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9') { throw 'actionlint archive digest mismatch' }
if (-not (Test-Path -LiteralPath $actionlintRoot)) { Expand-Archive -LiteralPath $actionlintZip -DestinationPath $actionlintRoot }
$workflowFiles = @(Get-ChildItem -LiteralPath '.github/workflows' -Filter '*.yml' -File | Sort-Object FullName)
if ($workflowFiles.Count -eq 0) { throw 'No workflow files found' }
& (Join-Path $actionlintRoot 'actionlint.exe') -ignore 'label "github-pages-ubuntu-latest-8-core" is unknown' -ignore 'label "gh-trending-claude" is unknown' @($workflowFiles.FullName)
if ($LASTEXITCODE -ne 0) { throw 'actionlint failed' }
```

- [ ] **Step 4: Spec coverage와 placeholder를 자체 review한다**

각 spec section 1-15를 Task 1-8 중 하나에 매핑한다. 다음 scan은 match 0이어야 한다.

```powershell
$redFlags = @(('T'+'BD'),('FIX'+'ME'),('implement'+' later'),('fill in'+' details'),('추후'+' 결정'),('PLACE'+'HOLDER'))
rg -n ($redFlags -join '|') docs/superpowers/plans/2026-09-01-v3-codex-summary-fallback-release-semantics.md
if ($LASTEXITCODE -eq 0) { throw 'Plan placeholder found' }
```

- [ ] **Step 5: 최종 staged gate와 좌표 gate를 실행한다**

Stage only reviewed files, run the Common Commit Gate, then:

```powershell
git fetch --prune origin
$head = git rev-parse HEAD
$remote = git rev-parse refs/remotes/origin/main
git merge-base --is-ancestor $remote $head
if ($LASTEXITCODE -ne 0) { throw 'origin/main advanced outside the reviewed branch' }
git status --short
git diff --stat origin/main...HEAD
```

- [ ] **Step 6: branch를 push하고 PR을 만든다**

현재 작업 branch를 같은 이름으로 push한다. PR base는 `main`, body에는 RED/GREEN, mutation, 전체 suite, actionlint, production audit, 남은 merge/refresh/deploy gate를 적는다.

- [ ] **Step 7: PR head와 potential merge SHA를 검증한다**

PR head/base를 다시 조회하고, actual CodeQL analyses가 그 SHA를 대상으로 Python과 JavaScript/TypeScript 각각 하나씩 완료됐으며 `results_count == 0`인지 확인한다. `alerts?ref=`의 빈 응답만으로 통과를 선언하지 않는다.

- [ ] **Step 8: 사용자에게 merge와 Task 8 진행 승인을 요청한다**

보고에는 exact PR, head/base SHA, command exits, CodeQL run/analysis, 남은 provider call 2개와 production 변경을 분리해 적는다.

---

### Task 8: 새 v1 snapshot 생성, exact redeploy, production/auth 검증

**Files:**
- Generated by existing pipeline: `data/repository-observations.sqlite`, `data/latest.json`, `data/repo-summaries.json`, `data/translation-sources.json`, `data/membership-status.json`, `data/readme-state.json`, `star-history.json`, `feed.xml`, `changes.xml`, generated regions in `index.html`
- Temporary only: frozen facts/events, Codex plan/prompts/schemas/events/responses/prepared file, parent evidence, artifact contracts

**Interfaces:**
- Consumes: merged exact `origin/main`, Task 3 adapter, Task 4 prepared import.
- Produces: one new immutable v1 snapshot and one exact finalized Pages deployment.
- External calls: exactly one Codex turn per exact pending repository; current expected pending set is two.

- [ ] **Step 1: 이 운영 단계 시작 시 skill gate를 다시 실행한다**

사용자 지시대로 `find-skills`와 선호 스킬 기록을 다시 조회한다. Browser/auth 검증에는 그 시점에 설치된 browser skill을 재판정하고, 배포에는 검증된 skill만 쓴다.

- [ ] **Step 2: merge 뒤 exact clean main을 고정한다**

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\AppData\Local\Temp\gh-trending-page'
git fetch --prune origin
git switch main
git pull --ff-only origin main
if ((git status --short).Count -ne 0) { throw 'main worktree is not clean' }
if ((git rev-parse HEAD) -ne (git rev-parse refs/remotes/origin/main)) { throw 'main is not exact origin/main' }
```

- [ ] **Step 3: existing Daily Refresh prepare 과정을 수동 재현한다**

`.github/workflows/daily-refresh.yml`의 `Resolve verified production state`부터 `Collect complete repository events`까지 같은 순서와 같은 command를 checkout에서 실행한다. 모든 output은 다음 새 temp root 아래에 둔다.

```powershell
$refreshRoot = Join-Path $env:TEMP ("gh-trending-codex-refresh-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $refreshRoot | Out-Null
```

Facts/events 완료 조건은 strict parse 성공, active repository 44, facts/events binding hash 일치, provider call 0, tracked worktree clean이다.

- [ ] **Step 4: Codex request를 prepare한다**

```powershell
$adapterRoot = Join-Path $refreshRoot 'codex-adapter'
node scripts/codex-summary-bundle-adapter.mjs prepare --facts (Join-Path $refreshRoot 'repository-facts.json') --source-root (Join-Path $refreshRoot 'candidate') --out-dir $adapterRoot
```

Expected: exact pending slug가 `kaifcodec/user-scanner`, `handsomestwei/patent-disclosure-skill` 두 개이고 request file도 두 세트다. 다르면 model을 호출하지 않고 drift를 보고한다.

- [ ] **Step 5: 각 request를 한 번씩 수동 실행한다**

각 `000`, `001`에 대해 빈 cwd를 따로 만들고 다음 command를 실행한다. prompt는 stdin으로 전달하고 stdout JSONL은 events file에 보존한다.

```powershell
$responsesRoot = Join-Path $refreshRoot 'codex-responses'
New-Item -ItemType Directory -Path $responsesRoot | Out-Null
foreach ($suffix in @('000','001')) {
  $codexCwd = Join-Path $refreshRoot "codex-empty-cwd-$suffix"
  New-Item -ItemType Directory -Path $codexCwd | Out-Null
  $prompt = Join-Path $adapterRoot "request-$suffix-prompt.txt"
  $schema = Join-Path $adapterRoot "request-$suffix-schema.json"
  $response = Join-Path $responsesRoot "response-$suffix.json"
  $events = Join-Path $responsesRoot "events-$suffix.jsonl"
  Push-Location -LiteralPath $codexCwd
  try {
    Get-Content -LiteralPath $prompt -Raw | codex exec --ephemeral --ignore-user-config --model gpt-5.6-sol --sandbox read-only --output-schema $schema --output-last-message $response --json - 1> $events
    if ($LASTEXITCODE -ne 0) { throw "Codex request $suffix failed" }
  } finally {
    Pop-Location
  }
}
```

- [ ] **Step 6: responses를 complete하고 frozen pipeline에 import한다**

```powershell
$prepared = Join-Path $refreshRoot 'prepared-codex.json'
node scripts/codex-summary-bundle-adapter.mjs complete --facts (Join-Path $refreshRoot 'repository-facts.json') --source-root (Join-Path $refreshRoot 'candidate') --plan (Join-Path $adapterRoot 'plan.json') --responses-dir $responsesRoot --out $prepared
```

그 다음 existing `generate-summary-bundles.mjs` command에 `--prepared-codex $prepared`만 추가한다. 완료 조건은 retained Claude 42, new Codex 2, active 44, locales 220, missing/stale/insufficient source 0이다.

- [ ] **Step 7: existing record→derive→finalize→verify를 처음부터 끝까지 실행한다**

Daily workflow의 `Record core repository snapshot`, `Derive and render public artifacts`, `Finalize repository derivatives`, `Validate whole candidate`, `Build and probe validated candidate` command를 같은 순서로 실행한다. `verify-pages`가 새 snapshot의 current code hash contract를 export해야 한다.

- [ ] **Step 8: generated child commit을 검증·push한다**

Allowlisted generated paths만 stage하고 Common Commit Gate를 실행한다. DB sidecar, temp response, prompt, README full body가 staged되지 않았는지 확인한다. `git fetch --prune origin` 뒤 exact main이 전진하지 않았을 때만 `chore: refresh trending snapshot` commit과 push를 수행한다.

- [ ] **Step 9: finalized artifact redeploy를 한 번 실행한다**

새 generated commit이 `origin/main`과 exact하고 matching-SHA CodeQL이 끝난 뒤 `deploy-current-pages.yml`을 한 번 dispatch한다. run에서 refresh, DB write, Claude/Codex call은 0이어야 하며 build/probe가 upload 전에 성공해야 한다.

- [ ] **Step 10: production과 auth matrix를 검증한다**

Production `deployment-manifest.json`의 source SHA, snapshot ID, 20 artifact hash를 새 contract와 1:1 대조한다. HTTP 200, locale/period/sidebar 동작, Google login reload, 새 tab, BFCache, 브라우저 재시작, cross-tab logout, guest/account isolation을 actual browser에서 확인한다.

- [ ] **Step 11: 2시간 automation을 실행 가능 상태로 갱신한다**

현재 `github-trending-2` heartbeat를 같은 수동 runbook으로 갱신한다. 실행 전 exact main/clean/active-run 0을 확인하고, 각 run은 facts/events부터 새로 수집하며 exact pending만 provider로 생성한다. 종료 시각 `2026-09-02 20:00 KST`를 유지하고 그 시각 이후 automation을 삭제한다.

- [ ] **Step 12: 최종 좌표를 보고한다**

다음을 모두 보고한다: source 40-char SHA, snapshot ID, CodeQL run/analysis, deploy run, Pages deployment id, artifact count/bytes/hash 일치, provider별 entry 수, Codex usage 합계, production/auth matrix, automation next run/end time, clean `HEAD == origin/main`.
