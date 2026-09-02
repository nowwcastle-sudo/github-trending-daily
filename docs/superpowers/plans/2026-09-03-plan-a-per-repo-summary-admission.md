# Plan A — Repository 단위 요약 admission과 validator 재분류 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 요약 산문 품질 실패를 repository 하나로 격리해(`verified | retained | held`) 다른 repo의 검증 통과 요약이 같은 run에서 publish되게 하고, validator 규칙을 hard/warning으로 재분류한다.

**Architecture:** `generate-summary-bundles.mjs`의 validator는 hard defect만 throw하고 warning은 반환값에 싣는다. `runClaudeSummaryBundleRequests`는 repo 하나의 종료 실패를 `held` 결과로 바꿔 run을 계속한다. `runFrozenSummaryBundlePipeline`은 `enrichment-index.json` v2에 repo별 status를 쓰고 held 비율 ≤ 50%를 강제한다. 렌더러·coverage validator·recorder는 held repo를 "요약 없음 + 상태"로 다룬다. DB 스키마는 바꾸지 않는다(held는 sentinel digest로 기록).

**Tech Stack:** Node.js 24, Python 3.13, SQLite. 신규 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-09-03-per-repo-summary-admission-and-star-ticks-design.md` §3·§4.1·§4.2·§5.3·§6·§7.

## Global Constraints

- hard gate(envelope shape, evidence 결합, README provenance, command/URL parity, number/version/product README 존재, generic/placeholder)는 그대로 throw한다. warning은 correction을 유발하지 않는다.
- `data/repo-summaries.json`에는 `verified`·`retained`만 들어간다. held repo 항목은 절대 없다("README 참고" 등 generic 문구 금지).
- DB 스키마·schema fingerprint·append-only 트리거 불변. `snapshot_items.summary_*_sha256`(NOT NULL)에는 held sentinel digest를 쓴다.
- 재시도 상한 `max(12, pending×3)`, repo당 초기+3 교정 유지. 한 repo 실패가 다른 repo 시도를 막지 않는다.
- 기존 규칙 "held ratio > 50% → run 실패".
- 사양서 §4.1의 "검증 통과 bundle 즉시 캐시 기록"은 이 계획에서 **구현하지 않는다**(run 크래시 시 지속성 문제라 admission이 폐기 문제를 해결한 뒤 별도 후속). 사양서 §4.1 해당 문장을 Task 7에서 "후속"으로 고친다.
- RED 먼저, mutation 확인 후 원복, Common Commit Gate(`docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md`) 통과 후 commit. 테스트는 PowerShell.
- branch: `claude/plan-a-per-repo-admission-20260903`. merge·dispatch는 사용자 확인 뒤.

## File Structure

- Modify: `scripts/generate-summary-bundles.mjs` — validator 재분류(`checkedSummaryBundle`, `validateSummaryBundleEnvelopeShape`), 상수 `CANONICAL_NUMBER_INVARIANT_RE` 삭제, `runClaudeSummaryBundleRequests` held 결과, `runFrozenSummaryBundlePipeline` index v2·held 비율·cache 구성, failure diagnostics → `enrichment-held.json` 의미로 확장
- Modify: `scripts/validate-enrichment-coverage.mjs` — `--enrichment-index` 인자, held 허용, cache에 held 부재 검사
- Modify: `scripts/update-trending.mjs` — `renderRepositoryFacts`·`assertCompleteSummary`·`createPageSnapshot`·`validateFrozenEnrichmentIndex`·`renderFrozenCandidate` held 처리
- Modify: `scripts/record_repository_observations.py` — `_enrichment_hashes` held sentinel
- Modify: `index.html`(tooltip held 문구), `site-i18n.js`(`summary.held` 5 locale), `current-view-export.js`(summary null 허용)
- Modify: `.github/workflows/daily-refresh.yml` — coverage 명령에 `--enrichment-index`, held diagnostics 업로드 조건
- Tests: `tests/summary-bundle-pipeline.test.mjs`, `tests/update-trending.test.mjs`, `tests/test_repository_observations.py`, `tests/page-runtime.test.mjs`, `tests/pages-publication.test.mjs`, `tests/daily-refresh-workflow.test.mjs`
- Docs: `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md` §3 8·9항, 사양서 §4.1 한 문장

---

### Task 0: branch

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\AppData\Local\Temp\gh-trending-page'
git fetch --prune origin; git switch main; git pull --ff-only origin main
if ((git status --short).Count -ne 0) { throw 'main worktree is not clean' }
if ((git rev-parse HEAD) -ne (git rev-parse refs/remotes/origin/main)) { throw 'main is not exact origin/main' }
git switch -c claude/plan-a-per-repo-admission-20260903
```

### Task 1: validator를 hard/warning으로 재분류한다

**Files:** `scripts/generate-summary-bundles.mjs:45`(상수), `:95-130`(`checkedSummaryBundle`), `:246-330`(`validateSummaryBundleEnvelopeShape`); `tests/summary-bundle-pipeline.test.mjs`

**Interfaces:**
- `validateSummaryBundleEnvelope(value, item)` / `validateStoredSummaryBundleEnvelope(value, item)`는 hard defect 없으면 `{ summaries, evidence, invariants, inference_fields, warnings }`를 돌려준다. `warnings[]` 원소는 `{ code, locale?, field?, invariant? }`(code ∈ `LOCALE_INVARIANT_NUMBERS`, `INVARIANT_FIELDS_SOFT`, `INFERENCE_HEDGE`, `UNSUPPORTED_MARKETING`, `LENGTH_CONTRACT`, `FIELD_REPETITION`).
- hard defect가 있으면 기존대로 throw(`error.qualityDefects` = hard만).
- 분류표(사양서 §4.2): hard = envelope/schema shape, evidence, README provenance, `GENERIC_OR_PLACEHOLDER`, `LOCALE_INVARIANT`(command/url cross-locale mismatch, invariant absent from README, invariant schema invalid, inference field set invalid), `INVARIANT_FIELDS`(kind command/url). warning = 위 목록.

- [ ] **Step 1: RED tests** — `tests/summary-bundle-pipeline.test.mjs`에 추가(fixture `item`, `modelEnvelope`, `SUMMARY_BUNDLE_LOCALES` 재사용):

```js
test("number invariants that are literal README substrings are accepted without canonical normalization", () => {
  const md = "# Repository\n\nBaseline spends 15,704 tokens and regresses 9.9 percent. Run `npm test`.";
  const numberItem = { ...item, markdown: md, readme_content_sha256: createHash("sha256").update(Buffer.from(md, "utf8")).digest("hex") };
  const value = modelEnvelope();
  for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].usage += " 15,704 / 9.9 percent.";
  value.invariants.push({ kind: "number", value: "15,704" }, { kind: "number", value: "9.9 percent" });
  const checked = validateSummaryBundleEnvelope(value, numberItem);
  assert.deepEqual(checked.invariants.slice(-2).map(v => v.value), ["15,704", "9.9 percent"]);
  assert.deepEqual(checked.warnings, []);
  const absent = structuredClone(value);
  absent.invariants.push({ kind: "number", value: "42,000" });
  assert.throws(() => validateSummaryBundleEnvelope(absent, numberItem), /absent from README/);
});

test("number and product cross-locale differences are warnings while command and URL differences stay hard", () => {
  const value = modelEnvelope();
  value.summaries.es.usage += " 3 pasos.";
  const checked = validateSummaryBundleEnvelope(value, item);
  assert.deepEqual(checked.warnings.map(w => [w.code, w.locale, w.field]), [["LOCALE_INVARIANT_NUMBERS", "es", "usage"]]);
  const command = modelEnvelope();
  command.summaries.ja.goal = command.summaries.ja.goal.replace("`npm test`", "`npm run test`");
  assert.throws(() => validateSummaryBundleEnvelope(command, item), /invariant|command|locale/i);
});

test("missing inference hedges, marketing language, and length are warnings", () => {
  const value = modelEnvelope();
  value.inference_fields = ["fit"];
  value.summaries.en.fit = "It is the best tool for every team.";
  const checked = validateSummaryBundleEnvelope(value, item);
  const codes = checked.warnings.map(w => w.code);
  assert.ok(codes.includes("INFERENCE_HEDGE"));
  assert.ok(codes.includes("UNSUPPORTED_MARKETING"));
});
```

기존 test 중 `INVARIANT_DECLARATION`·hedge·marketing·length가 throw할 것을 기대하는 단언은 warning 반환 단언으로 바꾼다(각각 이름을 유지하고 기대만 수정; 목록은 실행 시 `grep -n "INVARIANT_DECLARATION\|inference strength\|marketing\|LENGTH_CONTRACT" tests/summary-bundle-pipeline.test.mjs`로 확정하고 커밋 메시지에 열거).

- [ ] **Step 2: RED 확인** — `node --test --test-name-pattern="canonical normalization|warnings while command|are warnings" tests/summary-bundle-pipeline.test.mjs` → FAIL(현재는 throw 또는 `warnings` undefined).

- [ ] **Step 3: 최소 구현**
  1. `CANONICAL_NUMBER_INVARIANT_RE` 상수와 `:246-252`의 `INVARIANT_DECLARATION` 분기, `:924-927`의 correction 문구 삭제.
  2. `checkedSummaryBundle`: `FIELD_REPETITION`·`LENGTH_CONTRACT`·marketing 검출을 `defects` 대신 `warnings` 배열에 push하고 `{ result, defects, warnings }` 반환. `GENERIC_OR_PLACEHOLDER`는 defects 유지.
  3. `validateSummaryBundleEnvelopeShape`: `const warnings = shape.warnings` 로 시작. invariant fields mismatch(`:274-288`)는 `invariant.kind`가 `command`/`url`이면 defects, 아니면 `warnings.push({ code: "INVARIANT_FIELDS_SOFT", locale, invariant: exact })`. cross-locale token 비교(`:301`)를 셋으로 나눠 commands/urls 불일치는 defects(`LOCALE_INVARIANT`), numbers 불일치는 `warnings.push({ code: "LOCALE_INVARIANT_NUMBERS", locale, field })`. hedge(`:318-325`)는 `warnings.push({ code: "INFERENCE_HEDGE", locale, field })`.
  4. 반환값에 `warnings` 추가. `throwQualityDefects(defects)`는 hard만.
  5. `correctionSchema`/`correctionTargets`(`:560-660`)는 `error.qualityDefects`만 보므로 변경 없음. `promptDefectDiagnostic`에서 `INVARIANT_DECLARATION` 분기 제거.

- [ ] **Step 4: GREEN** — `node --test tests/summary-bundle-pipeline.test.mjs`.
- [ ] **Step 5: mutation** — numbers 불일치를 다시 defects로 넣으면 두 번째 test FAIL; 원복 후 GREEN.
- [ ] **Step 6: Commit** — `feat: 요약 validator를 hard/warning으로 재분류하고 canonical number 정규식을 제거`

### Task 2: 한 repository의 종료 실패를 `held` 결과로 바꾼다

**Files:** `scripts/generate-summary-bundles.mjs:1093-1233`(`runClaudeSummaryBundleRequests`, `requestOneWithClaude`); `tests/summary-bundle-pipeline.test.mjs`

**Interfaces:**
- `runClaudeSummaryBundleRequests(...)` → `{ results, usage, runtime, held }`. `results[i]`는 verified bundle(`warnings` 포함) 또는 `null`. `held[i]`(results가 null인 index만) = `{ slug, reason: "quality_defects"|"insufficient_source"|"budget_exhausted"|"deadline_exhausted", defect_codes: string[], diagnostic }`(diagnostic은 기존 `summaryFailureDiagnostic` 형태의 bounded 객체).
- fatal(run 전체 중단)은 provider 인증·프로세스 실행 오류(`CLAUDE_REQUEST_FAILURE_CODES` 중 auth/process/schema)만. `CLAUDE_RATE_LIMITED`·timeout·deadline·retryCap 소진·quality는 held.

- [ ] **Step 1: RED tests** — 기존 `runClaudeSummaryBundleRequests` fixture(`executeClaude` stub)를 쓰는 test 구간 뒤에:

```js
test("one repository exhausting its corrections is held while the others are verified", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item, { ...item, slug: "owner/second" }], { retryAttempts: 12 });
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan, runProcess: () => {}, preflightResult: producerFixture(),
    executeClaude: async ({ prompt }) => {
      calls += 1;
      const bad = prompt.includes("owner/second");
      const output = modelEnvelope();
      if (bad) output.summaries.es.cons = "Consulte el README.";
      return { structuredOutput: output, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    deadline: Date.now() + 60_000,
  });
  assert.equal(result.results[0]?.summaries?.en?.goal?.length > 0, true);
  assert.equal(result.results[1], null);
  assert.equal(result.held[1].reason, "quality_defects");
  assert.deepEqual(result.held[1].defect_codes, ["GENERIC_OR_PLACEHOLDER"]);
  assert.equal(calls, 1 + 4);
});

test("a rate limit holds the remaining repositories as budget_exhausted instead of failing the run", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item, { ...item, slug: "owner/second" }], { retryAttempts: 12 });
  const result = await runClaudeSummaryBundleRequests({
    plan, runProcess: () => {}, preflightResult: producerFixture(), concurrency: 1,
    executeClaude: async ({ prompt }) => {
      if (prompt.includes("owner/second")) throw Object.assign(new Error("429"), { failureCode: "CLAUDE_RATE_LIMITED" });
      return { structuredOutput: modelEnvelope(), usage: { inputTokens: 1, outputTokens: 1 } };
    },
    deadline: Date.now() + 60_000,
  });
  assert.equal(result.held[1].reason, "budget_exhausted");
  assert.notEqual(result.results[0], null);
});
```

`producerFixture()`는 파일에 이미 있는 preflight 결과 fixture 이름으로 맞춘다(실행 시 `grep -n "preflightResult" tests/summary-bundle-pipeline.test.mjs`로 확정).

- [ ] **Step 2: RED 확인** — 첫 test는 현재 `fatal`로 reject되어 FAIL.
- [ ] **Step 3: 최소 구현** — worker의 `catch`에서 `fatal ??= failure; return;` 대신:

```js
        const reason = failure.quality === true ? (failure.insufficientSource ? "insufficient_source" : "quality_defects")
          : failure.message === "Summary bundle deadline is exhausted" ? "deadline_exhausted"
          : runtimeBudgetExhausted(failure, execution) ? "budget_exhausted"
          : null;
        if (reason === null) { fatal ??= failure; return; }
        results[index] = null;
        held[index] = { slug: plan.items[index].slug, reason, defect_codes: defectCodes(failure), diagnostic: boundedDiagnostic(failure, plan.items[index].slug) };
```

`runtimeBudgetExhausted`는 `failure.failureCode === "CLAUDE_RATE_LIMITED" || execution.retries >= execution.retryCap`. `boundedDiagnostic`은 기존 `fatal.summaryFailureDiagnostic` 조립 코드를 함수로 추출한 것(내용 동일). rate limit 이후 남은 요청은 `execution.retries >= execution.retryCap`이 아니어도 `held(budget_exhausted)`로 즉시 표시하도록 `execution.exhausted = true` 플래그를 두고 worker 루프 시작에서 확인한다. 반환에 `held` 추가.

- [ ] **Step 4: GREEN**, **Step 5: mutation**(`reason === null` 조건을 항상 true로 바꾸면 첫 test FAIL), **Step 6: Commit** — `feat: 요약 요청 실패를 repository 단위 held 결과로 격리`

### Task 3: frozen pipeline이 index v2를 쓰고 held 비율을 강제한다

**Files:** `scripts/generate-summary-bundles.mjs:1236-1360`; `tests/summary-bundle-pipeline.test.mjs`(frozen pipeline fixture)

**Interfaces:**
- `enrichment-index.json` v2: `{ version: 2, snapshotId, activeSetSha256, factsSha256, sourceSetSha256, runContextSha256, eventsSha256, repositories: { [slugLower]: { status: "verified"|"retained"|"held", summary?, summaries?, evidence?, invariants?, inference_fields?, warnings: [], held_reason?, defect_codes? } }, held_ratio }`.
- `data/repo-summaries.json`·`translation-sources.json`에는 verified·retained만.
- held 비율 = held / active > 0.5 → throw `"Summary bundle held ratio exceeds 50%"`.
- `--failure-diagnostics-out` 파일은 held ≥ 1이면 성공 run에도 쓴다: `{ version: 2, held: [diagnostic...] }`.

- [ ] **Step 1: RED tests** — 기존 frozen pipeline test fixture를 복제해 두 repo 중 하나가 held일 때: 반환 `{ repositories: 2, pending: 2, held: 1 }`, index v2에 `status` 3종, cache 파일에 held slug 없음; held 2/2이면 throw `/held ratio/`.
- [ ] **Step 2: RED 확인**, **Step 3: 최소 구현** — `:1305-1335` 루프: `completed.results[index] === null`이면 `repositories[slug] = { status: "held", held_reason, defect_codes, warnings: [] }`, 아니면 retained set + `status: "verified"`; 기존 retained(재사용)는 `status: "retained"`. `if (!entry || !reusableEntry(entry, item))` 검사는 held가 아닌 항목에만. held ratio 계산·throw. index `version: 2`. diagnostics 파일 쓰기(`--failure-diagnostics-out` 경로는 CLI가 이미 받음).
- [ ] **Step 4: GREEN**, **Step 5: mutation**(ratio 비교를 `> 1`로 바꾸면 RED), **Step 6: Commit** — `feat: enrichment index v2에 repository 상태를 기록하고 held 비율 50%를 강제`

### Task 4: 렌더러·페이지·export가 held를 표현한다

**Files:** `scripts/update-trending.mjs:922-960, 1058-1066, 1117-1150, 1396-1410, 1442-1500`; `index.html:995` 근처 tooltip; `site-i18n.js`; `current-view-export.js`; tests `update-trending.test.mjs`, `page-runtime.test.mjs`

**Interfaces:**
- page REPOS 항목: held면 `summary: null, summaries: null, detail: null, summary_status: "held", held_reason`. verified/retained면 기존 + `summary_status: "verified"|"retained"`.
- `createPageSnapshot`은 held repo를 cache에 넣지 않는다. `assertCompleteSummary`는 `summary_status === "held"`면 summary 검사를 건너뛴다(gain·classification 검사는 유지).
- i18n key `summary.held`: en "Summary is being verified. Open the README for details.", ko "요약 검증 중입니다. 자세한 내용은 README를 여세요.", zh-CN "摘要正在验证中。详情请查看 README。", es "El resumen se está verificando. Abra el README para más detalles.", ja "要約を検証中です。詳細は README をご覧ください。" — 이 문구는 **LLM 산출물이 아니라 static UI 문구**이며 `data/repo-summaries.json`에 들어가지 않으므로 generic 금지 규칙과 충돌하지 않는다.
- export(CSV/JSON): summary 필드는 빈 문자열/`null`, `summary_status` 열 추가는 하지 않는다(열 계약 13개 유지).

- [ ] **Step 1: RED tests** — `update-trending.test.mjs`: index v2에 held 1개인 `renderFrozenCandidate` → page REPOS의 그 항목 `summary_status: "held"`, `summary: null`, cache에 없음; `page-runtime.test.mjs`: held repo 카드 hover 시 tooltip에 `summary.held` 문구(locale ko) 표시, README 버튼은 동작.
- [ ] **Step 2: RED 확인**, **Step 3: 최소 구현** — 위 인터페이스대로. `validateFrozenEnrichmentIndex`는 `status === "held"`면 `exactObjectKeys(entry, ["status","held_reason","defect_codes","warnings"])`만 요구.
- [ ] **Step 4: GREEN**, **Step 5: mutation**(held를 verified로 렌더하면 `assertCompleteSummary` RED), **Step 6: Commit** — `feat: held repository를 요약 없음 상태로 렌더하고 5 locale 고정 문구를 표시`

### Task 5: recorder·coverage·workflow가 held를 받아들인다

**Files:** `scripts/record_repository_observations.py`(`_enrichment_hashes`, `_enrichment_entry`); `scripts/validate-enrichment-coverage.mjs`; `.github/workflows/daily-refresh.yml`(`Validate whole candidate` 명령, diagnostics 업로드 `if`); tests `test_repository_observations.py`, `pages-publication.test.mjs`, `daily-refresh-workflow.test.mjs`

**Interfaces:**
- recorder: index entry `status === "held"`면 `summary_source_sha256 = digest({"kind":"held","slug":slug,"reason":held_reason,"schema_version":3})`, `summary_content_sha256 = digest({"status":"held"})`, `summary_envelope_sha256 = digest({"content":{"status":"held"},"source":{...}})`, `translation_status = "not_applicable:no_prose"`(readme 있음) 또는 `"not_applicable:no_readme"`. 스키마 무변경.
- coverage: `--enrichment-index FILE` 필수. active set = page REPOS = facts = index keys. cache/source exact set = index의 verified+retained. held slug가 cache에 있으면 throw. counts에 `held` 추가.
- workflow: `node scripts/validate-enrichment-coverage.mjs --root … --facts … --enrichment-index "${RUNNER_TEMP}/enrichment-index.json" --json-counts`; `Upload bounded enrichment failure diagnostics`의 `if:`를 `always()` + 파일 존재로.

- [ ] **Step 1: RED tests** — Python: index에 held 1개 포함 `record_writer_snapshot` → snapshot_items 행 존재, sentinel digest 일치; coverage: held slug가 cache에 있으면 throw, 없으면 counts.held 1; workflow test: coverage 명령에 `--enrichment-index` 포함.
- [ ] **Step 2~6** — RED → 구현 → GREEN → mutation(sentinel 대신 빈 문자열이면 CHECK 위반으로 RED) → Commit `feat: recorder·coverage·workflow가 held repository를 받아들임`

### Task 6: 전체 검증·리뷰·push·PR·CodeQL

- `npm test`, `npm run test:rules`(PowerShell). `git diff --check main...HEAD`. workflow diff는 coverage 명령·업로드 조건 두 hunk만. `data/` 변경 0.
- 독립 리뷰: fable 5.1(읽기 전용). push → PR → matching-SHA CodeQL → **merge 승인 요청**(Plan B와 함께 merge 후 W1 dispatch 1회).

### Task 7: 문서

- handoff §3 8항 → "5개 locale은 한 묶음이며 한 locale 결함은 그 repository를 held로 만든다. candidate는 held ≤ 50%면 publish된다." 9항 → "`insufficient_source`·상한 소진은 held다. generic fallback 문구 금지는 유지한다."
- 사양서 §4.1 "검증 통과 bundle은 완료 즉시 candidate cache에 기록한다" → "run 종료 시 일괄 기록한다. 크래시 시 지속성은 §9 후속."
- Commit `docs: 정본 §3 8·9항을 repository 단위 admission으로 개정`
