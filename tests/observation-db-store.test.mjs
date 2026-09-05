// tests/observation-db-store.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  allowedHosts, assetNameFor, DATABASE_PATH, downloadAsset, downloadUrlFor, downloadVerified,
  parsePointerBytes, POINTER_PATH, publishObservationDatabase, releaseTagFor, resolveDeadlineMs,
  resolveObservationDatabase, retryDelays, scrub, validatePointer,
} from "../scripts/observation-db-store.mjs";

const SNAPSHOT = "20260905024612-0123456789abcdef";
const SHA = "a".repeat(40);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const DB = Buffer.from("SQLite format 3\0" + "x".repeat(4000));
// The deadline handed to the CLI children and to in-process resolves. Short enough that a hang
// surfaces in a fifth of the module's 600 s default, generous enough that an ordinary run - which
// spends nearly all of its time creating processes - never trips it on a loaded machine.
const TEST_DEADLINE_MS = 120_000;
const pointerFor = (bytes = DB, overrides = {}) => ({
  version: 1, snapshotId: SNAPSHOT,
  database: { sha256: sha256(bytes), byteSize: bytes.length },
  asset: { releaseTag: releaseTagFor(SNAPSHOT), name: assetNameFor(SNAPSHOT) },
  ...overrides,
});

// Every variable the module reads, plus the ones the fake `git` and fake `gh` fixtures read out of
// their inherited environment. CI always sets GITHUB_ACTIONS=true and the module rightly refuses the
// dev-only overrides there, so each test clears the whole set in its own setup, installs exactly what
// it needs, and restores the original values afterwards. No test relies on a sibling's cleanup.
const MANAGED_ENV = [
  "GITHUB_ACTIONS", "GIT_BIN", "GIT_SCRIPT", "FAKE_POINTER", "FAKE_BLOB",
  "GH_BIN", "GH_SCRIPT", "GH_LOG", "GH_STATE", "GH_SERVED_DIR",
  "OBSERVATION_DB_DOWNLOAD_BASE_URL", "OBSERVATION_DB_ALLOWED_HOSTS",
  "OBSERVATION_DB_RETRY_DELAYS_MS", "OBSERVATION_DB_RESOLVE_DEADLINE_MS",
  "OBSERVATION_DB_RELEASE_TAG_OVERRIDE",
];

function isolateEnv(t, overrides = {}) {
  const saved = MANAGED_ENV.map(name => [name, process.env[name]]);
  for (const name of MANAGED_ENV) delete process.env[name];
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// Children inherit the isolated environment, never GITHUB_ACTIONS.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GITHUB_ACTIONS;
  return env;
}

async function scratchDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    // Verified downloads land mode 0444, which is the read-only attribute on Windows.
    const entries = await readdir(directory).catch(() => []);
    for (const entry of entries) await chmod(join(directory, entry), 0o666).catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return directory;
}

test("tag and asset names derive from the snapshot id", { timeout: 60_000 }, t => {
  isolateEnv(t);
  assert.equal(releaseTagFor(SNAPSHOT), "observation-db-2026-09");
  assert.equal(assetNameFor(SNAPSHOT), `repository-observations-${SNAPSHOT}.sqlite`);
  assert.throws(() => releaseTagFor("2026-09-05"), /snapshot/i);
});

// The one override the module honours inside Actions: observation-db-preflight.yml runs its round
// trip against a throwaway release, and only a run under the Actions token proves that token may
// create a release and upload an asset. The name pattern is what keeps it throwaway - anything that
// could name a real monthly release is refused everywhere.
test("the release tag override is accepted only for test tags", { timeout: 60_000 }, t => {
  isolateEnv(t, { OBSERVATION_DB_RELEASE_TAG_OVERRIDE: "observation-db-test-20260905120000" });
  assert.equal(releaseTagFor(SNAPSHOT), "observation-db-test-20260905120000");
  assert.equal(
    validatePointer({ ...pointerFor(), asset: { releaseTag: "observation-db-test-20260905120000", name: assetNameFor(SNAPSHOT) } }).asset.releaseTag,
    "observation-db-test-20260905120000",
  );
  assert.throws(() => validatePointer({ ...pointerFor(), asset: { releaseTag: "observation-db-2026-09", name: assetNameFor(SNAPSHOT) } }), /pointer/i);
  process.env.GITHUB_ACTIONS = "true";
  assert.equal(releaseTagFor(SNAPSHOT), "observation-db-test-20260905120000");
  process.env.OBSERVATION_DB_RELEASE_TAG_OVERRIDE = "observation-db-2026-01";
  assert.throws(() => releaseTagFor(SNAPSHOT), /override/i);
  delete process.env.GITHUB_ACTIONS;
  assert.throws(() => releaseTagFor(SNAPSHOT), /override/i);
});

test("pointer validation is exact and derived fields are re-checked", { timeout: 60_000 }, t => {
  isolateEnv(t);
  assert.deepEqual(validatePointer(pointerFor()), pointerFor());
  assert.throws(() => validatePointer({ ...pointerFor(), producedAt: "x" }), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { snapshotId: "bad" })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { database: { sha256: "0".repeat(63), byteSize: 1 } })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { database: { sha256: "0".repeat(64), byteSize: -1 } })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { database: { sha256: 12345, byteSize: 1 } })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { asset: { releaseTag: "observation-db-2026-10", name: assetNameFor(SNAPSHOT) } })), /pointer/i);
  assert.throws(() => validatePointer(pointerFor(DB, { asset: { releaseTag: releaseTagFor(SNAPSHOT), name: "other.sqlite" } })), /pointer/i);
  assert.equal(downloadUrlFor(pointerFor()), `https://github.com/nowwcastle-sudo/github-trending-daily/releases/download/observation-db-2026-09/repository-observations-${SNAPSHOT}.sqlite`);
});

test("parsePointerBytes refuses empty, oversized, non-UTF-8 and malformed input", { timeout: 60_000 }, t => {
  isolateEnv(t);
  const encoded = Buffer.from(JSON.stringify(pointerFor()));
  assert.deepEqual(parsePointerBytes(encoded), pointerFor());
  assert.throws(() => parsePointerBytes(Buffer.alloc(0)), /pointer/i);
  assert.throws(() => parsePointerBytes(Buffer.alloc(4097, 0x20)), /pointer/i);
  assert.throws(() => parsePointerBytes(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), /pointer/i);
  assert.throws(() => parsePointerBytes(Buffer.from("{not json")), /pointer/i);
  assert.throws(() => parsePointerBytes(JSON.stringify(pointerFor())), /pointer/i);
});

test("scrub redacts every token shape it knows", { timeout: 60_000 }, t => {
  isolateEnv(t);
  // Synthetic placeholders built from repeated letters - none of these is, or resembles, a real
  // credential; they exist only to prove each alternative of TOKEN_RE fires.
  const synthetic = [
    `sk-ant-${"a".repeat(40)}`,
    `ghp_${"b".repeat(30)}`,
    `github_pat_${"c".repeat(30)}`,
    `AIza${"d".repeat(35)}`,
  ];
  for (const value of synthetic) {
    assert.equal(scrub(`before ${value} after`), "before [redacted] after");
  }
  assert.equal(scrub(`${synthetic[0]} and ${synthetic[1]}`), "[redacted] and [redacted]");
  assert.equal(scrub("nothing to redact"), "nothing to redact");
  assert.equal(scrub(null), "");
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

test("downloadVerified verifies hash and size, follows one allow-listed redirect, retries 503, refuses oversize and bad hosts", { timeout: 60_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-store-");
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
  isolateEnv(t, {
    OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1,1,1",
  });
  const fetchWith = (name, out) => downloadVerified({
    url: `${base}/${name}`, sha256: sha256(DB), byteSize: DB.length,
    destination: join(directory, out), deadline: Date.now() + 10_000,
  });
  const ok = await fetchWith("redirect.sqlite", "a.sqlite");
  assert.equal(ok.sha256, sha256(DB)); assert.equal(ok.byteSize, DB.length);
  assert.deepEqual(await readFile(join(directory, "a.sqlite")), DB);
  await assert.rejects(fetchWith("redirect.sqlite", "a.sqlite"), /EEXIST|exists/i);
  assert.equal((await fetchWith("flaky.sqlite", "b.sqlite")).sha256, sha256(DB));
  await assert.rejects(fetchWith("big.sqlite", "c.sqlite"), /size/i);
  await assert.rejects(fetchWith("wrong.sqlite", "d.sqlite"), /sha256/i);
  await assert.rejects(fetchWith("missing.sqlite", "e.sqlite"), /404/);
  await assert.rejects(fetchWith("evil.sqlite", "f.sqlite"), /redirect|allowed/i);
  // Only the verified body ever reaches disk.
  assert.deepEqual((await readdir(directory)).sort(), ["a.sqlite", "b.sqlite"]);
});

test("downloadAsset drives downloadVerified from a validated pointer", { timeout: 60_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-pointer-");
  const { base, close } = await assetServer((request, response) => {
    if (request.url.endsWith(assetNameFor(SNAPSHOT))) { response.writeHead(200); response.end(DB); return; }
    response.writeHead(404); response.end();
  });
  t.after(close);
  isolateEnv(t, {
    OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1",
  });
  const destination = join(directory, "db.sqlite");
  const verified = await downloadAsset({ pointer: pointerFor(), destination, deadline: Date.now() + 10_000 });
  assert.equal(verified.sha256, sha256(DB));
  assert.deepEqual(await readFile(destination), DB);
  // A pointer whose asset name is not derived from the snapshot id never reaches the network.
  await assert.rejects(
    downloadAsset({ pointer: pointerFor(DB, { asset: { releaseTag: releaseTagFor(SNAPSHOT), name: "other.sqlite" } }), destination: join(directory, "no.sqlite"), deadline: Date.now() + 10_000 }),
    /pointer/i);
});

test("a size mismatch and a non-retryable status are fatal and are not retried", { timeout: 60_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-fatal-");
  const requests = { truncated: 0, unimplemented: 0, flaky: 0 };
  const { base, close } = await assetServer((request, response) => {
    if (request.url.endsWith("/truncated.sqlite")) { requests.truncated += 1; response.writeHead(200); response.end(DB.subarray(0, 100)); return; }
    if (request.url.endsWith("/unimplemented.sqlite")) { requests.unimplemented += 1; response.writeHead(501); response.end(); return; }
    if (request.url.endsWith("/flaky.sqlite")) { requests.flaky += 1; response.writeHead(503); response.end(); return; }
    response.writeHead(404); response.end();
  });
  t.after(close);
  isolateEnv(t, {
    OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1,1,1",
  });
  const fetchWith = (name, out) => downloadVerified({
    url: `${base}/${name}`, sha256: sha256(DB), byteSize: DB.length,
    destination: join(directory, out), deadline: Date.now() + 10_000,
  });
  await assert.rejects(fetchWith("truncated.sqlite", "t.sqlite"), /size mismatch/i);
  assert.equal(requests.truncated, 1, "a truncated body is fatal: it must not be requested again");
  await assert.rejects(fetchWith("unimplemented.sqlite", "u.sqlite"), /501/);
  assert.equal(requests.unimplemented, 1, "HTTP 501 is fatal: it must not be requested again");
  // The counter-example: a retryable status really does consume all four attempts.
  await assert.rejects(fetchWith("flaky.sqlite", "r.sqlite"), /503/);
  assert.equal(requests.flaky, 4);
  assert.deepEqual(await readdir(directory), []);
});

test("dev-only environment overrides are refused inside GitHub Actions", { timeout: 60_000 }, t => {
  isolateEnv(t, {
    GITHUB_ACTIONS: "true",
    OBSERVATION_DB_DOWNLOAD_BASE_URL: "http://127.0.0.1:1",
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1",
    OBSERVATION_DB_RESOLVE_DEADLINE_MS: "20000",
  });
  assert.throws(() => downloadUrlFor(pointerFor()), /override/i);
  assert.throws(() => allowedHosts(), /override/i);
  assert.throws(() => retryDelays(), /override/i);
  assert.throws(() => resolveDeadlineMs(), /override/i);
});

// The two refusals raised from inside the download retry loop. A refusal is a configuration verdict,
// not a flaky network, so it has to surface at once; if it is merely retried the caller waits out the
// full production backoff (2 s + 8 s + 20 s) before seeing a message that was never going to change.
test("override refusals inside the retry loop fail immediately instead of sleeping through the retries", { timeout: 60_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-refusal-");
  isolateEnv(t, { GITHUB_ACTIONS: "true" });
  const attempt = async url => {
    const started = Date.now();
    await assert.rejects(downloadVerified({
      url, sha256: sha256(DB), byteSize: DB.length,
      destination: join(directory, "never.sqlite"), deadline: Date.now() + 60_000,
    }), /override/i);
    return Date.now() - started;
  };
  // allowedHosts() refuses before any socket is opened.
  process.env.OBSERVATION_DB_ALLOWED_HOSTS = "127.0.0.1";
  const hostRefusal = await attempt("https://github.com/a/b/releases/download/t/n.sqlite");
  assert.ok(hostRefusal < 2000, `the allowed-host refusal must not be retried (took ${hostRefusal} ms)`);
  // downloadBaseOverride() refuses from the plain-http transport check.
  delete process.env.OBSERVATION_DB_ALLOWED_HOSTS;
  process.env.OBSERVATION_DB_DOWNLOAD_BASE_URL = "http://127.0.0.1:1";
  const baseRefusal = await attempt("http://github.com/a/b/releases/download/t/n.sqlite");
  assert.ok(baseRefusal < 2000, `the download-base refusal must not be retried (took ${baseRefusal} ms)`);
  assert.deepEqual(await readdir(directory), []);
});

async function fakeGit(directory, { pointer = null, blob = null }) {
  const script = join(directory, "fake-git.mjs");
  await writeFile(join(directory, "pointer.json"), pointer ? JSON.stringify(pointer) : "");
  await writeFile(join(directory, "blob.sqlite"), blob ?? Buffer.alloc(0));
  // The presence check reads "ls-tree -z <sha> -- <path>", so this answers it the way the real
  // binary does: exit 0 whether or not the path is tracked, one NUL-terminated "<mode> blob <oid>"
  // record for a tracked path and no output at all for an untracked one. The last argument is the
  // bare path for ls-tree and "<sha>:<path>" for the content commands, which is why the suffix
  // test does not anchor on the colon.
  await writeFile(script, `import { readFileSync } from "node:fs"; let args = process.argv.slice(2); if (args[0] === "-C") args = args.slice(2);
const has = { pointer: ${Boolean(pointer)}, blob: ${Boolean(blob)} };
const spec = args.at(-1); const isPointer = spec.endsWith("data/observation-db.pointer.json"); const isBlob = spec.endsWith("data/repository-observations.sqlite");
if (args[0] === "ls-tree") { if ((isPointer && has.pointer) || (isBlob && has.blob)) process.stdout.write(\`100644 blob \${"0".repeat(40)}\\t\${spec}\\0\`); process.exit(0); }
if (args[0] === "cat-file" && args[1] === "blob" && isBlob && has.blob) { process.stdout.write(readFileSync(process.env.FAKE_BLOB)); process.exit(0); }
if (args[0] === "show" && isPointer && has.pointer) { process.stdout.write(readFileSync(process.env.FAKE_POINTER)); process.exit(0); }
process.exit(128);`);
  return { GIT_BIN: process.execPath, GIT_SCRIPT: script, FAKE_POINTER: join(directory, "pointer.json"), FAKE_BLOB: join(directory, "blob.sqlite") };
}

test("the git binary override is refused inside GitHub Actions", { timeout: 60_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-gitbin-");
  const fixture = await fakeGit(directory, { pointer: pointerFor() });
  isolateEnv(t, { GITHUB_ACTIONS: "true", GIT_BIN: fixture.GIT_BIN, GIT_SCRIPT: fixture.GIT_SCRIPT });
  await assert.rejects(
    resolveObservationDatabase({ sourceSha: SHA, gitRoot: directory, check: true, deadline: Date.now() + TEST_DEADLINE_MS }),
    /git binary override is refused/i);
});

// The CLI child downloads from the asset server that runs in THIS process, so the child must be
// spawned asynchronously: spawnSync would block this event loop, the server could never answer,
// and both sides would wait until the resolve deadline expired.
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

// A real hang is bounded by the child's own OBSERVATION_DB_RESOLVE_DEADLINE_MS (TEST_DEADLINE_MS,
// 120 s) below, not by this timeout, which only backstops a stall in the runner itself. It is the
// most generous in the file because this one test spawns ~32 processes - eight CLI runs, each of
// which runs fake git three times - and process creation is the slow part on a loaded machine.
test("resolve: pointer only downloads and verifies; blob only uses git; both or neither fail closed; expect-snapshot-id is enforced", { timeout: 300_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-resolve-");
  const { base, close } = await assetServer((request, response) => { if (request.url.endsWith(assetNameFor(SNAPSHOT))) { response.writeHead(200); response.end(DB); } else { response.writeHead(404); response.end(); } });
  t.after(close);
  isolateEnv(t);
  const run = async (fixture, extra = []) => {
    const env = childEnv({
      ...(await fakeGit(directory, fixture)),
      OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
      OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
      OBSERVATION_DB_RETRY_DELAYS_MS: "1",
      OBSERVATION_DB_RESOLVE_DEADLINE_MS: String(TEST_DEADLINE_MS),
    });
    const out = join(directory, `${Math.random().toString(16).slice(2)}.sqlite`);
    const result = await runStore(["resolve", "--source-sha", SHA, "--out", out, ...extra], env);
    return { ...result, out };
  };
  const pointerOnly = await run({ pointer: pointerFor() });
  assert.equal(pointerOnly.status, 0, pointerOnly.stderr);
  assert.equal(JSON.parse(pointerOnly.stdout).mode, "pointer");
  assert.equal(JSON.parse(pointerOnly.stdout).snapshotId, SNAPSHOT);
  assert.deepEqual(await readFile(pointerOnly.out), DB);

  const blobOnly = await run({ blob: DB });
  assert.equal(blobOnly.status, 0, blobOnly.stderr);
  assert.equal(JSON.parse(blobOnly.stdout).mode, "blob");
  assert.equal(JSON.parse(blobOnly.stdout).snapshotId, null, "the blob carries no snapshot id to report");
  assert.match(blobOnly.stderr, /::notice::blob fallback cannot verify --expect-snapshot-id/);

  // The two failures a caller has to tell apart. An ambiguous commit is a defect - exit 1, ::error::
  // - and no workflow may answer it by building the legacy artifact.
  const both = await run({ pointer: pointerFor(), blob: DB });
  assert.equal(both.status, 1, both.stderr); assert.match(both.stderr, /::error::[^\n]*both/i);
  assert.equal(existsSync(both.out), false, "a failed resolve leaves no output file");

  // Nothing tracked is the one benign verdict, and it says so in the status rather than only in the
  // text: exit 3 with a ::notice::, identical whether or not --check was asked for.
  const neither = await run({});
  assert.equal(neither.status, 3, neither.stderr);
  assert.match(neither.stderr, /::notice::observation database is not tracked at [a-f0-9]{40}: neither pointer nor blob is tracked/);
  assert.doesNotMatch(neither.stderr, /::error::/);
  assert.equal(existsSync(neither.out), false, "a failed resolve leaves no output file");

  const neitherCheck = await run({}, ["--check"]);
  assert.equal(neitherCheck.status, 3, neitherCheck.stderr);
  assert.match(neitherCheck.stderr, /::notice::observation database is not tracked at [a-f0-9]{40}/);

  const wrongSnapshot = await run({ pointer: pointerFor() }, ["--expect-snapshot-id", "20260101000000-0000000000000000"]);
  assert.notEqual(wrongSnapshot.status, 0); assert.match(wrongSnapshot.stderr, /snapshot/i);
  assert.equal(existsSync(wrongSnapshot.out), false);

  const check = await run({ pointer: pointerFor() }, ["--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /"mode":"pointer"/);
  assert.equal(existsSync(check.out), false, "--check must not download to --out");

  const withGitRoot = await run({ pointer: pointerFor() }, ["--git-root", directory]);
  assert.equal(withGitRoot.status, 0, withGitRoot.stderr);
  assert.deepEqual(await readFile(withGitRoot.out), DB);
});

// Every git call is given the identity and the newline policy inline: the fixture repository has no
// config of its own, an inherited user.name is not something a test may rely on, and core.autocrlf
// is true on Windows developer machines, where it would rewrite the SQLite fixture on the way in.
const GIT_FIXTURE_CONFIG = Object.freeze([
  "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false",
]);

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...GIT_FIXTURE_CONFIG, ...args], { cwd, env: childEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => {
      if (status === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")} exited ${status}: ${stderr.trim()}`));
    });
  });
}

// The fake git above is one we wrote, so on its own it can only prove the module agrees with our own
// idea of git. It exited 1 for an absent path; real git exits 128, and the module read 128 as a
// lookup failure - so a pointer-only commit, which is what every commit after the transition looks
// like, threw instead of resolving. Nothing but the real binary catches that, so this test takes no
// GIT_BIN/GIT_SCRIPT override: isolateEnv clears both and the CLI child runs against git itself.
test("resolve reads real git: pointer-only and blob-only commits resolve; both and neither fail closed", { timeout: 300_000 }, async t => {
  isolateEnv(t);
  // Kept out of scratchDirectory: a repository is a tree, and its objects land read-only on Windows,
  // which that helper's flat chmod pass does not reach. A leftover fixture is cheaper than a red run.
  const repository = await mkdtemp(join(tmpdir(), "obs-realgit-"));
  t.after(() => rm(repository, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}));
  const outputs = await scratchDirectory(t, "obs-realgit-out-");
  const { base, close } = await assetServer((request, response) => {
    if (request.url.endsWith(assetNameFor(SNAPSHOT))) { response.writeHead(200); response.end(DB); } else { response.writeHead(404); response.end(); }
  });
  t.after(close);

  await runGit(repository, ["init", "-q"]);
  await mkdir(join(repository, "data"), { recursive: true });
  // Each commit is built by clearing both tracked paths and writing back only the ones the case
  // wants, so what the commit carries is its whole tree rather than an accumulation of the last one.
  const commitTree = async files => {
    for (const relative of [POINTER_PATH, DATABASE_PATH]) await rm(join(repository, relative), { force: true });
    for (const [relative, contents] of Object.entries(files)) await writeFile(join(repository, relative), contents);
    await runGit(repository, ["add", "-A"]);
    await runGit(repository, ["commit", "-q", "--allow-empty", "-m", "fixture"]);
    const sha = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
    assert.match(sha, /^[a-f0-9]{40}$/, "the fixture repository must use 40-hex object names");
    return sha;
  };
  const pointerJson = `${JSON.stringify(pointerFor(), null, 2)}\n`;
  const pointerSha = await commitTree({ [POINTER_PATH]: pointerJson });
  const blobSha = await commitTree({ [DATABASE_PATH]: DB });
  const bothSha = await commitTree({ [POINTER_PATH]: pointerJson, [DATABASE_PATH]: DB });
  const neitherSha = await commitTree({});

  // Async spawn, never spawnSync: the asset server the child downloads from runs in this process, so
  // blocking this event loop would deadlock both sides until the resolve deadline expired.
  const run = async (sourceSha, name) => {
    const out = join(outputs, name);
    const result = await runStore(["resolve", "--source-sha", sourceSha, "--out", out, "--git-root", repository], childEnv({
      OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
      OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
      OBSERVATION_DB_RETRY_DELAYS_MS: "1",
      OBSERVATION_DB_RESOLVE_DEADLINE_MS: String(TEST_DEADLINE_MS),
    }));
    return { ...result, out };
  };

  const pointerOnly = await run(pointerSha, "pointer.sqlite");
  assert.equal(pointerOnly.status, 0, pointerOnly.stderr);
  assert.equal(JSON.parse(pointerOnly.stdout).mode, "pointer");
  assert.equal(JSON.parse(pointerOnly.stdout).snapshotId, SNAPSHOT);
  assert.deepEqual(await readFile(pointerOnly.out), DB);

  const blobOnly = await run(blobSha, "blob.sqlite");
  assert.equal(blobOnly.status, 0, blobOnly.stderr);
  assert.equal(JSON.parse(blobOnly.stdout).mode, "blob");
  assert.deepEqual(await readFile(blobOnly.out), DB, "cat-file blob must hand back the committed bytes unfiltered");

  const both = await run(bothSha, "both.sqlite");
  assert.equal(both.status, 1, both.stderr);
  assert.match(both.stderr, /::error::[^\n]*both/i);
  assert.equal(existsSync(both.out), false, "a failed resolve leaves no output file");

  // Against real git too, and not only the fake: an untracked commit is exit 3 with a ::notice::.
  const neither = await run(neitherSha, "neither.sqlite");
  assert.equal(neither.status, 3, neither.stderr);
  assert.match(neither.stderr, /::notice::observation database is not tracked at [a-f0-9]{40}: neither pointer nor blob is tracked/);
  assert.doesNotMatch(neither.stderr, /::error::/);
  assert.equal(existsSync(neither.out), false, "a failed resolve leaves no output file");
});

// Nine more CLI spawns; each one fails during argument parsing, before any I/O, so nothing here
// can hang - the timeout only has to outlast process creation on a loaded machine.
test("the CLI rejects a malformed command line before it touches git or gh", { timeout: 120_000 }, async t => {
  isolateEnv(t);
  const env = childEnv();
  const out = join(tmpdir(), "never-created.sqlite");
  const cases = [
    { args: ["resolve", "--source-sha", SHA, "--out", out, "--source-sha", "nope"], expected: /repeated flag/i },
    { args: ["resolve", "--source-sha", SHA, "--out"], expected: /requires a value/i },
    { args: ["resolve", "--source-sha", SHA, "--out", "--check"], expected: /requires a value/i },
    { args: ["resolve", "--source-sha", SHA, "--nonsense", "x"], expected: /unknown flag/i },
    { args: ["resolve", "extra", "--source-sha", SHA], expected: /unexpected argument/i },
    { args: ["resolve", "--source-sha", "nope", "--out", out], expected: /source sha/i },
    { args: ["publish", "--database", out], expected: /is required/i },
    { args: ["publish", "--nonsense", "x"], expected: /unknown flag/i },
    { args: ["nonsense"], expected: /unknown command/i },
  ];
  for (const { args, expected } of cases) {
    const result = await runStore(args, env);
    assert.notEqual(result.status, 0, `expected a non-zero exit for ${args.join(" ")}`);
    assert.match(result.stderr, expected);
  }
  assert.equal(existsSync(out), false);
});

// A fake `gh` selected by GH_BIN/GH_SCRIPT, exactly as the fake git is selected by GIT_BIN/GIT_SCRIPT.
// It logs every argument array it is handed, models the failures publish has to survive - the release
// already existing, a `release view` that fails for a reason other than the release being missing,
// the release appearing between our view and our create, and the asset name already being taken -
// and, on a successful upload, copies the staged file into the directory the asset server serves from.
async function fakeGh(directory, { existingRelease, uploadResult, servedBytes = null, createResult = "ok", viewStderr = "release not found\n" }) {
  const script = join(directory, "fake-gh.mjs");
  const log = join(directory, "gh-calls.log");
  await writeFile(log, "");
  await writeFile(script, `import { appendFileSync, copyFileSync } from "node:fs"; import { basename, join } from "node:path";
const args = process.argv.slice(2); appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const state = JSON.parse(process.env.GH_STATE);
if (args[0] === "release" && args[1] === "view") { if (state.existingRelease) { process.stdout.write(JSON.stringify({ tagName: args[2] })); process.exit(0); } process.stderr.write(state.viewStderr); process.exit(1); }
if (args[0] === "release" && args[1] === "create") { if (state.existingRelease || state.createResult === "already_exists") { process.stderr.write("HTTP 422: Validation Failed (already_exists)\\n"); process.exit(1); } process.exit(0); }
if (args[0] === "release" && args[1] === "upload") { if (state.uploadResult === "fail") { process.stderr.write("HTTP 422: asset already exists\\n"); process.exit(1); } copyFileSync(args[3], join(process.env.GH_SERVED_DIR, basename(args[3]))); process.exit(0); }
process.exit(91);`);
  const served = join(directory, "served");
  await mkdir(served, { recursive: true });
  if (servedBytes) await writeFile(join(served, assetNameFor(SNAPSHOT)), servedBytes);
  return {
    env: {
      GH_BIN: process.execPath, GH_SCRIPT: script, GH_LOG: log,
      GH_STATE: JSON.stringify({ existingRelease, uploadResult, createResult, viewStderr }), GH_SERVED_DIR: served,
    },
    log, served,
  };
}

// The three inputs publish cross-checks against the database file it is handed.
async function publishFixture(directory, { db = DB, snapshotId = SNAPSHOT } = {}) {
  const database = join(directory, "candidate.sqlite");
  const latest = join(directory, "latest.json");
  const receipt = join(directory, "scan.json");
  await writeFile(database, db);
  await writeFile(latest, JSON.stringify({ snapshotId, generatedAt: "2026-09-05T02:46:12.000Z", statsDate: "2026-09-05", count: 0, repos: [] }));
  await writeFile(receipt, JSON.stringify({ ok: true, databaseSha256: sha256(db), databaseSha256Prefix: sha256(db).slice(0, 12), rawByteSize: db.length }));
  return { database, latest, receipt };
}

// This test drives ~6 `gh` child processes plus in-process downloads, so its timeout is sized for
// process creation like the resolve test's. The fake gh never calls back into the asset server, so
// the execFileSync inside publish cannot deadlock this event loop; the served asset is confirmed
// afterwards through in-process fetch, when no synchronous call is outstanding.
test("publish: creates the monthly release when missing, uploads, confirms by anonymous download, writes the pointer; re-runs and conflicts fail closed", { timeout: 300_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-publish-");
  const { database, latest, receipt } = await publishFixture(directory);
  let gh = await fakeGh(directory, { existingRelease: false, uploadResult: "ok" });
  const { base, close } = await assetServer((request, response) => {
    readFile(join(gh.served, request.url.split("/").pop())).then(
      bytes => { response.writeHead(200); response.end(bytes); },
      () => { response.writeHead(404); response.end(); });
  });
  t.after(close);
  isolateEnv(t, {
    ...gh.env,
    OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1",
  });
  const pointerOut = join(directory, "pointer.json");
  const args = () => ({ database, snapshotId: SNAPSHOT, targetSha: SHA, latestPath: latest, scanReceiptPath: receipt, pointerOut, deadline: Date.now() + 60_000 });

  const result = await publishObservationDatabase(args());
  assert.equal(result.uploaded, true);
  assert.deepEqual(JSON.parse(await readFile(pointerOut, "utf8")), pointerFor());
  const calls = (await readFile(gh.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [["release", "view"], ["release", "create"], ["release", "upload"]]);
  assert.ok(calls[1].includes("--target") && calls[1].includes(SHA) && calls[1].includes("--prerelease") && calls[1].includes("--latest=false"));
  assert.equal(calls[2][2], "observation-db-2026-09");
  assert.ok(calls[2][3].endsWith(assetNameFor(SNAPSHOT)));
  assert.ok(!calls[2].includes("--clobber"), "an asset name is never overwritten");

  // Idempotent re-run: the release exists, the upload is refused, the served bytes match - success.
  gh = await fakeGh(directory, { existingRelease: true, uploadResult: "fail", servedBytes: DB });
  Object.assign(process.env, gh.env);
  await rm(pointerOut);
  assert.equal((await publishObservationDatabase(args())).uploaded, false);
  assert.deepEqual(JSON.parse(await readFile(pointerOut, "utf8")), pointerFor());

  // The name is taken by different bytes - fail closed rather than point at someone else's file.
  gh = await fakeGh(directory, { existingRelease: true, uploadResult: "fail", servedBytes: Buffer.from("z".repeat(DB.length)) });
  Object.assign(process.env, gh.env);
  await rm(pointerOut);
  await assert.rejects(publishObservationDatabase(args()), /sha256/i);
  assert.equal(existsSync(pointerOut), false, "a failed publish writes no pointer");

  // A receipt that does not describe this file is refused before gh is invoked at all.
  await writeFile(receipt, JSON.stringify({ ok: true, databaseSha256: "0".repeat(64), databaseSha256Prefix: "000000000000", rawByteSize: DB.length }));
  await writeFile(gh.log, "");
  await assert.rejects(publishObservationDatabase(args()), /receipt/i);
  assert.equal((await readFile(gh.log, "utf8")).trim(), "", "the receipt check runs before any gh call");

  // latest.json names a different snapshot than the one being published.
  await writeFile(receipt, JSON.stringify({ ok: true, databaseSha256: sha256(DB), databaseSha256Prefix: sha256(DB).slice(0, 12), rawByteSize: DB.length }));
  await writeFile(latest, JSON.stringify({ snapshotId: "20260101000000-0000000000000000" }));
  await assert.rejects(publishObservationDatabase(args()), /latest/i);
  assert.equal(existsSync(pointerOut), false);
  assert.equal((await readFile(gh.log, "utf8")).trim(), "", "the latest.json check runs before any gh call");
});

// The asymmetry finding 1 introduced. GitHub accepts an upload before it serves the asset, so the
// confirmation - and only the confirmation - treats 404 as transient; a resolve asking for an asset
// that is not there already has its answer and must not spend the backoff discovering it again.
test("publish confirms through a 404 the release has not caught up with yet; resolve keeps 404 fatal", { timeout: 180_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-publish-404-");
  const { database, latest, receipt } = await publishFixture(directory);
  const gh = await fakeGh(directory, { existingRelease: true, uploadResult: "ok" });
  let hits = 0;
  const { base, close } = await assetServer((request, response) => {
    hits += 1;
    // Not served yet on the first look, served on the second - what a fresh upload actually does.
    if (hits === 1) { response.writeHead(404); response.end(); return; }
    response.writeHead(200); response.end(DB);
  });
  t.after(close);
  isolateEnv(t, {
    ...gh.env,
    OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1,1,1",
  });
  const pointerOut = join(directory, "pointer.json");
  const result = await publishObservationDatabase({
    database, snapshotId: SNAPSHOT, targetSha: SHA, latestPath: latest, scanReceiptPath: receipt,
    pointerOut, deadline: Date.now() + 60_000,
  });
  assert.equal(result.uploaded, true);
  assert.equal(hits, 2, "the confirmation retried the 404 once and then accepted the served asset");
  assert.deepEqual(JSON.parse(await readFile(pointerOut, "utf8")), pointerFor());
});

test("resolve does not retry a 404: a missing asset is fatal on the first attempt", { timeout: 120_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-resolve-404-");
  let hits = 0;
  const { base, close } = await assetServer((request, response) => { hits += 1; response.writeHead(404); response.end(); });
  t.after(close);
  isolateEnv(t, {
    ...(await fakeGit(directory, { pointer: pointerFor() })),
    OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1,1,1",
  });
  await assert.rejects(resolveObservationDatabase({
    sourceSha: SHA, out: join(directory, "db.sqlite"), gitRoot: directory, deadline: Date.now() + TEST_DEADLINE_MS,
  }), /404/);
  assert.equal(hits, 1, "the retry ladder is not walked for a 404 outside the publish confirmation");
  assert.equal((await readdir(directory)).includes("db.sqlite"), false, "a failed resolve leaves no output file");
});

// `gh release view` exits 1 both when the release is missing and when the API call itself failed, so
// the two halves of that contract are tested together: the race we tolerate, and the failure we must
// not mistake for it.
test("a release created between our view and our create is tolerated; a view that failed for another reason is not", { timeout: 180_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-ensure-release-");
  const { database, latest, receipt } = await publishFixture(directory);
  // The racing creator: our view says missing, our create is told the tag already exists.
  let gh = await fakeGh(directory, { existingRelease: false, createResult: "already_exists", uploadResult: "ok" });
  const { base, close } = await assetServer((request, response) => {
    readFile(join(gh.served, request.url.split("/").pop())).then(
      bytes => { response.writeHead(200); response.end(bytes); },
      () => { response.writeHead(404); response.end(); });
  });
  t.after(close);
  isolateEnv(t, {
    ...gh.env,
    OBSERVATION_DB_DOWNLOAD_BASE_URL: base,
    OBSERVATION_DB_ALLOWED_HOSTS: "127.0.0.1",
    OBSERVATION_DB_RETRY_DELAYS_MS: "1",
  });
  const pointerOut = join(directory, "pointer.json");
  const args = () => ({ database, snapshotId: SNAPSHOT, targetSha: SHA, latestPath: latest, scanReceiptPath: receipt, pointerOut, deadline: Date.now() + 60_000 });
  assert.equal((await publishObservationDatabase(args())).uploaded, true);
  assert.deepEqual(JSON.parse(await readFile(pointerOut, "utf8")), pointerFor());
  const calls = (await readFile(gh.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [["release", "view"], ["release", "create"], ["release", "upload"]]);

  // Same exit status 1, different stderr: an auth failure must surface, not be answered by a create.
  gh = await fakeGh(directory, { existingRelease: false, uploadResult: "ok", viewStderr: "HTTP 401: Bad credentials\n" });
  Object.assign(process.env, gh.env);
  await rm(pointerOut);
  await assert.rejects(publishObservationDatabase(args()), /gh release view failed/i);
  assert.deepEqual(
    (await readFile(gh.log, "utf8")).trim().split("\n").map(line => JSON.parse(line)).map(call => call.slice(0, 2)),
    [["release", "view"]],
    "a view failure that is not 'release not found' stops before create");
  assert.equal(existsSync(pointerOut), false);
});

test("the gh binary override is refused inside GitHub Actions", { timeout: 60_000 }, async t => {
  const directory = await scratchDirectory(t, "obs-ghbin-");
  const { database, latest, receipt } = await publishFixture(directory);
  const gh = await fakeGh(directory, { existingRelease: true, uploadResult: "ok" });
  isolateEnv(t, { ...gh.env, GITHUB_ACTIONS: "true" });
  await assert.rejects(
    publishObservationDatabase({
      database, snapshotId: SNAPSHOT, targetSha: SHA, latestPath: latest, scanReceiptPath: receipt,
      pointerOut: join(directory, "pointer.json"), deadline: Date.now() + 10_000,
    }),
    /gh binary override is refused/i);
  assert.equal((await readFile(gh.log, "utf8")).trim(), "", "the refusal happens before gh runs");
});
