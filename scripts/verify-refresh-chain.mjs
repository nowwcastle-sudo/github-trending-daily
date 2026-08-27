import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateDeploymentManifest } from "./build-pages-artifact.mjs";
import { readCandidateManifestFromDownload } from "./dispatch-refresh.mjs";
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
  if (expected && sameProvenance(expected, production)) {
    return { expectedRunId: expected.runId, effectiveRunId: expected.runId, receipt: expected };
  }
  if (expected && !isAncestor(expected.sourceSha, production.sourceSha)) throw new Error("production replacement is not a fast-forward");
  const receipt = selectMatchingReceipt(production, laterReceipts);
  if (receipt.sourceSha !== originMain) throw new Error("effective production source does not equal origin/main");
  return { expectedRunId: expected?.runId ?? null, effectiveRunId: receipt.runId, receipt };
}

function command(binary, args) {
  try {
    return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(error?.stderr?.toString().trim() || `${binary} command failed`);
  }
}

function gh(args) { return command(process.env.GH_BIN || "gh", args); }
function git(args) { return command(process.env.GIT_BIN || "git", args).trim(); }

function successfulDeployAndProbe(run) {
  if (run?.conclusion !== "success" || run?.status !== "completed" || !["workflow_dispatch", "schedule"].includes(run?.event)) return false;
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const successful = pattern => jobs.some(job => pattern.test(job.name ?? "") && job.conclusion === "success");
  return successful(/deploy/i) && successful(/probe|verify/i);
}

async function receiptForRun(runId, { requireSuccessfulChain = true, requireDispatchEvent = false } = {}) {
  const run = JSON.parse(gh(["run", "view", String(runId), "--json", "databaseId,headSha,event,status,conclusion,createdAt,url,jobs"]));
  if (requireSuccessfulChain && !successfulDeployAndProbe(run)) throw new Error(`run ${runId} lacks a successful Pages deploy/probe chain`);
  if (requireDispatchEvent && run.event !== "workflow_dispatch") throw new Error(`run ${runId} is not a workflow dispatch`);
  const directory = await mkdtemp(path.join(tmpdir(), `verify-refresh-${runId}-`));
  try {
    gh(["run", "download", String(runId), "--name", `github-pages-candidate-${runId}`, "--dir", directory]);
    const bytes = await readCandidateManifestFromDownload(directory);
    const manifest = validateDeploymentManifest(JSON.parse(bytes.toString("utf8")));
    return {
      runId: Number(runId),
      sourceSha: manifest.sourceSha,
      snapshotId: manifest.snapshotId,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: run.createdAt,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function productionReceipt(baseUrl) {
  const url = new URL("deployment-manifest.json", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(url, { redirect: "error", cache: "no-store" });
  if (response.status !== 200) throw new Error(`production manifest HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const manifest = validateDeploymentManifest(JSON.parse(bytes.toString("utf8")));
  return { sourceSha: manifest.sourceSha, snapshotId: manifest.snapshotId, manifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

function listSuccessfulRuns() {
  const runs = JSON.parse(gh(["run", "list", "--workflow", "daily-refresh.yml", "--limit", "100", "--json", "databaseId,headSha,event,status,conclusion,createdAt,url"]));
  if (!Array.isArray(runs) || runs.length > 100) throw new Error("invalid bounded workflow run list");
  return runs.filter(run => run.status === "completed" && run.conclusion === "success" && ["workflow_dispatch", "schedule"].includes(run.event));
}

function isAncestor(left, right) {
  try { command(process.env.GIT_BIN || "git", ["merge-base", "--is-ancestor", left, right]); return true; } catch { return false; }
}

export async function verifyRefreshChain({ baseUrl, currentProduction = false, expectedRunId = null, expectedSourceSha = null, expectedSnapshotId = null, expectedManifestSha256 = null }) {
  const production = await productionReceipt(baseUrl);
  let expected = null;
  let expectedCreatedAt = null;
  if (!currentProduction) {
    if (!Number.isSafeInteger(expectedRunId) || expectedRunId <= 0 || !SHA_RE.test(expectedSourceSha) || !SNAPSHOT_RE.test(expectedSnapshotId) || !SHA256_RE.test(expectedManifestSha256)) {
      throw new Error("invalid expected receipt arguments");
    }
    const actual = await receiptForRun(expectedRunId, { requireSuccessfulChain: true, requireDispatchEvent: true });
    expectedCreatedAt = actual.createdAt;
    expected = { runId: expectedRunId, sourceSha: expectedSourceSha, snapshotId: expectedSnapshotId, manifestSha256: expectedManifestSha256 };
    if (!sameProvenance(actual, expected)) throw new Error("expected run artifact does not match expected receipt");
  }

  let laterReceipts = [];
  if (!expected || !sameProvenance(expected, production)) {
    const candidates = listSuccessfulRuns().filter(run => !expected || (
      run.databaseId !== expected.runId
      && typeof run.createdAt === "string"
      && typeof expectedCreatedAt === "string"
      && run.createdAt > expectedCreatedAt
    ));
    for (const run of candidates) {
      try {
        const receipt = await receiptForRun(run.databaseId, { requireSuccessfulChain: true });
        if (sameProvenance(receipt, production)) laterReceipts.push(receipt);
      } catch {
        // A nonmatching or unavailable artifact is not evidence for production.
      }
    }
  }
  git(["fetch", "origin", "main"]);
  const originMain = git(["rev-parse", "refs/remotes/origin/main"]);
  const resolved = resolveEffectiveReceipt({ expected, production, laterReceipts, isAncestor, originMain });
  await probeProduction({ baseUrl, sourceSha: resolved.receipt.sourceSha, snapshotId: resolved.receipt.snapshotId });
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
