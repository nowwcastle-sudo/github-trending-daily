// scripts/observation-db-store.mjs
// Observation database store: the SQLite snapshot lives outside git as an immutable
// GitHub Release asset; git tracks only data/observation-db.pointer.json
// (docs/superpowers/specs/2026-09-05-observation-db-release-assets-design.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const TEST_RELEASE_TAG_RE = /^observation-db-test-[0-9]{14}$/;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}/g;

export function scrub(text) { return String(text ?? "").replace(TOKEN_RE, "[redacted]"); }
// A ::notice:: workflow command is one line by definition; an embedded newline would truncate it and
// leave the remainder loose in the log, so interpolated text is flattened first.
function collapse(text) { return String(text ?? "").replace(/\s+/g, " ").trim(); }
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

// The one resolve failure that is not a defect: a commit from before the observation database
// existed at all. Callers branch on it - the v0 and bootstrap arms of the two workflows - so it gets
// its own exit code (3) and a ::notice::, and every other failure keeps exit 1 and ::error::. Folding
// the two together is what let a corrupt pointer or a git fault read as "no database here yet".
export const UNTRACKED_CODE = "OBSERVATION_DB_UNTRACKED";
function untrackedError(message) {
  const error = new Error(message);
  error.code = UNTRACKED_CODE;
  return error;
}

// The one override honoured inside Actions, and deliberately so: observation-db-preflight.yml has to
// prove the Actions token can create a release and upload an asset, which no local PAT run can prove,
// and it must do that against a release nothing else will ever read. The name pattern is the whole
// safety property - a value that could name a real monthly release is refused here, not in the
// workflow - so it is checked on every call rather than once at startup.
export function releaseTagFor(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid snapshot id");
  const override = process.env.OBSERVATION_DB_RELEASE_TAG_OVERRIDE;
  if (override) {
    if (!TEST_RELEASE_TAG_RE.test(override)) throw fatalError("release tag override must name a throwaway test release");
    return override;
  }
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
  // Fatal: both this and allowedHosts() are read from inside the download retry loop, and a refused
  // override is a verdict about the configuration, not a transient failure worth 30 s of backoff.
  if (inActions()) throw fatalError("download base override is refused inside GitHub Actions");
  return override.replace(/\/+$/, "");
}
export function downloadBaseUrl() {
  return downloadBaseOverride() ?? `https://github.com/${OWNER_REPO}/releases/download`;
}
export function downloadUrlFor(pointer) { return `${downloadBaseUrl()}/${pointer.asset.releaseTag}/${pointer.asset.name}`; }

export function allowedHosts() {
  const override = process.env.OBSERVATION_DB_ALLOWED_HOSTS;
  if (override && inActions()) throw fatalError("allowed host override is refused inside GitHub Actions");
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
// `retryNotFound` is opt-in and exists for exactly one caller - see the 404 comment below.
export async function downloadVerified({ url, sha256: expectedSha256, byteSize, destination, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch, retryNotFound = false }) {
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
        // 404 stays fatal everywhere except the post-upload confirmation: a resolve asking for an
        // asset that is not there has its answer, but the publisher that just uploaded the file
        // knows it is supposed to exist, and GitHub sometimes needs a second or two to serve it.
        const retryable = RETRY_STATUSES.has(response.status) || (retryNotFound && response.status === 404);
        if (!retryable) throw fatalError(message);
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

export async function downloadAsset({ pointer, destination, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch, retryNotFound = false }) {
  validatePointer(pointer);
  return downloadVerified({
    url: downloadUrlFor(pointer), sha256: pointer.database.sha256, byteSize: pointer.database.byteSize,
    destination, deadline, fetchImpl, retryNotFound,
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
// Which mode we resolve in hangs entirely on this answer, so it is read from a command whose
// "absent" is a successful exit rather than a failure code. `cat-file -e` cannot do that: real git
// exits 128 for a path that is not in the tree - the shape of every pointer-only commit - and 128 is
// also what a broken invocation exits with, so absence and failure are indistinguishable. `ls-tree`
// exits 0 either way and says which it was in its output: no record for an untracked path, one
// NUL-terminated record for a tracked one. That record also carries the mode, so a symlink or a
// directory standing where the pointer or the database belongs is refused rather than followed.
function gitPathExists(sourceSha, relative, options) {
  let stdout;
  try { stdout = git(["ls-tree", "-z", sourceSha, "--", relative], options); }
  catch (error) {
    // Refusals raised by git() itself (an override inside Actions, the deadline) carry no exit
    // status, so they keep their own message instead of being flattened into a lookup failure.
    if (error.status === undefined && !error.signal) throw error;
    throw new Error(`git lookup failed for ${relative}`);
  }
  const records = stdout.toString("utf8").split("\0").filter(record => record !== "");
  if (records.length === 0) return false;
  // One pathspec naming one file can match one entry only; more than one, or an entry naming
  // something other than what was asked for, means git answered a question we did not ask.
  if (records.length !== 1) throw new Error(`git lookup failed for ${relative}`);
  const entry = /^([0-7]{6}) (blob|tree|commit) [0-9a-f]{40,64}\t([\s\S]+)$/.exec(records[0]);
  if (!entry || entry[3] !== relative) throw new Error(`git lookup failed for ${relative}`);
  if (entry[1] !== "100644" && entry[1] !== "100755") throw new Error(`${relative} is not a regular file at ${sourceSha}: mode ${entry[1]}`);
  return true;
}

export async function resolveObservationDatabase({ sourceSha, out = null, expectSnapshotId = null, gitRoot = process.cwd(), check = false, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch }) {
  if (typeof sourceSha !== "string" || !SHA_RE.test(sourceSha)) throw new Error("invalid source sha");
  if (expectSnapshotId !== null && !SNAPSHOT_RE.test(expectSnapshotId)) throw new Error("invalid expected snapshot id");
  const options = { gitRoot, deadline };
  const hasPointer = gitPathExists(sourceSha, POINTER_PATH, options);
  const hasBlob = gitPathExists(sourceSha, DATABASE_PATH, options);
  if (hasPointer && hasBlob) throw new Error(`observation database is ambiguous at ${sourceSha}: both pointer and blob are tracked`);
  if (!hasPointer && !hasBlob) throw untrackedError(`observation database is not tracked at ${sourceSha}: neither pointer nor blob is tracked`);
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

// Only publish shells out to gh, so it is the only place that needs GH_TOKEN. Every argument is
// passed as an array element; nothing is ever interpolated into a shell string.
function gh(args, { deadline }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("observation database publish deadline exceeded");
  // gh decides whether a release exists and whether an upload happened, so the test-only binary
  // override is refused inside Actions exactly like the git and download overrides are.
  const binOverride = process.env.GH_BIN;
  const scriptOverride = process.env.GH_SCRIPT;
  if ((binOverride || scriptOverride) && inActions()) throw fatalError("gh binary override is refused inside GitHub Actions");
  try {
    return execFileSync(binOverride || "gh", scriptOverride ? [scriptOverride, ...args] : args, {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: Math.min(600_000, remaining), stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // gh prints the token it used on some auth failures, so nothing from it reaches a message unscrubbed.
    const failure = new Error(`gh ${args[0]} ${args[1]} failed: ${scrub(error.stderr ?? error.message).trim().slice(0, 500)}`);
    failure.status = error.status;
    failure.stderr = scrub(error.stderr ?? "");
    throw failure;
  }
}

// Idempotent: the release for this month may already exist, and two refreshes can race to create it.
function ensureRelease(tag, targetSha, { deadline }) {
  try { gh(["release", "view", tag, "--json", "tagName"], { deadline }); return; }
  catch (error) {
    // Exit-code contract: `gh release view` exits 1 for a release that does not exist, and also for
    // other API failures (an expired token, a rate limit). Status alone is therefore not enough -
    // "missing" additionally has to say so in stderr, or we would answer an auth failure by trying
    // to create a release that already exists.
    if (error.status !== 1 || !/release not found|not found|HTTP 404/i.test(error.stderr ?? "")) throw error;
  }
  try {
    gh(["release", "create", tag, "--target", targetSha, "--prerelease", "--latest=false",
      "--title", `Observation database snapshots ${tag.slice("observation-db-".length)}`,
      "--notes", "Immutable observation-database snapshots produced by the trending refresh workflow. Each asset is named by its snapshot id and referenced from data/observation-db.pointer.json in the commit that published it."], { deadline });
  } catch (error) {
    if (!/already_exists|already exists/i.test(error.stderr ?? "")) throw error;
  }
}

export async function publishObservationDatabase({ database, snapshotId, targetSha, latestPath, scanReceiptPath, pointerOut, deadline = Date.now() + RESOLVE_DEADLINE_MS, fetchImpl = fetch }) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid snapshot id");
  if (typeof targetSha !== "string" || !SHA_RE.test(targetSha)) throw new Error("invalid target sha");
  const bytes = await readFile(database);
  if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) throw new Error("observation database size is out of range for a release asset");
  const sha256 = hash(bytes);
  // Both cross-checks run before gh is touched: a mismatch here means the wrong file is about to be
  // published under a name that can never be taken back, so nothing is created at all.
  const receipt = JSON.parse(await readFile(scanReceiptPath, "utf8"));
  if (receipt?.ok !== true || receipt.databaseSha256 !== sha256 || receipt.rawByteSize !== bytes.length) throw new Error("scan receipt does not describe the database being published");
  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  if (latest?.snapshotId !== snapshotId) throw new Error("latest.json snapshot id does not match the published snapshot");
  const pointer = validatePointer({
    version: 1, snapshotId,
    database: { sha256, byteSize: bytes.length },
    asset: { releaseTag: releaseTagFor(snapshotId), name: assetNameFor(snapshotId) },
  });
  ensureRelease(pointer.asset.releaseTag, targetSha, { deadline });
  const staging = await mkdtemp(path.join(tmpdir(), "observation-db-publish-"));
  const confirmed = path.join(staging, "served.sqlite");
  let uploaded = false;
  try {
    // gh names the asset after the file, so the upload is staged under the asset name. No --clobber:
    // an existing name is a conflict to resolve by comparing bytes, never something to overwrite.
    const staged = path.join(staging, pointer.asset.name);
    await copyFile(database, staged);
    try { gh(["release", "upload", pointer.asset.releaseTag, staged], { deadline }); uploaded = true; }
    catch (error) { process.stderr.write(`::notice::${collapse(`upload did not complete (${scrub(error.message)}); verifying the served asset instead`)}\n`); }
    // The only proof that matters: what the anonymous URL actually serves hashes to our bytes. This
    // is the one download allowed to retry a 404 - see downloadVerified's retryNotFound.
    await downloadAsset({ pointer, destination: confirmed, deadline, fetchImpl, retryNotFound: true });
  } finally {
    // A verified download lands mode 0444 - read-only on Windows - so it is made writable before the
    // recursive delete, and cleanup never masks the publish failure that brought us here. It is
    // still reported: a staging directory left behind is a leak worth one line in the log.
    await chmod(confirmed, 0o600).catch(() => {});
    await rm(staging, { recursive: true, force: true, maxRetries: 5 })
      .catch(error => { process.stderr.write(`::notice::${collapse(`staging cleanup failed for ${staging}: ${scrub(error.message)}`)}\n`); });
  }
  // The pointer is the artefact the commit carries, so it appears whole or not at all. A temp file
  // left behind by a failed write would fail the exclusive create on every later attempt.
  const temporary = `${pointerOut}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, pointerOut);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { pointer, uploaded };
}

const RESOLVE_FLAGS = Object.freeze({
  "source-sha": "string", out: "string", "expect-snapshot-id": "string", "git-root": "string", check: "boolean",
});

const PUBLISH_FLAGS = Object.freeze({
  database: "string", "snapshot-id": "string", "target-sha": "string",
  latest: "string", "scan-receipt": "string", "pointer-out": "string",
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

// publish has no optional flags: every one of them is part of the cross-check, so a missing one is a
// weaker publish rather than a smaller one.
function requireFlags(args, spec) {
  for (const key of Object.keys(spec)) if (!Object.hasOwn(args, key)) throw new Error(`flag --${key} is required`);
  return args;
}

async function publishFromArgs(argv, deadline) {
  const args = requireFlags(parseArgs(argv, PUBLISH_FLAGS), PUBLISH_FLAGS);
  const result = await publishObservationDatabase({
    database: args.database, snapshotId: args["snapshot-id"], targetSha: args["target-sha"],
    latestPath: args.latest, scanReceiptPath: args["scan-receipt"], pointerOut: args["pointer-out"], deadline,
  });
  process.stdout.write(`${JSON.stringify({
    uploaded: result.uploaded, snapshotId: result.pointer.snapshotId,
    sha256: result.pointer.database.sha256, byteSize: result.pointer.database.byteSize, asset: result.pointer.asset,
  })}\n`);
  return 0;
}

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
  // Exit 3 means one thing only - nothing is tracked at that commit - and both --check and a real
  // resolve report it the same way, so a caller can branch on it without parsing any output.
  main().then(code => { process.exitCode = code; }, error => {
    const untracked = error.code === UNTRACKED_CODE;
    process.stderr.write(`${untracked ? "::notice::" : "::error::"}${scrub(error.message)}\n`);
    process.exitCode = untracked ? 3 : 1;
  });
}
