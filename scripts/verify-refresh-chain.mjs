import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseJsonStrict, validateDeploymentManifest } from "./build-pages-artifact.mjs";
import { downloadCandidateManifest, validRunStatusConclusion } from "./dispatch-refresh.mjs";
import { probeProduction } from "./probe-production.mjs";

const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;

function sameProvenance(left, right) {
  return left?.sourceSha === right?.sourceSha
    && left?.snapshotId === right?.snapshotId
    && left?.manifestSha256 === right?.manifestSha256;
}

export function selectMatchingReceipt(production, receipts) {
  const matches = receipts.filter(receipt => sameProvenance(production, receipt));
  if (matches.length !== 1) throw new Error("exactly one successful receipt must match production");
  return matches[0];
}

export function resolveEffectiveReceipt({ expected, production, laterReceipts, isAncestor, originMain }) {
  if (!production || !SHA_RE.test(production.sourceSha) || !SNAPSHOT_RE.test(production.snapshotId) || !SHA256_RE.test(production.manifestSha256)) {
    throw new Error("invalid production receipt");
  }
  const exactExpected = Boolean(expected && sameProvenance(expected, production));
  let receipt;
  if (exactExpected) receipt = expected;
  else {
    if (expected && !isAncestor(expected.sourceSha, production.sourceSha)) throw new Error("production replacement is not a fast-forward");
    receipt = selectMatchingReceipt(production, laterReceipts);
  }
  if (!exactExpected && receipt.sourceSha !== originMain) throw new Error("effective production source does not equal origin/main");
  return { expectedRunId: expected?.runId ?? null, effectiveRunId: receipt.runId, receipt };
}

function boundedTimeout(deadline, cap, label) {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error(`${label} deadline exceeded`);
  return Math.max(1, Math.min(cap, Math.ceil(remaining)));
}

function command(binary, args, { deadline = Date.now() + 30_000, timeout = 30_000, encoding = "utf8", maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    return execFileSync(binary, args, { encoding, maxBuffer, timeout: boundedTimeout(deadline, timeout, `${binary} command`), stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(error?.stderr?.toString().trim() || `${binary} command failed`);
  }
}

function gh(args, options) { return command(process.env.GH_BIN || "gh", process.env.GH_SCRIPT ? [process.env.GH_SCRIPT, ...args] : args, options); }
function git(args, options) { return command(process.env.GIT_BIN || "git", process.env.GIT_SCRIPT ? [process.env.GIT_SCRIPT, ...args] : args, options).trim(); }

function canonicalTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function githubRunUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(url.pathname);
  } catch { return false; }
}

export function validateWorkflowRun(run, expectedRunId, { requireDispatchEvent = false } = {}) {
  if (!run || typeof run !== "object" || !Number.isSafeInteger(run.databaseId) || run.databaseId !== Number(expectedRunId)
      || !SHA_RE.test(run.headSha) || !["workflow_dispatch", "schedule"].includes(run.event)
      || (requireDispatchEvent && run.event !== "workflow_dispatch") || run.status !== "completed" || run.conclusion !== "success"
      || !canonicalTimestamp(run.createdAt) || !githubRunUrl(run.url) || !Array.isArray(run.jobs) || run.jobs.length > 10) {
    throw new Error(`run ${expectedRunId} has an invalid successful workflow schema`);
  }
  for (const job of run.jobs) {
    if (!job || typeof job !== "object" || !Number.isSafeInteger(job.databaseId) || job.databaseId <= 0 || typeof job.name !== "string"
        || job.status !== "completed" || !validRunStatusConclusion(job.status, job.conclusion)) throw new Error("invalid workflow job schema");
  }
  for (const name of ["Deploy candidate Pages artifact", "Probe production candidate"]) {
    const matches = run.jobs.filter(job => job.name === name && job.conclusion === "success");
    if (matches.length !== 1) throw new Error(`run ${expectedRunId} lacks exact successful job ${name}`);
  }
  return run;
}

function approvedGeneratedCommitPath(relative) {
  return ["index.html", "data/repo-summaries.json", "data/star-observations.sqlite", "data/trending-membership.sqlite", "data/membership-status.json", "data/latest.json", "data/translation-sources.json", "feed.xml", "changes.xml", "star-history.json"].includes(relative)
    || /^translations\/[^/]+\.json$/.test(relative);
}

export function assertSourceBoundToRunHead(headSha, sourceSha, gitFn = git) {
  if (sourceSha === headSha) return true;
  const parents = gitFn(["show", "-s", "--format=%P", sourceSha]).split(/\s+/).filter(Boolean);
  if (parents.length !== 1 || parents[0] !== headSha) throw new Error("artifact source is not the run head or its one direct generated commit");
  const paths = gitFn(["diff-tree", "--no-commit-id", "--name-only", "-r", sourceSha]).split(/\r?\n/).filter(Boolean);
  if (paths.length === 0 || paths.some(relative => !approvedGeneratedCommitPath(relative))) throw new Error("artifact source commit contains non-generated changes");
  return true;
}

async function receiptForRun(runId, { requireSuccessfulChain = true, requireDispatchEvent = false, deadline = Date.now() + 300_000 } = {}) {
  if (Date.now() >= deadline) throw new Error("refresh receipt verification deadline exceeded");
  const run = parseJsonStrict(Buffer.from(gh(["run", "view", String(runId), "--json", "databaseId,headSha,event,status,conclusion,createdAt,url,jobs"], { deadline })), "GitHub workflow run", 4 * 1024 * 1024);
  if (requireSuccessfulChain) validateWorkflowRun(run, runId, { requireDispatchEvent });
  const bytes = downloadCandidateManifest(Number(runId), { deadline });
  const manifest = validateDeploymentManifest(parseJsonStrict(bytes, "deployment manifest", 1024 * 1024));
  assertSourceBoundToRunHead(run.headSha, manifest.sourceSha, args => git(args, { deadline }));
  return {
    runId: Number(runId),
    headSha: run.headSha,
    sourceSha: manifest.sourceSha,
    snapshotId: manifest.snapshotId,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt: run.createdAt,
  };
}

async function productionReceipt(baseUrl, { deadline = Date.now() + 300_000 } = {}) {
  const url = new URL("deployment-manifest.json", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(boundedTimeout(deadline, 15_000, "production manifest fetch")) });
  if (response.status !== 200) throw new Error(`production manifest HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 1024 * 1024) throw new Error("production manifest body is too large");
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("production manifest body is too large");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const manifest = validateDeploymentManifest(parseJsonStrict(bytes, "production deployment manifest", 1024 * 1024));
  return { sourceSha: manifest.sourceSha, snapshotId: manifest.snapshotId, manifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

function listSuccessfulRuns({ deadline = Date.now() + 300_000 } = {}) {
  const runs = parseJsonStrict(Buffer.from(gh(["run", "list", "--workflow", "daily-refresh.yml", "--limit", "100", "--json", "databaseId,headSha,event,status,conclusion,createdAt,url"], { deadline })), "GitHub workflow run list", 4 * 1024 * 1024);
  if (!Array.isArray(runs) || runs.length > 100) throw new Error("invalid bounded workflow run list");
  for (const run of runs) {
    if (!Number.isSafeInteger(run?.databaseId) || run.databaseId <= 0 || !SHA_RE.test(run.headSha) || !["workflow_dispatch", "schedule"].includes(run.event)
        || !validRunStatusConclusion(run.status, run.conclusion)
        || !canonicalTimestamp(run.createdAt) || !githubRunUrl(run.url)) throw new Error("invalid bounded workflow run row");
  }
  return runs.filter(run => run.status === "completed" && run.conclusion === "success" && ["workflow_dispatch", "schedule"].includes(run.event));
}

function isAncestor(left, right, { deadline = Date.now() + 300_000 } = {}) {
  try { git(["merge-base", "--is-ancestor", left, right], { deadline }); return true; } catch { return false; }
}

export async function verifyRefreshChain({ baseUrl, currentProduction = false, expectedRunId = null, expectedSourceSha = null, expectedSnapshotId = null, expectedManifestSha256 = null }, dependencies = {}) {
  const timeoutMs = Number(dependencies.timeoutMs ?? process.env.VERIFY_TIMEOUT_MS ?? 300_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("invalid refresh verification timeout");
  const deadline = Date.now() + timeoutMs;
  const getProduction = dependencies.productionReceipt ?? productionReceipt;
  const getReceipt = dependencies.receiptForRun ?? receiptForRun;
  const getRuns = dependencies.listSuccessfulRuns ?? listSuccessfulRuns;
  const fetchOrigin = dependencies.fetchOrigin ?? (({ deadline: value }) => git(["fetch", "origin", "main"], { deadline: value }));
  const getOriginMain = dependencies.originMain ?? (({ deadline: value }) => git(["rev-parse", "refs/remotes/origin/main"], { deadline: value }));
  const ancestor = dependencies.isAncestor ?? ((left, right) => isAncestor(left, right, { deadline }));
  const probe = dependencies.probeProduction ?? probeProduction;
  const production = await getProduction(baseUrl, { deadline });
  let expected = null;
  let expectedCreatedAt = null;
  if (!currentProduction) {
    if (!Number.isSafeInteger(expectedRunId) || expectedRunId <= 0 || !SHA_RE.test(expectedSourceSha) || !SNAPSHOT_RE.test(expectedSnapshotId) || !SHA256_RE.test(expectedManifestSha256)) {
      throw new Error("invalid expected receipt arguments");
    }
    const actual = await getReceipt(expectedRunId, { requireSuccessfulChain: true, requireDispatchEvent: true, deadline });
    if (actual.runId !== expectedRunId) throw new Error("expected receipt returned the wrong run id");
    expectedCreatedAt = actual.createdAt;
    expected = { runId: expectedRunId, sourceSha: expectedSourceSha, snapshotId: expectedSnapshotId, manifestSha256: expectedManifestSha256 };
    if (!sameProvenance(actual, expected)) throw new Error("expected run artifact does not match expected receipt");
  }

  let laterReceipts = [];
  if (!expected || !sameProvenance(expected, production)) {
    const candidates = getRuns({ deadline }).filter(run => !expected || (
      run.databaseId !== expected.runId
      && typeof run.createdAt === "string"
      && typeof expectedCreatedAt === "string"
      && run.createdAt > expectedCreatedAt
    ));
    for (const run of candidates) {
      if (Date.now() >= deadline) throw new Error("refresh chain verification deadline exceeded");
      try {
        const receipt = await getReceipt(run.databaseId, { requireSuccessfulChain: true, deadline });
        if (receipt.runId !== run.databaseId) throw new Error("candidate receipt returned the wrong run id");
        if (sameProvenance(receipt, production)) laterReceipts.push(receipt);
      } catch {
        // A nonmatching or unavailable artifact is not evidence for production.
      }
    }
  }
  if (Date.now() >= deadline) throw new Error("refresh chain verification deadline exceeded");
  fetchOrigin({ deadline });
  if (Date.now() >= deadline) throw new Error("refresh chain verification deadline exceeded");
  const originMain = getOriginMain({ deadline });
  const resolved = resolveEffectiveReceipt({ expected, production, laterReceipts, isAncestor: ancestor, originMain });
  await probe({ baseUrl, sourceSha: resolved.receipt.sourceSha, snapshotId: resolved.receipt.snapshotId, deadline });
  if (Date.now() >= deadline) throw new Error("refresh chain verification deadline exceeded");
  return { expectedRunId: resolved.expectedRunId, effectiveRunId: resolved.effectiveRunId, sourceSha: resolved.receipt.sourceSha, snapshotId: resolved.receipt.snapshotId, manifestSha256: resolved.receipt.manifestSha256 };
}

function parseArgs(argv) {
  const values = {};
  let currentProduction = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--current-production" && !currentProduction) currentProduction = true;
    else if (argv[index]?.startsWith("--") && argv[index + 1] !== undefined) {
      const key = argv[index].slice(2);
      if (Object.hasOwn(values, key)) throw new Error("invalid arguments");
      values[key] = argv[++index];
    }
    else throw new Error("invalid arguments");
  }
  const expected = currentProduction
    ? ["base-url"]
    : ["base-url", "expected-manifest-sha256", "expected-run-id", "expected-snapshot-id", "expected-source-sha"];
  if (Object.keys(values).sort().join("\0") !== expected.sort().join("\0") || expected.some(key => !values[key])) throw new Error("invalid arguments");
  return {
    baseUrl: values["base-url"], currentProduction,
    expectedRunId: values["expected-run-id"] === undefined ? null : Number(values["expected-run-id"]),
    expectedSourceSha: values["expected-source-sha"] ?? null,
    expectedSnapshotId: values["expected-snapshot-id"] ?? null,
    expectedManifestSha256: values["expected-manifest-sha256"] ?? null,
  };
}

async function main() {
  console.log(JSON.stringify(await verifyRefreshChain(parseArgs(process.argv.slice(2)))));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "refresh chain verification failed"); process.exitCode = 1; });
}
