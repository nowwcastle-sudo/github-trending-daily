import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OVERLAY_PATHS, VERSION_1_BASE_PATHS } from "../scripts/build-pages-artifact.mjs";
import { assetNameFor, releaseTagFor } from "../scripts/observation-db-store.mjs";
import { assertSourceBoundToRunHead, selectMatchingReceipt, resolveEffectiveReceipt, validateWorkflowRun, verifyRefreshChain } from "../scripts/verify-refresh-chain.mjs";

const expected = {
  runId: 20,
  sourceSha: "a".repeat(40),
  snapshotId: "20260826100700-0123456789abcdef",
  manifestSha256: "b".repeat(64),
};
const later = {
  runId: 21,
  sourceSha: "c".repeat(40),
  snapshotId: "20260826120700-fedcba9876543210",
  manifestSha256: "d".repeat(64),
};

test("exact expected production keeps the expected receipt", () => {
  assert.deepEqual(resolveEffectiveReceipt({ expected, production: expected, laterReceipts: [], isAncestor: () => true, originMain: expected.sourceSha }), { expectedRunId: 20, effectiveRunId: 20, receipt: expected });
  assert.deepEqual(resolveEffectiveReceipt({ expected, production: expected, laterReceipts: [], isAncestor: () => true, originMain: "f".repeat(40) }), { expectedRunId: 20, effectiveRunId: 20, receipt: expected });
});

test("one later fast-forward receipt may replace the expected receipt", () => {
  assert.deepEqual(resolveEffectiveReceipt({ expected, production: later, laterReceipts: [later], isAncestor: () => true, originMain: later.sourceSha }), { expectedRunId: 20, effectiveRunId: 21, receipt: later });
});

test("later replacement fails on non-fast-forward, zero matches, or two matches", () => {
  assert.throws(() => resolveEffectiveReceipt({ expected, production: later, laterReceipts: [later], isAncestor: () => false, originMain: later.sourceSha }), /fast-forward/i);
  assert.throws(() => resolveEffectiveReceipt({ expected, production: later, laterReceipts: [], isAncestor: () => true, originMain: later.sourceSha }), /exactly one/i);
  assert.throws(() => resolveEffectiveReceipt({ expected, production: later, laterReceipts: [later, { ...later, runId: 22 }], isAncestor: () => true, originMain: later.sourceSha }), /exactly one/i);
});

test("current production accepts exactly one matching receipt and exact origin main", () => {
  assert.deepEqual(selectMatchingReceipt(later, [expected, later]), later);
  assert.throws(() => selectMatchingReceipt(later, []), /exactly one/i);
  assert.throws(() => selectMatchingReceipt(later, [later, { ...later, runId: 22 }]), /exactly one/i);
  assert.throws(() => resolveEffectiveReceipt({ expected: null, production: later, laterReceipts: [later], isAncestor: () => true, originMain: expected.sourceSha }), /origin\/main/i);
});

test("workflow receipt requires exact run identity and exact deploy/probe jobs", () => {
  const run = {
    databaseId: 20, headSha: expected.sourceSha, event: "workflow_dispatch", status: "completed", conclusion: "success",
    createdAt: "2026-08-26T10:07:00Z", url: "https://github.com/owner/repo/actions/runs/20",
    jobs: [
      { databaseId: 1, name: "Deploy candidate Pages artifact", status: "completed", conclusion: "success" },
      { databaseId: 2, name: "Probe production candidate", status: "completed", conclusion: "success" },
      { databaseId: 3, name: "Skipped unrelated job", status: "completed", conclusion: "skipped" },
    ],
  };
  assert.equal(validateWorkflowRun(run, 20, { requireDispatchEvent: true }), run);
  assert.throws(() => validateWorkflowRun({ ...run, databaseId: 21 }, 20), /invalid/i);
  assert.throws(() => validateWorkflowRun({ ...run, jobs: run.jobs.map(job => ({ ...job, name: `renamed ${job.name}` })) }, 20), /exact successful job/i);
  assert.throws(() => validateWorkflowRun({ ...run, event: "schedule" }, 20, { requireDispatchEvent: true }), /invalid/i);
  assert.throws(() => validateWorkflowRun({ ...run, url: "https://example.test/actions/runs/20" }, 20), /invalid/i);
  assert.throws(() => validateWorkflowRun({ ...run, jobs: [...run.jobs, { databaseId: 4, name: "Queued unrelated job", status: "queued", conclusion: "" }] }, 20), /job schema/i);
  assert.throws(() => validateWorkflowRun({ ...run, jobs: run.jobs.map(job => job.databaseId === 3 ? { ...job, status: "queued", conclusion: "success" } : job) }, 20), /job schema/i);
  assert.throws(() => validateWorkflowRun({ ...run, jobs: run.jobs.map(job => job.databaseId === 3 ? { ...job, status: "completed", conclusion: null } : job) }, 20), /job schema/i);
});

test("v1 requires one permitted generated child while v0 recovery preserves run-head reuse", () => {
  const head = "a".repeat(40);
  const child = "b".repeat(40);
  assert.throws(() => assertSourceBoundToRunHead(head, head, () => assert.fail("Git must not run")), /generated child/i);
  assert.equal(assertSourceBoundToRunHead(head, head, () => assert.fail("Git must not run"), { version: 0 }), true);
  assert.equal(assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "data/latest.json\ndata/readme-state.json\ndata/repository-observations.sqlite\nindex.html"), true);
  assert.equal(assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "data/latest.json\ndata/observation-db.pointer.json\nindex.html"), true);
  assert.throws(() => assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? "c".repeat(40) : "data/latest.json"), /direct generated/i);
  assert.throws(() => assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "repo-filters.js"), /non-generated/i);
  assert.throws(() => assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "data/star-observations.sqlite"), /non-generated/i);
  assert.throws(() => assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "data/trending-membership.sqlite"), /non-generated/i);
  assert.throws(() => assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "data/legacy-public-star-history.json"), /non-generated/i);
});

test("assembled verifyRefreshChain binds expected, later run, origin and final probe", async () => {
  const calls = [];
  const laterWithTime = { ...later, headSha: later.sourceSha, createdAt: "2026-08-26T12:07:00Z" };
  const expectedWithTime = { ...expected, headSha: expected.sourceSha, createdAt: "2026-08-26T10:07:00Z" };
  const dependencies = {
    fetchOrigin: () => calls.push("fetch"),
    productionReceipt: async () => { calls.push("production"); return later; },
    receiptForRun: async runId => { calls.push(`receipt-${runId}`); return runId === expected.runId ? expectedWithTime : laterWithTime; },
    listSuccessfulRuns: () => { calls.push("runs"); return [{ databaseId: later.runId, createdAt: laterWithTime.createdAt }]; },
    originMain: () => later.sourceSha,
    isAncestor: () => true,
    probeProduction: async options => calls.push(["probe", options.sourceSha, options.snapshotId]),
  };
  const result = await verifyRefreshChain({ baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha, expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256 }, dependencies);
  assert.equal(result.effectiveRunId, later.runId);
  assert.deepEqual(calls, ["production", "receipt-20", "runs", "receipt-21", "fetch", ["probe", later.sourceSha, later.snapshotId]]);

  await assert.rejects(verifyRefreshChain({ baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha, expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256 }, {
    ...dependencies, productionReceipt: async () => expected, receiptForRun: async () => ({ ...expectedWithTime, runId: 999 }),
  }), /wrong run id/i);
  await assert.rejects(verifyRefreshChain({ baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha, expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256 }, {
    ...dependencies, originMain: () => expected.sourceSha,
  }), /origin\/main/i);
});

test("later receipt discovery cannot reuse an origin ref fetched before a concurrent advance", async () => {
  let remote = later.sourceSha;
  let cached = later.sourceSha;
  const expectedWithTime = { ...expected, headSha: expected.sourceSha, createdAt: "2026-08-26T10:07:00Z" };
  const laterWithTime = { ...later, headSha: later.sourceSha, createdAt: "2026-08-26T12:07:00Z" };
  await assert.rejects(verifyRefreshChain({
    baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha,
    expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256,
  }, {
    productionReceipt: async () => later,
    receiptForRun: async runId => {
      if (runId === expected.runId) return expectedWithTime;
      remote = "f".repeat(40);
      return laterWithTime;
    },
    listSuccessfulRuns: () => [{ databaseId: later.runId, createdAt: laterWithTime.createdAt }],
    fetchOrigin: () => { cached = remote; },
    originMain: () => cached,
    isAncestor: () => true,
    probeProduction: async () => assert.fail("stale production must not be probed"),
  }), /origin\/main/i);
});

test("the final probe receives the one verification deadline instead of restarting its own budget", async () => {
  const started = Date.now();
  const expectedWithTime = { ...expected, headSha: expected.sourceSha, createdAt: "2026-08-26T10:07:00Z" };
  await assert.rejects(verifyRefreshChain({
    baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha,
    expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256,
  }, {
    timeoutMs: 25,
    productionReceipt: async () => expected,
    receiptForRun: async () => expectedWithTime,
    fetchOrigin: () => {},
    originMain: () => expected.sourceSha,
    isAncestor: () => true,
    probeProduction: async options => {
      assert.ok(options.deadline >= started && options.deadline <= started + 50);
      await new Promise(resolve => setTimeout(resolve, 30));
    },
  }), /deadline/i);
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function tar(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const payload = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write("0000644\0", 100, 8); header.write("0000000\0", 108, 8); header.write("0000000\0", 116, 8);
    header.write(`${payload.length.toString(8).padStart(11, "0")}\0`, 124, 12); header.write("00000000000\0", 136, 12);
    header.fill(0x20, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, payload, Buffer.alloc((512 - payload.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function zipOne(name, body) {
  const payload = Buffer.from(body);
  const nameBytes = Buffer.from(name);
  const crc = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12); eocd.writeUInt32LE(local.length + nameBytes.length + payload.length, 16);
  return Buffer.concat([local, nameBytes, payload, central, nameBytes, eocd]);
}

function atom({ kind, generatedAt, snapshotId, statsDate, slug = null }) {
  const current = kind === "current";
  const id = `https://nowwcastle-sudo.github.io/github-trending-daily/${current ? "feed.xml" : "changes.xml"}`;
  const title = current ? "GITHUB INSIGHT — Current repositories" : "GITHUB INSIGHT — New and re-entered repositories";
  const entry = slug ? `<entry><id>https://github.com/${slug}</id><title>${slug}</title><updated>${generatedAt}</updated><link rel="alternate" type="text/html" href="https://github.com/${slug}" /><summary type="text">summary</summary></entry>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${id}</id><title>${title}</title><updated>${generatedAt}</updated><link rel="self" type="application/atom+xml" href="${id}" /><link rel="alternate" type="text/html" href="https://nowwcastle-sudo.github.io/github-trending-daily/" /><category scheme="https://nowwcastle-sudo.github.io/github-trending-daily/snapshot" term="${snapshotId}" /><category scheme="https://nowwcastle-sudo.github.io/github-trending-daily/stats-date" term="${statsDate}" />${entry}</feed>`;
}

async function makeArtifact(directory, sourceSha, snapshotId) {
  const generatedAt = "2026-08-26T10:07:00.000Z";
  const statsDate = "2026-08-26";
  const slug = "owner/repo";
  const sources = { version: 3, sources: { [slug]: {
    kind: "readme", slug, path: "README.md", blob_sha: "b".repeat(40), content_sha256: "c".repeat(64),
    provider: "claude-cli-oauth", interface: "claude-p", cli_version: "2.1.241",
    auth_method: "oauth_token", api_provider: "firstParty",
    model: "claude-sonnet-5", schema_version: 3, prompt_schema_version: 3, translation_applicable: false,
  } } };
  const payloads = new Map();
  for (const relative of [...VERSION_1_BASE_PATHS, ...OVERLAY_PATHS]) payloads.set(relative, Buffer.from(`${relative}\n`));
  const classification = { tag_rule_version: 1, field_tags: ["ai-ml", "dev-tools"], form_tags: ["agent", "library"] };
  payloads.set("index.html", Buffer.from(`<html>\nconst REPOS = [${JSON.stringify({ slug, _snapshot_id: snapshotId, _generated_at: generatedAt, _stats_date: statsDate, ...classification })}];\n</html>\n`));
  payloads.set("data/latest.json", Buffer.from(`${JSON.stringify({ snapshotId, generatedAt, statsDate, count: 1, repos: [{ slug, ...classification }] })}\n`));
  payloads.set("data/membership-status.json", Buffer.from(`${JSON.stringify({ schemaVersion: 1, generatedAt, statsDate, baseline: true, current: [{ slug, status: "baseline" }], exited: [] })}\n`));
  payloads.set("feed.xml", Buffer.from(atom({ kind: "current", generatedAt, snapshotId, statsDate, slug })));
  payloads.set("changes.xml", Buffer.from(atom({ kind: "changes", generatedAt, snapshotId, statsDate })));
  const files = Object.fromEntries([...payloads].sort(([left], [right]) => left.localeCompare(right)).map(([relative, bytes]) => [relative, createHash("sha256").update(bytes).digest("hex")]));
  const manifestBytes = Buffer.from(`${JSON.stringify({ version: 1, sourceSha, snapshotId, files }, null, 2)}\n`);
  for (const [relative, bytes] of payloads) {
    const target = join(directory, ...relative.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(directory, "deployment-manifest.json"), manifestBytes);
  return {
    sourceSha, snapshotId, manifestBytes, sourcesBytes: Buffer.from(`${JSON.stringify(sources)}\n`),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    archive: zipOne("artifact.tar", tar([["deployment-manifest.json", manifestBytes], ...payloads])),
  };
}

function successfulRun(runId, headSha, createdAt, event = "workflow_dispatch") {
  return {
    databaseId: runId, headSha, event, status: "completed", conclusion: "success", createdAt,
    url: `https://github.com/owner/repo/actions/runs/${runId}`,
    jobs: [
      { databaseId: runId * 10 + 1, name: "Deploy candidate Pages artifact", status: "completed", conclusion: "success" },
      { databaseId: runId * 10 + 2, name: "Probe production candidate", status: "completed", conclusion: "success" },
    ],
  };
}

async function startArtifactServer(directory, { delayPath = null, delayMs = 0 } = {}) {
  const mime = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".xml": "application/xml" };
  const server = http.createServer(async (request, response) => {
    const relative = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
    if (relative === delayPath) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const bytes = await readFile(join(directory, ...relative.split("/")));
      response.writeHead(200, { "content-type": mime[extname(relative)] ?? "application/octet-stream", "content-length": bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function runVerifier(directory, { artifact, expectedArtifact = artifact, runs = [], views = {}, artifactByRun = {}, originBefore = artifact.sourceSha, originAfter = artifact.sourceSha, parentBySource = {}, diffBySource = {}, currentProduction = false, timeoutMs = 60_000, serverOptions = {}, insideActions = false }) {
  const ghScript = join(directory, "fake-gh.mjs");
  const gitScript = join(directory, "fake-git.mjs");
  const resolverScript = join(directory, "fake-resolver.mjs");
  const pointerPath = join(directory, "observation-db.pointer.json");
  const statePath = join(directory, "origin-state");
  const sourcesPath = join(directory, "translation-sources.json");
  const configPath = join(directory, "gh-config.json");
  const databasePath = join(directory, "data", "repository-observations.sqlite");
  const database = spawnSync(process.env.PYTHON ?? "python", ["-c", [
    "import sqlite3, sys",
    "from pathlib import Path",
    "from scripts.derive_repository_artifacts import derive_repository_insights, finalize_snapshot_derivatives, hash_pages_artifacts",
    "from scripts.record_repository_observations import PAGES_BASE_ARTIFACT_PATHS, prepare_candidate_database",
    "from tests.test_repository_observations import record_writer_snapshot, sha1, writer_events, writer_legacy_baselines, writer_payload",
    "root, snapshot_id = Path(sys.argv[1]), sys.argv[2]",
    "database = root / 'data' / 'repository-observations.sqlite'",
    "database.exists() and sys.exit(0)",
    "legacy_root = root / 'legacy-fixture'",
    "legacy_root.mkdir(exist_ok=True)",
    "paths, receipt = writer_legacy_baselines(legacy_root)",
    "payload = writer_payload(snapshot_id=snapshot_id, utc='2026-08-26T10:07:00.000Z', kst='2026-08-26T19:07:00.000+09:00', stats_date='2026-08-26', run_kind='migration_baseline')",
    "payload['legacy_baseline_receipt'] = receipt",
    "payload['legacy_baselines'] = paths",
    "prepare_candidate_database(root / 'missing-parent.sqlite', database, {'missing': True}, paths)",
    "record_writer_snapshot(database, payload, writer_events(head=sha1(), transition='baseline'), {})",
    "connection = sqlite3.connect(database)",
    "insights = derive_repository_insights(connection, 1)",
    "connection.close()",
    "finalize_snapshot_derivatives(database, snapshot_id, insights, hash_pages_artifacts(root, PAGES_BASE_ARTIFACT_PATHS))",
  ].join("; "), directory, artifact.snapshotId], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  if (database.status !== 0) throw new Error(database.stderr);
  const databaseBytes = await readFile(databasePath);
  await writeFile(pointerPath, `${JSON.stringify({
    version: 1,
    snapshotId: artifact.snapshotId,
    database: { sha256: createHash("sha256").update(databaseBytes).digest("hex"), byteSize: databaseBytes.length },
    asset: { releaseTag: releaseTagFor(artifact.snapshotId), name: assetNameFor(artifact.snapshotId) },
  })}\n`);
  // Stands in for scripts/observation-db-store.mjs so the probe never reaches a release
  // asset over the network, and proves which flags the probe hands the store.
  await writeFile(resolverScript, `import { copyFileSync } from "node:fs";
const args=process.argv.slice(2); const flag=name=>{ const index=args.indexOf(name); return index<0?null:args[index+1]; };
if(args[0]!=="resolve"||!/^[a-f0-9]{40}$/.test(flag("--source-sha")??"")||!/^[0-9]{14}-[a-f0-9]{16}$/.test(flag("--expect-snapshot-id")??"")||!flag("--git-root")||!flag("--out")) process.exit(93);
copyFileSync(process.env.DATABASE_PATH,flag("--out"));
process.stdout.write(JSON.stringify({mode:"pointer"})+"\\n");`);
  await writeFile(statePath, originBefore);
  await writeFile(sourcesPath, artifact.sourcesBytes);
  const configuredArtifacts = {};
  for (const [runId, value] of Object.entries(artifactByRun)) {
    const zipPath = join(directory, `artifact-${runId}.zip`);
    await writeFile(zipPath, value.archive);
    configuredArtifacts[runId] = { id: Number(runId) + 1000, zipPath, size: value.archive.length };
    if (!Object.hasOwn(parentBySource, value.sourceSha) && views[runId]) parentBySource[value.sourceSha] = views[runId].headSha;
  }
  await writeFile(configPath, JSON.stringify({ runs, views, artifacts: configuredArtifacts }));
  await writeFile(ghScript, `import { readFileSync } from "node:fs";
const config=JSON.parse(readFileSync(process.env.GH_CONFIG,"utf8")); const args=process.argv.slice(2);
if(args[0]==="run"&&args[1]==="view") process.stdout.write(JSON.stringify(config.views[args[2]]));
else if(args[0]==="run"&&args[1]==="list") process.stdout.write(JSON.stringify(config.runs));
else if(args[0]==="api"&&args[1].includes("/runs/")) { const id=/runs\\/(\\d+)/.exec(args[1])[1]; const row=config.artifacts[id]; process.stdout.write(JSON.stringify({total_count:row?1:0,artifacts:row?[{id:row.id,name:"github-pages-candidate-"+id,expired:false,size_in_bytes:row.size}]:[]})); }
else if(args[0]==="api"&&args[1].includes("/artifacts/")) { const id=Number(/artifacts\\/(\\d+)/.exec(args[1])[1]); const row=Object.values(config.artifacts).find(value=>value.id===id); process.stdout.write(readFileSync(row.zipPath)); }
else process.exit(91);`);
  await writeFile(gitScript, `import { readFileSync,writeFileSync } from "node:fs"; let args=process.argv.slice(2); if(args[0]==="-C") args=args.slice(2);
if(args[0]==="fetch") writeFileSync(process.env.ORIGIN_STATE,process.env.ORIGIN_AFTER);
else if(args[0]==="rev-parse") process.stdout.write(readFileSync(process.env.ORIGIN_STATE,"utf8")+"\\n");
else if(args[0]==="merge-base") process.exit(process.env.ANCESTOR==="false"?1:0);
else if(args[0]==="show"&&args[1]==="-s") { const map=JSON.parse(process.env.PARENT_BY_SOURCE); process.stdout.write((map[args.at(-1)]??"")+"\\n"); }
else if(args[0]==="diff-tree") { const map=JSON.parse(process.env.DIFF_BY_SOURCE); process.stdout.write((map[args.at(-1)]??"data/latest.json")+"\\n"); }
  else if(args[0]==="show"&&args.at(-1).endsWith(":data/translation-sources.json")) process.stdout.write(readFileSync(process.env.SOURCES_PATH));
  else if(args[0]==="cat-file"&&args[1]==="-e") process.exit(args.at(-1).endsWith(":data/observation-db.pointer.json")?0:1);
  else if(args[0]==="show"&&args.at(-1).endsWith(":data/observation-db.pointer.json")) process.stdout.write(readFileSync(process.env.POINTER_PATH));
else process.exit(92);`);
  const server = await startArtifactServer(directory, serverOptions);
  const script = fileURLToPath(new URL("../scripts/verify-refresh-chain.mjs", import.meta.url));
  const args = currentProduction ? ["--current-production", "--base-url", server.baseUrl] : [
    "--expected-run-id", "20", "--expected-source-sha", expectedArtifact.sourceSha, "--expected-snapshot-id", expectedArtifact.snapshotId,
    "--expected-manifest-sha256", expectedArtifact.manifestSha256, "--base-url", server.baseUrl,
  ];
  // The probe refuses its resolver override inside Actions, so the child must never inherit
  // GITHUB_ACTIONS from a CI run of this suite.
  const childEnv = { ...process.env, GH_BIN: process.execPath, GH_SCRIPT: ghScript, GIT_BIN: process.execPath, GIT_SCRIPT: gitScript, GITHUB_REPOSITORY: "owner/repo",
    GH_CONFIG: configPath, ORIGIN_STATE: statePath, ORIGIN_AFTER: originAfter, SOURCES_PATH: sourcesPath, DATABASE_PATH: databasePath,
    OBSERVATION_DB_RESOLVER_SCRIPT: resolverScript, POINTER_PATH: pointerPath,
    PARENT_BY_SOURCE: JSON.stringify(parentBySource), DIFF_BY_SOURCE: JSON.stringify(diffBySource), VERIFY_TIMEOUT_MS: String(timeoutMs) };
  delete childEnv.GITHUB_ACTIONS;
  if (insideActions) childEnv.GITHUB_ACTIONS = "true";
  const child = spawn(process.execPath, [script, ...args], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await server.close();
  return { status, stdout, stderr };
}

test("verifier CLI assembles fake GitHub, fake Git, raw artifacts, fresh origin and local production", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expectedDir = join(root, "expected"); const productionDir = join(root, "production");
  await mkdir(expectedDir); await mkdir(productionDir);
  const expectedArtifact = await makeArtifact(expectedDir, expected.sourceSha, expected.snapshotId);
  const productionArtifact = await makeArtifact(productionDir, later.sourceSha, later.snapshotId);
  const run20 = successfulRun(20, "1".repeat(40), "2026-08-26T10:07:00Z");
  const run21 = successfulRun(21, "2".repeat(40), "2026-08-26T12:07:00Z", "schedule");
  const pending = [
    { databaseId: 18, headSha: expected.sourceSha, event: "schedule", status: "queued", conclusion: null, createdAt: "2026-08-26T11:00:00Z", url: "https://github.com/owner/repo/actions/runs/18" },
    { databaseId: 19, headSha: later.sourceSha, event: "schedule", status: "in_progress", conclusion: "", createdAt: "2026-08-26T11:30:00Z", url: "https://github.com/owner/repo/actions/runs/19" },
  ];

  const exactResult = await runVerifier(expectedDir, { artifact: expectedArtifact, runs: pending, views: { 20: run20 }, artifactByRun: { 20: expectedArtifact } });
  assert.equal(exactResult.status, 0, exactResult.stderr);
  assert.equal(JSON.parse(exactResult.stdout).effectiveRunId, 20);

  const inActions = await runVerifier(expectedDir, { artifact: expectedArtifact, runs: pending, views: { 20: run20 }, artifactByRun: { 20: expectedArtifact }, insideActions: true });
  assert.notEqual(inActions.status, 0);
  assert.match(inActions.stderr, /resolver override is refused inside GitHub Actions/i);

  const laterResult = await runVerifier(productionDir, { artifact: productionArtifact, expectedArtifact, runs: [...pending, run21], views: { 20: run20, 21: run21 }, artifactByRun: { 20: expectedArtifact, 21: productionArtifact } });
  assert.equal(laterResult.status, 0, laterResult.stderr);
  assert.equal(JSON.parse(laterResult.stdout).effectiveRunId, 21);

  const currentResult = await runVerifier(productionDir, { artifact: productionArtifact, currentProduction: true, runs: [...pending, run21], views: { 21: run21 }, artifactByRun: { 21: productionArtifact } });
  assert.equal(currentResult.status, 0, currentResult.stderr);
  assert.equal(JSON.parse(currentResult.stdout).effectiveRunId, 21);

  const advanced = await runVerifier(expectedDir, { artifact: expectedArtifact, runs: pending, views: { 20: run20 }, artifactByRun: { 20: expectedArtifact }, originAfter: later.sourceSha });
  assert.equal(advanced.status, 0, advanced.stderr);
  assert.equal(JSON.parse(advanced.stdout).effectiveRunId, 20);

  const laterAdvanced = await runVerifier(productionDir, { artifact: productionArtifact, expectedArtifact, runs: [...pending, run21], views: { 20: run20, 21: run21 }, artifactByRun: { 20: expectedArtifact, 21: productionArtifact }, originAfter: "f".repeat(40) });
  assert.notEqual(laterAdvanced.status, 0);
  assert.match(laterAdvanced.stderr, /origin\/main/i);

  const currentAdvanced = await runVerifier(productionDir, { artifact: productionArtifact, currentProduction: true, runs: [...pending, run21], views: { 21: run21 }, artifactByRun: { 21: productionArtifact }, originAfter: "f".repeat(40) });
  assert.notEqual(currentAdvanced.status, 0);
  assert.match(currentAdvanced.stderr, /origin\/main/i);

  const zero = await runVerifier(productionDir, { artifact: productionArtifact, currentProduction: true, runs: pending, views: {}, artifactByRun: {} });
  assert.notEqual(zero.status, 0);
  assert.match(zero.stderr, /exactly one/i);
  const run22 = successfulRun(22, "2".repeat(40), "2026-08-26T13:07:00Z", "schedule");
  const two = await runVerifier(productionDir, { artifact: productionArtifact, currentProduction: true, runs: [run21, run22], views: { 21: run21, 22: run22 }, artifactByRun: { 21: productionArtifact, 22: productionArtifact } });
  assert.notEqual(two.status, 0);
  assert.match(two.stderr, /exactly one/i);
});

test("verifier CLI rejects an unrelated source child at the real Git boundary", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "artifact"));
  const childSource = "e".repeat(40);
  const artifact = await makeArtifact(join(root, "artifact"), childSource, expected.snapshotId);
  const run20 = successfulRun(20, expected.sourceSha, "2026-08-26T10:07:00Z");
  const result = await runVerifier(join(root, "artifact"), {
    artifact, expectedArtifact: artifact, views: { 20: run20 }, artifactByRun: { 20: artifact },
    originBefore: childSource, originAfter: childSource, parentBySource: { [childSource]: "f".repeat(40) },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct generated/i);
});

test("the real final HTTP probe cannot restart a fresh 120-second deadline", async t => {
  const root = await mkdtemp(join(tmpdir(), "verify-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = await makeArtifact(root, expected.sourceSha, expected.snapshotId);
  const server = await startArtifactServer(root, { delayPath: "changes.xml", delayMs: 500 });
  t.after(() => server.close());
  const expectedWithTime = { ...expected, manifestSha256: artifact.manifestSha256, headSha: expected.sourceSha, createdAt: "2026-08-26T10:07:00Z" };
  const started = Date.now();
  await assert.rejects(verifyRefreshChain({
    baseUrl: server.baseUrl, expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha,
    expectedSnapshotId: expected.snapshotId, expectedManifestSha256: artifact.manifestSha256,
  }, {
    timeoutMs: 150,
    productionReceipt: async () => ({ ...expected, manifestSha256: artifact.manifestSha256 }),
    receiptForRun: async () => expectedWithTime,
    fetchOrigin: () => {},
    originMain: () => expected.sourceSha,
    isAncestor: () => true,
  }), /deadline|abort|fetch/i);
  assert.ok(Date.now() - started < 1_000, "the final probe must consume only the remaining shared budget");
});
