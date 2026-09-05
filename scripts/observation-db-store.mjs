// scripts/observation-db-store.mjs
// Observation database store: the SQLite snapshot lives outside git as an immutable
// GitHub Release asset; git tracks only data/observation-db.pointer.json
// (docs/superpowers/specs/2026-09-05-observation-db-release-assets-design.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, open, unlink } from "node:fs/promises";
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
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_ALLOWED_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}/g;

export function scrub(text) { return String(text ?? "").replace(TOKEN_RE, "[redacted]"); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function inActions() { return process.env.GITHUB_ACTIONS === "true"; }

// An error carrying `fatal` is never retried. The flag is set where the error is built, so the
// retry loop never has to guess from message text what kind of failure it is looking at.
function fatalError(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

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
  if (!exactKeys(value.database, ["sha256", "byteSize"]) || typeof value.database.sha256 !== "string" || !HEX64_RE.test(value.database.sha256)
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

function downloadBaseOverride() {
  const override = process.env.OBSERVATION_DB_DOWNLOAD_BASE_URL;
  if (!override) return null;
  if (inActions()) throw new Error("download base override is refused inside GitHub Actions");
  return override.replace(/\/+$/, "");
}
export function downloadBaseUrl() {
  return downloadBaseOverride() ?? `https://github.com/${OWNER_REPO}/releases/download`;
}
export function downloadUrlFor(pointer) { return `${downloadBaseUrl()}/${pointer.asset.releaseTag}/${pointer.asset.name}`; }

export function allowedHosts() {
  const override = process.env.OBSERVATION_DB_ALLOWED_HOSTS;
  if (override && inActions()) throw new Error("allowed host override is refused inside GitHub Actions");
  return new Set(override ? override.split(",").map(v => v.trim()).filter(Boolean) : DEFAULT_ALLOWED_HOSTS);
}
export function retryDelays() {
  const override = process.env.OBSERVATION_DB_RETRY_DELAYS_MS;
  if (!override) return RETRY_DELAYS_MS;
  if (inActions()) throw new Error("retry override is refused inside GitHub Actions");
  return override.split(",").map(Number);
}
export function resolveDeadlineMs() {
  const override = process.env.OBSERVATION_DB_RESOLVE_DEADLINE_MS;
  if (!override) return RESOLVE_DEADLINE_MS;
  if (inActions()) throw new Error("resolve deadline override is refused inside GitHub Actions");
  const value = Number(override);
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid resolve deadline override");
  return value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// https everywhere; plain http only while the dev-only download base override is in force, which is
// what the tests point at a loopback server. In Actions that override throws before we get here.
function assertTransportAllowed(target) {
  if (target.protocol === "https:") return;
  if (target.protocol === "http:" && downloadBaseOverride()) return;
  throw fatalError(`download url scheme is not allowed: ${target.protocol}//${target.hostname}`);
}

async function fetchFollowing(url, { deadline, fetchImpl }) {
  const hosts = allowedHosts();
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current);
    assertTransportAllowed(target);
    if (!hosts.has(target.hostname)) throw fatalError(`redirect target host is not allowed: ${target.hostname}`);
    if (Date.now() >= deadline) throw fatalError("observation database download deadline exceeded");
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw fatalError("redirect without location");
      await response.body?.cancel?.();
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw fatalError("too many redirects");
}

// A half-written destination would poison every later attempt - mode 0444 makes it unwritable and
// the exclusive create would then fail with EEXIST forever - so a failed write removes the file.
async function writeExclusive(destination, chunks) {
  let handle;
  try {
    handle = await open(destination, "wx", 0o444);
  } catch (error) {
    error.fatal = true;
    throw error;
  }
  try {
    for (const chunk of chunks) await handle.write(chunk);
  } catch (error) {
    await handle.close().catch(() => {});
    await chmod(destination, 0o600).catch(() => {});
    await unlink(destination).catch(() => {});
    error.fatal = true;
    throw error;
  }
  await handle.close();
}

// URL-level verified download: nothing reaches disk until both the byte size and the sha256 match.
export async function downloadVerified({ url, sha256: expectedSha256, byteSize, destination, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch }) {
  if (typeof url !== "string" || url === "") throw fatalError("invalid download url");
  if (typeof destination !== "string" || destination === "") throw fatalError("invalid download destination");
  if (typeof expectedSha256 !== "string" || !HEX64_RE.test(expectedSha256)) throw fatalError("invalid expected sha256");
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > MAX_ASSET_BYTES) throw fatalError("invalid expected byte size");
  const delays = retryDelays();
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetchFollowing(url, { deadline, fetchImpl });
      if (response.status !== 200) {
        await response.body?.cancel?.();
        const message = `observation database asset download failed: HTTP ${response.status}`;
        if (!RETRY_STATUSES.has(response.status)) throw fatalError(message);
        lastError = new Error(message);
      } else {
        const chunks = []; let total = 0; const digest = createHash("sha256");
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > byteSize) throw fatalError(`observation database asset size mismatch: more than ${byteSize} bytes`);
          digest.update(chunk); chunks.push(chunk);
        }
        if (total !== byteSize) throw fatalError(`observation database asset size mismatch: ${total} != ${byteSize}`);
        const sha256 = digest.digest("hex");
        if (sha256 !== expectedSha256) throw fatalError("observation database asset sha256 mismatch");
        await writeExclusive(destination, chunks);
        return { sha256, byteSize: total };
      }
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    if (attempt < delays.length) await sleep(Math.max(0, Math.min(delays[attempt], deadline - Date.now())));
  }
  throw lastError ?? new Error("observation database asset download failed");
}

export async function downloadAsset({ pointer, destination, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch }) {
  validatePointer(pointer);
  return downloadVerified({
    url: downloadUrlFor(pointer), sha256: pointer.database.sha256, byteSize: pointer.database.byteSize,
    destination, deadline, fetchImpl,
  });
}

function git(args, { gitRoot, deadline }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("observation database resolve deadline exceeded");
  // git output is the trust root for which mode we resolve in, so the test-only binary override is
  // refused inside Actions exactly like the download overrides are.
  const binOverride = process.env.GIT_BIN;
  const scriptOverride = process.env.GIT_SCRIPT;
  if ((binOverride || scriptOverride) && inActions()) throw new Error("git binary override is refused inside GitHub Actions");
  const full = ["-C", gitRoot, ...args];
  return execFileSync(binOverride || "git", scriptOverride ? [scriptOverride, ...full] : full, {
    encoding: null, maxBuffer: 256 * 1024 * 1024, timeout: Math.min(120_000, remaining), stdio: ["ignore", "pipe", "pipe"],
  });
}
function gitPathExists(sourceSha, relative, options) {
  try { git(["cat-file", "-e", `${sourceSha}:${relative}`], options); return true; }
  catch (error) {
    if (error.status === 1) return false;
    // Refusals raised by git() itself (an override inside Actions, the deadline) carry no exit
    // status, so they keep their own message instead of being flattened into a lookup failure.
    if (error.status === undefined && !error.signal) throw error;
    throw new Error(`git lookup failed for ${relative}`);
  }
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
  // Transition fallback (spec section 7): the source commit predates the pointer. Deleted by the
  // follow-up PR. The blob carries no snapshot id, so this mode reports null instead of echoing
  // back what the caller expected - claiming a verification that never happened would be worse.
  process.stderr.write("::notice::blob fallback cannot verify --expect-snapshot-id; export-parent-inputs verifies the parent snapshot id\n");
  if (check) return { mode: "blob", snapshotId: null, sha256: null, byteSize: null };
  if (!out) throw new Error("--out is required");
  const bytes = git(["cat-file", "blob", `${sourceSha}:${DATABASE_PATH}`], options);
  await writeExclusive(path.resolve(out), [bytes]);
  return { mode: "blob", snapshotId: null, sha256: hash(bytes), byteSize: bytes.length };
}

const RESOLVE_FLAGS = Object.freeze({
  "source-sha": "string", out: "string", "expect-snapshot-id": "string", "git-root": "string", check: "boolean",
});

// Fails closed on anything it does not recognise: an unknown flag, a repeated flag, and a
// value-taking flag with no value are all errors rather than a silently-wrong run.
function parseArgs(argv, spec) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!Object.hasOwn(spec, key)) throw new Error(`unknown flag: --${key}`);
    if (Object.hasOwn(args, key)) throw new Error(`repeated flag: --${key}`);
    if (spec[key] === "boolean") { args[key] = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`flag --${key} requires a value`);
    args[key] = value;
    index += 1;
  }
  return args;
}

async function publishFromArgs() { throw new Error("publish is not implemented yet"); } // replaced in Task 2

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const rest = argv.slice(1);
  const deadline = Date.now() + resolveDeadlineMs();
  if (command === "resolve") {
    const args = parseArgs(rest, RESOLVE_FLAGS);
    const result = await resolveObservationDatabase({
      sourceSha: args["source-sha"], out: args.out ?? null, expectSnapshotId: args["expect-snapshot-id"] ?? null,
      gitRoot: args["git-root"] ?? process.cwd(), check: args.check === true, deadline,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (command === "publish") return publishFromArgs(rest, deadline);
  throw new Error(`unknown command: ${command ?? "(none)"}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }, error => { process.stderr.write(`::error::${scrub(error.message)}\n`); process.exitCode = 1; });
}
