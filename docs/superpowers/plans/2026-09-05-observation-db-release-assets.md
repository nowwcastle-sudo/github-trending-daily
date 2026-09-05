# Observation Database → Release Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop committing `data/repository-observations.sqlite`; every refresh uploads the database as an immutable GitHub Release asset and commits a hash-verified pointer that all consumers resolve fail-closed.

**Architecture:** One new Node script `scripts/observation-db-store.mjs` owns two operations: `resolve` (git-addressed lookup of the pointer, anonymous HTTPS download, sha256+size verification, transition fallback to the tracked blob) and `publish` (release-per-month, asset-per-snapshot upload through `gh`, pointer write). Three workflows and two scripts swap their direct blob reads for `resolve`; the W1 promote step reorders so only the push can orphan an asset and uploads a 30-day second copy.

**Tech Stack:** Node 24 ESM (`node:test`, `node:crypto`, global `fetch`), Python 3.13 (`unittest`), GitHub Actions bash steps, `gh` CLI (publish only).

**Spec:** `docs/superpowers/specs/2026-09-05-observation-db-release-assets-design.md` (rev. 2). Read it before any task; section numbers below refer to it.

## Global Constraints

- Never modify the SQLite schema, `record_repository_observations.py`, `derive_repository_artifacts.py`, `VERSION_1_BASE_PATHS`, or `artifact_hashes`; the pointer path is never added to those (§2).
- No force-push, no history rewrite, no `--clobber`, no `--skip-existing`.
- Fail closed: any mismatch, ambiguity (pointer and blob both present), missing asset, or unexpected redirect host stops the run before publication.
- Only the W1 promote step exports `GH_TOKEN`; no other step in any workflow may export it (§5, §6.4). Never print token values; scrub `gh` stderr with the token regexes before echoing.
- Identity of a snapshot is the raw DB sha256; the pointer carries exactly `version, snapshotId, database{sha256,byteSize}, asset{releaseTag,name}` (§4.2). Release tag `observation-db-YYYY-MM`, asset `repository-observations-<snapshotId>.sqlite` (§4.1).
- Anonymous download URL base `https://github.com/nowwcastle-sudo/github-trending-daily/releases/download`; redirects only to `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`; body bounded by `database.byteSize`; retries `[2000, 8000, 20000]` ms on 408/425/429/5xx and network errors; deadline 600 s (§5).
- `resolve` never overwrites its `--out` (open with `wx`, mode 0444); callers delete stale files first.
- Tests: `npm test` (node + pytest) must stay green after every task; workflow files are CRLF; run tests in PowerShell from the repository root. Test doubles use `GIT_BIN`/`GIT_SCRIPT` (existing pattern in `scripts/probe-production.mjs:75`) and the new `GH_BIN`/`GH_SCRIPT`, `OBSERVATION_DB_DOWNLOAD_BASE_URL` (refused when `GITHUB_ACTIONS=true`), `OBSERVATION_DB_RESOLVER_SCRIPT`.
- Commit after each task with an English message; before each commit run `git diff --cached --check` and the staged-added-line secret scan (`sk-ant-|gh[pousr]_|github_pat_|AIza|BEGIN .*PRIVATE KEY`).
- Work on branch `feat/observation-db-release-assets-20260905` in `C:\Users\nasca\AppData\Local\Temp\gh-trending-page`.

---

### Task 1: Store script — pointer schema, `resolve`, anonymous download

**Files:**
- Create: `scripts/observation-db-store.mjs`
- Test: `tests/observation-db-store.test.mjs`

**Interfaces:**
- Produces (used by Tasks 2, 5, 6, 7):
  - `export const OWNER_REPO = "nowwcastle-sudo/github-trending-daily"`, `POINTER_PATH = "data/observation-db.pointer.json"`, `DATABASE_PATH = "data/repository-observations.sqlite"`, `RETRY_DELAYS_MS`, `RESOLVE_DEADLINE_MS`.
  - `export function releaseTagFor(snapshotId): string` → `observation-db-YYYY-MM`.
  - `export function assetNameFor(snapshotId): string`.
  - `export function validatePointer(value): pointer` (throws `Error("invalid observation database pointer")` on any violation).
  - `export function downloadUrlFor(pointer): string`.
  - `export async function downloadAsset({ pointer, destination, deadline, fetchImpl, skipNameCheck }): Promise<{ sha256, byteSize }>`.
  - `export async function resolveObservationDatabase({ sourceSha, out, expectSnapshotId = null, gitRoot = process.cwd(), check = false, deadline })`: returns `{ mode: "pointer" | "blob", snapshotId, sha256, byteSize }`.
  - CLI: `node scripts/observation-db-store.mjs resolve --source-sha <sha> --out <file> [--expect-snapshot-id <id>] [--git-root <dir>] [--check]` exit 0/1; prints one JSON line `{"mode":..,"sha256":..,"byteSize":..}` on success and `::error::<message>` on failure.

- [ ] **Step 1: Write the failing tests**

```js
// tests/observation-db-store.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assetNameFor, releaseTagFor, validatePointer, downloadUrlFor, downloadAsset, resolveObservationDatabase,
} from "../scripts/observation-db-store.mjs";

const SNAPSHOT = "20260905024612-0123456789abcdef";
const SHA = "a".repeat(40);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const DB = Buffer.from("SQLite format 3\0" + "x".repeat(4000));
const pointerFor = (bytes = DB, overrides = {}) => ({
  version: 1, snapshotId: SNAPSHOT,
  database: { sha256: sha256(bytes), byteSize: bytes.length },
  asset: { releaseTag: releaseTagFor(SNAPSHOT), name: assetNameFor(SNAPSHOT) },
  ...overrides,
});

test("tag and asset names derive from the snapshot id", () => {
  assert.equal(releaseTagFor(SNAPSHOT), "observation-db-2026-09");
  assert.equal(assetNameFor(SNAPSHOT), `repository-observations-${SNAPSHOT}.sqlite`);
  assert.throws(() => releaseTagFor("2026-09-05"), /snapshot/i);
});

test("pointer validation is exact and derived fields are re-checked", () => {
  assert.deepEqual(validatePointer(pointerFor()), pointerFor());
  assert.throws(() => validatePointer({ ...pointerFor(), producedAt: "x" }), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { snapshotId: "bad" })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { database: { sha256: "0".repeat(63), byteSize: 1 } })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { database: { sha256: "0".repeat(64), byteSize: -1 } })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { asset: { releaseTag: "observation-db-2026-10", name: assetNameFor(SNAPSHOT) } })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { asset: { releaseTag: releaseTagFor(SNAPSHOT), name: "other.sqlite" } })), /pointer/i);
  assert.equal(downloadUrlFor(pointerFor()), `https://github.com/nowwcastle-sudo/github-trending-daily/releases/download/observation-db-2026-09/repository-observations-${SNAPSHOT}.sqlite`);
});

async function assetServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

test("downloadAsset verifies hash and size, follows one allow-listed redirect, retries 503, refuses oversize and bad hosts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "obs-store-"));
  let attempts = 0;
  const { base, close } = await assetServer((request, response) => {
    if (request.url.endsWith("/redirect.sqlite")) { response.writeHead(302, { location: `${base}/final.sqlite` }); response.end(); return; }
    if (request.url.endsWith("/final.sqlite")) { response.writeHead(200); response.end(DB); return; }
    if (request.url.endsWith("/flaky.sqlite")) { attempts += 1; if (attempts < 2) { response.writeHead(503); response.end(); return; } response.writeHead(200); response.end(DB); return; }
    if (request.url.endsWith("/big.sqlite")) { response.writeHead(200); response.end(Buffer.concat([DB, Buffer.from("extra")])); return; }
    if (request.url.endsWith("/wrong.sqlite")) { response.writeHead(200); response.end(Buffer.from("y".repeat(DB.length))); return; }
    if (request.url.endsWith("/evil.sqlite")) { response.writeHead(302, { location: "http://127.0.0.2:9/x" }); response.end(); return; }
    response.writeHead(404); response.end();
  });
  t.after(close);
  process.env.OBSERVATION_DB_DOWNLOAD_BASE_URL = base;
  process.env.OBSERVATION_DB_ALLOWED_HOSTS = "127.0.0.1";
  process.env.OBSERVATION_DB_RETRY_DELAYS_MS = "1,1,1";
  t.after(() => { delete process.env.OBSERVATION_DB_DOWNLOAD_BASE_URL; delete process.env.OBSERVATION_DB_ALLOWED_HOSTS; delete process.env.OBSERVATION_DB_RETRY_DELAYS_MS; });
  const withName = name => ({ ...pointerFor(), asset: { ...pointerFor().asset, name } });
  const fetchWith = (name, out) => downloadAsset({ pointer: withName(name), destination: join(directory, out), deadline: Date.now() + 10_000, skipNameCheck: true });
  const ok = await fetchWith("redirect.sqlite", "a.sqlite");
  assert.equal(ok.sha256, sha256(DB)); assert.equal(ok.byteSize, DB.length);
  assert.deepEqual(await readFile(join(directory, "a.sqlite")), DB);
  await assert.rejects(fetchWith("redirect.sqlite", "a.sqlite"), /EEXIST|exists/i);
  assert.equal((await fetchWith("flaky.sqlite", "b.sqlite")).sha256, sha256(DB));
  await assert.rejects(fetchWith("big.sqlite", "c.sqlite"), /size/i);
  await assert.rejects(fetchWith("wrong.sqlite", "d.sqlite"), /sha256/i);
  await assert.rejects(fetchWith("missing.sqlite", "e.sqlite"), /404/);
  await assert.rejects(fetchWith("evil.sqlite", "f.sqlite"), /redirect|allowed/i);
});

test("download base override is refused inside GitHub Actions", () => {
  process.env.OBSERVATION_DB_DOWNLOAD_BASE_URL = "http://127.0.0.1:1";
  process.env.GITHUB_ACTIONS = "true";
  try { assert.throws(() => downloadUrlFor(pointerFor()), /override/i); }
  finally { delete process.env.OBSERVATION_DB_DOWNLOAD_BASE_URL; delete process.env.GITHUB_ACTIONS; }
});

async function fakeGit(directory, { pointer = null, blob = null }) {
  const script = join(directory, "fake-git.mjs");
  await writeFile(join(directory, "pointer.json"), pointer ? JSON.stringify(pointer) : "");
  await writeFile(join(directory, "blob.sqlite"), blob ?? Buffer.alloc(0));
  await writeFile(script, `import { readFileSync } from "node:fs"; let args = process.argv.slice(2); if (args[0] === "-C") args = args.slice(2);
const has = { pointer: ${Boolean(pointer)}, blob: ${Boolean(blob)} };
const spec = args.at(-1); const isPointer = spec.endsWith(":data/observation-db.pointer.json"); const isBlob = spec.endsWith(":data/repository-observations.sqlite");
if (args[0] === "cat-file" && args[1] === "-e") process.exit((isPointer && has.pointer) || (isBlob && has.blob) ? 0 : 1);
if (args[0] === "cat-file" && args[1] === "blob" && isBlob && has.blob) { process.stdout.write(readFileSync(process.env.FAKE_BLOB)); process.exit(0); }
if (args[0] === "show" && isPointer && has.pointer) { process.stdout.write(readFileSync(process.env.FAKE_POINTER)); process.exit(0); }
process.exit(128);`);
  return { GIT_BIN: process.execPath, GIT_SCRIPT: script, FAKE_POINTER: join(directory, "pointer.json"), FAKE_BLOB: join(directory, "blob.sqlite") };
}

test("resolve: pointer only downloads and verifies; blob only uses git; both or neither fail closed; expect-snapshot-id is enforced", async t => {
  const directory = await mkdtemp(join(tmpdir(), "obs-resolve-"));
  const { base, close } = await assetServer((request, response) => { if (request.url.endsWith(assetNameFor(SNAPSHOT))) { response.writeHead(200); response.end(DB); } else { response.writeHead(404); response.end(); } });
  t.after(close);
  const run = async (fixture, extra = []) => {
    const env = { ...process.env, ...(await fakeGit(directory, fixture)), OBSERVATION_DB_DOWNLOAD_BASE_URL: base, OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1", OBSERVATION_DB_RETRY_DELAYS_MS: "1" };
    const out = join(directory, `${Math.random().toString(16).slice(2)}.sqlite`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/observation-db-store.mjs", import.meta.url)), "resolve", "--source-sha", SHA, "--out", out, ...extra], { env, encoding: "utf8" });
    return { ...result, out };
  };
  const pointerOnly = await run({ pointer: pointerFor() });
  assert.equal(pointerOnly.status, 0, pointerOnly.stderr);
  assert.equal(JSON.parse(pointerOnly.stdout).mode, "pointer");
  assert.deepEqual(await readFile(pointerOnly.out), DB);
  const blobOnly = await run({ blob: DB });
  assert.equal(blobOnly.status, 0, blobOnly.stderr);
  assert.equal(JSON.parse(blobOnly.stdout).mode, "blob");
  const both = await run({ pointer: pointerFor(), blob: DB });
  assert.notEqual(both.status, 0); assert.match(both.stderr, /both/i);
  const neither = await run({});
  assert.notEqual(neither.status, 0); assert.match(neither.stderr, /neither|unavailable/i);
  const wrongSnapshot = await run({ pointer: pointerFor() }, ["--expect-snapshot-id", "20260101000000-0000000000000000"]);
  assert.notEqual(wrongSnapshot.status, 0); assert.match(wrongSnapshot.stderr, /snapshot/i);
  const check = await run({ pointer: pointerFor() }, ["--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /"mode":"pointer"/);
  const badSource = await run({ pointer: pointerFor() }, ["--source-sha", "nope"]);
  assert.notEqual(badSource.status, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/observation-db-store.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/observation-db-store.mjs'`.

- [ ] **Step 3: Implement the module**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/observation-db-store.test.mjs`
Expected: PASS (5 tests). Then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/observation-db-store.mjs tests/observation-db-store.test.mjs
git diff --cached --check
git commit -m "feat: add the observation database store with pointer resolution and verified anonymous download"
```

---

### Task 2: Store script — `publish` through `gh`

**Files:**
- Modify: `scripts/observation-db-store.mjs` (replace the `publishFromArgs` stub)
- Test: `tests/observation-db-store.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `export async function publishObservationDatabase({ database, snapshotId, targetSha, latestPath, scanReceiptPath, pointerOut, deadline, fetchImpl })` → `{ pointer, uploaded: boolean }`; CLI `publish --database <file> --snapshot-id <id> --target-sha <sha> --latest <file> --scan-receipt <file> --pointer-out <file>`.
- `gh` is invoked through `process.env.GH_BIN || "gh"` with `process.env.GH_SCRIPT` prefix (same shape as `GIT_SCRIPT`).

- [ ] **Step 1: Write the failing tests**

```js
// append to tests/observation-db-store.test.mjs (add `rm` to the fs/promises import and import publishObservationDatabase)
async function fakeGh(directory, { existingRelease, uploadResult, servedBytes }) {
  const script = join(directory, "fake-gh.mjs");
  const log = join(directory, "gh-calls.log");
  await writeFile(log, "");
  await writeFile(script, `import { appendFileSync, copyFileSync } from "node:fs"; import { basename, join } from "node:path";
const args = process.argv.slice(2); appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const state = JSON.parse(process.env.GH_STATE);
if (args[0] === "release" && args[1] === "view") { if (state.existingRelease) { process.stdout.write(JSON.stringify({ tagName: args[2] })); process.exit(0); } process.stderr.write("release not found\\n"); process.exit(1); }
if (args[0] === "release" && args[1] === "create") { if (state.existingRelease) { process.stderr.write("HTTP 422: Validation Failed (already_exists)\\n"); process.exit(1); } process.exit(0); }
if (args[0] === "release" && args[1] === "upload") { if (state.uploadResult === "fail") { process.stderr.write("HTTP 422: asset already exists\\n"); process.exit(1); } copyFileSync(args[3], join(process.env.GH_SERVED_DIR, basename(args[3]))); process.exit(0); }
process.exit(91);`);
  const served = join(directory, "served"); await mkdir(served, { recursive: true });
  if (servedBytes) await writeFile(join(served, assetNameFor(SNAPSHOT)), servedBytes);
  return { env: { GH_BIN: process.execPath, GH_SCRIPT: script, GH_LOG: log, GH_STATE: JSON.stringify({ existingRelease, uploadResult }), GH_SERVED_DIR: served }, log, served };
}

test("publish: creates the monthly release when missing, uploads, confirms by anonymous download, writes the pointer; re-runs and conflicts behave", async t => {
  const directory = await mkdtemp(join(tmpdir(), "obs-publish-"));
  const database = join(directory, "candidate.sqlite"); await writeFile(database, DB);
  const latest = join(directory, "latest.json"); await writeFile(latest, JSON.stringify({ snapshotId: SNAPSHOT, generatedAt: "2026-09-05T02:46:12.000Z", statsDate: "2026-09-05", count: 0, repos: [] }));
  const receipt = join(directory, "scan.json"); await writeFile(receipt, JSON.stringify({ ok: true, databaseSha256: sha256(DB), databaseSha256Prefix: sha256(DB).slice(0, 12), rawByteSize: DB.length }));
  let gh = await fakeGh(directory, { existingRelease: false, uploadResult: "ok" });
  const { base, close } = await assetServer((request, response) => {
    readFile(join(gh.served, request.url.split("/").pop())).then(bytes => { response.writeHead(200); response.end(bytes); }, () => { response.writeHead(404); response.end(); });
  });
  t.after(close);
  const applyEnv = () => Object.assign(process.env, gh.env, { OBSERVATION_DB_DOWNLOAD_BASE_URL: base, OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1", OBSERVATION_DB_RETRY_DELAYS_MS: "1" });
  applyEnv();
  t.after(() => { for (const key of [...Object.keys(gh.env), "OBSERVATION_DB_DOWNLOAD_BASE_URL", "OBSERVATION_DB_ALLOWED_HOSTS", "OBSERVATION_DB_RETRY_DELAYS_MS"]) delete process.env[key]; });
  const pointerOut = join(directory, "pointer.json");
  const args = () => ({ database, snapshotId: SNAPSHOT, targetSha: SHA, latestPath: latest, scanReceiptPath: receipt, pointerOut, deadline: Date.now() + 10_000 });
  const result = await publishObservationDatabase(args());
  assert.equal(result.uploaded, true);
  assert.deepEqual(JSON.parse(await readFile(pointerOut, "utf8")), pointerFor());
  const calls = (await readFile(gh.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [["release", "view"], ["release", "create"], ["release", "upload"]]);
  assert.ok(calls[1].includes("--target") && calls[1].includes(SHA) && calls[1].includes("--prerelease") && calls[1].includes("--latest=false"));
  assert.equal(calls[2][2], "observation-db-2026-09");
  assert.ok(calls[2][3].endsWith(assetNameFor(SNAPSHOT)));
  assert.ok(!calls[2].includes("--clobber"));
  // idempotent re-run: upload fails, served bytes equal → success without a second upload
  gh = await fakeGh(directory, { existingRelease: true, uploadResult: "fail", servedBytes: DB }); applyEnv();
  await rm(pointerOut);
  assert.equal((await publishObservationDatabase(args())).uploaded, false);
  // different served bytes → fail closed
  gh = await fakeGh(directory, { existingRelease: true, uploadResult: "fail", servedBytes: Buffer.from("z".repeat(DB.length)) }); applyEnv();
  await rm(pointerOut);
  await assert.rejects(publishObservationDatabase(args()), /sha256/i);
  // receipt hash mismatch → refuse before any gh call
  await writeFile(receipt, JSON.stringify({ ok: true, databaseSha256: "0".repeat(64), databaseSha256Prefix: "000000000000", rawByteSize: DB.length }));
  await writeFile(gh.log, "");
  await assert.rejects(publishObservationDatabase(args()), /receipt/i);
  assert.equal((await readFile(gh.log, "utf8")).trim(), "");
  // latest.json snapshot mismatch → refuse
  await writeFile(receipt, JSON.stringify({ ok: true, databaseSha256: sha256(DB), databaseSha256Prefix: sha256(DB).slice(0, 12), rawByteSize: DB.length }));
  await writeFile(latest, JSON.stringify({ snapshotId: "20260101000000-0000000000000000" }));
  await assert.rejects(publishObservationDatabase(args()), /latest/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/observation-db-store.test.mjs`
Expected: FAIL — `publishObservationDatabase` is not exported.

- [ ] **Step 3: Implement `publish`**

Add to `scripts/observation-db-store.mjs` (extend the `node:fs/promises` import to `{ copyFile, mkdtemp, open, readFile, rename, rm, writeFile }` and import `tmpdir` from `node:os`):

```js
function gh(args, { deadline }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("observation database publish deadline exceeded");
  try {
    return execFileSync(process.env.GH_BIN || "gh", process.env.GH_SCRIPT ? [process.env.GH_SCRIPT, ...args] : args, {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: Math.min(600_000, remaining), stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = new Error(`gh ${args[0]} ${args[1]} failed: ${scrub(error.stderr ?? error.message).trim().slice(0, 500)}`);
    failure.status = error.status; failure.stderr = scrub(error.stderr ?? "");
    throw failure;
  }
}

function ensureRelease(tag, targetSha, { deadline }) {
  try { gh(["release", "view", tag, "--json", "tagName"], { deadline }); return; } catch (error) { if (error.status !== 1) throw error; }
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
  const receipt = JSON.parse(await readFile(scanReceiptPath, "utf8"));
  if (receipt?.ok !== true || receipt.databaseSha256 !== sha256 || receipt.rawByteSize !== bytes.length) throw new Error("scan receipt does not describe the database being published");
  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  if (latest?.snapshotId !== snapshotId) throw new Error("latest.json snapshot id does not match the published snapshot");
  const pointer = validatePointer({ version: 1, snapshotId, database: { sha256, byteSize: bytes.length }, asset: { releaseTag: releaseTagFor(snapshotId), name: assetNameFor(snapshotId) } });
  ensureRelease(pointer.asset.releaseTag, targetSha, { deadline });
  const staging = await mkdtemp(path.join(tmpdir(), "observation-db-publish-"));
  let uploaded = false;
  try {
    const staged = path.join(staging, pointer.asset.name);
    await copyFile(database, staged);
    try { gh(["release", "upload", pointer.asset.releaseTag, staged], { deadline }); uploaded = true; }
    catch (error) { process.stderr.write(`::notice::upload did not complete (${scrub(error.message)}); verifying the served asset instead\n`); }
    await downloadAsset({ pointer, destination: path.join(staging, "served.sqlite"), deadline, fetchImpl }); // throws on sha256/size mismatch or 404
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const temporary = `${pointerOut}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, pointerOut);
  return { pointer, uploaded };
}

async function publishFromArgs(args, deadline) {
  const result = await publishObservationDatabase({ database: args.database, snapshotId: args["snapshot-id"], targetSha: args["target-sha"], latestPath: args.latest, scanReceiptPath: args["scan-receipt"], pointerOut: args["pointer-out"], deadline });
  process.stdout.write(`${JSON.stringify({ uploaded: result.uploaded, snapshotId: result.pointer.snapshotId, sha256: result.pointer.database.sha256, byteSize: result.pointer.database.byteSize, asset: result.pointer.asset })}\n`);
  return 0;
}
```

Delete the Task 1 stub `publishFromArgs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/observation-db-store.test.mjs` then `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/observation-db-store.mjs tests/observation-db-store.test.mjs
git diff --cached --check
git commit -m "feat: publish observation database snapshots as immutable monthly release assets"
```

---

### Task 3: Scan receipt carries the full database sha256

**Files:**
- Modify: `scripts/scan_repository_observations.py:183-192` (the success receipt dict)
- Test: `tests/test_scan_repository_observations.py:175` (extend the existing assertion block)

**Interfaces:**
- Produces: receipt key `databaseSha256` (64 hex) alongside the existing `databaseSha256Prefix`; consumed by Task 2's `publish` and Task 6's workflow.

- [ ] **Step 1: Write the failing test** — next to line 175 add:

```python
            self.assertEqual(receipt["databaseSha256"], hashlib.sha256(before).hexdigest())
```

- [ ] **Step 2: Run it** — `python -m unittest tests.test_scan_repository_observations` → FAIL `KeyError: 'databaseSha256'`.

- [ ] **Step 3: Implement** — in `scan_database`'s return dict add `"databaseSha256": digest_before,` before `"databaseSha256Prefix"`.

- [ ] **Step 4: Run** — same command → PASS; `npm test` green.

- [ ] **Step 5: Commit**

```bash
git add scripts/scan_repository_observations.py tests/test_scan_repository_observations.py
git commit -m "feat: report the full database sha256 in the observation scan receipt"
```

---

### Task 4: Candidate preparation — pointer is reinstated, the sqlite stays an approved candidate file

**Files:**
- Modify: `scripts/prepare-refresh-candidate.mjs:8-22` (`MUTABLE_GENERATED_PATHS`, new `CANDIDATE_ONLY_GENERATED_PATHS`, `FULL_FILE_GENERATED_PATHS`), `:61-63` (`approvedGeneratedFile`), and the reinstatement loop that copies mutable files from `lastGoodSha` (grep `MUTABLE_GENERATED_PATHS` in the file)
- Test: `tests/pages-publication.test.mjs` (add one test near the existing `verifyCandidateMutations` tests; grep `verify-generated` or `verifyCandidateMutations`)

**Interfaces:**
- Produces: `export const CANDIDATE_ONLY_GENERATED_PATHS = Object.freeze(["data/repository-observations.sqlite"])`; `MUTABLE_GENERATED_PATHS` contains `data/observation-db.pointer.json` and not the sqlite.

- [ ] **Step 1: Write the failing test**

```js
test("verify-generated accepts the recorder's database in the candidate whether or not the baseline tracked one, and reinstates the pointer instead of the blob", async () => {
  const { MUTABLE_GENERATED_PATHS, CANDIDATE_ONLY_GENERATED_PATHS, verifyCandidateMutations } = await import("../scripts/prepare-refresh-candidate.mjs");
  assert.ok(MUTABLE_GENERATED_PATHS.includes("data/observation-db.pointer.json"));
  assert.ok(!MUTABLE_GENERATED_PATHS.includes("data/repository-observations.sqlite"));
  assert.deepEqual([...CANDIDATE_ONLY_GENERATED_PATHS], ["data/repository-observations.sqlite"]);
  const root = await mkdtemp(join(tmpdir(), "candidate-verify-"));
  const baseline = join(root, "baseline"); const candidate = join(root, "candidate");
  for (const dir of [baseline, candidate]) { await mkdir(join(dir, "data"), { recursive: true }); await writeFile(join(dir, "README.md"), "same"); }
  await writeFile(join(candidate, "data", "repository-observations.sqlite"), "new-db");
  assert.deepEqual(await verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), { files: 2 });
  await writeFile(join(baseline, "data", "repository-observations.sqlite"), "old-db");
  assert.deepEqual(await verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), { files: 2 });
  await writeFile(join(candidate, "data", "stray.bin"), "x");
  await assert.rejects(verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), /residue/);
});
```

- [ ] **Step 2: Run** — `node --test tests/pages-publication.test.mjs` → FAIL (`CANDIDATE_ONLY_GENERATED_PATHS` undefined / pointer missing).

- [ ] **Step 3: Implement**

```js
export const MUTABLE_GENERATED_PATHS = Object.freeze([
  "changes.xml",
  "data/latest.json",
  "data/membership-status.json",
  "data/observation-db.pointer.json",
  "data/readme-state.json",
  "data/repo-summaries.json",
  "data/star-anchors.json",
  "data/translation-sources.json",
  "feed.xml",
  "index.html",
  "star-history.json",
  "translations",
]);
// Written by the recorder into the candidate but never tracked by git (the snapshot
// lives in a release asset; spec 2026-09-05 §6.1). Accepted by --verify-generated,
// never reinstated from lastGoodSha.
export const CANDIDATE_ONLY_GENERATED_PATHS = Object.freeze(["data/repository-observations.sqlite"]);
const FULL_FILE_GENERATED_PATHS = [...MUTABLE_GENERATED_PATHS, ...CANDIDATE_ONLY_GENERATED_PATHS].filter(value => value !== "index.html" && value !== "translations");
```

Reinstatement loop: when `data/observation-db.pointer.json` does not exist at `lastGoodSha` (transition run), skip it without failing (guard with `git cat-file -e`), and add a test for that case in the same test file (baseline commit without the pointer → candidate has no pointer, no error; the existing candidate-preparation test at `tests/pages-publication.test.mjs:1329` shows how a fixture repository is built).

- [ ] **Step 4: Run** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/prepare-refresh-candidate.mjs tests/pages-publication.test.mjs
git commit -m "fix: reinstate the observation pointer instead of the database and keep the candidate database approved"
```

---

### Task 5: `probe-production.mjs` and `verify-refresh-chain.mjs` resolve through the store

**Files:**
- Modify: `scripts/probe-production.mjs:30-48` (`artifactContractFromGit`)
- Modify: `scripts/verify-refresh-chain.mjs:86-89` (`approvedGeneratedCommitPath`)
- Test: `tests/verify-refresh-chain.test.mjs:74` (add pointer case), `:305-313` (fake git learns the pointer; resolver stub), plus any probe test that reaches `artifactContractFromGit` (grep `--source-sha` in `tests/pages-publication.test.mjs`).

**Interfaces:**
- Consumes: Task 1 CLI `resolve`.
- Produces: env `OBSERVATION_DB_RESOLVER_SCRIPT` — when set, the probe runs `node <script> resolve ...` instead of `node scripts/observation-db-store.mjs resolve ...`.

- [ ] **Step 1: Write the failing tests**

In `tests/verify-refresh-chain.test.mjs` after line 74:

```js
  assert.equal(assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "data/latest.json\ndata/observation-db.pointer.json\nindex.html"), true);
```

In `runVerifier` (~line 305): extend the fake git with
`else if(args[0]==="cat-file"&&args[1]==="-e") process.exit(args.at(-1).endsWith(":data/observation-db.pointer.json")?0:1);`
and `else if(args[0]==="show"&&args.at(-1).endsWith(":data/observation-db.pointer.json")) process.stdout.write(readFileSync(process.env.POINTER_PATH));`;
write a pointer fixture describing the fixture database (`sha256` and `byteSize` of `databasePath`, `releaseTag`/`name` derived from `artifact.snapshotId`) to `POINTER_PATH`; add a fake resolver script `fake-resolver.mjs` that copies `DATABASE_PATH` to the value after `--out` and prints `{"mode":"pointer"}`; pass `OBSERVATION_DB_RESOLVER_SCRIPT`, `POINTER_PATH`, `DATABASE_PATH` in the child's env. Remove the old `show …:data/repository-observations.sqlite` branch so the test proves the probe no longer asks git for the blob.

- [ ] **Step 2: Run** — `node --test tests/verify-refresh-chain.test.mjs` → FAIL.

- [ ] **Step 3: Implement**

`scripts/verify-refresh-chain.mjs`:
```js
function approvedGeneratedCommitPath(relative) {
  // data/repository-observations.sqlite stays accepted only because the transition commit deletes it
  // (spec 2026-09-05 §6.6); the follow-up PR removes it from this list.
  return ["index.html", "data/repo-summaries.json", "data/observation-db.pointer.json", "data/repository-observations.sqlite", "data/readme-state.json", "data/membership-status.json", "data/latest.json", "data/translation-sources.json", "feed.xml", "changes.xml", "data/star-anchors.json", "star-history.json"].includes(relative)
    || /^translations\/[^/]+\.json$/.test(relative);
}
```

`scripts/probe-production.mjs`: in `artifactContractFromGit` replace `await writeFile(database, gitBytes(sourceSha, "data/repository-observations.sqlite", gitRoot, deadline));` with `resolveObservationDatabase(sourceSha, snapshotId, database, gitRoot, deadline);` and add:

```js
function resolveObservationDatabase(sourceSha, snapshotId, destination, gitRoot, deadline) {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("production probe deadline exceeded");
  const script = process.env.OBSERVATION_DB_RESOLVER_SCRIPT || fileURLToPath(new URL("./observation-db-store.mjs", import.meta.url));
  try {
    execFileSync(process.execPath, [script, "resolve", "--source-sha", sourceSha, "--expect-snapshot-id", snapshotId, "--git-root", gitRoot, "--out", destination], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: Math.max(1, Math.min(600_000, Math.ceil(remaining))), stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Git repository observation database is unavailable");
  }
}
```

- [ ] **Step 4: Run** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-production.mjs scripts/verify-refresh-chain.mjs tests/verify-refresh-chain.test.mjs
git commit -m "feat: resolve the observation database through the pointer in the production probe and refresh-chain verifier"
```

---

### Task 6: W1 `daily-refresh.yml` — prepare, promote, committed probe, verify, second copy

**Files:**
- Modify: `.github/workflows/daily-refresh.yml` (lines 105-145 state checks, 146-165 recovery build, 176-200 parent capture, 468-535 promote, 539-552 committed probe, 596-605 verify job)
- Test: `tests/daily-refresh-workflow.test.mjs` (replace the tests named "one create-new parent database capture…", "candidate finalizes before checkout promotion…", "recurring allowlists…"; extend "recovery preserves…"; add new tests)

- [ ] **Step 1: Rewrite the failing tests** (replace the listed tests; keep all others untouched)

```js
test("one create-new parent database capture is resolved through the store and reused across every frozen boundary", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /set -o noclobber[\s\S]*observation-db-store\.mjs resolve --source-sha "\$HYDRATION_SOURCE_SHA" --expect-snapshot-id "\$PARENT_SNAPSHOT_ID" --out "\$PARENT_DATABASE"/);
  assert.doesNotMatch(workflow, /git (?:show|cat-file) (?:blob )?"?\$HYDRATION_SOURCE_SHA:data\/repository-observations\.sqlite/);
  assert.doesNotMatch(workflow, /rm -f "\$PARENT_DATABASE"/);
  assert.equal((workflow.match(/PARENT_DATABASE="\$PARENT_CAPTURE_DIR\/repository-observations\.sqlite"/g) ?? []).length, 1);
  assert.match(workflow, /pointer\.database\.sha256/);
  assert.match(workflow, /collect-repository-events\.mjs[^\n]*--parent-database "\$PARENT_DATABASE"/);
  assert.match(workflow, /generate-summary-bundles\.mjs[^\n]*--parent-database \$parentDatabase/);
  assert.match(workflow, /frozen-parent-input\/repository-observations\.sqlite/);
  assert.match(workflow, /record_repository_observations\.py[^\n]*--parent-database "\$PARENT_DATABASE"/);
});

test("production state checks and the recovery build resolve the database through the pointer", async () => {
  const workflow = await workflowText();
  assert.equal((workflow.match(/observation-db-store\.mjs resolve --source-sha "\$HYDRATION_SOURCE_SHA" --check/g) ?? []).length, 2);
  const buildStart = workflow.indexOf("- name: Build verified recovery artifact");
  const buildEnd = workflow.indexOf("- name: Prepare isolated refresh candidate", buildStart);
  assertInOrder(workflow.slice(buildStart, buildEnd), [
    'git archive --format=tar "$HYDRATION_SOURCE_SHA"',
    'rm -f "$RECOVERY_SOURCE/data/repository-observations.sqlite"',
    'observation-db-store.mjs resolve --source-sha "$HYDRATION_SOURCE_SHA" --expect-snapshot-id "$PARENT_SNAPSHOT_ID" --out "$RECOVERY_SOURCE/data/repository-observations.sqlite"',
    "derive_repository_artifacts.py export-contract",
  ]);
});

test("promotion scans the candidate database, publishes the asset after every local check, and never stages the database", async () => {
  const workflow = await workflowText();
  const finalization = workflow.indexOf("Finalize repository derivatives");
  const validation = workflow.indexOf("Validate whole candidate");
  const promotionStart = workflow.indexOf("Promote and scan staged candidate");
  assert.ok(finalization >= 0 && finalization < validation && validation < promotionStart);
  const promotion = workflow.slice(promotionStart, workflow.indexOf("Publish generated child commit"));
  assertInOrder(promotion, [
    'scan_repository_observations.py --database "$CANDIDATE/data/repository-observations.sqlite" --expect-snapshot "$SNAPSHOT_ID" > "${RUNNER_TEMP}/scan-receipt.json"',
    'cp "$CANDIDATE/index.html" index.html',
    "git rm --cached --quiet data/repository-observations.sqlite",
    "git fetch origin main",
    "origin/main advanced during refresh",
    'observation-db-store.mjs publish --database "$CANDIDATE/data/repository-observations.sqlite" --snapshot-id "$SNAPSHOT_ID" --target-sha "$ORIGINAL_SHA" --latest "$CANDIDATE/data/latest.json" --scan-receipt "${RUNNER_TEMP}/scan-receipt.json" --pointer-out data/observation-db.pointer.json',
    'case "$changed_path" in',
    "git add --",
    "git grep --cached -qE",
    "git diff --cached --check",
    'git commit -m "chore: refresh trending snapshot"',
    "git push origin HEAD:main",
  ]);
  assert.doesNotMatch(promotion, /cp "\$CANDIDATE\/data\/repository-observations\.sqlite"/);
  assert.doesNotMatch(promotion, /git show :data\/repository-observations\.sqlite/);
  assert.match(promotion, /if git ls-files --error-unmatch data\/repository-observations\.sqlite >\/dev\/null 2>&1; then\n\s+git rm --cached --quiet data\/repository-observations\.sqlite\n\s+rm -f data\/repository-observations\.sqlite\n\s+fi/);
  assert.match(promotion, /case "\$changed_path" in\n\s+index\.html\|data\/repo-summaries\.json\|data\/observation-db\.pointer\.json\|data\/readme-state\.json[^\n]*\|translations\/\*\.json\|data\/repository-observations\.sqlite\) ;;/);
  assert.match(promotion, /git add -- index\.html data\/repo-summaries\.json data\/observation-db\.pointer\.json data\/readme-state\.json/);
  assert.match(promotion, /git grep --cached -qE[^\n]*-- index\.html data\/repo-summaries\.json data\/observation-db\.pointer\.json/);
  assert.match(promotion, /data\/readme-state\.json/);
  assert.doesNotMatch(promotion, /data\/star-observations\.sqlite|data\/trending-membership\.sqlite|data\/legacy-public-star-history\.json|data\/legacy-observation-baseline\.json/);
  assert.match(promotion.slice(0, promotion.indexOf("run:")), /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.equal((workflow.match(/GH_TOKEN:/g) ?? []).length, 1);
  assert.match(promotion, /git diff --quiet --[\s\S]*git diff --cached --quiet --/);
  assert.match(promotion, /\[ "\$ORIGINAL_SHA" = "\$\(git rev-parse HEAD\)" \]/);
  assert.match(workflow, /if git diff --cached --quiet; then[\s\S]*exit 1/);
  assert.doesNotMatch(workflow, /git add (?:\.|-A|--all)(?:\s|$)/);
});

test("the committed artifact probe, the verify job and the second copy resolve the published database", async () => {
  const workflow = await workflowText();
  const committed = workflow.slice(workflow.indexOf("- name: Build and locally probe committed Pages artifact"), workflow.indexOf("- name: Upload published observation database copy"));
  assertInOrder(committed, [
    'git archive --format=tar "$SOURCE_SHA"',
    'rm -f "$PAGES_SOURCE/data/repository-observations.sqlite"',
    'observation-db-store.mjs resolve --source-sha "$SOURCE_SHA" --expect-snapshot-id "$SNAPSHOT_ID" --out "$PAGES_SOURCE/data/repository-observations.sqlite"',
    'cmp "$PAGES_SOURCE/data/repository-observations.sqlite" "${RUNNER_TEMP}/candidate/data/repository-observations.sqlite"',
    "derive_repository_artifacts.py export-contract",
  ]);
  assert.match(workflow, /- name: Upload published observation database copy\n\s+uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a[^\n]*\n\s+with:\n\s+name: observation-db-\$\{\{ github\.run_id \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/candidate\/data\/repository-observations\.sqlite\n\s+if-no-files-found: error\n\s+retention-days: 30\n/);
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  recovery:"));
  assertInOrder(verify, [
    "- name: Resolve observation database",
    'rm -f "${RUNNER_TEMP}/repository-observations.sqlite"',
    'observation-db-store.mjs resolve --source-sha "$(git rev-parse HEAD)" --expect-snapshot-id "${{ needs.publish.outputs.snapshot_id }}" --out "${RUNNER_TEMP}/repository-observations.sqlite"',
    "- name: Probe production candidate",
    'export-contract --database "${RUNNER_TEMP}/repository-observations.sqlite"',
  ]);
  assert.doesNotMatch(verify, /export-contract --database data\/repository-observations\.sqlite/);
});
```

In the existing "recovery preserves…" test add `assert.match(recoveryBuild, /observation-db-store\.mjs resolve/);`.

- [ ] **Step 2: Run** — `node --test tests/daily-refresh-workflow.test.mjs` → FAIL on the new assertions.

- [ ] **Step 3: Edit the workflow** (bash steps; keep 10-space indentation and CRLF)

(a) Lines 111 and 136 — replace `git cat-file -e "$HYDRATION_SOURCE_SHA:data/repository-observations.sqlite"` (including the `if … 2>/dev/null; then` form at 111) with `node scripts/observation-db-store.mjs resolve --source-sha "$HYDRATION_SOURCE_SHA" --check`. Keep the surrounding branching identical.

(b) Recovery build — inside the `else` branch, before `export-contract`:
```bash
            rm -f "$RECOVERY_SOURCE/data/repository-observations.sqlite"
            node scripts/observation-db-store.mjs resolve --source-sha "$HYDRATION_SOURCE_SHA" --expect-snapshot-id "$PARENT_SNAPSHOT_ID" --out "$RECOVERY_SOURCE/data/repository-observations.sqlite"
```

(c) Parent capture — replace `git cat-file blob "$HYDRATION_SOURCE_SHA:data/repository-observations.sqlite" > "$PARENT_DATABASE"` with
```bash
            node scripts/observation-db-store.mjs resolve --source-sha "$HYDRATION_SOURCE_SHA" --expect-snapshot-id "$PARENT_SNAPSHOT_ID" --out "$PARENT_DATABASE"
```
(keep `set -o noclobber` and `chmod 0444`). After the `verify-parent-inputs` line add:
```bash
          if git cat-file -e "$HYDRATION_SOURCE_SHA:data/observation-db.pointer.json" 2>/dev/null; then
            git show "$HYDRATION_SOURCE_SHA:data/observation-db.pointer.json" > "${RUNNER_TEMP}/parent-pointer.json"
            node --input-type=module -e 'import { readFileSync } from "node:fs"; const pointer=JSON.parse(readFileSync(process.argv[1],"utf8")); const evidence=JSON.parse(readFileSync(process.argv[2],"utf8")); const declared=evidence.parentDatabaseSha256; if(typeof declared!=="string"||declared!==pointer?.database?.sha256) throw new Error("pointer.database.sha256 does not match the parent evidence database hash");' "${RUNNER_TEMP}/parent-pointer.json" "${RUNNER_TEMP}/parent-evidence.json"
          fi
```
Before writing this, open `scripts/derive_repository_artifacts.py:622-670` and confirm the key under which `export_parent_inputs` stores the parent file hash (`parentDatabaseSha256` at line 664 per the review; adjust the one-liner if the real key differs).

(d) Promote step — replace the body from `cp "$CANDIDATE/index.html" index.html` through `echo "source_sha=$SOURCE_SHA" >> "$GITHUB_OUTPUT"` with:
```bash
          python scripts/scan_repository_observations.py --database "$CANDIDATE/data/repository-observations.sqlite" --expect-snapshot "$SNAPSHOT_ID" > "${RUNNER_TEMP}/scan-receipt.json"
          cp "$CANDIDATE/index.html" index.html
          cp "$CANDIDATE/data/repo-summaries.json" data/repo-summaries.json
          cp "$CANDIDATE/data/readme-state.json" data/readme-state.json
          cp "$CANDIDATE/data/membership-status.json" data/membership-status.json
          cp "$CANDIDATE/data/latest.json" data/latest.json
          cp "$CANDIDATE/data/translation-sources.json" data/translation-sources.json
          cp "$CANDIDATE/feed.xml" feed.xml
          cp "$CANDIDATE/changes.xml" changes.xml
          cp "$CANDIDATE/data/star-anchors.json" data/star-anchors.json
          cp "$CANDIDATE/star-history.json" star-history.json
          rsync --archive --delete "$CANDIDATE/translations/" translations/
          if git ls-files --error-unmatch data/repository-observations.sqlite >/dev/null 2>&1; then
            git rm --cached --quiet data/repository-observations.sqlite
            rm -f data/repository-observations.sqlite
          fi
          git fetch origin main
          [ "$ORIGINAL_SHA" = "$(git rev-parse refs/remotes/origin/main)" ] || { echo "::error::origin/main advanced during refresh"; exit 1; }
          node scripts/observation-db-store.mjs publish --database "$CANDIDATE/data/repository-observations.sqlite" --snapshot-id "$SNAPSHOT_ID" --target-sha "$ORIGINAL_SHA" --latest "$CANDIDATE/data/latest.json" --scan-receipt "${RUNNER_TEMP}/scan-receipt.json" --pointer-out data/observation-db.pointer.json
          changed_paths="$({ git diff --name-only && git diff --cached --name-only && git ls-files --others --exclude-standard; } | sort -u)"
          while IFS= read -r changed_path; do
            [ -z "$changed_path" ] && continue
            case "$changed_path" in
              index.html|data/repo-summaries.json|data/observation-db.pointer.json|data/readme-state.json|data/membership-status.json|data/latest.json|data/translation-sources.json|feed.xml|changes.xml|data/star-anchors.json|star-history.json|translations/*.json|data/repository-observations.sqlite) ;;
              *) echo "::error::Unexpected generated output: $changed_path"; exit 1 ;;
            esac
          done <<< "$changed_paths"
          git add -- index.html data/repo-summaries.json data/observation-db.pointer.json data/readme-state.json data/membership-status.json data/latest.json data/translation-sources.json feed.xml changes.xml data/star-anchors.json star-history.json translations/
          if git diff --cached --quiet; then
            echo "::error::version-1 refresh requires one nonempty generated child"
            exit 1
          fi
          set +e
          git grep --cached -qE '(sk-ant-[[:alnum:]_-]{20,}|gh[pousr]_[[:alnum:]_]{20,}|github_pat_[[:alnum:]_]{20,}|AIza[[:alnum:]_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' -- index.html data/repo-summaries.json data/observation-db.pointer.json data/readme-state.json data/membership-status.json data/latest.json data/translation-sources.json feed.xml changes.xml data/star-anchors.json star-history.json translations/
          SCAN_STATUS=$?
          set -e
          case "$SCAN_STATUS" in
            0) echo "::error::Potential secret detected in generated text outputs"; exit 1 ;;
            1) ;;
            *) echo "::error::Staged text secret scan failed"; exit 1 ;;
          esac
          git diff --cached --check
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -m "chore: refresh trending snapshot"
          SOURCE_SHA="$(git rev-parse HEAD)"
          [ "$SOURCE_SHA" != "$ORIGINAL_SHA" ]
          [ "$(git rev-parse "${SOURCE_SHA}^")" = "$ORIGINAL_SHA" ]
          git fetch origin main
          [ "$ORIGINAL_SHA" = "$(git rev-parse refs/remotes/origin/main)" ] || { echo "::error::origin/main advanced during refresh"; exit 1; }
          git push origin HEAD:main
          echo "source_sha=$SOURCE_SHA" >> "$GITHUB_OUTPUT"
```
Keep the existing lines before `cp "$CANDIDATE/index.html"` (the deadline cushion check, `git fetch origin main`, the four HEAD/index/tree checks). The `data/repository-observations.sqlite` entry in the `case` list exists only for the transition (the staged deletion shows the path); the follow-up PR removes it. Add `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to this step's `env:` block. Delete the old `STAGED_DATABASE`, `trap`, `git show :data/...`, and scanner lines.

(e) Committed-artifact probe step: after `git archive … | tar -x -C "$PAGES_SOURCE"` insert
```bash
          rm -f "$PAGES_SOURCE/data/repository-observations.sqlite"
          node scripts/observation-db-store.mjs resolve --source-sha "$SOURCE_SHA" --expect-snapshot-id "$SNAPSHOT_ID" --out "$PAGES_SOURCE/data/repository-observations.sqlite"
          cmp "$PAGES_SOURCE/data/repository-observations.sqlite" "${RUNNER_TEMP}/candidate/data/repository-observations.sqlite"
```

(f) New step right after "Build and locally probe committed Pages artifact", before "Upload candidate Pages artifact":
```yaml
      - name: Upload published observation database copy
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: observation-db-${{ github.run_id }}
          path: ${{ runner.temp }}/candidate/data/repository-observations.sqlite
          if-no-files-found: error
          retention-days: 30
```

(g) Verify job: insert before "Probe production candidate":
```yaml
      - name: Resolve observation database
        shell: bash
        run: |
          set -euo pipefail
          rm -f "${RUNNER_TEMP}/repository-observations.sqlite"
          node scripts/observation-db-store.mjs resolve --source-sha "$(git rev-parse HEAD)" --expect-snapshot-id "${{ needs.publish.outputs.snapshot_id }}" --out "${RUNNER_TEMP}/repository-observations.sqlite"
```
and change the probe step's `--database data/repository-observations.sqlite` to `--database "${RUNNER_TEMP}/repository-observations.sqlite"`.

- [ ] **Step 4: Run** — `npm test` → PASS (repair any other pinned string the old tests reveal; do not weaken unrelated assertions).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/daily-refresh.yml tests/daily-refresh-workflow.test.mjs
git diff --cached --check
git commit -m "feat: publish the observation database as a release asset and resolve it through the pointer in the refresh workflow"
```

---

### Task 7: W2 and redeploy workflows resolve the database; `.gitignore`

**Files:**
- Modify: `.github/workflows/star-ticks.yml:59-64` and `:138`, `.github/workflows/deploy-current-pages.yml:43-58`, `.gitignore`
- Test: `tests/star-ticks-workflow.test.mjs:68,80`, `tests/deploy-current-pages-workflow.test.mjs:15,17`

- [ ] **Step 1: Update the failing tests**

`tests/star-ticks-workflow.test.mjs`: replace the `[ -f data/repository-observations.sqlite ]` assertion with
```js
  assert.match(workflow, /node scripts\/observation-db-store\.mjs resolve --source-sha "\$\(git rev-parse HEAD\)" --check \|\| \{ echo "::error::star ticks require the version-1 repository database"; exit 1; \}/);
  assert.match(workflow, /- name: Resolve observation database[\s\S]*rm -f "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"[\s\S]*observation-db-store\.mjs resolve --source-sha "\$SOURCE_SHA" --expect-snapshot-id "\$SNAPSHOT_ID" --out "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"/);
  assert.doesNotMatch(workflow, /GH_TOKEN:/);
```
change the export-contract assertion to `/export-contract --database "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite" --snapshot-id "\$SNAPSHOT_ID" --contract-out "\$ARTIFACT_CONTRACT"/`; add `"- name: Resolve observation database"` to the `assertInOrder` list after `"- name: Commit star tick ledgers"`; change the gated-step count `4` → `5` and add `"- name: Resolve observation database"` to the gated step list.

`tests/deploy-current-pages-workflow.test.mjs`: replace `/if \[ -f data\/repository-observations\.sqlite \]/` with `/if node scripts\/observation-db-store\.mjs resolve --source-sha "\$SOURCE_SHA" --check; then/`; replace the database assertion with `/export-contract --database "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"/`; add `assert.match(workflow, /observation-db-store\.mjs resolve --source-sha "\$SOURCE_SHA" --expect-snapshot-id "\$SNAPSHOT_ID" --out "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"/);` and `assert.doesNotMatch(workflow, /GH_TOKEN:/);`.

- [ ] **Step 2: Run** — both test files → FAIL.

- [ ] **Step 3: Edit the workflows**

`star-ticks.yml` "Bind to exact origin main": replace the `[ -f … ]` line with
```bash
          node scripts/observation-db-store.mjs resolve --source-sha "$(git rev-parse HEAD)" --check || { echo "::error::star ticks require the version-1 repository database"; exit 1; }
```
Add after "Commit star tick ledgers":
```yaml
      - name: Resolve observation database
        if: ${{ steps.collect.outputs.skipped != 'true' && steps.commit.outputs.committed == 'true' }}
        shell: bash
        run: |
          set -euo pipefail
          SOURCE_SHA="$(git rev-parse HEAD)"
          SNAPSHOT_ID="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const value = JSON.parse(readFileSync("data/latest.json", "utf8")); if (!/^[0-9]{14}-[a-f0-9]{16}$/.test(value.snapshotId ?? "")) throw new Error("committed snapshot id is invalid"); process.stdout.write(value.snapshotId);')"
          rm -f "${RUNNER_TEMP}/repository-observations.sqlite"
          node scripts/observation-db-store.mjs resolve --source-sha "$SOURCE_SHA" --expect-snapshot-id "$SNAPSHOT_ID" --out "${RUNNER_TEMP}/repository-observations.sqlite"
```
In "Build committed Pages artifact" change `--database "${GITHUB_WORKSPACE}/data/repository-observations.sqlite"` to `--database "${RUNNER_TEMP}/repository-observations.sqlite"`.

`deploy-current-pages.yml` "Build committed Pages artifact": replace `if [ -f data/repository-observations.sqlite ]; then` with `if node scripts/observation-db-store.mjs resolve --source-sha "$SOURCE_SHA" --check; then`; insert after the `SNAPSHOT_ID=` line:
```bash
            rm -f "${RUNNER_TEMP}/repository-observations.sqlite"
            node scripts/observation-db-store.mjs resolve --source-sha "$SOURCE_SHA" --expect-snapshot-id "$SNAPSHOT_ID" --out "${RUNNER_TEMP}/repository-observations.sqlite"
```
and point `export-contract --database` at `"${RUNNER_TEMP}/repository-observations.sqlite"`.

`.gitignore`: add `data/repository-observations.sqlite` after the existing `-wal` line.

- [ ] **Step 4: Run** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/star-ticks.yml .github/workflows/deploy-current-pages.yml .gitignore tests/star-ticks-workflow.test.mjs tests/deploy-current-pages-workflow.test.mjs
git commit -m "feat: resolve the observation database through the pointer in the star-tick and redeploy workflows"
```

---

### Task 8: Dispatch-only pre-flight / restore workflow

**Files:**
- Create: `.github/workflows/observation-db-preflight.yml`
- Modify: `scripts/observation-db-store.mjs` (test-tag override), `tests/observation-db-store.test.mjs`
- Test: `tests/observation-db-preflight-workflow.test.mjs`

**Interfaces:** consumes the store CLI. Inputs: `mode` (choice `roundtrip` | `restore`, default `roundtrip`), `snapshot-id` (string, restore only), `run-id` (string, restore only: the W1 run whose `observation-db-<run-id>` artifact holds the file). Store addition: env `OBSERVATION_DB_RELEASE_TAG_OVERRIDE` — accepted only when it matches `^observation-db-test-[0-9]{14}$`; `releaseTagFor()` returns it and `validatePointer` accepts a pointer whose `asset.releaseTag` equals it.

- [ ] **Step 1: Write the failing tests**

```js
// tests/observation-db-preflight-workflow.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the observation database pre-flight workflow is dispatch-only, uses the Actions token once, and deletes its throwaway release", async () => {
  const workflow = (await readFile(".github/workflows/observation-db-preflight.yml", "utf8")).replaceAll("\r\n", "\n");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:/m);
  assert.doesNotMatch(workflow, /^  (?:schedule|push|pull_request):/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^    permissions:\n      contents: write$/m);
  assert.equal((workflow.match(/GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/g) ?? []).length, 1);
  assert.match(workflow, /observation-db-store\.mjs publish --database[\s\S]*--snapshot-id "\$SNAPSHOT_ID"/);
  assert.match(workflow, /observation-db-store\.mjs resolve --source-sha "\$PROOF_SHA" --expect-snapshot-id "\$SNAPSHOT_ID" --git-root "\$PROOF" --out/);
  assert.match(workflow, /cmp "\$DATABASE" "\$WORK\/resolved\.sqlite"/);
  assert.match(workflow, /gh release delete "\$TEST_TAG" --cleanup-tag --yes/);
  assert.match(workflow, /if \[ "\$MODE" = "restore" \]; then/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) assert.match(match[2], /^[0-9a-f]{40}$/, `${match[1]} must be pinned by commit`);
});
```

And in `tests/observation-db-store.test.mjs`:
```js
test("the release tag override is accepted only for test tags", () => {
  process.env.OBSERVATION_DB_RELEASE_TAG_OVERRIDE = "observation-db-test-20260905120000";
  try {
    assert.equal(releaseTagFor(SNAPSHOT), "observation-db-test-20260905120000");
    assert.deepEqual(validatePointer({ ...pointerFor(), asset: { releaseTag: "observation-db-test-20260905120000", name: assetNameFor(SNAPSHOT) } }).asset.releaseTag, "observation-db-test-20260905120000");
    process.env.OBSERVATION_DB_RELEASE_TAG_OVERRIDE = "observation-db-2026-01";
    assert.throws(() => releaseTagFor(SNAPSHOT), /override/i);
  } finally { delete process.env.OBSERVATION_DB_RELEASE_TAG_OVERRIDE; }
});
```

- [ ] **Step 2: Run** → FAIL (ENOENT; override not implemented).

- [ ] **Step 3: Implement** — in the store, `releaseTagFor` becomes:
```js
export function releaseTagFor(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid snapshot id");
  const override = process.env.OBSERVATION_DB_RELEASE_TAG_OVERRIDE;
  if (override) {
    if (!/^observation-db-test-[0-9]{14}$/.test(override)) throw new Error("release tag override must name a throwaway test release");
    return override;
  }
  return `observation-db-${snapshotId.slice(0, 4)}-${snapshotId.slice(4, 6)}`;
}
```
(`validatePointer` already compares against `releaseTagFor`, so it accepts the override automatically.)

Write the workflow:

```yaml
name: Observation database pre-flight and restore

# Dispatch-only. roundtrip: proves the Actions token can create a release, upload an
# asset, and that anonymous resolve verifies it, then deletes the throwaway release.
# restore: re-uploads a lost snapshot from a W1 run's observation-db-<run-id> artifact
# (spec 2026-09-05 §7, §8).

on:
  workflow_dispatch:
    inputs:
      mode:
        description: roundtrip (throwaway test release) or restore (re-upload a lost snapshot asset)
        required: true
        default: roundtrip
        type: choice
        options:
          - roundtrip
          - restore
      snapshot-id:
        description: restore only - snapshot id named by the committed pointer
        required: false
        type: string
      run-id:
        description: restore only - W1 run id whose observation-db-<run-id> artifact holds the database
        required: false
        type: string

permissions: {}

jobs:
  store:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: main
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.13"
      - name: Download the published database copy
        if: ${{ inputs.mode == 'restore' }}
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: observation-db-${{ inputs.run-id }}
          path: ${{ runner.temp }}/restore
          run-id: ${{ inputs.run-id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - name: Publish and verify
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          MODE: ${{ inputs.mode }}
          REQUESTED_SNAPSHOT_ID: ${{ inputs.snapshot-id }}
        run: |
          set -euo pipefail
          WORK="${RUNNER_TEMP}/store-work"
          mkdir "$WORK"
          if [ "$MODE" = "restore" ]; then
            [[ "$REQUESTED_SNAPSHOT_ID" =~ ^[0-9]{14}-[a-f0-9]{16}$ ]] || { echo "::error::snapshot-id is required for restore"; exit 1; }
            SNAPSHOT_ID="$REQUESTED_SNAPSHOT_ID"
            DATABASE="${RUNNER_TEMP}/restore/repository-observations.sqlite"
            [ -f "$DATABASE" ] || { echo "::error::downloaded artifact does not contain the database"; exit 1; }
            git show "HEAD:data/observation-db.pointer.json" > "$WORK/pointer.json"
            git show "HEAD:data/latest.json" > "$WORK/latest.json"
            python scripts/scan_repository_observations.py --database "$DATABASE" --expect-snapshot "$SNAPSHOT_ID" > "$WORK/scan-receipt.json"
            node scripts/observation-db-store.mjs publish --database "$DATABASE" --snapshot-id "$SNAPSHOT_ID" --target-sha "$(git rev-parse HEAD)" --latest "$WORK/latest.json" --scan-receipt "$WORK/scan-receipt.json" --pointer-out "$WORK/republished-pointer.json"
            cmp "$WORK/pointer.json" "$WORK/republished-pointer.json" || { echo "::error::restored asset does not match the committed pointer"; exit 1; }
            exit 0
          fi
          SNAPSHOT_ID="$(date -u +%Y%m%d%H%M%S)-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
          TEST_TAG="observation-db-test-$(date -u +%Y%m%d%H%M%S)"
          DATABASE="$WORK/preflight.sqlite"
          head -c 65536 /dev/urandom > "$DATABASE"
          node --input-type=module -e 'import { createHash } from "node:crypto"; import { readFileSync, writeFileSync } from "node:fs"; const bytes=readFileSync(process.argv[1]); const digest=createHash("sha256").update(bytes).digest("hex"); writeFileSync(process.argv[2], JSON.stringify({ ok: true, databaseSha256: digest, databaseSha256Prefix: digest.slice(0,12), rawByteSize: bytes.length }));' "$DATABASE" "$WORK/scan-receipt.json"
          printf '{"snapshotId":"%s"}\n' "$SNAPSHOT_ID" > "$WORK/latest.json"
          trap 'gh release delete "$TEST_TAG" --cleanup-tag --yes || echo "::warning::could not delete the test release $TEST_TAG"' EXIT
          export OBSERVATION_DB_RELEASE_TAG_OVERRIDE="$TEST_TAG"
          node scripts/observation-db-store.mjs publish --database "$DATABASE" --snapshot-id "$SNAPSHOT_ID" --target-sha "$(git rev-parse HEAD)" --latest "$WORK/latest.json" --scan-receipt "$WORK/scan-receipt.json" --pointer-out "$WORK/pointer.json"
          PROOF="$WORK/proof"
          mkdir -p "$PROOF/data"
          cp "$WORK/pointer.json" "$PROOF/data/observation-db.pointer.json"
          git -C "$PROOF" init -q
          git -C "$PROOF" -c user.name=preflight -c user.email=preflight@example.invalid add --all
          git -C "$PROOF" -c user.name=preflight -c user.email=preflight@example.invalid commit -qm "preflight pointer"
          PROOF_SHA="$(git -C "$PROOF" rev-parse HEAD)"
          node scripts/observation-db-store.mjs resolve --source-sha "$PROOF_SHA" --expect-snapshot-id "$SNAPSHOT_ID" --git-root "$PROOF" --out "$WORK/resolved.sqlite"
          cmp "$DATABASE" "$WORK/resolved.sqlite"
          echo "round trip verified for $SNAPSHOT_ID on $TEST_TAG"
```

The round trip uses a random 64 KiB file, not a real SQLite database: what it proves is token scope, release creation, upload, anonymous download and hash verification — exactly the parts a local PAT run cannot prove. The `git add --all` inside `$PROOF` is on a throwaway repository in `$RUNNER_TEMP`, not the checkout; the W1 shape test's `git add --all` prohibition applies only to `daily-refresh.yml`.

- [ ] **Step 4: Run** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/observation-db-preflight.yml tests/observation-db-preflight-workflow.test.mjs scripts/observation-db-store.mjs tests/observation-db-store.test.mjs
git commit -m "feat: add a dispatch-only pre-flight and restore workflow for observation database assets"
```

---

### Task 9: README data section and recorder determinism note

**Files:**
- Modify: `README.md` (after the paragraph at line 127 about the star-tick ledgers; do NOT remove that paragraph), `README.ko.md` (matching section)
- Modify: `tests/test_repository_observations.py` (one new test)

- [ ] **Step 1: Add one paragraph to each README**

English (README.md):

> **Observation database.** The SQLite database that records every refresh (`repository-observations.sqlite`) is not committed to this repository. Each refresh uploads it as an immutable asset on the month's `observation-db-YYYY-MM` prerelease and commits `data/observation-db.pointer.json`, which names the asset and its SHA-256. Every workflow and the production probe download the asset anonymously and verify the hash before use, so a checkout never contains the database; run `node scripts/observation-db-store.mjs resolve --source-sha "$(git rev-parse HEAD)" --out repository-observations.sqlite` to fetch the one the current commit refers to.

Korean (README.ko.md):

> **관측 데이터베이스.** 갱신마다 기록되는 SQLite 데이터베이스(`repository-observations.sqlite`)는 이 저장소에 커밋되지 않습니다. 각 갱신은 그 파일을 해당 월의 `observation-db-YYYY-MM` 프리릴리스 자산으로 올리고, 자산 이름과 SHA-256을 담은 `data/observation-db.pointer.json`만 커밋합니다. 모든 워크플로와 운영 점검은 자산을 익명으로 내려받아 해시를 검증한 뒤 사용하므로 체크아웃에는 데이터베이스가 없습니다. 현재 커밋이 가리키는 파일은 `node scripts/observation-db-store.mjs resolve --source-sha "$(git rev-parse HEAD)" --out repository-observations.sqlite`로 받을 수 있습니다.

- [ ] **Step 2: Recorder determinism test** — in `tests/test_repository_observations.py` add `test_recording_identical_inputs_is_byte_deterministic`: record the same writer snapshot twice into two fresh databases (reuse `record_writer_snapshot`, `writer_payload`, `writer_events`, `writer_legacy_baselines` exactly as `tests/verify-refresh-chain.test.mjs:263-283` composes them) and assert the two files' sha256 are equal. If it fails because SQLite page allocation differs, decorate it with `@unittest.expectedFailure` and a comment pointing to spec §6.2 step 7 and §8, and state the outcome in the task report.

- [ ] **Step 3: Run** — `npm test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md README.ko.md tests/test_repository_observations.py
git commit -m "docs: describe the release-asset observation database and record recorder determinism"
```

---

## Self-review

**Spec coverage.** §4.1/4.2/4.3 → Tasks 1–2. §5 (two subcommands, `resolve --check`, publish, no `gh` in resolve, overrides refused in Actions) → Tasks 1–2, 8. §6.1 → Tasks 4, 6(a–c). §6.2 → Task 6(d–f) and Task 3 (receipt). §6.3 → Task 5. §6.4 → Tasks 6(g), 7. §6.5 → Task 5 (probe path). §6.6 → Task 5. §6.7 → Task 7. §7 pre-flight (b) → Task 8; (a) is an S6 activity, not a task. §8 restore procedure → Task 8 restore mode. §9 tests → each task; recorder determinism → Task 9. §11 README → Task 9. Deferred by design: §10.

**Placeholder scan.** No TBD/TODO. Two places tell the implementer to read code and adjust (parent-evidence key in Task 6(c); reinstatement loop in Task 4) — both name the exact file and lines.

**Type consistency.** `resolveObservationDatabase({ sourceSha, out, expectSnapshotId, gitRoot, check, deadline, fetchImpl })` and `publishObservationDatabase({ database, snapshotId, targetSha, latestPath, scanReceiptPath, pointerOut, deadline, fetchImpl })` are used with the same names in Tasks 1, 2, 5, 6, 7, 8. CLI flags `--source-sha --out --expect-snapshot-id --git-root --check` and `--database --snapshot-id --target-sha --latest --scan-receipt --pointer-out` are identical across workflow snippets and tests. Env doubles: `GIT_BIN/GIT_SCRIPT`, `GH_BIN/GH_SCRIPT`, `OBSERVATION_DB_DOWNLOAD_BASE_URL`, `OBSERVATION_DB_ALLOWED_HOSTS`, `OBSERVATION_DB_RETRY_DELAYS_MS`, `OBSERVATION_DB_RESOLVER_SCRIPT`, `OBSERVATION_DB_RELEASE_TAG_OVERRIDE`.

**Ordering.** Tasks 1→2→3 build the store; 4 and 5 are independent of each other but both precede 6; 7 after 6 (shares the test idiom); 8 after 2; 9 last. Implementers run sequentially in one checkout.
