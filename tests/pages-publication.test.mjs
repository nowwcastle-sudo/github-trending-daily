import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  VERSION_1_BASE_PATHS,
  buildLegacyRecoveryArtifact,
  buildPagesArtifact,
  expectedVersion1Paths,
} from "../scripts/build-pages-artifact.mjs";
import { prepareRefreshCandidate } from "../scripts/prepare-refresh-candidate.mjs";
import { probeArtifactDirectory } from "../scripts/probe-production.mjs";
import { createRunContext } from "../scripts/run-context.mjs";
import { buildLatestFeed } from "../scripts/update-latest-feed.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceSha = "a".repeat(40);
const snapshotId = "20260826100700-0123456789abcdef";

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
  await mkdir(join(source, "translations"));
  await writeFile(join(source, "translations", "owner__one.json"), `${JSON.stringify({ markdown: "# One", source: sources.sources["owner/one"] })}\n`);
  await writeFile(join(source, "data", "private.sqlite"), "private");

  const manifest = await buildPagesArtifact({ sourceRoot: source, outDir: out, sourceSha, snapshotId });
  assert.deepEqual(Object.keys(manifest.files), expectedVersion1Paths(latest, sources));
  assert.equal(manifest.files["index.html"], createHash("sha256").update("index.html\n").digest("hex"));
  await assert.rejects(readFile(join(out, "data", "private.sqlite")));

  await writeFile(join(source, "translations", "owner__one.json"), `${JSON.stringify({ html: "legacy", source: sources.sources["owner/one"] })}\n`);
  await assert.rejects(
    buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "bad"), sourceSha, snapshotId }),
    /translation envelope/i,
  );
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
  await writeFile(join(directory, "code.js"), "old code\n");
  await writeFile(join(directory, "data", "latest.json"), "production data\n");
  run(["add", "--", "code.js", "data/latest.json"]); run(["commit", "-qm", "production"]);
  const productionSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const productionData = run(["show", `${productionSha}:data/latest.json`]).stdout;
  await writeFile(join(directory, "code.js"), "current code\n");
  await writeFile(join(directory, "data", "latest.json"), "failed main-only data\n");
  run(["add", "--", "code.js", "data/latest.json"]); run(["commit", "-qm", "current"]);
  const checkoutSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const currentCode = run(["show", `${checkoutSha}:code.js`]).stdout;
  const out = join(outer, "candidate");
  await prepareRefreshCandidate({ checkoutRoot: directory, outDir: out, lastGoodSha: productionSha });
  assert.equal(await readFile(join(out, "code.js"), "utf8"), currentCode);
  assert.equal(await readFile(join(out, "data", "latest.json"), "utf8"), productionData);
  assert.equal(run(["rev-parse", "HEAD"]).stdout.trim(), checkoutSha);
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
  await writeFile(join(checkout, "index.html"), '<html>\nconst REPOS = [{"slug":"owner/legacy"}];\n</html>\n');
  await writeFile(join(checkout, "data", "latest.json"), "verified legacy data\n");
  await writeFile(join(checkout, "readmes", "owner__legacy.md"), "# Legacy\n");
  assert.equal(run(["add", "--", "index.html", "data/latest.json", "readmes/owner__legacy.md"]).status, 0);
  assert.equal(run(["commit", "-qm", "verified legacy production"]).status, 0);
  const legacySourceSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const recovery = await buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: recoveryArtifact, sourceSha: legacySourceSha });
  assert.deepEqual({ version: recovery.version, sourceSha: recovery.sourceSha, snapshotId: recovery.snapshotId }, { version: 0, sourceSha: legacySourceSha, snapshotId: null });

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

  const sources = { version: 2, sources: { "owner/repo-0": sourceEntry(true) } };
  await mkdir(join(directory, "data"), { recursive: true });
  await writeFile(join(directory, "data", "latest.json"), `${JSON.stringify(latest)}\n`);
  await writeFile(join(directory, "data", "membership-status.json"), await readFile(join(directory, "membership.json")));
  await writeFile(join(directory, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  await mkdir(join(directory, "translations"));
  await writeFile(join(directory, "translations", "owner__repo-0.json"), `${JSON.stringify({ markdown: "# 저장소 0", source: sources.sources["owner/repo-0"] })}\n`);
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
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: "20260826120700-fedcba9876543210", gitRoot: directory }),
    /manifest identity mismatch/i,
  );
});
