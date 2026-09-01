import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  completeCodexSummaryBundle,
  parseCodexTurnEvents,
  prepareCodexSummaryBundle,
  runCodexSummaryPreflight,
} from "../scripts/codex-summary-bundle-adapter.mjs";
import {
  EVENT_LIMITS,
  hashCanonicalJson,
} from "../scripts/collect-repository-events.mjs";

const fields = ["goal", "usage", "pros", "cons", "fit"];
const producer = {
  provider: "codex-cli",
  interface: "codex-exec",
  cli_version: "0.151.0",
  auth_method: "chatgpt_session",
  api_provider: "openai_first_party",
  model: "codex-cli/gpt-5.6-sol",
};
const markdown = "# Repository\n\nInstall with `npm install` and run `npm test`. It is designed for source-bound examples.";
const contentSha256 = createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex");

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

function summaries() {
  return Object.fromEntries(Object.keys(localeLead).map(locale => [locale, detailed(locale)]));
}

function modelEnvelope() {
  return {
    summaries: summaries(),
    evidence: Object.fromEntries(fields.map(field => [field, [{ start_line: 1, end_line: 3 }]])),
    invariants: [{ kind: "command", value: "npm test" }],
    inference_fields: [],
  };
}

function storedEnvelope() {
  const value = modelEnvelope();
  for (const refs of Object.values(value.evidence)) refs[0].section_heading = "Repository";
  for (const invariant of value.invariants) invariant.fields = [...fields];
  return value;
}

function literalSource(item, runtime = producer) {
  return {
    kind: "readme",
    slug: item.slug.toLowerCase(),
    path: item.readme_path,
    blob_sha: item.readme_blob_sha,
    content_sha256: item.readme_content_sha256,
    ...runtime,
    schema_version: 3,
    prompt_schema_version: 3,
    translation_applicable: false,
  };
}

function storedEntry(item, runtime = producer) {
  const value = storedEnvelope();
  return {
    content: value.summaries.en,
    summaries: value.summaries,
    evidence: value.evidence,
    invariants: value.invariants,
    inference_fields: value.inference_fields,
    source: literalSource(item, runtime),
  };
}

function processResult(stdout) {
  return { exitCode: 0, stdout, stderr: "", timedOut: false, outputExceeded: false };
}

function officialEvents() {
  return [
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
}

function item(index) {
  return {
    slug: index === 9 ? "owner/stale" : `owner/repo-${index}`,
    readme_path: "README.md",
    readme_blob_sha: String(index % 10).repeat(40),
    readme_content_sha256: contentSha256,
    default_branch_head_sha: String((index + 1) % 10).repeat(40),
    markdown,
  };
}

function repositoryFromItem(value) {
  return {
    slug: value.slug,
    readme_status: "present",
    readme_path: value.readme_path,
    readme_blob_sha: value.readme_blob_sha,
    readme_content_sha256: value.readme_content_sha256,
    readme_locale: null,
    readme_variants: [],
    default_branch_head_sha: value.default_branch_head_sha,
  };
}

function frozenFacts(items) {
  const snapshotId = "20260901000000-aaaaaaaaaaaaaaaa";
  const observedAtUtc = "2026-09-01T00:00:00Z";
  const observedAtKst = "2026-09-01T09:00:00+09:00";
  const statsDate = "2026-09-01";
  const inputSourceSha = "a".repeat(40);
  const hydrationSourceSha = "b".repeat(40);
  const repositories = items.map(repositoryFromItem);
  const runContextSha256 = hashCanonicalJson({
    observedAtUtc,
    observedAtKst,
    statsDateKst: statsDate,
    snapshotId,
    parentSnapshotId: null,
    parentSourceSha: null,
  });
  const trendingSourceSha256 = {
    daily: "c".repeat(64),
    weekly: "d".repeat(64),
    monthly: "e".repeat(64),
  };
  const productionManifestSha256 = "f".repeat(64);
  const sourceSetSha256 = hashCanonicalJson({
    input_source_sha: inputSourceSha,
    hydration_source_sha: hydrationSourceSha,
    production_manifest_status: "verified_v0",
    production_manifest_sha256: productionManifestSha256,
    run_context_sha256: runContextSha256,
    trending_source_sha256: trendingSourceSha256,
  });
  return {
    version: 1,
    snapshotId,
    observedAtUtc,
    observedAtKst,
    statsDate,
    parentSnapshotId: null,
    inputSourceSha,
    hydrationSourceSha,
    productionManifestStatus: "verified_v0",
    productionManifestSha256,
    runContextSha256,
    trendingSourceSha256,
    sourceSetSha256,
    activeSetSha256: hashCanonicalJson(items.map(value => value.slug.toLowerCase()).sort()),
    factsSha256: hashCanonicalJson({ snapshot_id: snapshotId, input_source_sha: inputSourceSha, repositories }),
    repositories,
    readmes: Object.fromEntries(items.map(value => [value.slug.toLowerCase(), {
      path: value.readme_path,
      blobSha: value.readme_blob_sha,
      contentSha256: value.readme_content_sha256,
      markdown: value.markdown,
    }])),
    budgetReceipt: {
      logicalRequests: 0,
      httpAttempts: 0,
      originEpochMs: 1_700_000_000_000,
      eventDeadlineEpochMs: 1_700_000_000_000 + EVENT_LIMITS.eventWindowMs,
    },
  };
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-summary-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const factsPath = join(root, "facts.json");
  const items = Array.from({ length: 10 }, (_, index) => item(index));
  const facts = frozenFacts(items);
  const cache = Object.fromEntries(items.map(value => [value.slug, storedEntry(value)]));
  cache["owner/stale"].source.content_sha256 = "0".repeat(64);
  await mkdir(join(sourceRoot, "data"), { recursive: true });
  await writeFile(join(sourceRoot, "data", "repo-summaries.json"), `${JSON.stringify(cache)}\n`);
  await writeFile(factsPath, `${JSON.stringify(facts)}\n`);
  return { root, sourceRoot, factsPath, facts, items };
}

async function preparedFixture(t) {
  const value = await fixture(t);
  const outDir = join(value.root, "prepared");
  await prepareCodexSummaryBundle({
    factsPath: value.factsPath,
    sourceRoot: value.sourceRoot,
    outDir,
    preflight: async () => producer,
  });
  const responsesDir = join(value.root, "responses");
  await mkdir(responsesDir);
  const response = {
    ...modelEnvelope(),
    source: {
      ...literalSource(value.items.at(-1)),
      provider: "untrusted-response-provider",
      cli_version: "9.9.9",
    },
  };
  await writeFile(join(responsesDir, "response-000.json"), `${JSON.stringify(response)}\n`);
  await writeFile(join(responsesDir, "events-000.jsonl"), officialEvents());
  return { ...value, outDir, planPath: join(outDir, "plan.json"), responsesDir };
}

test("official Codex v0.151.0 turn.completed usage is parsed exactly", () => {
  assert.deepEqual(parseCodexTurnEvents(Buffer.from(officialEvents())), { inputTokens: 11, outputTokens: 7 });
});

test("Codex JSONL rejects incomplete, failed, negative, duplicate-key, and truncated events", () => {
  const completed = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } });
  const cases = [
    ["missing completion", [{ type: "thread.started", thread_id: "thread-1" }, { type: "turn.started" }]
      .map(JSON.stringify).join("\n") + "\n"],
    ["failed turn", `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${JSON.stringify({ type: "turn.started" })}\n${JSON.stringify({ type: "turn.failed", error: { message: "failed" } })}\n${completed}\n`],
    ["negative token", `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: -1, output_tokens: 7 } })}\n`],
    ["duplicate key", '{"type":"turn.completed","usage":{"input_tokens":11,"input_tokens":12,"output_tokens":7}}\n'],
    ["truncated final JSON", `${JSON.stringify({ type: "turn.started" })}\n{"type":"turn.completed","usage":`],
  ];
  for (const [name, events] of cases) {
    assert.throws(() => parseCodexTurnEvents(Buffer.from(events)), undefined, name);
  }
});

test("Codex preflight measures the exact profile using three local capability checks", async () => {
  const outputs = [
    "codex-cli 0.151.0\n",
    "Logged in using ChatGPT\n",
    "--ephemeral --ignore-user-config --output-schema --output-last-message --json --sandbox\n",
  ];
  const calls = [];
  const runtime = await runCodexSummaryPreflight({
    environment: { PATH: "test-path" },
    cwd: resolve("."),
    runProcess: async options => {
      calls.push(options);
      return processResult(outputs.shift());
    },
  });

  assert.deepEqual(runtime, producer);
  assert.deepEqual(calls.map(value => [value.command, value.args]), [
    ["codex", ["--version"]],
    ["codex", ["login", "status"]],
    ["codex", ["exec", "--help"]],
  ]);
  assert.equal(outputs.length, 0);
});

test("Codex preflight rejects missing ChatGPT login or output-schema without a model call", async () => {
  const cases = [
    ["login", ["codex-cli 0.151.0\n", "Not logged in\n"], 2],
    ["capability", ["codex-cli 0.151.0\n", "Logged in using ChatGPT\n", "--ephemeral --ignore-user-config --output-last-message --json --sandbox\n"], 3],
  ];
  for (const [name, outputs, expectedCalls] of cases) {
    let calls = 0;
    await assert.rejects(runCodexSummaryPreflight({
      environment: {},
      cwd: resolve("."),
      runProcess: async () => {
        calls += 1;
        return processResult(outputs.shift());
      },
    }), undefined, name);
    assert.equal(calls, expectedCalls, name);
  }
});

test("prepare writes one request only for the exact stale repository", async t => {
  const value = await fixture(t);
  const outDir = join(value.root, "prepared");
  const result = await prepareCodexSummaryBundle({
    factsPath: value.factsPath,
    sourceRoot: value.sourceRoot,
    outDir,
    preflight: async () => producer,
  });

  assert.deepEqual(result.pending, ["owner/stale"]);
  assert.equal(await exists(join(outDir, "plan.json")), true);
  assert.equal(await exists(join(outDir, "request-000-prompt.txt")), true);
  assert.equal(await exists(join(outDir, "request-000-schema.json")), true);
  assert.equal(await exists(join(outDir, "request-001-prompt.txt")), false);
});

test("prepare rejects existing, checkout-internal, and symlink-parent output paths before writing", async t => {
  const value = await fixture(t);
  const existing = join(value.root, "existing");
  await mkdir(existing);
  await assert.rejects(prepareCodexSummaryBundle({
    factsPath: value.factsPath,
    sourceRoot: value.sourceRoot,
    outDir: existing,
    preflight: async () => producer,
  }), /exist|new/i);

  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const inside = join(checkoutRoot, `.codex-adapter-path-test-${randomUUID()}`);
  await assert.rejects(prepareCodexSummaryBundle({
    factsPath: value.factsPath,
    sourceRoot: value.sourceRoot,
    outDir: inside,
    preflight: async () => producer,
  }), /outside|checkout/i);
  assert.equal(await exists(inside), false);

  const linkedParent = join(value.root, "linked-source");
  await symlink(value.sourceRoot, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const linkedOutput = join(linkedParent, "new-output");
  await assert.rejects(prepareCodexSummaryBundle({
    factsPath: value.factsPath,
    sourceRoot: value.sourceRoot,
    outDir: linkedOutput,
    preflight: async () => producer,
  }), /outside|source|symlink/i);
  assert.equal(await exists(linkedOutput), false);
});

test("complete validates the bundle and derives source only from local facts and measured producer", async t => {
  const value = await preparedFixture(t);
  const outPath = join(value.root, "prepared-codex.json");
  const result = await completeCodexSummaryBundle({
    factsPath: value.factsPath,
    planPath: value.planPath,
    responsesDir: value.responsesDir,
    outPath,
    preflight: async () => producer,
  });
  const output = JSON.parse(await readFile(outPath, "utf8"));

  assert.deepEqual(Object.keys(output), ["version", "facts_sha256", "producer", "usage", "repositories"]);
  assert.deepEqual(Object.keys(output.repositories["owner/stale"]), [
    "content", "summaries", "evidence", "invariants", "inference_fields", "source",
  ]);
  assert.deepEqual(output.producer, producer);
  assert.deepEqual(output.usage, { attempts: 1, input_tokens: 11, output_tokens: 7 });
  assert.deepEqual(output.repositories["owner/stale"].source, literalSource(value.items.at(-1)));
  assert.equal(output.repositories["owner/stale"].source.provider, "codex-cli");
  assert.deepEqual(result, { pending: ["owner/stale"], attempts: 1, inputTokens: 11, outputTokens: 7 });
});

test("complete rejects plan, request, README, pending, and current CLI drift before output", async t => {
  const value = await preparedFixture(t);
  const original = JSON.parse(await readFile(value.planPath, "utf8"));
  const cases = [
    ["facts", plan => { plan.facts_sha256 = "0".repeat(64); }, producer],
    ["prompt", plan => { plan.requests[0].prompt_sha256 = "0".repeat(64); }, producer],
    ["schema", plan => { plan.requests[0].schema_sha256 = "0".repeat(64); }, producer],
    ["README", plan => { plan.requests[0].readme_content_sha256 = "0".repeat(64); }, producer],
    ["pending", plan => { plan.pending = []; }, producer],
    ["CLI version", () => {}, { ...producer, cli_version: "0.151.1" }],
  ];
  for (const [name, mutate, measured] of cases) {
    const plan = structuredClone(original);
    mutate(plan);
    const planPath = join(value.outDir, `plan-${name.replaceAll(" ", "-")}.json`);
    const outPath = join(value.root, `out-${name.replaceAll(" ", "-")}.json`);
    await writeFile(planPath, `${JSON.stringify(plan)}\n`);
    await assert.rejects(completeCodexSummaryBundle({
      factsPath: value.factsPath,
      planPath,
      responsesDir: value.responsesDir,
      outPath,
      preflight: async () => measured,
    }), undefined, name);
    assert.equal(await exists(outPath), false, name);
  }
});
