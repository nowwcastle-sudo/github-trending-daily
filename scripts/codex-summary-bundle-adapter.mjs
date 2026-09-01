import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonStrict } from "./build-pages-artifact.mjs";
import { runBoundedClaudeProcess as runBoundedCliProcess } from "./claude-cli-runtime.mjs";
import { parseFrozenFactsBytes } from "./collect-repository-events.mjs";
import { CODEX_SUMMARY_PRODUCER_PROFILE, isSupportedSummaryProducer } from "./enrichment-models.mjs";
import {
  buildSummaryBundleRequest,
  buildSummarySource,
  planSummaryBundleReuse,
  summaryItemsFromFacts,
  validateSummaryBundleEnvelope,
} from "./generate-summary-bundles.mjs";

const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_EXEC_MODEL = "gpt-5.6-sol";
const PROCESS_TIMEOUT_MS = 15_000;
const MAX_PREFLIGHT_OUTPUT_BYTES = 256 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PLAN_KEYS = ["version", "facts_sha256", "pending", "requests", "producer", "model"];
const REQUEST_KEYS = [
  "slug", "readme_path", "readme_blob_sha", "readme_content_sha256", "default_branch_head_sha",
  "prompt_sha256", "schema_sha256",
];
const RESPONSE_KEYS = ["summaries", "evidence", "invariants", "inference_fields"];
const HELP_FLAGS = [
  "--ephemeral", "--ignore-user-config", "--output-schema", "--output-last-message", "--json", "--sandbox",
];

function exactKeys(value, keys) {
  return value && !Array.isArray(value) && typeof value === "object"
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalNewPath(target, label) {
  if (typeof target !== "string" || !target) throw new Error(`${label} path is required`);
  const absolute = path.resolve(target);
  try {
    await lstat(absolute);
    throw new Error(`${label} must be a new path`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const missing = [path.basename(absolute)];
  let ancestor = path.dirname(absolute);
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return { absolute, canonical: path.resolve(canonicalAncestor, ...missing.reverse()) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`${label} parent path is invalid`);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`${label} parent path is invalid`);
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function checkedPrepareOutput(outDir, sourceRoot) {
  const output = await canonicalNewPath(outDir, "Codex prepare output");
  const [checkout, source] = await Promise.all([realpath(CHECKOUT_ROOT), realpath(path.resolve(sourceRoot))]);
  if (isInside(CHECKOUT_ROOT, output.absolute) || isInside(checkout, output.canonical)
      || isInside(path.resolve(sourceRoot), output.absolute) || isInside(source, output.canonical)) {
    throw new Error("Codex prepare output must be outside the tracked checkout and source root");
  }
  return output.absolute;
}

async function checkedCompleteOutput(outPath) {
  const output = await canonicalNewPath(outPath, "Prepared Codex output");
  const checkout = await realpath(CHECKOUT_ROOT);
  if (isInside(CHECKOUT_ROOT, output.absolute) || isInside(checkout, output.canonical)) {
    throw new Error("Prepared Codex output must be outside the tracked checkout");
  }
  return output.absolute;
}

function checkedProcessResult(value, label) {
  if (!value || !Number.isInteger(value.exitCode) || typeof value.stdout !== "string"
      || typeof value.stderr !== "string" || typeof value.timedOut !== "boolean"
      || typeof value.outputExceeded !== "boolean" || value.exitCode !== 0 || value.timedOut || value.outputExceeded) {
    throw new Error(`${label} failed`);
  }
  return `${value.stdout}\n${value.stderr}`;
}

async function runPreflightCommand(runProcess, options, args, label) {
  const result = await runProcess({
    command: "codex",
    args,
    input: "",
    environment: options.environment,
    cwd: options.cwd,
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxStdoutBytes: MAX_PREFLIGHT_OUTPUT_BYTES,
    maxStderrBytes: MAX_PREFLIGHT_OUTPUT_BYTES,
  });
  return checkedProcessResult(result, label);
}

export async function runCodexSummaryPreflight({
  runProcess = runBoundedCliProcess,
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  if (typeof runProcess !== "function" || !environment || Array.isArray(environment) || typeof environment !== "object"
      || typeof cwd !== "string" || !cwd) throw new Error("Codex preflight configuration is invalid");
  const options = { environment, cwd };
  const versionOutput = await runPreflightCommand(runProcess, options, ["--version"], "Codex version check");
  const versions = [...versionOutput.matchAll(/\bcodex-cli\s+(\d+\.\d+\.\d+)\b/g)].map(match => match[1]);
  if (versions.length !== 1) throw new Error("Codex CLI version is invalid");
  const loginOutput = await runPreflightCommand(runProcess, options, ["login", "status"], "Codex login check");
  if (!/(?:^|\r?\n)Logged in using ChatGPT(?:\r?\n|$)/.test(loginOutput)) {
    throw new Error("Codex CLI is not logged in using ChatGPT");
  }
  const helpOutput = await runPreflightCommand(runProcess, options, ["exec", "--help"], "Codex exec capability check");
  if (HELP_FLAGS.some(flag => !new RegExp(`(?:^|\\s)${flag.replaceAll("-", "\\-")}(?:\\s|[=,]|$)`).test(helpOutput))) {
    throw new Error("Codex exec required capabilities are unavailable");
  }
  const producer = { ...CODEX_SUMMARY_PRODUCER_PROFILE, cli_version: versions[0] };
  if (!isSupportedSummaryProducer(producer)) throw new Error("Codex producer profile is invalid");
  return producer;
}

export function parseCodexTurnEvents(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  if (input.length === 0 || input.length > MAX_EVENT_BYTES || input.at(-1) !== 0x0a) {
    throw new Error("Codex JSONL event stream is incomplete");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); } catch { throw new Error("Codex JSONL is not valid UTF-8"); }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some(line => !line || line.endsWith("\r") && line.length === 1)) throw new Error("Codex JSONL event stream is invalid");
  let threads = 0;
  let turns = 0;
  let completed = null;
  for (const [index, line] of lines.entries()) {
    const event = parseJsonStrict(Buffer.from(line.endsWith("\r") ? line.slice(0, -1) : line), `Codex event ${index}`, MAX_EVENT_BYTES);
    if (!event || Array.isArray(event) || typeof event !== "object" || typeof event.type !== "string") {
      throw new Error("Codex event shape is invalid");
    }
    if (event.type === "thread.started") threads += 1;
    if (event.type === "turn.started") turns += 1;
    if (event.type === "turn.failed") throw new Error("Codex turn failed");
    if (event.type === "turn.completed") {
      if (completed !== null || !event.usage || Array.isArray(event.usage) || typeof event.usage !== "object") {
        throw new Error("Codex turn completion is invalid");
      }
      const inputTokens = event.usage.input_tokens;
      const outputTokens = event.usage.output_tokens;
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
        throw new Error("Codex token usage is invalid");
      }
      completed = { inputTokens, outputTokens };
    }
  }
  if (threads !== 1 || turns !== 1 || completed === null) throw new Error("Codex JSONL event stream is incomplete");
  return completed;
}

function checkedProducer(value) {
  if (!isSupportedSummaryProducer(value) || value.provider !== "codex-cli") {
    throw new Error("Codex producer profile is invalid");
  }
  return value;
}

function deterministicFrameId(factsSha256, slug, index) {
  const digest = sha256(Buffer.from(`${factsSha256}\0${slug}\0${index}`, "utf8"));
  const variant = ["8", "9", "a", "b"][Number.parseInt(digest[16], 16) % 4];
  return `gh-summary-${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function requestArtifacts(item, factsSha256, index) {
  const request = buildSummaryBundleRequest(item, { frameId: deterministicFrameId(factsSha256, item.slug, index) });
  const promptBytes = Buffer.from(request.prompt, "utf8");
  const schemaBytes = Buffer.from(`${JSON.stringify(request.schema, null, 2)}\n`, "utf8");
  return {
    request,
    promptBytes,
    schemaBytes,
    plan: {
      slug: item.slug,
      readme_path: item.readme_path,
      readme_blob_sha: item.readme_blob_sha,
      readme_content_sha256: item.readme_content_sha256,
      default_branch_head_sha: item.default_branch_head_sha,
      prompt_sha256: sha256(promptBytes),
      schema_sha256: sha256(schemaBytes),
    },
  };
}

async function measuredProducer(preflight) {
  if (typeof preflight !== "function") throw new Error("Codex preflight is invalid");
  return checkedProducer(await preflight({ environment: process.env, cwd: process.cwd() }));
}

export async function prepareCodexSummaryBundle({
  factsPath,
  sourceRoot,
  outDir,
  preflight = runCodexSummaryPreflight,
} = {}) {
  if (typeof factsPath !== "string" || !factsPath || typeof sourceRoot !== "string" || !sourceRoot) {
    throw new Error("Codex prepare inputs are invalid");
  }
  const outputRoot = await checkedPrepareOutput(outDir, sourceRoot);
  const factsFile = path.resolve(factsPath);
  const cacheFile = path.join(path.resolve(sourceRoot), "data", "repo-summaries.json");
  const [factsBytes, cacheBytes] = await Promise.all([readFile(factsFile), readFile(cacheFile)]);
  const facts = parseFrozenFactsBytes(factsBytes);
  const cache = parseJsonStrict(cacheBytes, "summary cache", 32 * 1024 * 1024);
  const items = summaryItemsFromFacts(facts);
  const { pending } = planSummaryBundleReuse(items, cache);
  const producer = await measuredProducer(preflight);
  const requests = pending.map((item, index) => requestArtifacts(item, facts.factsSha256, index));
  const plan = {
    version: 1,
    facts_sha256: facts.factsSha256,
    pending: pending.map(item => item.slug),
    requests: requests.map(value => value.plan),
    producer,
    model: CODEX_EXEC_MODEL,
  };
  const [finalFactsBytes, finalCacheBytes] = await Promise.all([readFile(factsFile), readFile(cacheFile)]);
  if (!factsBytes.equals(finalFactsBytes) || !cacheBytes.equals(finalCacheBytes)) {
    throw new Error("Codex prepare inputs changed after planning");
  }
  await mkdir(outputRoot, { recursive: false });
  await writeFile(path.join(outputRoot, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  for (const [index, value] of requests.entries()) {
    const suffix = String(index).padStart(3, "0");
    await writeFile(path.join(outputRoot, `request-${suffix}-prompt.txt`), value.promptBytes, { flag: "wx" });
    await writeFile(path.join(outputRoot, `request-${suffix}-schema.json`), value.schemaBytes, { flag: "wx" });
  }
  return { pending: plan.pending, requests: requests.length, factsSha256: facts.factsSha256, producer };
}

function checkedPlan(value) {
  if (!exactKeys(value, PLAN_KEYS) || value.version !== 1 || !SHA256_RE.test(value.facts_sha256 ?? "")
      || !Array.isArray(value.pending) || !Array.isArray(value.requests) || value.model !== CODEX_EXEC_MODEL
      || value.pending.length !== value.requests.length || new Set(value.pending.map(slug => slug.toLowerCase())).size !== value.pending.length
      || value.requests.some((request, index) => !exactKeys(request, REQUEST_KEYS) || request.slug !== value.pending[index]
        || !SHA256_RE.test(request.prompt_sha256 ?? "") || !SHA256_RE.test(request.schema_sha256 ?? ""))) {
    throw new Error("Codex summary plan is invalid");
  }
  checkedProducer(value.producer);
  return value;
}

function responseEnvelope(value) {
  const keys = Object.keys(value ?? {});
  if (!value || Array.isArray(value) || typeof value !== "object"
      || keys.some(key => !RESPONSE_KEYS.includes(key) && key !== "source")
      || RESPONSE_KEYS.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Codex response shape is invalid");
  }
  return Object.fromEntries(RESPONSE_KEYS.map(key => [key, value[key]]));
}

async function expectedResponseFiles(directory, count) {
  const expected = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, "0");
    expected.push(`events-${suffix}.jsonl`, `response-${suffix}.json`);
  }
  const actual = (await readdir(directory)).sort();
  if (actual.join("\0") !== expected.sort().join("\0")) throw new Error("Codex response file set is invalid");
}

export async function completeCodexSummaryBundle({
  factsPath,
  planPath,
  responsesDir,
  outPath,
  preflight = runCodexSummaryPreflight,
} = {}) {
  if ([factsPath, planPath, responsesDir].some(value => typeof value !== "string" || !value)) {
    throw new Error("Codex complete inputs are invalid");
  }
  const outputFile = await checkedCompleteOutput(outPath);
  const factsFile = path.resolve(factsPath);
  const planFile = path.resolve(planPath);
  const responseRoot = path.resolve(responsesDir);
  const requestRoot = path.dirname(planFile);
  const [factsBytes, planBytes] = await Promise.all([readFile(factsFile), readFile(planFile)]);
  const facts = parseFrozenFactsBytes(factsBytes);
  const plan = checkedPlan(parseJsonStrict(planBytes, "Codex summary plan", MAX_PLAN_BYTES));
  if (plan.facts_sha256 !== facts.factsSha256) throw new Error("Codex summary plan facts changed");
  const items = summaryItemsFromFacts(facts);
  const bySlug = new Map(items.map(item => [item.slug, item]));
  const artifacts = plan.requests.map((request, index) => {
    const item = bySlug.get(request.slug);
    if (!item) throw new Error("Codex summary plan pending set is invalid");
    const expected = requestArtifacts(item, facts.factsSha256, index);
    if (REQUEST_KEYS.some(key => request[key] !== expected.plan[key])) {
      throw new Error(`Codex summary request changed for ${request.slug}`);
    }
    return { item, ...expected };
  });
  const requestBytes = await Promise.all(artifacts.flatMap((_, index) => {
    const suffix = String(index).padStart(3, "0");
    return [
      readFile(path.join(requestRoot, `request-${suffix}-prompt.txt`)),
      readFile(path.join(requestRoot, `request-${suffix}-schema.json`)),
    ];
  }));
  for (let index = 0; index < artifacts.length; index += 1) {
    if (!requestBytes[index * 2].equals(artifacts[index].promptBytes)
        || !requestBytes[index * 2 + 1].equals(artifacts[index].schemaBytes)) {
      throw new Error(`Codex summary request file changed for ${artifacts[index].item.slug}`);
    }
  }
  const producer = await measuredProducer(preflight);
  if (Object.entries(plan.producer).some(([key, expected]) => producer[key] !== expected)) {
    throw new Error("Codex CLI provenance changed after prepare");
  }
  await expectedResponseFiles(responseRoot, artifacts.length);
  const responseBytes = await Promise.all(artifacts.flatMap((_, index) => {
    const suffix = String(index).padStart(3, "0");
    return [
      readFile(path.join(responseRoot, `response-${suffix}.json`)),
      readFile(path.join(responseRoot, `events-${suffix}.jsonl`)),
    ];
  }));
  let inputTokens = 0;
  let outputTokens = 0;
  const repositories = {};
  for (let index = 0; index < artifacts.length; index += 1) {
    const { item } = artifacts[index];
    const response = parseJsonStrict(responseBytes[index * 2], `Codex response for ${item.slug}`, MAX_RESPONSE_BYTES);
    const checked = validateSummaryBundleEnvelope(responseEnvelope(response), item);
    const usage = parseCodexTurnEvents(responseBytes[index * 2 + 1]);
    if (!Number.isSafeInteger(inputTokens + usage.inputTokens) || !Number.isSafeInteger(outputTokens + usage.outputTokens)) {
      throw new Error("Codex token usage total is invalid");
    }
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    repositories[item.slug] = {
      content: checked.summaries.en,
      summaries: checked.summaries,
      evidence: checked.evidence,
      invariants: checked.invariants,
      inference_fields: checked.inference_fields,
      source: buildSummarySource(item, producer),
    };
  }
  const output = {
    version: 1,
    facts_sha256: facts.factsSha256,
    producer,
    usage: { attempts: artifacts.length, input_tokens: inputTokens, output_tokens: outputTokens },
    repositories,
  };
  const [finalFactsBytes, finalPlanBytes, finalRequestBytes, finalResponseBytes] = await Promise.all([
    readFile(factsFile),
    readFile(planFile),
    Promise.all(artifacts.flatMap((_, index) => {
      const suffix = String(index).padStart(3, "0");
      return [
        readFile(path.join(requestRoot, `request-${suffix}-prompt.txt`)),
        readFile(path.join(requestRoot, `request-${suffix}-schema.json`)),
      ];
    })),
    Promise.all(artifacts.flatMap((_, index) => {
      const suffix = String(index).padStart(3, "0");
      return [
        readFile(path.join(responseRoot, `response-${suffix}.json`)),
        readFile(path.join(responseRoot, `events-${suffix}.jsonl`)),
      ];
    })),
  ]);
  await expectedResponseFiles(responseRoot, artifacts.length);
  if (!factsBytes.equals(finalFactsBytes) || !planBytes.equals(finalPlanBytes)
      || requestBytes.some((bytes, index) => !bytes.equals(finalRequestBytes[index]))
      || responseBytes.some((bytes, index) => !bytes.equals(finalResponseBytes[index]))) {
    throw new Error("Codex complete inputs changed during validation");
  }
  await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { pending: [...plan.pending], attempts: artifacts.length, inputTokens, outputTokens };
}

function parseArgs(argv, keys) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!keys.includes(key) || !value || Object.hasOwn(values, key)) throw new Error("Invalid Codex summary adapter arguments");
    values[key] = value;
  }
  if (Object.keys(values).length !== keys.length) throw new Error("Invalid Codex summary adapter arguments");
  return values;
}

export async function runCodexSummaryBundleAdapter(argv) {
  const [command, ...args] = argv;
  if (command === "prepare") {
    const values = parseArgs(args, ["--facts", "--source-root", "--out-dir"]);
    return prepareCodexSummaryBundle({
      factsPath: values["--facts"],
      sourceRoot: values["--source-root"],
      outDir: values["--out-dir"],
    });
  }
  if (command === "complete") {
    const values = parseArgs(args, ["--facts", "--plan", "--responses-dir", "--out"]);
    return completeCodexSummaryBundle({
      factsPath: values["--facts"],
      planPath: values["--plan"],
      responsesDir: values["--responses-dir"],
      outPath: values["--out"],
    });
  }
  throw new Error("Codex summary adapter command must be prepare or complete");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCodexSummaryBundleAdapter(process.argv.slice(2))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error instanceof Error ? error.message : "Codex summary adapter failed");
      process.exitCode = 1;
    });
}
