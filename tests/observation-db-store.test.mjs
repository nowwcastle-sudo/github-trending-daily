// tests/observation-db-store.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
  const server = http.createServer((request, response) => {
    response.setHeader("connection", "close");
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
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

// The CLI child downloads from the asset server that runs in THIS process, so the child must be
// spawned asynchronously: spawnSync would block this event loop, the server could never answer,
// and both sides would wait until the resolve deadline (600 s) expired.
function runStore(args, env) {
  const script = fileURLToPath(new URL("../scripts/observation-db-store.mjs", import.meta.url));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

test("resolve: pointer only downloads and verifies; blob only uses git; both or neither fail closed; expect-snapshot-id is enforced", async t => {
  const directory = await mkdtemp(join(tmpdir(), "obs-resolve-"));
  const { base, close } = await assetServer((request, response) => { if (request.url.endsWith(assetNameFor(SNAPSHOT))) { response.writeHead(200); response.end(DB); } else { response.writeHead(404); response.end(); } });
  t.after(close);
  const run = async (fixture, extra = []) => {
    const env = { ...process.env, ...(await fakeGit(directory, fixture)), OBSERVATION_DB_DOWNLOAD_BASE_URL: base, OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1", OBSERVATION_DB_RETRY_DELAYS_MS: "1" };
    const out = join(directory, `${Math.random().toString(16).slice(2)}.sqlite`);
    const result = await runStore(["resolve", "--source-sha", SHA, "--out", out, ...extra], env);
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
