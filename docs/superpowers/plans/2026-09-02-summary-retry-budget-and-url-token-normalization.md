# 요약 재시도 예산 비례화와 URL 토큰 정규화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** controlled run `33639446686`이 드러낸 두 구조적 원인 — pending 수와 무관한 고정 재시도 상한 12, 문장 부호에 취약한 URL invariant 토큰화 — 를 각각 한 곳에서 고쳐 다음 controlled dispatch가 enrichment를 완주할 수 있게 한다.

**Architecture:** `resolveClaudeCliSummaryRetryCap`이 모든 policy에서 `max(policy.retryAttempts, pending × MAX_REQUEST_RETRIES)`를 돌려준다(기존 bootstrap 분기를 일반화). `invariantTokens`의 URL 토큰에서 끝 문장 부호를 제거해 cross-locale 비교가 언어별 구두점에 흔들리지 않게 한다. validator·retry 구조·프롬프트는 바꾸지 않는다.

**Tech Stack:** Node.js 24 표준 라이브러리.

**Spec:** `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md` §3 10항(재시도 정책)·7항(cross-locale invariant 동일성). 10항의 "normal refresh의 전체 12 retry는 유지한다"는 이 계획으로 개정된다.

## 근거 (run 33639446686, 2026-09-02 23:02~23:21 KST)

- pending 37/54(README 변경 9 + 신규 28)인데 normal 모드 재시도 상한은 12. 14번째 초기 호출(`vercel-labs/portless`)에서 `retries=12` 도달 후 defects 3으로 fail-closed. 검증 통과한 13개 요약은 폐기.
- defect 중 `es.usage LOCALE_INVARIANT`는 expected/actual URL 개수가 1:1인데 mismatch. `invariantTokens`의 URL 정규식 `[^\s)>\]}]+`이 문장 끝 `.`을 토큰에 포함한다. 재현: `https://myapp.localhost` vs `https://myapp.localhost.`.
- 나머지 2건(`ko.fit`, `zh-CN.fit` OUTPUT_SCHEMA)은 교정 기회가 남지 않은 상태의 기록이다.

## Global Constraints

- fail-closed·검증 약화 금지. 프롬프트·correction schema·retry 구조·validator 규칙 집합은 바꾸지 않는다.
- 테스트·검증은 PowerShell에서 실행한다.
- RED 먼저, mutation 확인 후 원복, Common Commit Gate(`docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md` 참조) 통과 후 commit.
- merge·dispatch는 사용자 확인 뒤에만.

---

### Task 1: 재시도 상한을 모든 모드에서 pending 수에 비례시킨다

**Files:**
- Modify: `scripts/generate-summary-bundles.mjs:478-486` (`resolveClaudeCliSummaryRetryCap`)
- Modify: `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md:81` (§3 10항)
- Test: `tests/summary-bundle-pipeline.test.mjs:1431-1435`

- [ ] **Step 1: RED test** — 기존 test의 두 번째 단언을 바꾸고 하한 단언을 추가한다.

```js
test("retry capacity covers three bounded corrections per pending repository in every mode", async () => {
  const producer = await import("../scripts/generate-summary-bundles.mjs");
  assert.equal(producer.resolveClaudeCliSummaryRetryCap({ name: "bootstrap_v0_approved", retryAttempts: 12 }, 45), 135);
  assert.equal(producer.resolveClaudeCliSummaryRetryCap({ name: "normal", retryAttempts: 12 }, 45), 135);
  assert.equal(producer.resolveClaudeCliSummaryRetryCap({ name: "normal", retryAttempts: 12 }, 2), 12);
});
```

- [ ] **Step 2: RED 확인** — Run: `node --test --test-name-pattern="retry capacity" tests/summary-bundle-pipeline.test.mjs`. Expected: FAIL, actual 12 expected 135.

- [ ] **Step 3: 최소 구현**

```js
export function resolveClaudeCliSummaryRetryCap(policy, pendingRepositories) {
  if (!policy || typeof policy.name !== "string" || !Number.isSafeInteger(policy.retryAttempts) || policy.retryAttempts < 0
      || !Number.isSafeInteger(pendingRepositories) || pendingRepositories < 0 || pendingRepositories > MAX_REPOSITORIES) {
    throw new Error("Claude summary retry policy is invalid");
  }
  // 2026-09-02: a refresh after any stall carries bootstrap-scale pending work,
  // so every mode gets three bounded corrections per pending repository.
  return Math.max(policy.retryAttempts, pendingRepositories * MAX_REQUEST_RETRIES);
}
```

- [ ] **Step 4: GREEN** — 같은 명령. Expected: PASS.
- [ ] **Step 5: mutation** — `Math.max(...)`를 `policy.retryAttempts`로 되돌리면 RED. 원복 후 GREEN.
- [ ] **Step 6: 문서** — handoff §3 10항 "normal refresh의 전체 12 retry는 유지한다."를 "재시도 상한은 모든 모드에서 `max(12, pending × 3)`이다(2026-09-02 개정, run 33639446686 근거)."로 바꾼다.
- [ ] **Step 7: Commit** — `feat: 요약 재시도 상한을 모든 모드에서 pending 수에 비례시킴`

### Task 2: URL invariant 토큰에서 끝 문장 부호를 제거한다

**Files:**
- Modify: `scripts/generate-summary-bundles.mjs:166-172` (`invariantTokens`)
- Test: `tests/summary-bundle-pipeline.test.mjs` (Task 1 test 뒤에 추가)

- [ ] **Step 1: RED test**

```js
test("URL invariants ignore trailing sentence punctuation across locales", () => {
  const urlMarkdown = "# Repository\n\nInstall with `npm install` and run `npm test`. Docs: https://example.com/docs";
  const urlItem = {
    ...item,
    markdown: urlMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(urlMarkdown, "utf8")).digest("hex"),
  };
  const value = modelEnvelope();
  value.summaries.en.usage += " Read https://example.com/docs before deploying.";
  value.summaries.ko.usage += " 배포 전에 https://example.com/docs.";
  value.summaries["zh-CN"].usage += " 部署前请阅读 https://example.com/docs。";
  value.summaries.es.usage += " Lea https://example.com/docs.";
  value.summaries.ja.usage += " https://example.com/docs、を参照してください。";

  const checked = validateSummaryBundleEnvelope(value, urlItem);
  assert.equal(checked.summaries.es.usage.endsWith("https://example.com/docs."), true);

  const different = structuredClone(value);
  different.summaries.es.usage = different.summaries.es.usage.replace("https://example.com/docs.", "https://example.com/other.");
  assert.throws(() => validateSummaryBundleEnvelope(different, urlItem), /invariant|locale/i);
});
```

- [ ] **Step 2: RED 확인** — Run: `node --test --test-name-pattern="trailing sentence punctuation" tests/summary-bundle-pipeline.test.mjs`. Expected: FAIL with `Summary bundle cross-locale invariant mismatch in usage`.

- [ ] **Step 3: 최소 구현** — `invariantTokens`의 urls 줄을 다음과 같이 바꾼다. RED 실행에서 일본어 fixture(`https://example.com/docs、を参照`)가 URL 뒤에 공백 없이 CJK 문자를 붙여 같은 토큰화 문제의 두 번째 양상을 드러냈으므로, URL 토큰을 ASCII(RFC 3986)로 한정하고 끝 문장 부호를 제거한다:

```js
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?、。]+$/u;
    urls: [...text.matchAll(/https?:\/\/[^\s)>\]}\u0080-\uffff]+/g)].map(match => match[0].replace(TRAILING_SENTENCE_PUNCTUATION, "")).sort(),
```

- [ ] **Step 4: GREEN** — 같은 명령 + `node --test tests/summary-bundle-pipeline.test.mjs`. Expected: 전부 PASS.
- [ ] **Step 5: mutation** — `.replace(...)`를 제거하면 es/ko/zh-CN에서, ASCII 한정(`\u0080-\uffff`)을 제거하면 ja에서 새 test RED. 각각 원복 후 GREEN.
- [ ] **Step 6: Commit** — `fix: URL invariant 토큰에서 끝 문장 부호를 제거해 locale 구두점 오탐 방지`

### Task 3: 검증·push·PR·CodeQL → merge 승인 → controlled dispatch 1회

- `npm test`(PowerShell) 전체, `git diff --check`, workflow·`data/` 변경 0줄, 비밀값 스캔.
- 독립 리뷰는 fable 5.1 서브에이전트(읽기 전용).
- push → PR → matching-SHA CodeQL → 사용자 merge 승인 → exact main 재측정 → runner online 확인 → `gh workflow run daily-refresh.yml --ref main` 1회.
- 실패하면 blind retry 없이 `wait-what`으로 기존 결정을 뒤엎는 재설계에 들어간다(사용자 지시 2026-09-02).
