import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MAX_FROZEN_FACTS_BYTES,
  SUMMARY_BUNDLE_LOCALES,
  buildSummaryBundleRequest,
  measureClaudeCliSummaryBundlePlan,
  runClaudeSummaryBundleRequests,
  validateSummaryBundle,
  validateSummaryBundleEnvelope,
  validateStoredSummaryBundleEnvelope,
} from "../scripts/generate-summary-bundles.mjs";

const fields = ["goal", "usage", "pros", "cons", "fit"];
const oauthRuntime = { version: "2.1.241", authMethod: "oauth_token", apiProvider: "firstParty" };

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

function modelEnvelope() {
  const value = envelope();
  for (const refs of Object.values(value.evidence)) delete refs[0].section_heading;
  return value;
}

function derivedHeading(markdown, startLine) {
  const value = modelEnvelope();
  for (const refs of Object.values(value.evidence)) {
    refs[0].start_line = startLine;
    refs[0].end_line = startLine;
  }
  return validateSummaryBundleEnvelope(value, {
    ...item,
    markdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex"),
  }).evidence.goal[0].section_heading;
}

test("summary bundle accepts exactly five complete locales and rejects generic README fallbacks", () => {
  assert.deepEqual(Object.keys(validateSummaryBundle(bundle())), SUMMARY_BUNDLE_LOCALES);
  assert.throws(() => validateSummaryBundle({ ...bundle(), ja: undefined }), /locale|schema/i);
  const generic = bundle();
  generic.ko.usage = "자세한 내용은 README를 참고하세요.";
  assert.throws(() => validateSummaryBundle(generic), /generic|placeholder|README/i);
});

test("the shared summary contract validates README evidence and cross-locale invariants", () => {
  assert.deepEqual(validateSummaryBundleEnvelope(modelEnvelope(), item).summaries, bundle());
  assert.throws(() => validateSummaryBundleEnvelope(envelope(), item), /output|evidence|range/i);
  const missingCommand = modelEnvelope();
  missingCommand.summaries.ja.goal = missingCommand.summaries.ja.goal.replace("`npm test`", "");
  assert.throws(() => validateSummaryBundleEnvelope(missingCommand, item), /invariant|command|locale/i);
  const staleEvidence = modelEnvelope();
  staleEvidence.evidence.fit[0].end_line = 99;
  assert.throws(() => validateSummaryBundleEnvelope(staleEvidence, item), /evidence|line|README/i);
});

test("stored evidence requires the canonical README-derived heading shape", () => {
  assert.deepEqual(validateStoredSummaryBundleEnvelope(envelope(), item).summaries, bundle());
  assert.throws(() => validateStoredSummaryBundleEnvelope(modelEnvelope(), item), /evidence|range/i);
  const staleHeading = envelope();
  staleHeading.evidence.goal[0].section_heading = "Other section";
  assert.throws(() => validateStoredSummaryBundleEnvelope(staleHeading, item), /evidence|heading|README/i);
  const paddedHeading = envelope();
  paddedHeading.evidence.goal[0].section_heading = " Repository ";
  assert.throws(() => validateStoredSummaryBundleEnvelope(paddedHeading, item), /evidence|heading|README/i);
});

test("model evidence returns only line ranges and derives headings from the frozen README", () => {
  const request = buildSummaryBundleRequest(item, { frameId: "gh-summary-00000000-0000-4000-8000-000000000000" });
  const evidenceItem = request.schema.properties.evidence.properties.goal.items;
  assert.deepEqual(evidenceItem.required, ["start_line", "end_line"]);
  assert.deepEqual(Object.keys(evidenceItem.properties), ["start_line", "end_line"]);

  const checked = validateSummaryBundleEnvelope(modelEnvelope(), item);
  assert.deepEqual(checked.evidence.goal, [{ start_line: 1, end_line: 3, section_heading: "Repository" }]);
});

test("derived evidence headings recognize Setext sections in frozen README Markdown", () => {
  const setextMarkdown = "Repository\n==========\n\nInstall with `npm install` and run `npm test`.";
  const setextItem = {
    ...item,
    markdown: setextMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(setextMarkdown, "utf8")).digest("hex"),
  };
  const value = modelEnvelope();
  for (const refs of Object.values(value.evidence)) {
    refs[0].start_line = 4;
    refs[0].end_line = 4;
  }
  const checked = validateSummaryBundleEnvelope(value, setextItem);
  assert.deepEqual(checked.evidence.goal, [{ start_line: 4, end_line: 4, section_heading: "Repository" }]);
});

test("derived headings ignore thematic breaks, indented code, and shorter closing fences", () => {
  assert.equal(derivedHeading("***\n---\n\nRun `npm test`.", 4), "");
  assert.equal(derivedHeading("    Code title\n---\n\nRun `npm test`.", 4), "");
  assert.equal(derivedHeading(" \tCode title\n---\n\nRun `npm test`.", 4), "");
  assert.equal(derivedHeading("\t# Fake\nRun `npm test`.", 2), "");
  assert.equal(derivedHeading("````text\n```\nCode title\n===\n````\nRun `npm test`.", 6), "");
});

test("derived Setext headings reject non-paragraph blocks and invalid backtick openers", () => {
  assert.equal(derivedHeading("- item\n---\n\nRun `npm test`.", 4), "");
  assert.equal(derivedHeading("> quote\n===\n\nRun `npm test`.", 4), "");
  assert.equal(derivedHeading("[label]: target\n---\n\nRun `npm test`.", 4), "");
  assert.equal(derivedHeading("<div>\n---\n\nRun `npm test`.", 4), "");
  assert.equal(derivedHeading("```bad`info\n# Real\nRun `npm test`.", 3), "Real");
});

test("one Sonnet 5 request carries all five summaries and no README translation output", () => {
  const request = buildSummaryBundleRequest(item, { frameId: "gh-summary-00000000-0000-4000-8000-000000000000" });
  assert.equal(request.model, "claude-sonnet-5");
  assert.equal(request.kind, "summary_bundle");
  assert.deepEqual(request.locales, SUMMARY_BUNDLE_LOCALES);
  assert.deepEqual(Object.keys(request.schema.properties.summaries.properties), SUMMARY_BUNDLE_LOCALES);
  assert.deepEqual(request.schema.required.sort(), ["evidence", "inference_fields", "invariants", "summaries"].sort());
  assert.match(request.prompt, /180.{0,20}280|evidence|line range/is);
  assert.doesNotMatch(JSON.stringify(request.schema), /translated_markdown|translation_applicable/);
  assert.match(request.prompt, /untrusted source data/i);
});

test("Claude subscription planning keeps byte and retry bounds without a dollar-cost stage", () => {
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  assert.equal(plan.logicalCalls, 1);
  assert.equal(plan.model, "claude-sonnet-5");
  assert.equal(plan.provider, "claude-cli-oauth");
  assert.ok(plan.inputBytes > 0);
  assert.equal(Object.hasOwn(plan, "plannedMaximumCostUsd"), false);
  assert.equal(Object.hasOwn(plan, "maximumCostUsd"), false);
  assert.ok(MAX_FROZEN_FACTS_BYTES > 75 * 2 * 1024 * 1024 * 2);
});

test("every frozen-facts consumer shares the collector's 75-repository byte cap", async () => {
  const collector = await import("../scripts/collect-repository-events.mjs");
  assert.equal(collector.MAX_FROZEN_FACTS_BYTES, MAX_FROZEN_FACTS_BYTES);
  assert.equal(typeof collector.parseFrozenFactsBytes, "function");
});
test("Claude subscription execution preflights once and applies one bounded quality correction", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const invalid = modelEnvelope();
  invalid.summaries.ko.usage = "자세한 내용은 README를 참고하세요.";
  const replies = [invalid, modelEnvelope()];
  let preflights = 0;
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: { ANTHROPIC_API_KEY: "must-be-removed" },
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => { preflights += 1; return oauthRuntime; },
    executeClaude: async ({ prompt, schema, model }) => {
      assert.match(prompt, /untrusted source data/i);
      assert.equal(schema.type, "object");
      assert.equal(model, "claude-sonnet-5");
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(preflights, 1);
  assert.equal(calls, 2);
  assert.deepEqual(result.usage, {
    inputTokens: 200,
    outputTokens: 400,
    logicalCalls: 1,
    attempts: 2,
    retries: 1,
  });
  assert.deepEqual(result.runtime, {
    provider: "claude-cli-oauth",
    interface: "claude-p",
    cli_version: "2.1.241",
    auth_method: "oauth_token",
    api_provider: "firstParty",
    model: "claude-sonnet-5",
  });
});

test("Claude subscription execution makes zero model calls when OAuth preflight fails", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  let calls = 0;
  await assert.rejects(
    runClaudeSummaryBundleRequests({
      plan,
      now: () => 0,
      deadline: 100_000,
      attemptTimeoutMs: 1_000,
      preflight: async () => { throw new Error("OAuth unavailable"); },
      executeClaude: async () => { calls += 1; },
    }),
    /OAuth unavailable/,
  );
  assert.equal(calls, 0);
});

test("Claude subscription execution retries one bounded transport failure after 2 seconds", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const sleeps = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async milliseconds => { sleeps.push(milliseconds); },
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("transport unavailable"), { retryable: true });
      return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 200,
    logicalCalls: 1,
    attempts: 2,
    retries: 1,
  });
});
