import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateDeploymentManifest } from "./build-pages-artifact.mjs";

const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;
const RECEIPT_KEYS = ["runId", "headSha", "sourceSha", "snapshotId", "manifestSha256", "url"];
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function validateDispatchReceipt(value) {
  if (!exactKeys(value, RECEIPT_KEYS)
    || !Number.isSafeInteger(value.runId) || value.runId <= 0
    || !SHA_RE.test(value.headSha) || !SHA_RE.test(value.sourceSha)
    || !SNAPSHOT_RE.test(value.snapshotId) || !SHA256_RE.test(value.manifestSha256)) {
    throw new Error("invalid dispatch receipt");
  }
  let url;
  try { url = new URL(value.url); } catch { throw new Error("invalid dispatch receipt"); }
  if (url.protocol !== "https:") throw new Error("invalid dispatch receipt");
  return value;
}

export function selectNewDispatchRun(beforeRuns, afterRuns, expectedHeadSha) {
  if (!SHA_RE.test(expectedHeadSha) || !Array.isArray(beforeRuns) || !Array.isArray(afterRuns)) throw new Error("invalid run selection input");
  const oldIds = new Set(beforeRuns.map(run => run.databaseId));
  const matches = afterRuns.filter(run => !oldIds.has(run.databaseId) && run.event === "workflow_dispatch" && run.headSha === expectedHeadSha);
  if (matches.length === 0) throw new Error("zero matching new workflow-dispatch runs");
  if (matches.length > 1) throw new Error("multiple matching new workflow-dispatch runs");
  return matches[0];
}

function command(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, { encoding: options.encoding ?? "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(error?.stderr?.toString().trim() || `${binary} command failed`);
  }
}

function gh(args) {
  return command(process.env.GH_BIN || "gh", args);
}

function git(args) {
  return command(process.env.GIT_BIN || "git", args).trim();
}

function listRuns() {
  const value = JSON.parse(gh(["run", "list", "--workflow", "daily-refresh.yml", "--event", "workflow_dispatch", "--limit", "100", "--json", "databaseId,headSha,event,status,conclusion,createdAt,url"]));
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid workflow run list");
  return value;
}

function safeArchiveName(value) {
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.includes("\\") || path.posix.isAbsolute(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("artifact path traversal rejected");
  }
  return normalized;
}

function tarString(block, start, length) {
  return block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function tarOctal(block, start, length) {
  const value = tarString(block, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("invalid candidate artifact tar header");
  return Number.parseInt(value, 8);
}

function manifestFromTar(bytes) {
  let offset = 0;
  let manifest = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const storedChecksum = tarOctal(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (storedChecksum !== checksum) throw new Error("invalid candidate artifact tar checksum");
    const prefix = tarString(header, 345, 155);
    const rawName = `${prefix}${prefix ? "/" : ""}${tarString(header, 0, 100)}`;
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const rootDirectory = type === "5" && (rawName === "." || rawName === "./");
    const name = rootDirectory ? "." : safeArchiveName(rawName);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > bytes.length) throw new Error("truncated candidate artifact tar");
    if (type === "1" || type === "2") throw new Error("artifact link rejected");
    if (type !== "0" && type !== "5") throw new Error("unsupported candidate artifact tar entry");
    if (!rootDirectory && type === "0" && path.posix.basename(name) === "deployment-manifest.json") {
      if (manifest !== null) throw new Error("artifact must contain exactly one deployment-manifest receipt candidate");
      manifest = Buffer.from(bytes.subarray(bodyStart, bodyEnd));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (manifest === null) throw new Error("artifact must contain exactly one deployment-manifest receipt candidate");
  return manifest;
}

export async function readCandidateManifestFromDownload(root) {
  const manifests = [];
  const archives = [];
  async function visit(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") throw new Error("unsafe artifact entry");
      const child = path.join(directory, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("artifact link rejected");
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (next.split("/").some(part => !part || part === "." || part === "..")) throw new Error("artifact path traversal rejected");
      if (info.isDirectory()) await visit(child, next);
      else if (info.isFile() && entry.name === "deployment-manifest.json") manifests.push(child);
      else if (info.isFile() && entry.name === "artifact.tar") archives.push(child);
      else if (!info.isFile()) throw new Error("artifact non-file rejected");
    }
  }
  await visit(root);
  if (manifests.length === 1 && archives.length === 0) return readFile(manifests[0]);
  if (manifests.length === 0 && archives.length === 1) return manifestFromTar(await readFile(archives[0]));
  throw new Error("artifact must contain exactly one deployment-manifest receipt candidate");
}

export async function dispatchRefresh({ wait = false, bootstrapSourceSha = null } = {}) {
  if (bootstrapSourceSha !== null && !SHA_RE.test(bootstrapSourceSha)) throw new Error("invalid bootstrap source SHA");
  const before = listRuns();
  git(["fetch", "origin", "main"]);
  const expectedHeadSha = git(["rev-parse", "refs/remotes/origin/main"]);
  if (!SHA_RE.test(expectedHeadSha)) throw new Error("origin/main is not a 40-hex commit");
  const dispatchArgs = ["workflow", "run", "daily-refresh.yml", "--ref", "main"];
  if (bootstrapSourceSha) dispatchArgs.push("-f", `bootstrap-source-sha=${bootstrapSourceSha}`);
  gh(dispatchArgs);

  const timeoutMs = Number(process.env.DISPATCH_TIMEOUT_MS ?? 60_000);
  const intervalMs = Number(process.env.DISPATCH_POLL_INTERVAL_MS ?? 2_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("invalid dispatch polling configuration");
  const deadline = Date.now() + timeoutMs;
  let selected;
  do {
    const after = listRuns();
    const oldIds = new Set(before.map(run => run.databaseId));
    const matches = after.filter(run => !oldIds.has(run.databaseId) && run.event === "workflow_dispatch" && run.headSha === expectedHeadSha);
    if (matches.length > 1) throw new Error("multiple matching new workflow-dispatch runs");
    if (matches.length === 1) { selected = matches[0]; break; }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  } while (true);
  if (!selected) throw new Error("zero matching new workflow-dispatch runs after 60 seconds");
  if (!wait) return { runId: selected.databaseId, headSha: expectedHeadSha, url: selected.url };

  gh(["run", "watch", String(selected.databaseId), "--exit-status"]);
  const directory = await mkdtemp(path.join(tmpdir(), "dispatch-refresh-"));
  try {
    gh(["run", "download", String(selected.databaseId), "--name", `github-pages-candidate-${selected.databaseId}`, "--dir", directory]);
    const manifestBytes = await readCandidateManifestFromDownload(directory);
    const manifest = validateDeploymentManifest(JSON.parse(manifestBytes.toString("utf8")));
    return validateDispatchReceipt({
      runId: selected.databaseId,
      headSha: expectedHeadSha,
      sourceSha: manifest.sourceSha,
      snapshotId: manifest.snapshotId,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      url: selected.url,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  let wait = false;
  let bootstrapSourceSha = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--wait" && !wait) wait = true;
    else if (argv[index] === "--bootstrap-source-sha" && bootstrapSourceSha === null && argv[index + 1]) bootstrapSourceSha = argv[++index];
    else throw new Error("invalid arguments");
  }
  return { wait, bootstrapSourceSha };
}

async function main() {
  console.log(JSON.stringify(await dispatchRefresh(parseArgs(process.argv.slice(2)))));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "refresh dispatch failed"); process.exitCode = 1; });
}
