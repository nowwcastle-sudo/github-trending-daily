// scripts/observation-db-store.mjs
// Observation database store: the SQLite snapshot lives outside git as an immutable
// GitHub Release asset; git tracks only data/observation-db.pointer.json
// (docs/superpowers/specs/2026-09-05-observation-db-release-assets-design.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OWNER_REPO = "nowwcastle-sudo/github-trending-daily";
export const POINTER_PATH = "data/observation-db.pointer.json";
export const DATABASE_PATH = "data/repository-observations.sqlite";
export const RETRY_DELAYS_MS = Object.freeze([2000, 8000, 20000]);
export const RESOLVE_DEADLINE_MS = 600_000;
const MAX_POINTER_BYTES = 4096;
const MAX_ASSET_BYTES = 2 * 1024 ** 3;
const MAX_REDIRECTS = 5;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_ALLOWED_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}/g;

export function scrub(text) { return String(text ?? "").replace(TOKEN_RE, "[redacted]"); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function inActions() { return process.env.GITHUB_ACTIONS === "true"; }

export function releaseTagFor(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid snapshot id");
  return `observation-db-${snapshotId.slice(0, 4)}-${snapshotId.slice(4, 6)}`;
}
export function assetNameFor(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid snapshot id");
  return `repository-observations-${snapshotId}.sqlite`;
}

export function validatePointer(value) {
  const fail = () => { throw new Error("invalid observation database pointer"); };
  if (!exactKeys(value, ["version", "snapshotId", "database", "asset"]) || value.version !== 1) fail();
  if (typeof value.snapshotId !== "string" || !SNAPSHOT_RE.test(value.snapshotId)) fail();
  if (!exactKeys(value.database, ["sha256", "byteSize"]) || !HEX64_RE.test(value.database.sha256 ?? "")
      || !Number.isSafeInteger(value.database.byteSize) || value.database.byteSize <= 0 || value.database.byteSize > MAX_ASSET_BYTES) fail();
  if (!exactKeys(value.asset, ["releaseTag", "name"]) || value.asset.releaseTag !== releaseTagFor(value.snapshotId) || value.asset.name !== assetNameFor(value.snapshotId)) fail();
  return value;
}

export function parsePointerBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_POINTER_BYTES) throw new Error("invalid observation database pointer");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("invalid observation database pointer"); }
  return validatePointer(parsed);
}

export function downloadBaseUrl() {
  const override = process.env.OBSERVATION_DB_DOWNLOAD_BASE_URL;
  if (override) {
    if (inActions()) throw new Error("download base override is refused inside GitHub Actions");
    return override.replace(/\/+$/, "");
  }
  return `https://github.com/${OWNER_REPO}/releases/download`;
}
export function downloadUrlFor(pointer) { return `${downloadBaseUrl()}/${pointer.asset.releaseTag}/${pointer.asset.name}`; }

function allowedHosts() {
  const override = process.env.OBSERVATION_DB_ALLOWED_HOSTS;
  if (override && inActions()) throw new Error("allowed host override is refused inside GitHub Actions");
  return new Set(override ? override.split(",").map(v => v.trim()).filter(Boolean) : DEFAULT_ALLOWED_HOSTS);
}
function retryDelays() {
  const override = process.env.OBSERVATION_DB_RETRY_DELAYS_MS;
  if (!override) return RETRY_DELAYS_MS;
  if (inActions()) throw new Error("retry override is refused inside GitHub Actions");
  return override.split(",").map(Number);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchFollowing(url, { deadline, fetchImpl }) {
  const hosts = allowedHosts();
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current);
    if (!hosts.has(target.hostname)) throw new Error(`redirect target host is not allowed: ${target.hostname}`);
    if (Date.now() >= deadline) throw new Error("observation database download deadline exceeded");
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect without location");
      await response.body?.cancel?.();
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error("too many redirects");
}

async function writeExclusive(destination, chunks) {
  const handle = await open(destination, "wx", 0o444);
  try { for (const chunk of chunks) await handle.write(chunk); } finally { await handle.close(); }
}

const FATAL_RE = /mismatch|not allowed|redirect|deadline|EEXIST|HTTP 4/;

export async function downloadAsset({ pointer, destination, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch, skipNameCheck = false }) {
  validatePointer(skipNameCheck ? { ...pointer, asset: { ...pointer.asset, name: assetNameFor(pointer.snapshotId) } } : pointer);
  const url = downloadUrlFor(pointer);
  const expectedSize = pointer.database.byteSize;
  const delays = retryDelays();
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetchFollowing(url, { deadline, fetchImpl });
      if (response.status !== 200) {
        await response.body?.cancel?.();
        const error = new Error(`observation database asset download failed: HTTP ${response.status}`);
        if (!RETRY_STATUSES.has(response.status)) throw error;
        lastError = error;
      } else {
        const chunks = []; let total = 0; const digest = createHash("sha256");
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > expectedSize) throw new Error(`observation database asset size mismatch: more than ${expectedSize} bytes`);
          digest.update(chunk); chunks.push(chunk);
        }
        if (total !== expectedSize) throw new Error(`observation database asset size mismatch: ${total} != ${expectedSize}`);
        const sha256 = digest.digest("hex");
        if (sha256 !== pointer.database.sha256) throw new Error("observation database asset sha256 mismatch");
        await writeExclusive(destination, chunks);
        return { sha256, byteSize: total };
      }
    } catch (error) {
      if (FATAL_RE.test(error.message) || error.code === "EEXIST") throw error;
      lastError = error;
    }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  throw lastError ?? new Error("observation database asset download failed");
}

function git(args, { gitRoot, deadline }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("observation database resolve deadline exceeded");
  const full = ["-C", gitRoot, ...args];
  return execFileSync(process.env.GIT_BIN || "git", process.env.GIT_SCRIPT ? [process.env.GIT_SCRIPT, ...full] : full, {
    encoding: null, maxBuffer: 256 * 1024 * 1024, timeout: Math.min(120_000, remaining), stdio: ["ignore", "pipe", "pipe"],
  });
}
function gitPathExists(sourceSha, relative, options) {
  try { git(["cat-file", "-e", `${sourceSha}:${relative}`], options); return true; }
  catch (error) { if (error.status === 1) return false; throw new Error(`git lookup failed for ${relative}`); }
}

export async function resolveObservationDatabase({ sourceSha, out = null, expectSnapshotId = null, gitRoot = process.cwd(), check = false, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch }) {
  if (typeof sourceSha !== "string" || !SHA_RE.test(sourceSha)) throw new Error("invalid source sha");
  if (expectSnapshotId !== null && !SNAPSHOT_RE.test(expectSnapshotId)) throw new Error("invalid expected snapshot id");
  const options = { gitRoot, deadline };
  const hasPointer = gitPathExists(sourceSha, POINTER_PATH, options);
  const hasBlob = gitPathExists(sourceSha, DATABASE_PATH, options);
  if (hasPointer && hasBlob) throw new Error(`observation database is ambiguous at ${sourceSha}: both pointer and blob are tracked`);
  if (!hasPointer && !hasBlob) throw new Error(`observation database is unavailable at ${sourceSha}: neither pointer nor blob is tracked`);
  if (hasPointer) {
    const pointer = parsePointerBytes(git(["show", `${sourceSha}:${POINTER_PATH}`], options));
    if (expectSnapshotId !== null && pointer.snapshotId !== expectSnapshotId) throw new Error(`pointer snapshot ${pointer.snapshotId} does not match expected ${expectSnapshotId}`);
    if (check) return { mode: "pointer", snapshotId: pointer.snapshotId, sha256: pointer.database.sha256, byteSize: pointer.database.byteSize };
    if (!out) throw new Error("--out is required");
    const verified = await downloadAsset({ pointer, destination: path.resolve(out), deadline, fetchImpl });
    return { mode: "pointer", snapshotId: pointer.snapshotId, ...verified };
  }
  // Transition fallback (spec §7): the source commit predates the pointer. Deleted by the follow-up PR.
  if (check) return { mode: "blob", snapshotId: expectSnapshotId, sha256: null, byteSize: null };
  if (!out) throw new Error("--out is required");
  const bytes = git(["cat-file", "blob", `${sourceSha}:${DATABASE_PATH}`], options);
  await writeExclusive(path.resolve(out), [bytes]);
  return { mode: "blob", snapshotId: expectSnapshotId, sha256: hash(bytes), byteSize: bytes.length };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) { args[key] = argv[index + 1]; index += 1; } else args[key] = true;
    } else args._.push(value);
  }
  return args;
}

async function publishFromArgs() { throw new Error("publish is not implemented yet"); } // replaced in Task 2

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  const deadline = Date.now() + RESOLVE_DEADLINE_MS;
  if (command === "resolve") {
    const result = await resolveObservationDatabase({ sourceSha: args["source-sha"], out: args.out ?? null, expectSnapshotId: args["expect-snapshot-id"] ?? null, gitRoot: args["git-root"] ?? process.cwd(), check: args.check === true, deadline });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (command === "publish") return publishFromArgs(args, deadline);
  throw new Error(`unknown command: ${command ?? "(none)"}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }, error => { process.stderr.write(`::error::${scrub(error.message)}\n`); process.exitCode = 1; });
}
