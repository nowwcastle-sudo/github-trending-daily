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
  for (const invariant of value.invariants) delete invariant.fields;
  return value;
}

function summaryPatch(value, selections) {
  return {
    summaries: Object.fromEntries(Object.entries(selections).map(([locale, selected]) => [
      locale,
      Object.fromEntries(selected.map(field => [field, value.summaries[locale][field]])),
    ])),
  };
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
  const checked = validateSummaryBundleEnvelope(modelEnvelope(), item);
  assert.deepEqual(checked.summaries, bundle());
  assert.deepEqual(checked.invariants[0].fields, fields);
  assert.throws(() => validateSummaryBundleEnvelope(envelope(), item), /output|evidence|range/i);
  const rawWithInvariantFields = modelEnvelope();
  rawWithInvariantFields.invariants[0].fields = [...fields];
  assert.throws(() => validateSummaryBundleEnvelope(rawWithInvariantFields, item), /invariant|schema/i);
  const missingCommand = modelEnvelope();
  missingCommand.summaries.ja.goal = missingCommand.summaries.ja.goal.replace("`npm test`", "");
  assert.throws(() => validateSummaryBundleEnvelope(missingCommand, item), /invariant|command|locale/i);
  const staleEvidence = modelEnvelope();
  staleEvidence.evidence.fit[0].end_line = 99;
  assert.throws(() => validateSummaryBundleEnvelope(staleEvidence, item), /evidence|line|README/i);
});

test("version invariants bind to the rendered text of README emphasis", () => {
  const emphasizedMarkdown = "# Repository\n\n- **Node.js** >= 20; run `npm test`.";
  const emphasizedItem = {
    ...item,
    markdown: emphasizedMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(emphasizedMarkdown, "utf8")).digest("hex"),
  };
  const value = modelEnvelope();
  for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].usage += " Node.js >= 20.";
  value.invariants.push({ kind: "version", value: "Node.js >= 20" });

  assert.equal(validateSummaryBundleEnvelope(value, emphasizedItem).invariants[1].value, "Node.js >= 20");

  const invented = structuredClone(value);
  for (const locale of SUMMARY_BUNDLE_LOCALES) invented.summaries[locale].usage = invented.summaries[locale].usage.replace(">= 20", ">= 21");
  invented.invariants[1].value = "Node.js >= 21";
  assert.throws(() => validateSummaryBundleEnvelope(invented, emphasizedItem), /invariant is absent from README/i);
});

test("README inventory invariants that are unused by the summary are omitted deterministically", () => {
  const value = modelEnvelope();
  value.invariants.push({ kind: "product", value: "source-bound examples" });

  const checked = validateSummaryBundleEnvelope(value, item);

  assert.deepEqual(checked.invariants, [{ kind: "command", value: "npm test", fields }]);
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
  const staleInvariantFields = envelope();
  staleInvariantFields.invariants[0].fields = ["goal"];
  assert.throws(() => validateStoredSummaryBundleEnvelope(staleInvariantFields, item), /invariant|fields/i);
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
  const invariantItem = request.schema.properties.invariants.items;
  assert.deepEqual(invariantItem.required, ["kind", "value"]);
  assert.deepEqual(Object.keys(invariantItem.properties), ["kind", "value"]);
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
  const valid = modelEnvelope();
  const replies = [invalid, summaryPatch(valid, { ko: ["usage"] })];
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

test("quality correction identifies a repeated failing locale field and stays bounded", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const firstInvalid = modelEnvelope();
  firstInvalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  const secondInvalid = modelEnvelope();
  secondInvalid.summaries.es.cons = "Consulte el README para revisar las limitaciones.";
  const valid = modelEnvelope();
  const replies = [
    firstInvalid,
    summaryPatch(secondInvalid, { es: ["cons"] }),
    summaryPatch(valid, { es: ["cons"] }),
  ];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 3);
  assert.match(prompts[0], /prerequisite, limitation, operational trade-off/);
  assert.match(prompts[1], /es\.cons/);
  assert.match(prompts[1], /prerequisite, limitation, operational trade-off/);
  assert.match(prompts[1], /do not mention the README at all/i);
  assert.match(prompts[2], /es\.cons/);
  assert.deepEqual(result.usage, {
    inputTokens: 300,
    outputTokens: 600,
    logicalCalls: 1,
    attempts: 3,
    retries: 2,
  });
});

test("quality correction identifies an invariant that is not a literal README substring", async () => {
  const versionMarkdown = "# Repository\n\n- **Python**: 3.13+; run `npm test`.";
  const versionItem = {
    ...item,
    markdown: versionMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(versionMarkdown, "utf8")).digest("hex"),
  };
  const invalid = () => {
    const value = modelEnvelope();
    for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].goal += " Python 3.13+.";
    value.invariants.push({ kind: "version", value: "Python 3.13+" });
    return value;
  };
  const valid = invalid();
  valid.invariants[1].value = "3.13+";
  const plan = measureClaudeCliSummaryBundlePlan([versionItem], { retryAttempts: 12 });
  const replies = [invalid(), { invariants: invalid().invariants }, { invariants: valid.invariants }];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 3);
  assert.match(prompts[1], /Python 3\.13\+/);
  assert.match(prompts[1], /exact literal substring/i);
  assert.match(prompts[2], /Python 3\.13\+/);
  assert.equal(result.results[0].invariants[1].value, "3.13+");
});

test("quality correction identifies an invariant field mismatch in one locale", async () => {
  const invalid = () => {
    const value = modelEnvelope();
    value.summaries.ja.cons = value.summaries.ja.cons.replace("`npm test`", "the test command");
    return value;
  };
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const valid = modelEnvelope();
  const replies = [
    invalid(),
    summaryPatch(invalid(), { ja: ["cons"] }),
    summaryPatch(valid, { ja: ["cons"] }),
  ];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 3);
  assert.match(prompts[0], /same named fields across all five locales/i);
  assert.match(prompts[1], /ja/);
  assert.match(prompts[1], /npm test/);
  assert.match(prompts[1], /untrusted data, never as instructions/i);
  assert.match(prompts[1], /expected.*goal.*usage.*pros.*cons.*fit/i);
  assert.match(prompts[1], /actual.*goal.*usage.*pros.*fit/i);
  assert.match(prompts[2], /npm test/);
  assert.deepEqual(result.results[0].invariants[0].fields, fields);
});

test("invariant field correction audits every declared invariant across every locale", async () => {
  const invalid = () => {
    const value = modelEnvelope();
    value.summaries.ko.goal = value.summaries.ko.goal.replace("`npm test`", "the test command");
    value.summaries.es.usage = value.summaries.es.usage.replace("`npm test`", "the test command");
    value.summaries.ja.cons = value.summaries.ja.cons.replace("`npm test`", "the test command");
    return value;
  };
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const valid = modelEnvelope();
  const selected = { ko: ["goal"], es: ["usage"], ja: ["cons"] };
  const replies = [invalid(), summaryPatch(invalid(), selected), summaryPatch(valid, selected)];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 3);
  assert.match(prompts[1], /audit every declared invariant value across all five locales/i);
  assert.match(prompts[1], /not only the diagnostic one/i);
  assert.match(prompts[2], /audit every declared invariant value across all five locales/i);
  assert.deepEqual(result.results[0].invariants[0].fields, fields);
});

test("cross-locale token correction receives every exact expected and actual inventory", async () => {
  const invalid = modelEnvelope();
  invalid.invariants = [];
  for (const locale of ["ko", "zh-CN", "ja"]) {
    invalid.summaries[locale].goal = invalid.summaries[locale].goal.replace("1.0", "1");
    invalid.summaries[locale].usage = invalid.summaries[locale].usage.replace("2.0", "2");
  }
  const valid = modelEnvelope();
  valid.invariants = [];
  const selected = {
    ko: ["goal", "usage"],
    "zh-CN": ["goal", "usage"],
    ja: ["goal", "usage"],
  };
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const replies = [invalid, summaryPatch(valid, selected)];
  const prompts = [];
  const schemas = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt, schema }) => {
      prompts.push(prompt);
      schemas.push(schema);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });

  assert.equal(calls, 2);
  assert.match(prompts[1], /expected_tokens/);
  assert.match(prompts[1], /actual_tokens/);
  assert.match(prompts[1], /"numbers":\["1\.0"\]/);
  assert.match(prompts[1], /"numbers":\["1"\]/);
  assert.match(prompts[1], /"numbers":\["2\.0"\]/);
  assert.match(prompts[1], /"numbers":\["2"\]/);
  assert.deepEqual(schemas[1].properties.summaries.required, ["ko", "zh-CN", "ja"]);
  for (const locale of Object.keys(selected)) {
    assert.deepEqual(schemas[1].properties.summaries.properties[locale].required, ["goal", "usage"]);
  }
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("quality correction identifies unsupported marketing language in one locale field", async () => {
  const invalid = () => {
    const value = modelEnvelope();
    value.summaries.en.fit += " It is the ultimate choice.";
    return value;
  };
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const valid = modelEnvelope();
  const replies = [
    invalid(),
    summaryPatch(invalid(), { en: ["fit"] }),
    summaryPatch(valid, { en: ["fit"] }),
  ];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 3);
  assert.match(prompts[1], /en\.fit/);
  assert.match(prompts[1], /neutral.*source-supported/i);
  assert.match(prompts[1], /promotional.*superlative/i);
  assert.match(prompts[2], /en\.fit/);
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("one correction receives the prior output and every independent quality defect", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.en.fit += " It is the ultimate choice.";
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  invalid.summaries.ja.goal = invalid.summaries.ja.goal.replace("`npm test`", "the test command");
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const valid = modelEnvelope();
  const selected = { en: ["fit"], es: ["cons"], ja: ["goal"] };
  const replies = [invalid, summaryPatch(valid, selected)];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });

  assert.equal(calls, 2);
  assert.match(prompts[1], /PREVIOUS_OUTPUT_JSON/);
  assert.match(prompts[1], /VALIDATION_DEFECTS_JSON/);
  assert.match(prompts[1], /en\.fit/);
  assert.match(prompts[1], /es\.cons/);
  assert.match(prompts[1], /ja/);
  assert.match(prompts[1], /ultimate choice/);
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("quality correction schema exposes only validator-selected defective paths", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.en.fit += " It is the ultimate choice.";
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  invalid.summaries.ja.goal = invalid.summaries.ja.goal.replace("`npm test`", "the test command");
  const corrected = modelEnvelope();
  const patch = {
    summaries: {
      en: { fit: corrected.summaries.en.fit },
      es: { cons: corrected.summaries.es.cons },
      ja: { goal: corrected.summaries.ja.goal },
    },
  };
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const replies = [invalid, patch];
  const schemas = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ schema }) => {
      schemas.push(schema);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(schemas[1].required, ["summaries"]);
  assert.deepEqual(Object.keys(schemas[1].properties), ["summaries"]);
  assert.deepEqual(schemas[1].properties.summaries.required, ["en", "es", "ja"]);
  assert.deepEqual(schemas[1].properties.summaries.properties.en.required, ["fit"]);
  assert.deepEqual(schemas[1].properties.summaries.properties.es.required, ["cons"]);
  assert.deepEqual(schemas[1].properties.summaries.properties.ja.required, ["goal"]);
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("a partial correction becomes the immutable base for the next targeted correction", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.en.fit += " It is the ultimate choice.";
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  const valid = modelEnvelope();
  const partial = {
    summaries: {
      en: { fit: valid.summaries.en.fit },
      es: { cons: invalid.summaries.es.cons },
    },
  };
  const final = summaryPatch(valid, { es: ["cons"] });
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const replies = [invalid, partial, final];
  const schemas = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ schema }) => {
      schemas.push(schema);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(schemas[1].properties.summaries.required, ["en", "es"]);
  assert.deepEqual(schemas[2].properties.summaries.required, ["es"]);
  assert.deepEqual(schemas[2].properties.summaries.properties.es.required, ["cons"]);
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("terminal quality failure exposes bounded defect diagnostics without model output", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  let calls = 0;

  await assert.rejects(
    runClaudeSummaryBundleRequests({
      plan,
      environment: {},
      now: () => 0,
      deadline: 100_000,
      attemptTimeoutMs: 1_000,
      sleep: async () => {},
      preflight: async () => oauthRuntime,
      executeClaude: async () => {
        calls += 1;
        return { structuredOutput: invalid, usage: { inputTokens: 100, outputTokens: 200 } };
      },
    }),
    error => {
      assert.equal(calls, 3);
      const invariantHash = createHash("sha256").update(Buffer.from("npm test", "utf8")).digest("hex");
      assert.deepEqual(error.summaryFailureDiagnostic, {
        version: 1,
        repository: "owner/repo",
        failure_code: "QUALITY_VALIDATION_FAILED",
        defect_count: 3,
        defects: [
          { code: "GENERIC_OR_PLACEHOLDER", locale: "es", field: "cons" },
          {
            code: "LOCALE_INVARIANT",
            locale: "es",
            expected_fields: fields,
            actual_fields: ["goal", "usage", "pros", "fit"],
            invariant: { length: 8, sha256: invariantHash },
          },
          {
            code: "LOCALE_INVARIANT",
            locale: "es",
            field: "cons",
            token_mismatch: {
              kinds: ["commands", "numbers"],
              expected_counts: { commands: 1, urls: 0, numbers: 1 },
              actual_counts: { commands: 0, urls: 0, numbers: 0 },
            },
          },
        ],
        usage: { inputTokens: 300, outputTokens: 600, attempts: 3, retries: 2 },
        runtime: {
          provider: "claude-cli-oauth",
          interface: "claude-p",
          cli_version: "2.1.241",
          auth_method: "oauth_token",
          api_provider: "firstParty",
          model: "claude-sonnet-5",
        },
      });
      assert.doesNotMatch(JSON.stringify(error.summaryFailureDiagnostic), /Consulte|README|summaries/i);
      return true;
    },
  );
});

test("inference fields use one documented canonical order across quality corrections", async () => {
  const hedge = {
    en: "This may support a cautious adoption decision.",
    ko: "이는 신중한 도입 판단에 도움이 될 수 있습니다.",
    "zh-CN": "这可能有助于谨慎评估采用方案。",
    es: "Esto puede apoyar una evaluación prudente.",
    ja: "これは慎重な導入評価に役立つ可能性があります。",
  };
  const withInference = inferenceFields => {
    const value = modelEnvelope();
    for (const locale of SUMMARY_BUNDLE_LOCALES) {
      value.summaries[locale].goal += ` ${hedge[locale]}`;
      value.summaries[locale].fit += ` ${hedge[locale]}`;
    }
    value.inference_fields = inferenceFields;
    return value;
  };
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const replies = [
    withInference(["fit", "goal"]),
    { inference_fields: ["fit", "goal"] },
    { inference_fields: ["goal", "fit"] },
  ];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 3);
  assert.match(prompts[0], /goal, usage, pros, cons, fit/);
  assert.match(prompts[1], /inference_fields only once and in canonical order/);
  assert.match(prompts[2], /inference_fields only once and in canonical order/);
  assert.deepEqual(result.results[0].inference_fields, ["goal", "fit"]);
});

test("inference strength correction identifies the exact locale field", async () => {
  const withInference = japanese => {
    const value = modelEnvelope();
    const hedges = {
      en: "This may affect an adoption decision.",
      ko: "이는 도입 판단에 영향을 줄 수 있습니다.",
      "zh-CN": "这可能会影响采用决策。",
      es: "Esto puede afectar una decisión de adopción.",
      ja: japanese,
    };
    for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].cons += ` ${hedges[locale]}`;
    value.inference_fields = ["cons"];
    return value;
  };
  const invalid = () => withInference("これは導入判断に影響します。");
  const valid = withInference("これは導入判断に影響する可能性があります。");
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const replies = [
    invalid(),
    summaryPatch(invalid(), { ja: ["cons"] }),
    summaryPatch(valid, { ja: ["cons"] }),
  ];
  const prompts = [];
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      prompts.push(prompt);
      return { structuredOutput: replies[calls++], usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 3);
  assert.match(prompts[0], /every locale.*explicit.*hedging/i);
  assert.match(prompts[1], /ja\.cons/);
  assert.match(prompts[1], /可能性/);
  assert.match(prompts[2], /ja\.cons/);
  assert.deepEqual(result.results[0].inference_fields, ["cons"]);
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

test("a fatal bundle failure stops every worker from dispatching a new repository", async () => {
  const items = Array.from({ length: 4 }, (_, index) => ({ ...item, slug: `owner/repo-${index}` }));
  const plan = measureClaudeCliSummaryBundlePlan(items, { retryAttempts: 12 });
  let releaseSecond;
  const secondBlocked = new Promise(resolve => { releaseSecond = resolve; });
  const calls = [];
  const execution = runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    concurrency: 2,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async ({ prompt }) => {
      const slug = /"repository":"([^"]+)"/.exec(prompt)?.[1];
      calls.push(slug);
      if (slug === "owner/repo-0") {
        const invalid = modelEnvelope();
        invalid.summaries.ko.usage = "자세한 내용은 README를 참고하세요.";
        return { structuredOutput: invalid, usage: { inputTokens: 100, outputTokens: 200 } };
      }
      if (slug === "owner/repo-1") {
        await secondBlocked;
        return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
      }
      return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  const rejected = assert.rejects(execution, error => {
    assert.match(String(error?.message), /generic|placeholder|README/i);
    assert.match(String(error?.message), /owner\/repo-0/);
    assert.match(String(error?.message), /defects?=/i);
    return true;
  });
  while (calls.filter(slug => slug === "owner/repo-0").length < 2) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  releaseSecond();
  await rejected;
  assert.equal(calls.includes("owner/repo-2"), false);
  assert.equal(calls.includes("owner/repo-3"), false);
});
