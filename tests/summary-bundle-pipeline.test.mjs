import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  SUMMARY_BUNDLE_LOCALES,
  buildSummaryBundleRequest,
  measureSummaryBundlePlan,
  resolveFreeLlmApiChatUrl,
  runSummaryBundleRequests,
  validateSummaryBundle,
  validateSummaryBundleEnvelope,
} from "../scripts/generate-summary-bundles.mjs";

const fields = ["goal", "usage", "pros", "cons", "fit"];

const localeLead = {
  en: "This field explains the repository with concrete technical context for developers evaluating adoption.",
  ko: "이 필드는 도입을 검토하는 개발자가 판단할 수 있도록 저장소의 구체적인 기술 맥락을 설명합니다.",
  "zh-CN": "此字段为评估采用方案的开发者说明该仓库的具体技术背景和实际约束。",
  es: "Este campo explica el repositorio con contexto técnico concreto para desarrolladores que evalúan su adopción.",
  ja: "この項目は導入を検討する開発者向けに、リポジトリの具体的な技術背景と制約を説明します。",
};

function detailed(locale) {
  return Object.fromEntries(fields.map((field, index) => {
    const suffix = locale === "en"
      ? `For ${field}, it identifies documented behavior, the relevant workflow, and a distinct practical consideration without repeating another section. The explanation preserves TestProduct ${index + 1}.0 and the exact command \`npm test\` while separating confirmed facts from cautious implications for a real project.`
      : `${field} 항목 ${index + 1}.0은 문서화된 동작과 실제 적용 조건을 다른 필드와 겹치지 않게 구분하며 TestProduct와 정확한 명령 \`npm test\`를 동일하게 보존합니다.`;
    return [field, `${localeLead[locale]} ${suffix}`];
  }));
}

function bundle() {
  return Object.fromEntries(SUMMARY_BUNDLE_LOCALES.map(locale => [locale, detailed(locale)]));
}

const markdown = "# Repository\n\nInstall with `npm install` and run `npm test`. It is designed for source-bound examples.";
const item = {
  slug: "owner/repo",
  readme_path: "README.md",
  readme_blob_sha: "a".repeat(40),
  readme_content_sha256: createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex"),
  default_branch_head_sha: "c".repeat(40),
  markdown,
};

function envelope() {
  return {
    summaries: bundle(),
    evidence: Object.fromEntries(fields.map(field => [field, [{ start_line: 1, end_line: 3, section_heading: "Repository" }]])),
    invariants: [{ kind: "command", value: "npm test", fields: [...fields] }],
    inference_fields: [],
  };
}

test("summary bundle accepts exactly five complete locales and rejects generic README fallbacks", () => {
  assert.deepEqual(Object.keys(validateSummaryBundle(bundle())), SUMMARY_BUNDLE_LOCALES);
  assert.throws(() => validateSummaryBundle({ ...bundle(), ja: undefined }), /locale|schema/i);
  const generic = bundle();
  generic.ko.usage = "자세한 내용은 README를 참고하세요.";
  assert.throws(() => validateSummaryBundle(generic), /generic|placeholder|README/i);
});

test("the shared summary contract validates README evidence and cross-locale invariants", () => {
  assert.deepEqual(validateSummaryBundleEnvelope(envelope(), item).summaries, bundle());
  const missingCommand = envelope();
  missingCommand.summaries.ja.goal = missingCommand.summaries.ja.goal.replace("`npm test`", "");
  assert.throws(() => validateSummaryBundleEnvelope(missingCommand, item), /invariant|command|locale/i);
  const staleEvidence = envelope();
  staleEvidence.evidence.fit[0].end_line = 99;
  assert.throws(() => validateSummaryBundleEnvelope(staleEvidence, item), /evidence|line|README/i);
});

test("one OpenAI-compatible request carries all five summaries and no README translation output", () => {
  const request = buildSummaryBundleRequest(item, { frameId: "gh-summary-00000000-0000-4000-8000-000000000000" });
  assert.equal(request.body.model, "auto:smart");
  assert.equal(request.kind, "summary_bundle");
  assert.deepEqual(request.locales, SUMMARY_BUNDLE_LOCALES);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.response_format.type, "json_schema");
  assert.equal(request.body.response_format.json_schema.name, "github_trending_summary_bundle");
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.deepEqual(Object.keys(request.body.response_format.json_schema.schema.properties.summaries.properties), SUMMARY_BUNDLE_LOCALES);
  assert.deepEqual(request.body.response_format.json_schema.schema.required.sort(), ["evidence", "inference_fields", "invariants", "summaries"].sort());
  assert.match(request.body.messages[0].content, /180.{0,20}280|evidence|line range/is);
  assert.doesNotMatch(JSON.stringify(request.body.response_format), /translated_markdown|translation_applicable/);
  assert.equal(Object.hasOwn(request.body, "output_config"), false);
  assert.match(request.body.messages[0].content, /untrusted source data/i);
});

test("token and retry limits remain without a monetary cost estimate", () => {
  const plan = measureSummaryBundlePlan([item], { inputTokenCap: 1_000_000, outputTokenCap: 250_000, retryAttempts: 12 });
  assert.equal(plan.logicalCalls, 1);
  assert.equal(plan.model, "auto:smart");
  assert.equal(Object.hasOwn(plan, "maximumCostUsd"), false);
  assert.ok(plan.requiredInputReservation > 0 && plan.requiredInputReservation <= 1_000_000);
  assert.ok(plan.requiredOutputAllocation > 0 && plan.requiredOutputAllocation <= 250_000);
});

test("FreeLLMAPI base URLs permit loopback HTTP and require remote HTTPS", () => {
  assert.equal(resolveFreeLlmApiChatUrl("http://127.0.0.1:3001/v1"), "http://127.0.0.1:3001/v1/chat/completions");
  assert.equal(resolveFreeLlmApiChatUrl("https://router.example.test/v1/"), "https://router.example.test/v1/chat/completions");
  for (const value of [
    "",
    "http://router.example.test/v1",
    "https://user:password@router.example.test/v1",
    "https://router.example.test/v1?key=value",
    "https://router.example.test/v1#fragment",
    "https://router.example.test/",
    "https://router.example.test/v1/chat/completions",
  ]) {
    assert.throws(() => resolveFreeLlmApiChatUrl(value), /FREELLMAPI_BASE_URL|HTTPS/i, value);
  }
});

test("one bounded quality correction uses the configured OpenAI-compatible endpoint", async () => {
  const plan = measureSummaryBundlePlan([item], { inputTokenCap: 1_000_000, outputTokenCap: 250_000, retryAttempts: 12 });
  const invalid = envelope();
  invalid.summaries.ko.usage = "자세한 내용은 README를 참고하세요.";
  const replies = [invalid, envelope()];
  let calls = 0;
  const result = await runSummaryBundleRequests({
    plan,
    apiKey: "test-key",
    baseUrl: "https://router.example.test/v1",
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://router.example.test/v1/chat/completions");
      assert.equal(init.headers.authorization, "Bearer test-key");
      assert.equal(Object.hasOwn(init.headers, "x-api-key"), false);
      assert.equal(Object.hasOwn(init.headers, "anthropic-version"), false);
      assert.equal(init.redirect, "error");
      const document = replies[calls++];
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === "x-routed-via" ? "test/example-model" : null },
        text: async () => JSON.stringify({
          choices: [{
            index: 0,
            message: { role: "assistant", content: JSON.stringify(document) },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }),
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.usage.logicalCalls, 1);
  assert.equal(result.usage.attempts, 2);
  assert.equal(result.usage.retries, 1);
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.outputTokens, 400);
  assert.deepEqual(result.usage.routes, { "test/example-model": 2 });
});

test("a response without exact usage and routed-model receipts fails closed", async () => {
  const plan = measureSummaryBundlePlan([item], { inputTokenCap: 1_000_000, outputTokenCap: 250_000, retryAttempts: 0 });
  const response = ({ usage, route }) => ({
    ok: true,
    status: 200,
    headers: { get: name => name.toLowerCase() === "x-routed-via" ? route : null },
    text: async () => JSON.stringify({
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify(envelope()) },
        finish_reason: "stop",
      }],
      usage,
    }),
  });
  const common = {
    plan,
    apiKey: "test-key",
    baseUrl: "https://router.example.test/v1",
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
  };
  await assert.rejects(
    runSummaryBundleRequests({
      ...common,
      fetchImpl: async () => response({
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 299 },
        route: "test/example-model",
      }),
    }),
    /usage receipt/i,
  );
  await assert.rejects(
    runSummaryBundleRequests({
      ...common,
      fetchImpl: async () => response({
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        route: null,
      }),
    }),
    /routed model receipt/i,
  );
});
