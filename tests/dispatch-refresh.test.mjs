import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { dispatchRefresh, readCandidateManifestFromArchive, selectNewDispatchRun, validateDispatchReceipt } from "../scripts/dispatch-refresh.mjs";

const sha = "a".repeat(40);
const prior = [{ databaseId: 10, headSha: sha, event: "workflow_dispatch" }];

test("dispatch selects exactly one new workflow-dispatch run for the expected head", () => {
  const match = { databaseId: 11, headSha: sha, event: "workflow_dispatch", url: "https://example.test/runs/11" };
  assert.deepEqual(selectNewDispatchRun(prior, [...prior, match], sha), match);
});

test("dispatch rejects zero or two same-head new runs", () => {
  assert.throws(() => selectNewDispatchRun(prior, prior, sha), /zero matching/i);
  assert.throws(() => selectNewDispatchRun(prior, [
    ...prior,
    { databaseId: 11, headSha: sha, event: "workflow_dispatch" },
    { databaseId: 12, headSha: sha, event: "workflow_dispatch" },
  ], sha), /multiple matching/i);
});

test("dispatch receipt is one exact provenance envelope", () => {
  const receipt = {
    runId: 11,
    headSha: sha,
    sourceSha: "b".repeat(40),
    snapshotId: "20260826100700-0123456789abcdef",
    manifestSha256: "c".repeat(64),
    url: "https://github.com/owner/repo/actions/runs/11",
  };
  assert.deepEqual(validateDispatchReceipt(receipt), receipt);
  assert.throws(() => validateDispatchReceipt({ ...receipt, extra: true }), /receipt/i);
  assert.throws(() => validateDispatchReceipt({ ...receipt, sourceSha: "main" }), /receipt/i);
});

test("dispatch rejects a polling override above 60 seconds before any command", async () => {
  const previous = process.env.DISPATCH_TIMEOUT_MS;
  const previousGh = process.env.GH_BIN;
  const previousScript = process.env.GH_SCRIPT;
  process.env.DISPATCH_TIMEOUT_MS = "60001";
  process.env.GH_BIN = join(tmpdir(), "task-6-never-resolve-real-gh");
  delete process.env.GH_SCRIPT;
  try { await assert.rejects(dispatchRefresh(), /polling configuration/i); } finally {
    if (previous === undefined) delete process.env.DISPATCH_TIMEOUT_MS; else process.env.DISPATCH_TIMEOUT_MS = previous;
    if (previousGh === undefined) delete process.env.GH_BIN; else process.env.GH_BIN = previousGh;
    if (previousScript === undefined) delete process.env.GH_SCRIPT; else process.env.GH_SCRIPT = previousScript;
  }
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function tar(entries, { nonzeroTrailer = false } = {}) {
  const blocks = [];
  for (const { name, body = Buffer.alloc(0), type = "0", link = "" } of entries) {
    const payload = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii"); header.write("0000000\0", 116, 8, "ascii");
    header.write(`${payload.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156); header.write(type, 156, 1, "ascii"); header.write(link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, payload, Buffer.alloc((512 - payload.length % 512) % 512));
  }
  const trailer = Buffer.alloc(1024);
  if (nonzeroTrailer) trailer[trailer.length - 1] = 1;
  return Buffer.concat([...blocks, trailer]);
}

function zip(entries, { mutateLocalHeader = null } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const payload = Buffer.from(body);
    const nameBytes = Buffer.from(name);
    const crc = crc32(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    if (mutateLocalHeader) mutateLocalHeader(local);
    locals.push(local, nameBytes, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE((0o100644 * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes); offset += local.length + nameBytes.length + payload.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function archive({ manifestBytes, extraTar = [], nonzeroTrailer = false, extraZip = [] } = {}) {
  const page = Buffer.from("<html></html>\n");
  const manifest = manifestBytes ?? Buffer.from(`${JSON.stringify({ version: 1, sourceSha: "b".repeat(40), snapshotId: "20260826100700-0123456789abcdef", files: { "index.html": createHash("sha256").update(page).digest("hex") } }, null, 2)}\n`);
  return { manifest, bytes: zip([["artifact.tar", tar([{ name: "deployment-manifest.json", body: manifest }, { name: "index.html", body: page }, ...extraTar], { nonzeroTrailer })], ...extraZip]) };
}

test("raw artifact reader binds one outer ZIP to one exact root manifest and file set", () => {
  const valid = archive();
  assert.deepEqual(readCandidateManifestFromArchive(valid.bytes), valid.manifest);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "nested/deployment-manifest.json", body: valid.manifest }] }).bytes), /unexpected|root/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "Deployment-Manifest.json", body: valid.manifest }] }).bytes), /case-fold|exactly one/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "linked", type: "1", link: "index.html" }] }).bytes), /link/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "sidecar.tmp", body: "x" }] }).bytes), /unexpected/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ nonzeroTrailer: true }).bytes), /trailing|terminator/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraZip: [["extra", Buffer.from("x")]] }).bytes), /exactly one/i);
  assert.throws(() => readCandidateManifestFromArchive(zip([["artifact.tar", tar([
    { name: "deployment-manifest.json", body: valid.manifest },
    { name: "index.html", body: "<html></html>\n" },
  ])]], { mutateLocalHeader: local => local.writeUInt32LE(1, 18) })), /local.*size|ZIP local/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "unused/", type: "5" }] }).bytes), /directory|prefix/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "./", type: "5" }, { name: ".", type: "5" }] }).bytes), /duplicate/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "data", body: "x" }, { name: "data/child", body: "y" }] }).bytes), /conflict/i);
  assert.throws(() => readCandidateManifestFromArchive(archive({ extraTar: [{ name: "data/", type: "5", body: "x" }] }).bytes), /directory.*size/i);
  const duplicate = Buffer.from(`{"version":1,"version":1,"sourceSha":"${"b".repeat(40)}","snapshotId":"20260826100700-0123456789abcdef","files":{}}`);
  assert.throws(() => readCandidateManifestFromArchive(archive({ manifestBytes: duplicate }).bytes), /duplicate key/i);
});

test("dispatch CLI assembles fake Git, gh run selection, raw archive, and exact receipt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = archive();
  const zipPath = join(directory, "artifact.zip");
  const countPath = join(directory, "count");
  const ghScript = join(directory, "fake-gh.mjs");
  const gitScript = join(directory, "fake-git.mjs");
  await writeFile(zipPath, raw.bytes);
  await writeFile(countPath, "0");
  await writeFile(ghScript, `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "list") {
  const count = Number(readFileSync(process.env.COUNT_PATH, "utf8")); writeFileSync(process.env.COUNT_PATH, String(count + 1));
  const pending = [
    {databaseId:8,headSha:"${sha}",event:"workflow_dispatch",status:"queued",conclusion:null,createdAt:"2026-08-26T10:05:00Z",url:"https://github.com/owner/repo/actions/runs/8"},
    {databaseId:9,headSha:"${sha}",event:"workflow_dispatch",status:"in_progress",conclusion:"",createdAt:"2026-08-26T10:06:00Z",url:"https://github.com/owner/repo/actions/runs/9"}
  ];
  process.stdout.write(JSON.stringify(count === 0 ? pending : [...pending,{databaseId:11,headSha:"${sha}",event:"workflow_dispatch",status:"completed",conclusion:"success",createdAt:"2026-08-26T10:07:00Z",url:"https://github.com/owner/repo/actions/runs/11"}]));
} else if (args[0] === "workflow" && args[1] === "run") process.stdout.write("ok");
else if (args[0] === "run" && args[1] === "watch") process.stdout.write("ok");
else if (args[0] === "api" && args[1].includes("/runs/11/artifacts")) process.stdout.write(JSON.stringify({total_count:1,artifacts:[{id:77,name:"github-pages-candidate-11",expired:false,size_in_bytes:${raw.bytes.length}}]}));
else if (args[0] === "api" && args[1].endsWith("/artifacts/77/zip")) process.stdout.write(readFileSync(process.env.ZIP_PATH));
else process.exit(91);
`);
  await writeFile(gitScript, `const args = process.argv.slice(2);
if (args[0] === "fetch") process.exit(0);
if (args[0] === "rev-parse") process.stdout.write("${sha}\\n");
else if (args[0] === "remote") process.stdout.write("https://github.com/owner/repo.git\\n");
else process.exit(92);
`);
  const executed = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/dispatch-refresh.mjs", import.meta.url)), "--wait"], {
    encoding: "utf8",
    env: { ...process.env, GH_BIN: process.execPath, GH_SCRIPT: ghScript, GIT_BIN: process.execPath, GIT_SCRIPT: gitScript, COUNT_PATH: countPath, ZIP_PATH: zipPath, GITHUB_REPOSITORY: "owner/repo", DISPATCH_TIMEOUT_MS: "1000", DISPATCH_POLL_INTERVAL_MS: "0" },
  });
  assert.equal(executed.status, 0, executed.stderr);
  const receipt = JSON.parse(executed.stdout);
  assert.equal(receipt.runId, 11);
  assert.equal(receipt.headSha, sha);
  assert.equal(receipt.sourceSha, "b".repeat(40));
  assert.equal(await readFile(countPath, "utf8"), "2");
});

test("dispatch polling gives nested run listing only the shared remaining budget", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const countPath = join(directory, "count");
  const completedPath = join(directory, "completed");
  const ghScript = join(directory, "fake-gh.mjs");
  const gitScript = join(directory, "fake-git.mjs");
  await writeFile(countPath, "0");
  await writeFile(ghScript, `import { readFileSync,writeFileSync } from "node:fs"; const args=process.argv.slice(2);
if(args[0]==="run"&&args[1]==="list"){const count=Number(readFileSync(process.env.COUNT_PATH,"utf8"));writeFileSync(process.env.COUNT_PATH,String(count+1));if(count>0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);writeFileSync(process.env.COMPLETED_PATH,"completed");}process.stdout.write("[]");}
else if(args[0]==="workflow"&&args[1]==="run") process.stdout.write("ok"); else process.exit(91);`);
  await writeFile(gitScript, `const args=process.argv.slice(2);if(args[0]==="fetch")process.exit(0);if(args[0]==="rev-parse")process.stdout.write("${sha}\\n");else process.exit(92);`);
  const executed = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/dispatch-refresh.mjs", import.meta.url))], {
    encoding: "utf8",
    env: { ...process.env, GH_BIN: process.execPath, GH_SCRIPT: ghScript, GIT_BIN: process.execPath, GIT_SCRIPT: gitScript, COUNT_PATH: countPath, COMPLETED_PATH: completedPath,
      DISPATCH_TIMEOUT_MS: "100", DISPATCH_POLL_INTERVAL_MS: "0", DISPATCH_OVERALL_TIMEOUT_MS: "5000" },
  });
  assert.notEqual(executed.status, 0);
  await assert.rejects(readFile(completedPath), "the nested run list must be killed before its delayed completion");
  assert.match(executed.stderr, /deadline|command failed/i);
});
