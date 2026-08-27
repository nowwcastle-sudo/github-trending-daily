import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { parseJsonStrict, validateDeploymentManifest } from "./build-pages-artifact.mjs";

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
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !new RegExp(`/actions/runs/${value.runId}$`).test(url.pathname)) throw new Error("invalid dispatch receipt");
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
    return execFileSync(binary, args, { encoding: options.encoding ?? "utf8", maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, timeout: options.timeout ?? 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(error?.stderr?.toString().trim() || `${binary} command failed`);
  }
}

function gh(args, options) {
  return command(process.env.GH_BIN || "gh", process.env.GH_SCRIPT ? [process.env.GH_SCRIPT, ...args] : args, options);
}

function git(args) {
  return command(process.env.GIT_BIN || "git", process.env.GIT_SCRIPT ? [process.env.GIT_SCRIPT, ...args] : args).trim();
}

function listRuns() {
  const value = parseJsonStrict(Buffer.from(gh(["run", "list", "--workflow", "daily-refresh.yml", "--event", "workflow_dispatch", "--limit", "100", "--json", "databaseId,headSha,event,status,conclusion,createdAt,url"])), "GitHub workflow run list", 4 * 1024 * 1024);
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid workflow run list");
  for (const run of value) {
    let url;
    try { url = new URL(run?.url); } catch { throw new Error("invalid workflow run row"); }
    if (!Number.isSafeInteger(run?.databaseId) || run.databaseId <= 0 || !SHA_RE.test(run.headSha) || run.event !== "workflow_dispatch"
        || !["queued", "in_progress", "completed", "requested", "waiting", "pending"].includes(run.status)
        || ![null, "success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale"].includes(run.conclusion)
        || typeof run.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(run.createdAt) || !Number.isFinite(Date.parse(run.createdAt))
        || url.protocol !== "https:" || url.hostname !== "github.com" || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(url.pathname)) throw new Error("invalid workflow run row");
  }
  return value;
}

function safeArchiveName(value, { rootOnly = false } = {}) {
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.includes("\\") || path.posix.isAbsolute(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("artifact path traversal rejected");
  }
  if (rootOnly && normalized.includes("/")) throw new Error("artifact entry must be at archive root");
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pagesTarFromZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 128 * 1024 * 1024) throw new Error("invalid raw artifact ZIP size");
  const eocd = bytes.length - 22;
  if (bytes.readUInt32LE(eocd) !== 0x06054b50 || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
      || bytes.readUInt16LE(eocd + 8) !== 1 || bytes.readUInt16LE(eocd + 10) !== 1 || bytes.readUInt16LE(eocd + 20) !== 0) {
    throw new Error("artifact ZIP must contain exactly one entry without a trailer");
  }
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd || bytes.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("invalid artifact ZIP directory");
  const flags = bytes.readUInt16LE(centralOffset + 8);
  const method = bytes.readUInt16LE(centralOffset + 10);
  const expectedCrc = bytes.readUInt32LE(centralOffset + 16);
  const compressedSize = bytes.readUInt32LE(centralOffset + 20);
  const size = bytes.readUInt32LE(centralOffset + 24);
  const nameLength = bytes.readUInt16LE(centralOffset + 28);
  const extraLength = bytes.readUInt16LE(centralOffset + 30);
  const commentLength = bytes.readUInt16LE(centralOffset + 32);
  const localOffset = bytes.readUInt32LE(centralOffset + 42);
  const externalMode = bytes.readUInt32LE(centralOffset + 38) >>> 16;
  const name = bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
  if ((flags & ~(0x800 | 0x8)) !== 0 || ![0, 8].includes(method) || size > 96 * 1024 * 1024 || compressedSize > 96 * 1024 * 1024
      || extraLength > 4096 || commentLength > 4096 || localOffset !== 0 || centralOffset + 46 + nameLength + extraLength + commentLength !== eocd
      || safeArchiveName(name, { rootOnly: true }) !== "artifact.tar" || (externalMode & 0o170000) === 0o120000) {
    throw new Error("invalid artifact ZIP entry");
  }
  if (bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(6) !== flags || bytes.readUInt16LE(8) !== method) throw new Error("invalid artifact ZIP local header");
  const localNameLength = bytes.readUInt16LE(26);
  const localExtraLength = bytes.readUInt16LE(28);
  const localName = bytes.subarray(30, 30 + localNameLength).toString("utf8");
  const dataStart = 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (localExtraLength > 4096 || localName !== name || dataEnd > centralOffset) throw new Error("invalid artifact ZIP local entry");
  const descriptor = bytes.subarray(dataEnd, centralOffset);
  if ((flags & 0x8) === 0 ? descriptor.length !== 0 : ![12, 16].includes(descriptor.length)) throw new Error("invalid artifact ZIP data descriptor");
  if (flags & 0x8) {
    const start = descriptor.length === 16 ? 4 : 0;
    if ((descriptor.length === 16 && descriptor.readUInt32LE(0) !== 0x08074b50) || descriptor.readUInt32LE(start) !== expectedCrc
        || descriptor.readUInt32LE(start + 4) !== compressedSize || descriptor.readUInt32LE(start + 8) !== size) throw new Error("invalid artifact ZIP data descriptor");
  }
  const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
  const payload = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 96 * 1024 * 1024 });
  if (payload.length !== size || crc32(payload) !== expectedCrc) throw new Error("artifact ZIP checksum or size mismatch");
  return payload;
}

function filesFromTar(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024 || bytes.length > 96 * 1024 * 1024 || bytes.length % 512 !== 0) throw new Error("invalid candidate artifact tar size");
  let offset = 0;
  let zeroBlocks = 0;
  const files = new Map();
  const names = new Set();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      zeroBlocks += 1; offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks !== 0) throw new Error("invalid candidate artifact tar terminator");
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
    const folded = name.toLowerCase();
    if (!rootDirectory && names.has(folded)) throw new Error("case-fold duplicate artifact entry");
    if (!rootDirectory) names.add(folded);
    if (type === "0") files.set(name, Buffer.from(bytes.subarray(bodyStart, bodyEnd)));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks !== 2 || bytes.subarray(offset).some(byte => byte !== 0)) throw new Error("candidate artifact tar has nonzero trailing data");
  return files;
}

export function readCandidateManifestFromArchive(zipBytes) {
  const files = filesFromTar(pagesTarFromZip(zipBytes));
  const manifestBytes = files.get("deployment-manifest.json");
  if (!manifestBytes || [...files.keys()].some(name => name.toLowerCase() === "deployment-manifest.json" && name !== "deployment-manifest.json")) {
    throw new Error("artifact must contain exactly one root deployment-manifest.json");
  }
  const manifest = validateDeploymentManifest(parseJsonStrict(manifestBytes, "deployment manifest", 1024 * 1024));
  const expected = ["deployment-manifest.json", ...Object.keys(manifest.files)].sort();
  if ([...files.keys()].sort().join("\0") !== expected.join("\0")) throw new Error("artifact contains missing or unexpected files");
  for (const [name, expectedHash] of Object.entries(manifest.files)) {
    if (createHash("sha256").update(files.get(name)).digest("hex") !== expectedHash) throw new Error(`artifact file hash mismatch: ${name}`);
  }
  return manifestBytes;
}

function repositorySlug() {
  const configured = process.env.GITHUB_REPOSITORY;
  if (configured && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured)) return configured;
  const remote = git(["remote", "get-url", "origin"]);
  const match = /github\.com(?::|\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error("origin is not a canonical GitHub repository URL");
  return match[1];
}

export function downloadCandidateManifest(runId) {
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new Error("invalid artifact run id");
  const repository = repositorySlug();
  const listBytes = gh(["api", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  const response = parseJsonStrict(listBytes, "GitHub artifact list", 4 * 1024 * 1024);
  if (!response || typeof response !== "object" || !Number.isSafeInteger(response.total_count) || response.total_count < 0 || !Array.isArray(response.artifacts)
      || response.artifacts.length > 100 || response.total_count !== response.artifacts.length) {
    throw new Error("invalid GitHub artifact list schema");
  }
  for (const artifact of response.artifacts) {
    if (!artifact || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 || typeof artifact.name !== "string" || artifact.name.length === 0 || artifact.name.length > 256
        || typeof artifact.expired !== "boolean" || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 0) throw new Error("invalid GitHub artifact metadata row");
  }
  const expectedName = `github-pages-candidate-${runId}`;
  const matches = response.artifacts.filter(artifact => artifact?.name === expectedName);
  if (matches.length !== 1) throw new Error("exact candidate artifact metadata not found");
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes)
      || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 128 * 1024 * 1024) {
    throw new Error("invalid candidate artifact metadata");
  }
  const zipBytes = gh(["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, timeout: 60_000 });
  return readCandidateManifestFromArchive(zipBytes);
}

export async function dispatchRefresh({ wait = false, bootstrapSourceSha = null } = {}) {
  if (bootstrapSourceSha !== null && !SHA_RE.test(bootstrapSourceSha)) throw new Error("invalid bootstrap source SHA");
  const timeoutMs = Number(process.env.DISPATCH_TIMEOUT_MS ?? 60_000);
  const intervalMs = Number(process.env.DISPATCH_POLL_INTERVAL_MS ?? 2_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 || !Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 5_000) throw new Error("invalid dispatch polling configuration");
  const before = listRuns();
  git(["fetch", "origin", "main"]);
  const expectedHeadSha = git(["rev-parse", "refs/remotes/origin/main"]);
  if (!SHA_RE.test(expectedHeadSha)) throw new Error("origin/main is not a 40-hex commit");
  const dispatchArgs = ["workflow", "run", "daily-refresh.yml", "--ref", "main"];
  if (bootstrapSourceSha) dispatchArgs.push("-f", `bootstrap-source-sha=${bootstrapSourceSha}`);
  gh(dispatchArgs);

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

  gh(["run", "watch", String(selected.databaseId), "--exit-status"], { timeout: 95 * 60_000 });
  const manifestBytes = downloadCandidateManifest(selected.databaseId);
  const manifest = validateDeploymentManifest(parseJsonStrict(manifestBytes, "deployment manifest", 1024 * 1024));
  return validateDispatchReceipt({
    runId: selected.databaseId,
    headSha: expectedHeadSha,
    sourceSha: manifest.sourceSha,
    snapshotId: manifest.snapshotId,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    url: selected.url,
  });
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
