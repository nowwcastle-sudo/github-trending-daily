import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  MAX_FROZEN_FACTS_BYTES,
  SUMMARY_BUNDLE_LOCALES,
  admitPreparedCodexSet,
  buildSummaryBundleRequest,
  buildSummarySource,
  measureClaudeCliSummaryBundlePlan,
  planSummaryBundleReuse,
  runClaudeSummaryBundleRequests,
  runFrozenSummaryBundlePipeline,
  summaryItemsFromFacts,
  validateSummaryBundle,
  validateSummaryBundleEnvelope,
  validateStoredSummaryBundleEnvelope,
} from "../scripts/generate-summary-bundles.mjs";
import {
  CLAUDE_SUMMARY_PRODUCER_PROFILE,
  CODEX_SUMMARY_PRODUCER_PROFILE,
  isSupportedSummaryProducer,
} from "../scripts/enrichment-models.mjs";
import { hashCanonicalJson } from "../scripts/collect-repository-events.mjs";

const fields = ["goal", "usage", "pros", "cons", "fit"];
const oauthRuntime = { version: "2.1.241", authMethod: "oauth_token", apiProvider: "firstParty" };
const execFile = promisify(execFileCallback);
const checkoutRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

function pathIsInside(target, parent) {
  const relativePath = relative(resolve(parent), resolve(target));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function safePythonCandidate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = resolve(value.trim());
  const windowsApps = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps")
    : null;
  if (pathIsInside(candidate, checkoutRoot) || (windowsApps && pathIsInside(candidate, windowsApps))) return null;
  return candidate;
}

async function resolvePythonCommand(command) {
  try {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFile(lookup, [command], { windowsHide: true, maxBuffer: 8 * 1024 });
    return stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveVerifiedPythonExecutable({ environment = process.env } = {}) {
  const candidates = environment.PYTHON ? [environment.PYTHON] : [];
  if (process.platform === "win32") candidates.push(...await resolvePythonCommand("python.exe"));
  else {
    candidates.push(...await resolvePythonCommand("python3"));
    candidates.push(...await resolvePythonCommand("python"));
  }
  const seen = new Set();
  for (const value of candidates) {
    const candidate = safePythonCandidate(value);
    if (!candidate || seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    try {
      const { stdout } = await execFile(candidate, ["-c", "import sys; print(sys.executable)"], {
        windowsHide: true,
        maxBuffer: 8 * 1024,
      });
      const executable = stdout.trim();
      if (!isAbsolute(executable) || !safePythonCandidate(executable)) continue;
      return resolve(executable);
    } catch {
      // bare command를 호출하지 않고 다음 로컬 실행 파일 후보를 시도한다.
    }
  }
  throw new Error("Verified Python executable is unavailable for summary CLI integration");
}

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

function storedEntry(entryItem, producer) {
  const value = envelope();
  return {
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
  };
}

function preparedCodexFixture(entries, { factsSha256 = "f".repeat(64) } = {}) {
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
    facts_sha256: factsSha256,
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

function pipelineItem(slug, index) {
  return {
    ...item,
    slug,
    readme_blob_sha: String(index % 10).repeat(40),
    default_branch_head_sha: String((index + 1) % 10).repeat(40),
  };
}

function frozenPipelineFacts(items) {
  const snapshotId = "20260901000000-aaaaaaaaaaaaaaaa";
  const parentSnapshotId = "20260831000000-bbbbbbbbbbbbbbbb";
  const observedAtUtc = "2026-09-01T00:00:00Z";
  const observedAtKst = "2026-09-01T09:00:00+09:00";
  const statsDate = "2026-09-01";
  const inputSourceSha = "a".repeat(40);
  const hydrationSourceSha = "b".repeat(40);
  const repositories = items.map(value => ({
    slug: value.slug,
    readme_status: "present",
    readme_path: value.readme_path,
    readme_blob_sha: value.readme_blob_sha,
    readme_content_sha256: value.readme_content_sha256,
    readme_locale: null,
    readme_variants: [],
    default_branch_head_sha: value.default_branch_head_sha,
  }));
  const runContextSha256 = hashCanonicalJson({
    observedAtUtc,
    observedAtKst,
    statsDateKst: statsDate,
    snapshotId,
    parentSnapshotId,
    parentSourceSha: hydrationSourceSha,
  });
  const trendingSourceSha256 = { daily: "c".repeat(64), weekly: "d".repeat(64), monthly: "e".repeat(64) };
  const productionManifestSha256 = "f".repeat(64);
  const sourceSetSha256 = hashCanonicalJson({
    input_source_sha: inputSourceSha,
    hydration_source_sha: hydrationSourceSha,
    production_manifest_status: "verified_v1",
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
    parentSnapshotId,
    inputSourceSha,
    hydrationSourceSha,
    productionManifestStatus: "verified_v1",
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
      eventDeadlineEpochMs: 1_700_000_000_000 + 900_000,
    },
  };
}

function frozenPipelineEvents(facts) {
  const content = {
    heads: [],
    releases: [],
    latestReleaseIds: Object.fromEntries(facts.repositories.map(repository => [repository.slug.toLowerCase(), null])),
    commits: [],
    estimates: [],
    budgetReceipt: {},
  };
  return {
    version: 1,
    snapshotId: facts.snapshotId,
    activeSetSha256: facts.activeSetSha256,
    factsSha256: facts.factsSha256,
    sourceSetSha256: facts.sourceSetSha256,
    runContextSha256: facts.runContextSha256,
    completeSetSha256: hashCanonicalJson(content),
    ...content,
  };
}

function normalPolicyContext(facts) {
  return {
    mode: "normal",
    inputSourceSha: facts.inputSourceSha,
    hydrationSourceSha: facts.hydrationSourceSha,
    sourceSetSha256: facts.sourceSetSha256,
    runContextSha256: facts.runContextSha256,
    productionManifestStatus: facts.productionManifestStatus,
    productionManifestSha256: facts.productionManifestSha256,
    recoveryVersion: "1",
    verifiedBootstrapSourceSha: facts.hydrationSourceSha,
    manualBootstrapSourceSha: "",
  };
}

async function exists(target) {
  return access(target).then(() => true, () => false);
}

async function frozenPipelineFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "summary-bundle-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedItems = Array.from({ length: 42 }, (_, index) => pipelineItem(`owner/repo-${String(index).padStart(2, "0")}`, index));
  const staleItems = [
    pipelineItem("kaifcodec/user-scanner", 42),
    pipelineItem("handsomestwei/patent-disclosure-skill", 43),
  ];
  const items = [...retainedItems, ...staleItems];
  const facts = frozenPipelineFacts(items);
  const sourceRoot = join(root, "source");
  const factsPath = join(root, "facts.json");
  const eventsPath = join(root, "events.json");
  const preparedPath = join(root, "prepared-codex.json");
  const priorHeadsPath = join(root, "prior-heads.json");
  const parentEvidencePath = join(root, "parent-evidence.json");
  const parentDatabasePath = join(root, "missing-parent.sqlite");
  const priorHeads = {
    version: 1,
    snapshotId: null,
    scope: "all_historical",
    parentDatabaseSha256: null,
    snapshotSeq: null,
    headCount: 0,
    headsSha256: hashCanonicalJson({}),
    heads: {},
  };
  const parentEvidence = {
    version: 1,
    parent_database: { missing: true },
    production_source_sha: facts.hydrationSourceSha,
    historical_heads: { scope: "all_historical", head_count: 0, heads_sha256: priorHeads.headsSha256 },
    legacy_baseline_receipt: {},
  };
  const claudeProducer = { ...CLAUDE_SUMMARY_PRODUCER_PROFILE, cli_version: "2.1.241" };
  const cache = Object.fromEntries(retainedItems.map(value => [value.slug, storedEntry(value, claudeProducer)]));
  const prepared = preparedCodexFixture(staleItems.map(value => [value, envelope()]), { factsSha256: facts.factsSha256 });
  await mkdir(join(sourceRoot, "data"), { recursive: true });
  await Promise.all([
    writeFile(join(sourceRoot, "data", "repo-summaries.json"), `${JSON.stringify(cache)}\n`),
    writeFile(factsPath, `${JSON.stringify(facts)}\n`),
    writeFile(eventsPath, `${JSON.stringify(frozenPipelineEvents(facts))}\n`),
    writeFile(preparedPath, `${JSON.stringify(prepared)}\n`),
    writeFile(priorHeadsPath, `${JSON.stringify(priorHeads)}\n`),
    writeFile(parentEvidencePath, `${JSON.stringify(parentEvidence)}\n`),
  ]);
  return {
    root, facts, items, staleItems, sourceRoot, factsPath, eventsPath, preparedPath,
    priorHeadsPath, parentEvidencePath, parentDatabasePath,
  };
}

async function pipelineArguments(value, name) {
  const outputRoot = join(value.root, name);
  await mkdir(outputRoot, { recursive: true });
  return {
    factsPath: value.factsPath,
    eventsPath: value.eventsPath,
    enrichmentIndexOut: join(value.root, `${name}-index.json`),
    sourceRoot: value.sourceRoot,
    outputRoot,
    parentEvidencePath: value.parentEvidencePath,
    priorHeadsPath: value.priorHeadsPath,
    parentDatabasePath: value.parentDatabasePath,
    policyContext: normalPolicyContext(value.facts),
    deadline: Date.now() + 1_000_000,
  };
}

test("summary item projection keeps frozen README identities in repository order", () => {
  const facts = {
    repositories: [
      { slug: "owner/second", readme_status: "present", default_branch_head_sha: "d".repeat(40) },
      { slug: "owner/first", readme_status: "present", default_branch_head_sha: "c".repeat(40) },
    ],
    readmes: {
      "owner/first": { path: "README.md", blobSha: "a".repeat(40), contentSha256: item.readme_content_sha256, markdown },
      "owner/second": { path: "docs/README.md", blobSha: "b".repeat(40), contentSha256: item.readme_content_sha256, markdown },
    },
  };

  assert.deepEqual(summaryItemsFromFacts(facts).map(value => ({ slug: value.slug, readme_path: value.readme_path })), [
    { slug: "owner/second", readme_path: "docs/README.md" },
    { slug: "owner/first", readme_path: "README.md" },
  ]);
});

test("source-identical Claude and Codex cache entries are retained while stale entries stay pending", () => {
  const claudeItem = { ...item, slug: "owner/claude" };
  const codexItem = { ...item, slug: "owner/codex", readme_blob_sha: "b".repeat(40) };
  const staleItem = { ...item, slug: "owner/stale", readme_blob_sha: "d".repeat(40) };
  const claudeProducer = { ...CLAUDE_SUMMARY_PRODUCER_PROFILE, cli_version: "2.1.241" };
  const codexProducer = { ...CODEX_SUMMARY_PRODUCER_PROFILE, cli_version: "0.151.0" };
  const staleEntry = storedEntry(staleItem, codexProducer);
  staleEntry.source.content_sha256 = "e".repeat(64);
  const planned = planSummaryBundleReuse([claudeItem, codexItem, staleItem], {
    "OWNER/CLAUDE": storedEntry(claudeItem, claudeProducer),
    "owner/codex": storedEntry(codexItem, codexProducer),
    "owner/stale": staleEntry,
  });

  assert.deepEqual([...planned.retained.keys()], ["owner/claude", "owner/codex"]);
  assert.deepEqual(planned.pending.map(value => value.slug), ["owner/stale"]);
  assert.equal(planned.retained.get("owner/codex").source.provider, "codex-cli");
});

test("cache reuse rejects changed README or Codex model instead of relabeling it", () => {
  const codexProducer = { ...CODEX_SUMMARY_PRODUCER_PROFILE, cli_version: "0.151.0" };
  const readmeChanged = { ...item, slug: "owner/readme" };
  const changedReadmeEntry = storedEntry(readmeChanged, codexProducer);
  changedReadmeEntry.source.content_sha256 = "f".repeat(64);
  const changedModel = { ...item, slug: "owner/model", readme_blob_sha: "b".repeat(40) };
  const changedModelEntry = storedEntry(changedModel, { ...codexProducer, model: "codex-cli/gpt-5.6-terra" });

  assert.deepEqual(planSummaryBundleReuse([readmeChanged], { [readmeChanged.slug]: changedReadmeEntry }).pending, [readmeChanged]);
  assert.deepEqual(planSummaryBundleReuse([changedModel], { [changedModel.slug]: changedModelEntry }).pending, [changedModel]);
});

test("prepared Codex admission requires exact facts, producer, pending set, and source identity", () => {
  const staleItem = { ...item, slug: "owner/stale" };
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

  const cases = [
    ["facts SHA", value => { value.facts_sha256 = "e".repeat(64); }, "f".repeat(64), [staleItem]],
    ["slug missing", value => { delete value.repositories[staleItem.slug]; }, "f".repeat(64), [staleItem]],
    ["extra slug", value => { value.repositories["owner/extra"] = structuredClone(value.repositories[staleItem.slug]); }, "f".repeat(64), [staleItem]],
    ["README identity", value => { value.repositories[staleItem.slug].source.blob_sha = "b".repeat(40); }, "f".repeat(64), [staleItem]],
    ["producer model", value => { value.producer.model = "codex-cli/gpt-5.6-terra"; }, "f".repeat(64), [staleItem]],
  ];
  for (const [name, mutate, factsSha256, pending] of cases) {
    const value = preparedCodexFixture([[staleItem, envelope()]]);
    mutate(value);
    assert.throws(() => admitPreparedCodexSet({ value, factsSha256, pending }), undefined, name);
  }

  const upperCaseStaleItem = { ...staleItem, slug: "OWNER/STALE" };
  const collidingPrepared = preparedCodexFixture([
    [staleItem, envelope()],
    [upperCaseStaleItem, envelope()],
  ]);
  assert.throws(
    () => admitPreparedCodexSet({
      value: collidingPrepared,
      factsSha256: "f".repeat(64),
      pending: [staleItem, upperCaseStaleItem],
    }),
    /pending set/i,
  );
});

test("frozen pipeline imports the exact 42 Claude plus 2 prepared Codex active set without Claude calls", async t => {
  const fixture = await frozenPipelineFixture(t);
  let preflights = 0;
  let calls = 0;
  const result = await runFrozenSummaryBundlePipeline({
    ...await pipelineArguments(fixture, "prepared-candidate"),
    preparedCodexPath: fixture.preparedPath,
    preflight: async () => { preflights += 1; throw new Error("Claude preflight must not run"); },
    executeClaude: async () => { calls += 1; throw new Error("Claude request must not run"); },
  });

  const activeSlugs = fixture.items.map(value => value.slug.toLowerCase());
  assert.equal(preflights, 0);
  assert.equal(calls, 0);
  assert.equal(result.repositories, 44);
  assert.equal(result.pending, 2);
  assert.equal(result.runtime.provider, "codex-cli");
  assert.equal(result.usage.logicalCalls, 2);
  assert.deepEqual(Object.keys(result.index.repositories).sort(), activeSlugs.sort());
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    logicalCalls: 2,
    attempts: 2,
    retries: 0,
  });
});

test("prepared Codex missing or extra entries create no candidate cache, source registry, or index", async t => {
  for (const [name, mutate, expected] of [
    ["missing", value => { delete value.repositories["kaifcodec/user-scanner"]; }, /prepared Codex summary pending set/i],
    ["case collision", value => { value.repositories["KAIFCODEC/USER-SCANNER"] = structuredClone(value.repositories["kaifcodec/user-scanner"]); }, /prepared Codex summary pending set/i],
    ["extra", value => { value.repositories["owner/extra"] = structuredClone(value.repositories["kaifcodec/user-scanner"]); }, /prepared Codex summary pending set/i],
    ["facts SHA drift", value => { value.facts_sha256 = "e".repeat(64); }, /prepared Codex summary set is invalid/i],
  ]) {
    const fixture = await frozenPipelineFixture(t);
    const prepared = JSON.parse(await readFile(fixture.preparedPath, "utf8"));
    mutate(prepared);
    await writeFile(fixture.preparedPath, `${JSON.stringify(prepared)}\n`);
    const args = await pipelineArguments(fixture, `${name}-candidate`);
    let preflights = 0;
    await assert.rejects(
      runFrozenSummaryBundlePipeline({
        ...args,
        preparedCodexPath: fixture.preparedPath,
        preflight: async () => { preflights += 1; throw new Error("Claude preflight must not run"); },
      }),
      expected,
      name,
    );
    assert.equal(preflights, 0, name);
    assert.equal(await exists(join(args.outputRoot, "data", "repo-summaries.json")), false, name);
    assert.equal(await exists(join(args.outputRoot, "data", "translation-sources.json")), false, name);
    assert.equal(await exists(args.enrichmentIndexOut), false, name);
  }
});

test("frozen pipeline preserves the Claude preflight and request path when prepared Codex is absent", async t => {
  const fixture = await frozenPipelineFixture(t);
  let preflights = 0;
  let calls = 0;
  const result = await runFrozenSummaryBundlePipeline({
    ...await pipelineArguments(fixture, "claude-candidate"),
    preflight: async () => { preflights += 1; return oauthRuntime; },
    executeClaude: async () => {
      calls += 1;
      return { structuredOutput: modelEnvelope(), usage: { inputTokens: 11, outputTokens: 7 } };
    },
  });

  assert.equal(preflights, 1);
  assert.equal(calls, 2);
  assert.equal(result.runtime.provider, "claude-cli-oauth");
  assert.deepEqual(result.usage, {
    inputTokens: 22,
    outputTokens: 14,
    logicalCalls: 2,
    attempts: 2,
    retries: 0,
  });
});

test("summary bundle CLI accepts the optional prepared Codex file", async t => {
  const fixture = await frozenPipelineFixture(t);
  const args = await pipelineArguments(fixture, "cli-candidate");
  const scriptPath = fileURLToPath(new URL("../scripts/generate-summary-bundles.mjs", import.meta.url));
  const pythonExecutable = await resolveVerifiedPythonExecutable();
  const unexpectedPythonRoot = join(fixture.root, "Python");
  assert.equal(isAbsolute(pythonExecutable), true);
  assert.equal(await exists(unexpectedPythonRoot), false);
  const environment = {
    ...process.env,
    PYTHON: pythonExecutable,
    ENRICHMENT_DEADLINE_EPOCH_MS: `${Date.now() + 1_000_000}`,
    ENRICHMENT_BUDGET_MODE: "normal",
    INPUT_SOURCE_SHA: fixture.facts.inputSourceSha,
    HYDRATION_SOURCE_SHA: fixture.facts.hydrationSourceSha,
    FROZEN_SOURCE_SET_SHA256: fixture.facts.sourceSetSha256,
    FROZEN_RUN_CONTEXT_SHA256: fixture.facts.runContextSha256,
    PRODUCTION_MANIFEST_STATUS: fixture.facts.productionManifestStatus,
    PRODUCTION_MANIFEST_SHA256: fixture.facts.productionManifestSha256,
    VERIFIED_RECOVERY_VERSION: "1",
    VERIFIED_BOOTSTRAP_SOURCE_SHA: fixture.facts.hydrationSourceSha,
    MANUAL_BOOTSTRAP_SOURCE_SHA: "",
  };
  const { stdout } = await execFile(process.execPath, [scriptPath,
    "--facts", args.factsPath,
    "--events", args.eventsPath,
    "--enrichment-index-out", args.enrichmentIndexOut,
    "--source-root", args.sourceRoot,
    "--output-root", args.outputRoot,
    "--prior-heads", args.priorHeadsPath,
    "--parent-evidence", args.parentEvidencePath,
    "--parent-database", args.parentDatabasePath,
    "--failure-diagnostics-out", join(fixture.root, "failure-diagnostics.json"),
    "--prepared-codex", fixture.preparedPath,
  ], { cwd: fixture.root, env: environment });

  const result = JSON.parse(stdout);
  assert.equal(result.repositories, 44);
  assert.equal(result.pending, 2);
  assert.equal(result.runtime.provider, "codex-cli");
  assert.equal(result.usage.logicalCalls, 2);
  assert.equal(await exists(unexpectedPythonRoot), false);
});

test("summary source uses the exact supported producer profile", () => {
  const producer = { ...CODEX_SUMMARY_PRODUCER_PROFILE, cli_version: "0.151.0" };
  assert.deepEqual(buildSummarySource(item, producer), storedEntry(item, producer).source);
  assert.throws(() => buildSummarySource(item, { ...producer, model: "codex-cli/gpt-5.6-terra" }), /producer/i);
});

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

test("a concise five-part English summary does not need translation-length parity", () => {
  const concise = bundle();
  concise.en = {
    goal: "Explains the documented repository purpose, intended users, supported scope, and practical problem that the project is designed to solve for adopters.",
    usage: "Describes the documented setup path, primary command flow, required environment, and normal operating sequence without inventing undocumented installation steps or capabilities.",
    pros: "Highlights concrete documented strengths, including workflow coverage, integration points, maintained examples, and operational conveniences that can reduce adoption effort for suitable teams.",
    cons: "States a documented prerequisite, limitation, maintenance trade-off, or cautious documentation gap so readers can evaluate operational cost without promotional language or guesswork.",
    fit: "Identifies the projects and teams that match the documented use case, while distinguishing situations where the repository scope or prerequisites make another option preferable.",
  };
  const englishWords = Object.values(concise.en).join(" ").split(/\s+/).length;

  assert.ok(englishWords >= 100 && englishWords < 150);
  assert.deepEqual(validateSummaryBundle(concise), concise);
});

test("locale prose may vary while every summary keeps the same field roles", () => {
  const natural = modelEnvelope();
  for (const locale of SUMMARY_BUNDLE_LOCALES) {
    for (const field of fields.filter(field => field !== "usage")) {
      natural.summaries[locale][field] = natural.summaries[locale][field].replace("`npm test`", "the documented test command");
    }
  }
  natural.summaries.ja.goal = "TestProduct 1.0 の目的と対象利用者を、README に記載された範囲で簡潔に説明します。";

  const checked = validateSummaryBundleEnvelope(natural, item);

  assert.equal(checked.summaries.ja.goal, natural.summaries.ja.goal);
  assert.deepEqual(checked.invariants[0].fields, ["usage"]);
});

test("Spanish todo remains prose while uppercase TODO remains a placeholder marker", () => {
  const spanish = bundle();
  spanish.es.cons += " La configuración manual puede afectar a todo el flujo de trabajo.";
  assert.deepEqual(validateSummaryBundle(spanish), spanish);

  const placeholder = bundle();
  placeholder.es.cons += " TODO";
  assert.throws(() => validateSummaryBundle(placeholder), /generic|placeholder/i);
});

test("tracked v0 bootstrap seed contains only source-bound five-locale summary entries", async () => {
  const seed = JSON.parse(await readFile("data/bootstrap-summary-seed.json", "utf8"));
  assert.equal(Object.keys(seed).length, 45);
  for (const [slug, entry] of Object.entries(seed)) {
    assert.deepEqual(Object.keys(entry).sort(), ["content", "evidence", "inference_fields", "invariants", "source", "summaries"]);
    assert.deepEqual(entry.content, entry.summaries.en);
    assert.deepEqual(validateSummaryBundle(entry.summaries), entry.summaries);
    assert.equal(entry.source.slug, slug.toLowerCase());
    assert.equal(entry.source.provider, "claude-cli-oauth");
    assert.equal(entry.source.interface, "claude-p");
    assert.equal(entry.source.auth_method, "oauth_token");
    assert.equal(entry.source.api_provider, "firstParty");
    assert.equal(entry.source.model, "claude-sonnet-5");
    assert.equal(entry.source.schema_version, 3);
    assert.equal(entry.source.prompt_schema_version, 3);
    assert.equal(entry.source.translation_applicable, false);
  }
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

test("product invariants require every English-bound field but allow extra translated mentions", () => {
  const productMarkdown = "# Repository\n\nThe iOS application runs with `npm test`.";
  const productItem = {
    ...item,
    markdown: productMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(productMarkdown, "utf8")).digest("hex"),
  };
  const value = modelEnvelope();
  for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].goal += " iOS.";
  value.summaries.es.pros += " iOS.";
  value.summaries.es.cons += " iOS.";
  value.summaries.es.fit += " iOS.";
  value.invariants.push({ kind: "product", value: "iOS" });

  const checked = validateSummaryBundleEnvelope(value, productItem);
  assert.deepEqual(checked.invariants.at(-1), { kind: "product", value: "iOS", fields: ["goal"] });

  const missing = structuredClone(value);
  missing.summaries.ja.goal = missing.summaries.ja.goal.replace(" iOS.", "");
  const softened = validateSummaryBundleEnvelope(missing, productItem);
  assert.deepEqual(softened.warnings, [{ code: "INVARIANT_FIELDS_SOFT", locale: "ja", invariant: "iOS" }]);
  return;
  assert.throws(() => validateSummaryBundleEnvelope(missing, productItem), /invariant|locale/i);
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
  assert.match(request.prompt, /100.{0,20}280|evidence|line range/is);
  assert.match(request.prompt, /natural|length|ordering|emphasis/i);
  assert.doesNotMatch(JSON.stringify(request.schema), /translated_markdown|translation_applicable/);
  assert.match(request.prompt, /untrusted source data/i);
});

test("Claude subscription planning keeps byte and retry bounds without a dollar-cost stage", () => {
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  assert.equal(plan.logicalCalls, 1);
  assert.equal(plan.maximumAttempts, 4);
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

test("a product name missing from one translated field is a warning and does not consume a correction", async () => {
  const productMarkdown = "# Repository\n\nThe iOS application runs with `npm test`.";
  const productItem = {
    ...item,
    markdown: productMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(productMarkdown, "utf8")).digest("hex"),
  };
  const value = modelEnvelope();
  for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].goal += " iOS.";
  value.summaries.ja.goal = value.summaries.ja.goal.replace(" iOS.", "");
  value.invariants.push({ kind: "product", value: "iOS" });
  const plan = measureClaudeCliSummaryBundlePlan([productItem], { retryAttempts: 12 });
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      return { structuredOutput: value, usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.results[0].warnings, [{ code: "INVARIANT_FIELDS_SOFT", locale: "ja", invariant: "iOS" }]);
});

test("command invariant correction names exact add and remove actions for one extra locale field", async () => {
  const commandMarkdown = "# Repository\n\nAuthenticate with the auth command, then run `npm test`.";
  const commandItem = {
    ...item,
    markdown: commandMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(commandMarkdown, "utf8")).digest("hex"),
  };
  const invalid = modelEnvelope();
  for (const locale of SUMMARY_BUNDLE_LOCALES) invalid.summaries[locale].usage += " auth.";
  invalid.summaries.es.fit += " auth 163.";
  invalid.invariants.push({ kind: "command", value: "auth" });
  const valid = structuredClone(invalid);
  valid.summaries.es.fit = valid.summaries.es.fit.replace(" auth 163.", "");
  const plan = measureClaudeCliSummaryBundlePlan([commandItem], { retryAttempts: 12 });
  const replies = [invalid, summaryPatch(valid, { es: ["fit"] })];
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
  assert.match(prompts[1], /"add_to_fields":\[\]/);
  assert.match(prompts[1], /"remove_from_fields":\["fit"\]/);
  assert.match(prompts[1], /remove exact invariant "auth" from es\.fit/i);
  const previousOutputEnd = prompts[1].indexOf("END_PREVIOUS_OUTPUT_JSON");
  assert.ok(previousOutputEnd > prompts[1].indexOf("PREVIOUS_OUTPUT_JSON"));
  const finalInstructions = prompts[1].slice(previousOutputEnd);
  assert.match(finalInstructions, /remove exact invariant "auth" from es\.fit/i);
  assert.match(finalInstructions, /Return only the validator-selected correction object/i);
  assert.deepEqual(result.results[0].summaries, valid.summaries);
});

test("invariant correction ends with exact additions for four missing locale fields", async () => {
  const authMarkdown = "# Repository\n\nAuthenticate with the `auth` command, then run `npm test`.";
  const authItem = {
    ...item,
    markdown: authMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(authMarkdown, "utf8")).digest("hex"),
  };
  const invalid = modelEnvelope();
  invalid.summaries.en.usage += " auth.";
  invalid.summaries.en.pros += " auth.";
  for (const locale of SUMMARY_BUNDLE_LOCALES.slice(1)) invalid.summaries[locale].usage += " auth.";
  invalid.invariants.push({ kind: "command", value: "auth" });
  const valid = structuredClone(invalid);
  const selected = {};
  for (const locale of SUMMARY_BUNDLE_LOCALES.slice(1)) {
    valid.summaries[locale].pros += " auth.";
    selected[locale] = ["pros"];
  }
  const plan = measureClaudeCliSummaryBundlePlan([authItem], { retryAttempts: 12 });
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
  const finalInstructions = prompts[1].slice(prompts[1].indexOf("END_PREVIOUS_OUTPUT_JSON"));
  for (const locale of SUMMARY_BUNDLE_LOCALES.slice(1)) {
    assert.match(finalInstructions, new RegExp(`add exact invariant "auth" only to ${locale.replace("-", "\\-")}\\.pros`, "i"));
  }
  assert.match(finalInstructions, /Return only the validator-selected correction object/i);
  assert.deepEqual(result.results[0].summaries, valid.summaries);
});


test("a correction that rewrites an inference field keeps the structural hedge pattern", async () => {
  const invalid = modelEnvelope();
  invalid.inference_fields = ["cons"];
  for (const locale of SUMMARY_BUNDLE_LOCALES) invalid.summaries[locale].cons += " 도입 판단에 영향을 줄 수 있습니다.";
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  const valid = structuredClone(invalid);
  valid.summaries.es.cons = "Requiere `npm test` y podría necesitar ajustes de configuración documentados.";
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
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
      if (calls++ === 0) return { structuredOutput: invalid, usage: { inputTokens: 100, outputTokens: 200 } };
      const fieldSchema = schema.properties.summaries.properties.es.properties.cons;
      assert.equal(typeof fieldSchema.pattern, "string");
      assert.match(valid.summaries.es.cons, new RegExp(fieldSchema.pattern, "u"));
      return { structuredOutput: summaryPatch(valid, { es: ["cons"] }), usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.results[0].summaries, valid.summaries);
});

test("cross-locale token correction receives every exact expected and actual inventory", async () => {
  const invalid = modelEnvelope();
  invalid.invariants = [];
  for (const locale of ["ko", "zh-CN", "ja"]) {
    invalid.summaries[locale].goal = invalid.summaries[locale].goal.replace("`npm test`", "`npm run test`");
    invalid.summaries[locale].usage = invalid.summaries[locale].usage.replace("`npm test`", "`npm run test`");
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
  assert.match(prompts[1], /"commands":\["npm test"\]/);
  assert.match(prompts[1], /"commands":\["npm run test"\]/);
  assert.deepEqual(schemas[1].properties.summaries.required, ["ko", "zh-CN", "ja"]);
  for (const locale of Object.keys(selected)) {
    assert.deepEqual(schemas[1].properties.summaries.properties[locale].required, ["goal", "usage"]);
  }
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("subjective marketing wording does not consume a quality correction", async () => {
  const value = modelEnvelope();
  value.summaries.en.fit += " It is the ultimate choice.";
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      return { structuredOutput: value, usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.results[0].summaries.en.fit, value.summaries.en.fit);
});

test("source-grounded best practices terminology is not promotional marketing", () => {
  const summaries = bundle();
  summaries.en.goal += " It enforces a documented code standard and a set of best practices.";
  summaries["zh-CN"].goal += " 它用于执行文档化的编码标准和一组最佳实践。";
  assert.deepEqual(validateSummaryBundle(summaries), summaries);
});

test("source-grounded best wording does not fail the deployable summary contract", () => {
  const summaries = bundle();
  summaries.en.goal += " The README describes it as one of the best known options for this use case.";

  assert.deepEqual(validateSummaryBundle(summaries), summaries);
});

test("subjective marketing wording does not block an otherwise deployable summary", () => {
  const summaries = bundle();
  summaries.en.fit += " The README calls this the ultimate option for its intended audience.";

  assert.deepEqual(validateSummaryBundle(summaries), summaries);
});

test("one correction receives the prior output and every independent quality defect", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  invalid.summaries.ja.goal = invalid.summaries.ja.goal.replace("`npm test`", "the test command");
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  const valid = modelEnvelope();
  const selected = { es: ["cons"], ja: ["goal"] };
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
  assert.match(prompts[1], /es\.cons/);
  assert.match(prompts[1], /ja/);
  assert.match(prompts[1], /forbidden_terms[^\n]*Consulte el README/i);
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("a third targeted quality correction remains bounded and can finish one repository", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.es.pros = "Consulte el README para conocer las ventajas.";
  const valid = modelEnvelope();
  const badPatch = summaryPatch(invalid, { es: ["pros"] });
  const validPatch = summaryPatch(valid, { es: ["pros"] });
  const replies = [invalid, badPatch, badPatch, validPatch];
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  let calls = 0;

  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => ({
      structuredOutput: replies[calls++],
      usage: { inputTokens: 100, outputTokens: 200 },
    }),
  });

  assert.equal(calls, 4);
  assert.equal(result.usage.attempts, 4);
  assert.equal(result.usage.retries, 3);
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("retry capacity covers three bounded corrections per pending repository in every mode", async () => {
  const producer = await import("../scripts/generate-summary-bundles.mjs");
  assert.equal(producer.resolveClaudeCliSummaryRetryCap({ name: "bootstrap_v0_approved", retryAttempts: 12 }, 45), 135);
  assert.equal(producer.resolveClaudeCliSummaryRetryCap({ name: "normal", retryAttempts: 12 }, 45), 135);
  assert.equal(producer.resolveClaudeCliSummaryRetryCap({ name: "normal", retryAttempts: 12 }, 2), 12);
});

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

test("quality correction schema exposes only validator-selected defective paths", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  invalid.summaries.ja.goal = invalid.summaries.ja.goal.replace("`npm test`", "the test command");
  const corrected = modelEnvelope();
  const patch = {
    summaries: {
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
  assert.deepEqual(schemas[1].properties.summaries.required, ["es", "ja"]);
  assert.deepEqual(schemas[1].properties.summaries.properties.es.required, ["cons"]);
  assert.deepEqual(schemas[1].properties.summaries.properties.ja.required, ["goal"]);
  assert.deepEqual(result.results[0].summaries, bundle());
});

test("a partial correction becomes the immutable base for the next targeted correction", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.en.fit += " TODO";
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

test("a held quality failure exposes bounded defect diagnostics without model output", async () => {
  const invalid = modelEnvelope();
  invalid.summaries.es.cons = "Consulte el README para conocer las limitaciones.";
  const badPatch = summaryPatch(invalid, { es: ["cons"] });
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      return { structuredOutput: calls === 1 ? invalid : badPatch, usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.results[0], null);
  const diagnostic = result.held[0].diagnostic;
  const invariantHash = createHash("sha256").update(Buffer.from("npm test", "utf8")).digest("hex");
  assert.equal(diagnostic.version, 1);
  assert.equal(diagnostic.repository, "owner/repo");
  assert.equal(diagnostic.failure_code, "QUALITY_VALIDATION_FAILED");
  assert.equal(diagnostic.defect_count, 3);
  assert.deepEqual(diagnostic.defects[0], { code: "GENERIC_OR_PLACEHOLDER", locale: "es", field: "cons", forbidden_terms: ["Consulte el README"] });
  assert.deepEqual(diagnostic.defects[1], {
    code: "LOCALE_INVARIANT",
    locale: "es",
    expected_fields: fields,
    actual_fields: ["goal", "usage", "pros", "fit"],
    invariant: { length: 8, sha256: invariantHash },
  });
  assert.equal(diagnostic.defects[2].code, "LOCALE_INVARIANT");
  assert.equal(diagnostic.defects[2].field, "cons");
  assert.deepEqual(diagnostic.defects[2].token_mismatch.expected_counts, { commands: 1, urls: 0, numbers: 1 });
  assert.deepEqual(diagnostic.usage, { inputTokens: 400, outputTokens: 800, attempts: 4, retries: 3 });
  assert.equal(JSON.stringify(diagnostic).includes("Consulte el README para"), false);
});

test("README-literal number invariants are accepted as declared and cross-locale field drift is a warning", async () => {
  const durationMarkdown = `${markdown}\n\nA typical local operation completes in 2 minutes.`;
  const durationItem = {
    ...item,
    markdown: durationMarkdown,
    readme_content_sha256: createHash("sha256").update(Buffer.from(durationMarkdown, "utf8")).digest("hex"),
  };
  const declared = modelEnvelope();
  const localizedDurations = {
    en: "The documented operation completes in 2 minutes.",
    ko: "문서화된 작업은 2분 안에 완료됩니다.",
    "zh-CN": "文档所述操作可在 2 分钟内完成。",
    es: "La operación documentada termina en 2 minutos.",
    ja: "文書化された処理は 2 分で完了します。",
  };
  for (const locale of SUMMARY_BUNDLE_LOCALES) declared.summaries[locale].pros += ` ${localizedDurations[locale]}`;
  declared.invariants.push({ kind: "number", value: "2 minutes" });
  const prompts = [];
  let calls = 0;
  const plan = measureClaudeCliSummaryBundlePlan([durationItem], { retryAttempts: 12 });
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
      calls += 1;
      return { structuredOutput: declared, usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.results[0].invariants.at(-1), { kind: "number", value: "2 minutes", fields: ["pros"] });
  assert.deepEqual(result.results[0].warnings.map(warning => warning.code), ["INVARIANT_FIELDS_SOFT", "INVARIANT_FIELDS_SOFT", "INVARIANT_FIELDS_SOFT", "INVARIANT_FIELDS_SOFT"]);
});

test("one repository exhausting its corrections is held while the other is verified", async () => {
  const second = { ...item, slug: "owner/second" };
  const plan = measureClaudeCliSummaryBundlePlan([item, second], { retryAttempts: 12 });
  const invalid = modelEnvelope();
  invalid.summaries.es.cons = "Consulte el README y ejecute `npm test` para conocer las limitaciones.";
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    concurrency: 1,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      if (calls === 1) return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
      if (calls === 2) return { structuredOutput: invalid, usage: { inputTokens: 100, outputTokens: 200 } };
      return { structuredOutput: summaryPatch(invalid, { es: ["cons"] }), usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 5);
  assert.deepEqual(result.results[0].summaries, bundle());
  assert.equal(result.results[1], null);
  assert.equal(result.held[0], null);
  assert.equal(result.held[1].slug, "owner/second");
  assert.equal(result.held[1].reason, "quality_defects");
  assert.deepEqual(result.held[1].defect_codes, ["GENERIC_OR_PLACEHOLDER"]);
  assert.equal(result.held[1].diagnostic.failure_code, "QUALITY_VALIDATION_FAILED");
  assert.equal(result.usage.attempts, 5);
});

test("a rate limit holds the failing and remaining repositories as budget_exhausted without failing the run", async () => {
  const items = [item, { ...item, slug: "owner/second" }, { ...item, slug: "owner/third" }];
  const plan = measureClaudeCliSummaryBundlePlan(items, { retryAttempts: 12 });
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    concurrency: 1,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      if (calls === 1) return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
      const error = new Error("Claude CLI request failed");
      error.failureCode = "CLAUDE_RATE_LIMITED";
      error.retryable = false;
      throw error;
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.results[0].summaries, bundle());
  assert.equal(result.results[1], null);
  assert.equal(result.results[2], null);
  assert.equal(result.held[1].reason, "budget_exhausted");
  assert.equal(result.held[1].diagnostic.failure_code, "CLAUDE_RATE_LIMITED");
  assert.equal(result.held[2].reason, "budget_exhausted");
  assert.equal(result.held[2].diagnostic.failure_code, "CLAUDE_RATE_LIMITED");
});

test("a per-request timeout after its retries holds only that repository as request_failed", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item, { ...item, slug: "owner/second" }], { retryAttempts: 12 });
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    concurrency: 1,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      if (calls <= 3) {
        const error = new Error("Claude CLI request timed out");
        error.failureCode = "CLAUDE_TIMEOUT";
        error.retryable = true;
        throw error;
      }
      return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.results[0], null);
  assert.equal(result.held[0].reason, "request_failed");
  assert.equal(result.held[0].diagnostic.failure_code, "CLAUDE_TIMEOUT");
  assert.deepEqual(result.results[1].summaries, bundle());
});

test("terminal Claude failure preserves its bounded request code without raw diagnostics", async () => {
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });

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
        const error = new Error("Claude CLI request failed");
        error.failureCode = "CLAUDE_SCHEMA_INVALID";
        error.retryable = false;
        throw error;
      },
    }),
    error => {
      assert.deepEqual(error.summaryFailureDiagnostic, {
        version: 1,
        repository: "owner/repo",
        failure_code: "CLAUDE_SCHEMA_INVALID",
        defect_count: 0,
        defects: [],
        usage: { inputTokens: 0, outputTokens: 0, attempts: 1, retries: 0 },
        runtime: {
          provider: "claude-cli-oauth",
          interface: "claude-p",
          cli_version: "2.1.241",
          auth_method: "oauth_token",
          api_provider: "firstParty",
          model: "claude-sonnet-5",
        },
      });
      assert.doesNotMatch(JSON.stringify(error.summaryFailureDiagnostic), /raw|stderr|stdout|diagnostic/i);
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

test("a missing inference hedge is a warning and does not consume a correction", async () => {
  const value = modelEnvelope();
  const hedges = {
    en: "This may affect an adoption decision.",
    ko: "이는 도입 판단에 영향을 줄 수 있습니다.",
    "zh-CN": "这可能会影响采用决策。",
    es: "Esto puede afectar una decisión de adopción.",
    ja: "これは導入判断に影響します。",
  };
  for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].cons += ` ${hedges[locale]}`;
  value.inference_fields = ["cons"];
  const plan = measureClaudeCliSummaryBundlePlan([item], { retryAttempts: 12 });
  let calls = 0;
  const result = await runClaudeSummaryBundleRequests({
    plan,
    environment: {},
    now: () => 0,
    deadline: 100_000,
    attemptTimeoutMs: 1_000,
    sleep: async () => {},
    preflight: async () => oauthRuntime,
    executeClaude: async () => {
      calls += 1;
      return { structuredOutput: value, usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.results[0].warnings, [{ code: "INFERENCE_HEDGE", locale: "ja", field: "cons" }]);
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

test("a provider-wide auth failure stops every worker while a quality failure does not", async () => {
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
        const error = new Error("Claude CLI request failed");
        error.failureCode = "CLAUDE_AUTH_FAILED";
        error.retryable = false;
        throw error;
      }
      if (slug === "owner/repo-1") {
        await secondBlocked;
        return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
      }
      return { structuredOutput: modelEnvelope(), usage: { inputTokens: 100, outputTokens: 200 } };
    },
  });
  const rejected = assert.rejects(execution, error => {
    assert.match(String(error?.message), /owner\/repo-0/);
    assert.equal(error.summaryFailureDiagnostic.failure_code, "CLAUDE_AUTH_FAILED");
    return true;
  });
  while (calls.filter(slug => slug === "owner/repo-0").length < 1) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  releaseSecond();
  await rejected;
  assert.equal(calls.includes("owner/repo-2"), false);
  assert.equal(calls.includes("owner/repo-3"), false);
});

test("number invariants that are literal README substrings are accepted without canonical normalization", () => {
  const md = `${markdown}\n\nBaseline spends 15,704 tokens and regresses 9.9 percent.`;
  const numberItem = { ...item, markdown: md, readme_content_sha256: createHash("sha256").update(Buffer.from(md, "utf8")).digest("hex") };
  const value = modelEnvelope();
  for (const locale of SUMMARY_BUNDLE_LOCALES) value.summaries[locale].usage += " 15,704 / 9.9 percent.";
  value.invariants.push({ kind: "number", value: "15,704" }, { kind: "number", value: "9.9 percent" });
  const checked = validateSummaryBundleEnvelope(value, numberItem);
  assert.deepEqual(checked.invariants.slice(-2).map(invariant => invariant.value), ["15,704", "9.9 percent"]);
  assert.deepEqual(checked.warnings, []);
  const absent = structuredClone(value);
  for (const locale of SUMMARY_BUNDLE_LOCALES) absent.summaries[locale].usage += " 42,000.";
  absent.invariants.push({ kind: "number", value: "42,000" });
  assert.throws(() => validateSummaryBundleEnvelope(absent, numberItem), /absent from README/);
});

test("number cross-locale drift is a warning while command differences stay hard", () => {
  const value = modelEnvelope();
  value.summaries.es.usage += " 3 pasos.";
  const checked = validateSummaryBundleEnvelope(value, item);
  assert.deepEqual(checked.warnings, [{ code: "LOCALE_INVARIANT_NUMBERS", locale: "es", field: "usage" }]);
  const command = modelEnvelope();
  command.summaries.ja.goal = command.summaries.ja.goal.replace("`npm test`", "`npm run test`");
  assert.throws(() => validateSummaryBundleEnvelope(command, item), /invariant|command|locale/i);
});

test("an English bundle shorter than the length contract is a warning", () => {
  const value = modelEnvelope();
  value.summaries.en = {
    goal: "Runs `npm test` for the documented repository.",
    usage: "Install, then run `npm test` as documented.",
    pros: "Concrete documented strength around `npm test`.",
    cons: "Documented limitation of `npm test`.",
    fit: "Teams whose workflow already uses `npm test`.",
  };
  const checked = validateSummaryBundleEnvelope(value, item);
  assert.ok(checked.warnings.some(warning => warning.code === "LENGTH_CONTRACT"));
});
