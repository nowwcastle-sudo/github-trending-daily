import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  VERSION_1_BASE_PATHS,
  buildLegacyRecoveryArtifact,
  buildPagesArtifact,
  expectedVersion1Paths,
} from "../scripts/build-pages-artifact.mjs";
import { prepareRefreshCandidate, verifyCandidateMutations } from "../scripts/prepare-refresh-candidate.mjs";
import { probeArtifactDirectory, probeProduction } from "../scripts/probe-production.mjs";
import { createRunContext } from "../scripts/run-context.mjs";
import { buildLatestFeed } from "../scripts/update-latest-feed.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceSha = "a".repeat(40);
const snapshotId = "20260826100700-0123456789abcdef";
const LEGACY_PROBE_POSITIVE_PATHS = Object.freeze([
  "data/latest.json",
  "index.html",
  "readmes/owner__both.md",
  "readmes/owner__readme-only.md",
  "translations/owner__both.json",
  "translations/owner__translation-only.json",
]);
const LEGACY_PROBE_MISSING_PATHS = Object.freeze([
  "readmes/owner__neither.md",
  "readmes/owner__translation-only.md",
  "translations/owner__neither.json",
  "translations/owner__readme-only.json",
]);

async function serveArtifact(root, { mimeOverride = {}, redirect = null, requests = null, requestHeaders = null } = {}) {
  const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    requests?.push(requestUrl);
    requestHeaders?.push(request.headers);
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (relative === redirect) { response.writeHead(302, { location: "/index.html" }); response.end(); return; }
    try {
      const bytes = await readFile(join(root, ...relative.split("/")));
      response.writeHead(200, { "content-type": mimeOverride[relative] ?? mime[extname(relative)] ?? "application/octet-stream", "content-length": bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function exactLegacyProbeToken(requests) {
  assert.ok(requests.some(url => url.pathname.endsWith("/deployment-manifest.json")));
  const tokens = requests.map(url => url.searchParams.get("probe"));
  assert.ok(tokens.every(token => /^[a-f0-9-]{36}$/.test(token ?? "")));
  assert.equal(new Set(tokens).size, 1);
  assert.deepEqual(
    requests.map(url => decodeURIComponent(url.pathname).replace(/^\/+/, "")).sort(),
    ["deployment-manifest.json", ...LEGACY_PROBE_POSITIVE_PATHS, ...LEGACY_PROBE_MISSING_PATHS].sort(),
  );
  return tokens[0];
}

function assertProbeConnectionsClose(requests, requestHeaders) {
  assert.equal(requestHeaders.length, requests.length);
  assert.ok(requestHeaders.length > 0);
  assert.ok(requestHeaders.every(headers => headers.connection === "close"));
}

async function rewriteArtifactFile(artifact, relative, bytes) {
  await writeFile(join(artifact, ...relative.split("/")), bytes);
  const manifestPath = join(artifact, "deployment-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[relative] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeTree(directory, paths) {
  for (const path of paths) {
    const target = join(directory, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, `${path}\n`);
  }
}

function sourceEntry(applicable = true) {
  return {
    blob_sha: "b".repeat(40),
    content_sha256: "c".repeat(64),
    model: "claude-haiku-4-5",
    schema_version: 2,
    translation_applicable: applicable,
  };
}

test("version-1 artifact path set is exact and derived from active applicable translations", () => {
  assert.deepEqual(VERSION_1_BASE_PATHS, [
    "changes.xml",
    "current-view-export.js",
    "data/latest.json",
    "data/membership-status.json",
    "favorite-sync.js",
    "favorites.js",
    "feed.xml",
    "firebase-client.js",
    "firebase-config.json",
    "hidden-repos.js",
    "index.html",
    "membership-history.js",
    "readme-markdown.js",
    "refresh-schedule.js",
    "repo-filters.js",
    "star-history.js",
    "star-history.json",
    "ui-motion.js",
  ]);
  const latest = { repos: [{ slug: "Owner/One" }, { slug: "owner/two" }] };
  const sources = { version: 2, sources: {
    "Owner/One": sourceEntry(true),
    "owner/two": sourceEntry(false),
    "old/stale": { ...sourceEntry(false), blob_sha: null, model: null, translation_applicable: null },
  } };
  assert.deepEqual(expectedVersion1Paths(latest, sources), [
    ...VERSION_1_BASE_PATHS,
    "translations/Owner__One.json",
  ].sort());
  assert.ok(!VERSION_1_BASE_PATHS.some(path => path.endsWith(".sqlite")));
  assert.ok(!VERSION_1_BASE_PATHS.includes("data/translation-sources.json"));
});

test("builder hashes only the exact allowlist and exact translation envelope", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pages-builder-"));
  const source = join(directory, "source");
  const out = join(directory, "out");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(source);
  await writeTree(source, VERSION_1_BASE_PATHS);
  const latest = { snapshotId, repos: [{ slug: "owner/one" }] };
  const sources = { version: 2, sources: { "owner/one": sourceEntry(true) } };
  await writeFile(join(source, "data", "latest.json"), `${JSON.stringify(latest)}\n`);
  await writeFile(join(source, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  const validPage = `<script>\nconst REPOS = [${JSON.stringify({ slug: "owner/one" })}];\n</script>\n`;
  await writeFile(join(source, "index.html"), validPage);
  await mkdir(join(source, "translations"));
  await writeFile(join(source, "translations", "owner__one.json"), `${JSON.stringify({ markdown: "# One", source: sources.sources["owner/one"] })}\n`);
  await writeFile(join(source, "data", "private.sqlite"), "private");

  const manifest = await buildPagesArtifact({ sourceRoot: source, outDir: out, sourceSha, snapshotId });
  assert.deepEqual(Object.keys(manifest.files), expectedVersion1Paths(latest, sources));
  assert.equal(manifest.files["index.html"], createHash("sha256").update(validPage).digest("hex"));
  await assert.rejects(readFile(join(out, "data", "private.sqlite")));

  await writeFile(join(source, "translations", "owner__one.json"), `${JSON.stringify({ html: "legacy", source: sources.sources["owner/one"] })}\n`);
  await assert.rejects(
    buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "bad"), sourceSha, snapshotId }),
    /translation envelope/i,
  );
  await writeFile(join(source, "data", "translation-sources.json"), `{"version":2,"version":2,"sources":{}}\n`);
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "duplicate-source"), sourceSha, snapshotId }), /duplicate key/i);
  await writeFile(join(source, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  await writeFile(join(source, "translations", "owner__one.json"), `${JSON.stringify({ markdown: "# One", source: sources.sources["owner/one"] })}\n`);
  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"owner/one","slug":"owner/one"}];\n</script>\n');
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "duplicate-page-json"), sourceSha, snapshotId }), /duplicate key/i);
  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"Owner/One"},{"slug":"owner/one"}];\n</script>\n');
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "case-fold-page"), sourceSha, snapshotId }), /duplicate|case-fold|identity/i);
});

test("candidate preparation uses current committed code and production generated state", async t => {
  const outer = await mkdtemp(join(tmpdir(), "candidate-preparer-"));
  const directory = join(outer, "checkout");
  await mkdir(directory);
  t.after(() => rm(outer, { recursive: true, force: true }));
  const run = args => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run(["init", "-q"]).status, 0);
  run(["config", "user.name", "test"]); run(["config", "user.email", "test@example.invalid"]);
  await mkdir(join(directory, "data"));
  const productionPage = ["production shell", "<!-- GENERATED:TRENDING-DATE:START -->", "production date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [];", "// GENERATED:TRENDING-REPOS:END", "production footer"].join("\n");
  await writeFile(join(directory, "code.js"), "old code\n");
  await writeFile(join(directory, "index.html"), `${productionPage}\n`);
  await writeFile(join(directory, "data", "latest.json"), "production data\n");
  run(["add", "--", "code.js", "index.html", "data/latest.json"]); run(["commit", "-qm", "production"]);
  const productionSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const productionData = run(["show", `${productionSha}:data/latest.json`]).stdout;
  await writeFile(join(directory, "code.js"), "current code\n");
  const currentPage = ["current shell", "<!-- GENERATED:TRENDING-DATE:START -->", "failed current date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [{\"slug\":\"failed/current\"}];", "// GENERATED:TRENDING-REPOS:END", "current footer"].join("\n");
  await writeFile(join(directory, "index.html"), `${currentPage}\n`);
  await writeFile(join(directory, "data", "latest.json"), "failed main-only data\n");
  run(["add", "--", "code.js", "index.html", "data/latest.json"]); run(["commit", "-qm", "current"]);
  const checkoutSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const currentCode = run(["show", `${checkoutSha}:code.js`]).stdout;
  const out = join(outer, "candidate");
  await prepareRefreshCandidate({ checkoutRoot: directory, outDir: out, lastGoodSha: productionSha });
  assert.equal(await readFile(join(out, "code.js"), "utf8"), currentCode);
  assert.equal(await readFile(join(out, "data", "latest.json"), "utf8"), productionData);
  assert.equal(await readFile(join(out, "index.html"), "utf8"), ["current shell", "<!-- GENERATED:TRENDING-DATE:START -->", "production date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [];", "// GENERATED:TRENDING-REPOS:END", "current footer", ""].join("\n"));
  assert.equal(run(["rev-parse", "HEAD"]).stdout.trim(), checkoutSha);
});

test("post-generation boundary rejects base-code mutations and sidecar residue", async t => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-mutation-boundary-"));
  const baseline = join(directory, "baseline");
  const candidate = join(directory, "candidate");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(baseline); await mkdir(candidate);
  const page = ["shell", "<!-- GENERATED:TRENDING-DATE:START -->", "date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [];", "// GENERATED:TRENDING-REPOS:END", "footer", ""].join("\n");
  for (const root of [baseline, candidate]) {
    await mkdir(join(root, "data"));
    await writeFile(join(root, "index.html"), page);
    await writeFile(join(root, "app.js"), "current code\n");
    await writeFile(join(root, "data", "latest.json"), "old generated\n");
  }
  await writeFile(join(candidate, "data", "latest.json"), "new generated\n");
  await verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate });
  const cli = spawnSync(process.execPath, [join(root, "scripts", "prepare-refresh-candidate.mjs"), "--verify-generated", baseline, "--candidate", candidate], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  await writeFile(join(candidate, "app.js"), "mutated base code\n");
  await assert.rejects(verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), /non-generated.*app\.js/i);
  await writeFile(join(candidate, "app.js"), "current code\n");
  await writeFile(join(candidate, "data", "trending-membership.sqlite-wal"), "sidecar\n");
  await assert.rejects(verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), /residue|sidecar|unexpected/i);
  await rm(join(candidate, "data", "trending-membership.sqlite-wal"));
  await link(join(candidate, "app.js"), join(candidate, "app-hardlink.js"));
  await assert.rejects(verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), /candidate hardlink rejected/i);
});

test("a version-0 recovery manifest produces the next candidate without bootstrap input", async t => {
  const outer = await mkdtemp(join(tmpdir(), "legacy-next-candidate-"));
  const checkout = join(outer, "checkout");
  const recoveryArtifact = join(outer, "recovery-artifact");
  const candidate = join(outer, "candidate");
  await mkdir(checkout);
  t.after(() => rm(outer, { recursive: true, force: true }));
  const run = args => spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
  assert.equal(run(["init", "-q"]).status, 0);
  run(["config", "user.name", "test"]); run(["config", "user.email", "test@example.invalid"]);
  await mkdir(join(checkout, "data"));
  await mkdir(join(checkout, "readmes"));
  await mkdir(join(checkout, "translations"));
  await writeFile(join(checkout, "index.html"), '<html>\n<!-- GENERATED:TRENDING-DATE:START -->\nlegacy date\n<!-- GENERATED:TRENDING-DATE:END -->\n// GENERATED:TRENDING-REPOS:START\nconst REPOS = [{"slug":"owner/both"},{"slug":"owner/readme-only"},{"slug":"owner/translation-only"},{"slug":"owner/neither"}];\n// GENERATED:TRENDING-REPOS:END\n</html>\n');
  await writeFile(join(checkout, "data", "latest.json"), "verified legacy data\n");
  await writeFile(join(checkout, "readmes", "owner__both.md"), "# Both\n");
  await writeFile(join(checkout, "readmes", "owner__readme-only.md"), "# README only\n");
  await writeFile(join(checkout, "readmes", "old__inactive.md"), "# Inactive\n");
  await writeFile(join(checkout, "translations", "owner__both.json"), '{"html":"<h1>Both</h1>"}\n');
  await writeFile(join(checkout, "translations", "owner__translation-only.json"), '{"html":"<h1>Translation only</h1>"}\n');
  await writeFile(join(checkout, "translations", "old__inactive.json"), '{"html":"<h1>Inactive</h1>"}\n');
  assert.equal(run(["add", "--", "index.html", "data/latest.json", "readmes/owner__both.md", "readmes/owner__readme-only.md", "readmes/old__inactive.md", "translations/owner__both.json", "translations/owner__translation-only.json", "translations/old__inactive.json"]).status, 0);
  assert.equal(run(["commit", "-qm", "verified legacy production"]).status, 0);
  const legacySourceSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const recovery = await buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: recoveryArtifact, sourceSha: legacySourceSha });
  assert.deepEqual({ version: recovery.version, sourceSha: recovery.sourceSha, snapshotId: recovery.snapshotId }, { version: 0, sourceSha: legacySourceSha, snapshotId: null });
  assert.deepEqual(Object.keys(recovery.files), [
    "data/latest.json",
    "index.html",
    "readmes/owner__both.md",
    "readmes/owner__readme-only.md",
    "translations/owner__both.json",
    "translations/owner__translation-only.json",
  ]);
  await probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout });
  const originalLegacyManifest = await readFile(join(recoveryArtifact, "deployment-manifest.json"));
  const inactiveReadme = await readFile(join(checkout, "readmes", "old__inactive.md"));
  const extraLegacyManifest = JSON.parse(originalLegacyManifest);
  extraLegacyManifest.files["readmes/old__inactive.md"] = createHash("sha256").update(inactiveReadme).digest("hex");
  await writeFile(join(recoveryArtifact, "readmes", "old__inactive.md"), inactiveReadme);
  await writeFile(join(recoveryArtifact, "deployment-manifest.json"), `${JSON.stringify(extraLegacyManifest, null, 2)}\n`);
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /manifest allowlist mismatch/i,
  );
  await writeFile(join(recoveryArtifact, "deployment-manifest.json"), originalLegacyManifest);
  await rm(join(recoveryArtifact, "readmes", "old__inactive.md"));
  const recoveryRequests = [];
  const recoveryRequestHeaders = [];
  const recoveryServer = await serveArtifact(recoveryArtifact, { requests: recoveryRequests, requestHeaders: recoveryRequestHeaders });
  let recoveryProbeToken;
  try {
    await probeProduction({ baseUrl: recoveryServer.baseUrl, legacyRecoverySha: legacySourceSha, gitRoot: checkout });
    recoveryProbeToken = exactLegacyProbeToken(recoveryRequests);
    assertProbeConnectionsClose(recoveryRequests, recoveryRequestHeaders);
  } finally {
    await recoveryServer.close();
  }
  const originalPresentReadme = await readFile(join(recoveryArtifact, "readmes", "owner__both.md"));
  await writeFile(join(recoveryArtifact, "readmes", "owner__both.md"), "# Altered\n");
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /legacy file mismatch/i,
  );
  await writeFile(join(recoveryArtifact, "readmes", "owner__both.md"), originalPresentReadme);
  const bootstrapRequests = [];
  const bootstrapRequestHeaders = [];
  const bootstrap = await serveArtifact(checkout, { requests: bootstrapRequests, requestHeaders: bootstrapRequestHeaders });
  try {
    await probeProduction({ baseUrl: bootstrap.baseUrl, bootstrapPreflightSha: legacySourceSha, gitRoot: checkout });
    const bootstrapProbeToken = exactLegacyProbeToken(bootstrapRequests);
    assertProbeConnectionsClose(bootstrapRequests, bootstrapRequestHeaders);
    assert.notEqual(bootstrapProbeToken, recoveryProbeToken);
    await writeFile(join(checkout, "readmes", "owner__neither.md"), "# Stale missing README\n");
    await assert.rejects(
      probeProduction({ baseUrl: bootstrap.baseUrl, bootstrapPreflightSha: legacySourceSha, gitRoot: checkout }),
      /owner__neither|status|404/i,
    );
    await rm(join(checkout, "readmes", "owner__neither.md"));
    await writeFile(join(checkout, "translations", "owner__neither.json"), '{"html":"stale"}\n');
    await assert.rejects(
      probeProduction({ baseUrl: bootstrap.baseUrl, bootstrapPreflightSha: legacySourceSha, gitRoot: checkout }),
      /owner__neither|status|404/i,
    );
  } finally {
    await rm(join(checkout, "readmes", "owner__neither.md"), { force: true });
    await rm(join(checkout, "translations", "owner__neither.json"), { force: true });
    await bootstrap.close();
  }
  await writeFile(join(recoveryArtifact, "readmes", "owner__neither.md"), "# Stale missing README\n");
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /owner__neither|status|404/i,
  );
  await rm(join(recoveryArtifact, "readmes", "owner__neither.md"));
  await writeFile(join(recoveryArtifact, "translations", "owner__neither.json"), '{"html":"stale"}\n');
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /owner__neither|status|404/i,
  );
  await rm(join(recoveryArtifact, "translations", "owner__neither.json"));

  await writeFile(join(checkout, "translations", "owner__readme-only.json"), '{"html":"present"}\n');
  await writeFile(join(checkout, "readmes", "owner__translation-only.md"), "# Present README\n");
  await writeFile(join(checkout, "readmes", "owner__neither.md"), "# Present README\n");
  await writeFile(join(checkout, "translations", "owner__neither.json"), '{"html":"present"}\n');
  assert.equal(run(["add", "--", "readmes/owner__translation-only.md", "readmes/owner__neither.md", "translations/owner__readme-only.json", "translations/owner__neither.json"]).status, 0);
  assert.equal(run(["commit", "-qm", "all active caches present"]).status, 0);
  const allPresentSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const allPresentArtifact = join(outer, "all-present-artifact");
  await buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: allPresentArtifact, sourceSha: allPresentSha });
  await probeArtifactDirectory({ artifactDir: allPresentArtifact, legacyRecoverySha: allPresentSha, gitRoot: checkout });
  const allPresentManifest = JSON.parse(await readFile(join(allPresentArtifact, "deployment-manifest.json"), "utf8"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "readmes/owner__translation-only.md"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "translations/owner__readme-only.json"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "readmes/owner__neither.md"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "translations/owner__neither.json"));
  assert.ok(!Object.hasOwn(allPresentManifest.files, "readmes/old__inactive.md"));
  assert.ok(!Object.hasOwn(allPresentManifest.files, "translations/old__inactive.json"));
  await writeFile(join(checkout, "index.html"), '<html>\nconst REPOS = [{"slug":"owner/legacy","slug":"owner/legacy"}];\n</html>\n');
  await assert.rejects(buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: join(outer, "duplicate-legacy"), sourceSha: legacySourceSha }), /duplicate key/i);
  await writeFile(join(checkout, "index.html"), '<html>\nconst REPOS = [{"slug":"Owner/Legacy"},{"slug":"owner/legacy"}];\n</html>\n');
  await assert.rejects(buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: join(outer, "case-fold-legacy"), sourceSha: legacySourceSha }), /duplicate|case-fold|identity/i);
  await writeFile(join(checkout, "index.html"), '<html>\n<!-- GENERATED:TRENDING-DATE:START -->\nlegacy date\n<!-- GENERATED:TRENDING-DATE:END -->\n// GENERATED:TRENDING-REPOS:START\nconst REPOS = [{"slug":"owner/legacy"}];\n// GENERATED:TRENDING-REPOS:END\n</html>\n');

  await mkdir(join(checkout, "scripts"));
  await writeFile(join(checkout, "scripts", "new-refresh-code.js"), "export const current = true;\n");
  await writeFile(join(checkout, "data", "latest.json"), "failed main-only data\n");
  assert.equal(run(["add", "--", "scripts/new-refresh-code.js", "data/latest.json"]).status, 0);
  assert.equal(run(["commit", "-qm", "current refresh code"]).status, 0);

  const result = await prepareRefreshCandidate({ checkoutRoot: checkout, outDir: candidate, lastGoodSha: recovery.sourceSha });
  assert.equal(result.lastGoodSha, legacySourceSha);
  assert.equal(await readFile(join(candidate, "scripts", "new-refresh-code.js"), "utf8"), "export const current = true;\n");
  assert.equal(await readFile(join(candidate, "data", "latest.json"), "utf8"), "verified legacy data\n");
  const context = createRunContext(new Date("2026-08-26T10:07:00.000Z"), { sourceSha: null, snapshotId: null });
  assert.equal(context.parentSourceSha, null);
  assert.equal(context.parentSnapshotId, null);
});

test("legacy recovery rejects noncanonical, nested, and linked README materialization", async t => {
  const outer = await mkdtemp(join(tmpdir(), "legacy-readme-materialization-"));
  const source = join(outer, "source");
  const readmes = join(source, "readmes");
  t.after(() => rm(outer, { recursive: true, force: true }));
  await mkdir(readmes, { recursive: true });
  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"owner/repo"}];\n</script>\n');

  await writeFile(join(readmes, "Owner__Repo.md"), "wrong exact case\n");
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "wrong-case"), sourceSha }),
    /exact-case/i,
  );
  await rm(join(readmes, "Owner__Repo.md"));

  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"a__/b"},{"slug":"a/__b"}];\n</script>\n');
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "encoded-collision"), sourceSha }),
    /duplicate|case-fold/i,
  );
  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"owner/repo"}];\n</script>\n');

  await writeFile(join(readmes, "README.md"), "not canonical\n");
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "noncanonical"), sourceSha }),
    /canonical/i,
  );
  await rm(join(readmes, "README.md"));

  await mkdir(join(readmes, "nested"));
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "nested"), sourceSha }),
    /regular file|nested/i,
  );
  await rm(join(readmes, "nested"), { recursive: true });

  const linked = join(outer, "linked-readmes");
  await mkdir(linked);
  await rm(readmes, { recursive: true });
  await symlink(linked, readmes, "junction");
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "linked"), sourceSha }),
    /regular directory|symlink/i,
  );
});

test("bootstrap probe rejects malformed or unsafe fake Git README trees", async t => {
  const outer = await mkdtemp(join(tmpdir(), "legacy-fake-git-"));
  const web = join(outer, "web");
  const fakeGit = join(outer, "fake-git.mjs");
  t.after(() => rm(outer, { recursive: true, force: true }));
  const previousGitBin = process.env.GIT_BIN;
  const previousGitScript = process.env.GIT_SCRIPT;
  const previousTreeCase = process.env.FAKE_TREE_CASE;
  t.after(() => {
    if (previousGitBin === undefined) delete process.env.GIT_BIN; else process.env.GIT_BIN = previousGitBin;
    if (previousGitScript === undefined) delete process.env.GIT_SCRIPT; else process.env.GIT_SCRIPT = previousGitScript;
    if (previousTreeCase === undefined) delete process.env.FAKE_TREE_CASE; else process.env.FAKE_TREE_CASE = previousTreeCase;
  });
  await mkdir(web);
  const page = '<script>\nconst REPOS = [{"slug":"owner/missing"}];\n</script>\n';
  await writeFile(join(web, "index.html"), page);
  await writeFile(fakeGit, String.raw`
const args = process.argv.slice(2);
const command = args[2];
if (command === "show") {
  const relative = args[3]?.split(":").slice(1).join(":");
  if (relative === "index.html") process.stdout.write(${JSON.stringify(page)});
  else process.exitCode = 2;
} else if (command === "ls-tree") {
  const oid = "b".repeat(40);
  const record = (mode, path) => mode + " blob " + oid + "\t" + path + "\0";
  const requested = args.includes("readmes") ? "readmes" : args.includes("translations") ? "translations" : "base";
  if (requested === "base") {
    if (process.env.FAKE_TREE_CASE === "base-error") process.exit(2);
    if (process.env.FAKE_TREE_CASE === "base-malformed") process.stdout.write("malformed");
    else process.stdout.write(Buffer.from(record("100644", "index.html"), "utf8"));
    process.exit(0);
  }
  if (process.env.FAKE_TREE_CASE === "readmes-error" && requested === "readmes") process.exit(2);
  if (process.env.FAKE_TREE_CASE === "translation-error" && requested === "translations") process.exit(2);
  const translation = process.env.FAKE_TREE_CASE?.startsWith("translation-");
  const treeCase = process.env.FAKE_TREE_CASE?.replace(/^translation-/, "");
  if ((requested === "translations") !== translation) process.exit(0);
  const directory = translation ? "translations" : "readmes";
  const extension = translation ? ".json" : ".md";
  const canonical = directory + "/owner__repo" + extension;
  const fixtures = {
    malformed: "100644 blob " + oid + "\t" + canonical,
    symlink: record("120000", canonical),
    nonblob: "040000 tree " + oid + "\t" + directory + "/owner__repo" + extension + "\0",
    nested: record("100644", directory + "/nested/owner__repo" + extension),
    noncanonical: record("100644", directory + "/README.txt"),
    wrongcase: record("100644", directory + "/Owner__Missing" + extension),
    duplicate: record("100644", canonical) + record("100644", canonical),
    casefold: record("100644", directory + "/Owner__Repo" + extension) + record("100644", canonical),
  };
  process.stdout.write(Buffer.from(fixtures[treeCase] ?? "", "utf8"));
} else {
  process.exitCode = 2;
}
`);
  process.env.GIT_BIN = process.execPath;
  process.env.GIT_SCRIPT = fakeGit;
  const server = await serveArtifact(web);
  try {
    for (const [treeCase, pattern] of [
      ["base-error", /legacy base listing unavailable/i],
      ["base-malformed", /malformed.*ls-tree/i],
      ["readmes-error", /readmes listing unavailable/i],
      ["translation-error", /translations listing unavailable/i],
      ["malformed", /malformed.*ls-tree/i],
      ["symlink", /symlink/i],
      ["nonblob", /regular file/i],
      ["nested", /canonical/i],
      ["noncanonical", /canonical/i],
      ["wrongcase", /exact-case/i],
      ["duplicate", /duplicate|case-fold/i],
      ["casefold", /duplicate|case-fold/i],
      ["translation-malformed", /malformed.*ls-tree/i],
      ["translation-symlink", /symlink/i],
      ["translation-nonblob", /regular file/i],
      ["translation-nested", /canonical/i],
      ["translation-noncanonical", /canonical/i],
      ["translation-wrongcase", /exact-case/i],
      ["translation-duplicate", /duplicate|case-fold/i],
      ["translation-casefold", /duplicate|case-fold/i],
    ]) {
      process.env.FAKE_TREE_CASE = treeCase;
      await assert.rejects(
        probeProduction({ baseUrl: server.baseUrl, bootstrapPreflightSha: sourceSha, gitRoot: outer }),
        pattern,
      );
    }
  } finally {
    await server.close();
  }
});

test("real membership then Atom CLIs share one injected candidate identity before artifact construction", async t => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-chain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = createRunContext(new Date("2026-08-26T10:07:00.000Z"));
  const repos = Array.from({ length: 10 }, (_, index) => ({
    slug: `owner/repo-${index}`, name: `owner / repo-${index}`, desc: `Description ${index}`,
    lang: "JavaScript", topics: ["testing"], stars: index, forks: index, issues: index,
    contributors: index + 1, stars_daily: index,
    summary: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" },
    _stats_date: context.statsDateKst,
  }));
  const latest = buildLatestFeed({ repos, snapshotId: context.snapshotId, statsDate: context.statsDateKst, generatedAt: context.observedAtUtc, signals: new Map() });
  const pageRepos = repos.map(repo => ({ slug: repo.slug, desc: repo.desc, _stats_date: context.statsDateKst, _snapshot_id: context.snapshotId, _generated_at: context.observedAtUtc }));
  const page = ["<html>", "// GENERATED:TRENDING-REPOS:START", `const REPOS = ${JSON.stringify(pageRepos)};`, "// GENERATED:TRENDING-REPOS:END", "</html>"].join("\n");
  await writeFile(join(directory, "index.html"), page);
  await writeFile(join(directory, "latest.json"), `${JSON.stringify(latest)}\n`);
  const environment = { ...process.env, RUN_CONTEXT_JSON: JSON.stringify(context) };
  const membership = spawnSync(process.env.PYTHON ?? "python", [join(root, "scripts", "record_trending_membership.py"), "--page", join(directory, "index.html"), "--latest", join(directory, "latest.json"), "--database", join(directory, "membership.sqlite"), "--status", join(directory, "membership.json")], { encoding: "utf8", env: environment });
  assert.equal(membership.status, 0, membership.stderr);
  const atom = spawnSync(process.env.PYTHON ?? "python", [join(root, "scripts", "generate_atom_feeds.py"), "--page", join(directory, "index.html"), "--latest", join(directory, "latest.json"), "--database", join(directory, "membership.sqlite"), "--status", join(directory, "membership.json"), "--feed", join(directory, "feed.xml"), "--changes", join(directory, "changes.xml")], { encoding: "utf8", env: environment });
  assert.equal(atom.status, 0, atom.stderr);
  const feed = await readFile(join(directory, "feed.xml"), "utf8");
  assert.equal((feed.match(/<entry>/g) ?? []).length, 10);
  assert.ok([...feed.matchAll(/<summary type="text">([^<]+)<\/summary>/g)].every(match => match[1].trim()));

  const sources = { version: 2, sources: Object.fromEntries(repos.map((repo, index) => [repo.slug, sourceEntry(index === 0)])) };
  const summaries = Object.fromEntries(repos.map(repo => [repo.slug, {
    content: { goal: "goal", usage: "usage", pros: "pros", cons: "cons", fit: "fit" },
    source: sources.sources[repo.slug],
  }]));
  await mkdir(join(directory, "data"), { recursive: true });
  await writeFile(join(directory, "data", "latest.json"), `${JSON.stringify(latest)}\n`);
  await writeFile(join(directory, "data", "membership-status.json"), await readFile(join(directory, "membership.json")));
  await writeFile(join(directory, "data", "repo-summaries.json"), `${JSON.stringify(summaries)}\n`);
  await writeFile(join(directory, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  await mkdir(join(directory, "translations"));
  for (const [index, repo] of repos.entries()) {
    await writeFile(join(directory, "translations", `owner__repo-${index}.json`), `${JSON.stringify({ markdown: index === 0 ? "# 저장소 0" : "```text\nN/A\n```", source: sources.sources[repo.slug] })}\n`);
  }
  const coverage = spawnSync(process.execPath, [join(root, "scripts", "validate-enrichment-coverage.mjs"), "--root", directory, "--json-counts"], { encoding: "utf8" });
  assert.equal(coverage.status, 0, coverage.stderr);
  assert.deepEqual(JSON.parse(coverage.stdout), { repository: 10, valid: 10, compact: 0, placeholder: 0, applicable: 1, "N/A": 9, missing: 0, stale: 0 });
  for (const relative of VERSION_1_BASE_PATHS) {
    const target = join(directory, ...relative.split("/"));
    try { await readFile(target); } catch {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, relative.endsWith(".json") ? "{}\n" : `${relative}\n`);
    }
  }
  const git = args => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  git(["config", "user.name", "test"]); git(["config", "user.email", "test@example.invalid"]);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-qm", "candidate fixture"]).status, 0);
  const committedSourceSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const artifact = join(directory, "artifact");
  await buildPagesArtifact({ sourceRoot: directory, outDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId });
  const probed = await probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory });
  assert.equal(probed.sourceSha, committedSourceSha);
  assert.equal(probed.snapshotId, context.snapshotId);
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: artifact, sourceSha: "f".repeat(40), snapshotId: context.snapshotId, gitRoot: directory }),
    /manifest identity mismatch/i,
  );

  const wrongMime = await serveArtifact(artifact, { mimeOverride: { "current-view-export.js": "text/plain; charset=utf-8" } });
  try { await assert.rejects(probeProduction({ baseUrl: wrongMime.baseUrl, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /MIME/i); } finally { await wrongMime.close(); }
  const redirected = await serveArtifact(artifact, { redirect: "index.html" });
  try { await assert.rejects(probeProduction({ baseUrl: redirected.baseUrl, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /redirect|fetch/i); } finally { await redirected.close(); }

  const originalMembership = await readFile(join(artifact, "data", "membership-status.json"));
  const staleMembership = JSON.parse(originalMembership);
  staleMembership.generatedAt = "2026-08-26T09:07:00.000Z";
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(staleMembership)}\n`));
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /membership run identity/i);
  await rewriteArtifactFile(artifact, "data/membership-status.json", originalMembership);
  const shortMembership = JSON.parse(originalMembership);
  shortMembership.current.pop();
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(shortMembership)}\n`));
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /active repository count|identity mismatch/i);
  await rewriteArtifactFile(artifact, "data/membership-status.json", originalMembership);

  const originalFeed = await readFile(join(artifact, "feed.xml"));
  const corruptFeed = Buffer.from(originalFeed.toString("utf8").replace(context.snapshotId, "20260826120700-fedcba9876543210"));
  await rewriteArtifactFile(artifact, "feed.xml", corruptFeed);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /Atom run identity/i);
  await rewriteArtifactFile(artifact, "feed.xml", originalFeed);
  const originalChanges = await readFile(join(artifact, "changes.xml"));
  const invalidChange = `<entry><id>https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml#bad</id><title>owner/repo-0 신규</title><updated>${context.observedAtUtc}</updated><link rel="alternate" type="text/html" href="https://github.com/owner/repo-0" /><category term="stayed" /><summary type="text">bad</summary></entry>`;
  await rewriteArtifactFile(artifact, "changes.xml", Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${invalidChange}</feed>`)));
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /change Atom category/i);
  await rewriteArtifactFile(artifact, "changes.xml", originalChanges);

  const exactMembership = JSON.parse(originalMembership);
  exactMembership.baseline = false;
  exactMembership.current = exactMembership.current.map((row, index) => ({ ...row, status: index === 0 ? "new" : index === 1 ? "reentered" : "stayed" }));
  const changeEntry = (slug, status) => {
    const updated = context.observedAtUtc;
    const id = `https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml#${encodeURIComponent(`${updated}|${status}|${slug.toLowerCase()}`)}`;
    return `<entry><id>${id}</id><title>${slug} ${status === "new" ? "신규" : "재진입"}</title><updated>${updated}</updated><link rel="alternate" type="text/html" href="https://github.com/${slug}" /><category term="${status}" /><summary type="text">change</summary></entry>`;
  };
  const exactEntries = [changeEntry("owner/repo-0", "new"), changeEntry("owner/repo-1", "reentered")];
  const exactChanges = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${exactEntries.join("")}</feed>`));
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(exactMembership)}\n`));
  await rewriteArtifactFile(artifact, "changes.xml", exactChanges);
  await probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory });

  const substituted = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${changeEntry("owner/repo-2", "new")}${changeEntry("owner/repo-1", "reentered")}</feed>`));
  await rewriteArtifactFile(artifact, "changes.xml", substituted);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /change.*membership|multiset|identity/i);
  const duplicated = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${exactEntries[0]}${exactEntries[0]}</feed>`));
  await rewriteArtifactFile(artifact, "changes.xml", duplicated);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /duplicate|provenance|change.*membership|multiset/i);
  const badUrl = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${exactEntries[0].replace("https://github.com/owner/repo-0", "https://github.com/owner/repo-0/extra")}${exactEntries[1]}</feed>`));
  await rewriteArtifactFile(artifact, "changes.xml", badUrl);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /change.*provenance|URL|identity/i);
  const overlap = structuredClone(exactMembership);
  overlap.exited.push({ slug: "OWNER/REPO-0", lastSeenAt: context.observedAtUtc, exitedAt: context.observedAtUtc });
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(overlap)}\n`));
  await rewriteArtifactFile(artifact, "changes.xml", exactChanges);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, gitRoot: directory }), /exited.*overlap|disjoint|duplicate/i);
  await rewriteArtifactFile(artifact, "data/membership-status.json", originalMembership);
  await rewriteArtifactFile(artifact, "changes.xml", originalChanges);
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: "20260826120700-fedcba9876543210", gitRoot: directory }),
    /manifest identity mismatch/i,
  );
});
