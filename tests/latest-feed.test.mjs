import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildLatestFeed,
  computeSignals,
  writeLatestFeed,
} from "../scripts/update-latest-feed.mjs";
import { createRunContext } from "../scripts/run-context.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const atomScript = join(repositoryRoot, "scripts", "generate_atom_feeds.py");
const membershipScript = join(repositoryRoot, "scripts", "record_trending_membership.py");
const python = process.env.PYTHON ?? "python";

function runPython(args) {
  return spawnSync(python, args, { cwd: repositoryRoot, encoding: "utf8" });
}

function integrationRepos() {
  return Array.from({ length: 10 }, (_, index) => ({
    slug: `owner/repo-${index}`,
    name: `owner / repo-${index}`,
    desc: `Public description ${index}`,
    lang: "JavaScript",
    topics: ["testing"],
    stars: index,
    forks: index,
    issues: index,
    contributors: index + 1,
    stars_daily: index,
    summary: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" },
    _stats_date: "2026-08-26",
  }));
}

function pageFixture(repos, identity = {}) {
  return [
    "before",
    "// GENERATED:TRENDING-REPOS:START",
    `const REPOS = ${JSON.stringify(repos.map(({ slug, desc, _stats_date }) => ({ slug, desc, _stats_date, ...identity })))};`,
    "// GENERATED:TRENDING-REPOS:END",
    "after",
  ].join("\n");
}

function initializeMembership({ page, latest, database, status }) {
  return runPython([
    membershipScript,
    "--page", page,
    "--latest", latest,
    "--database", database,
    "--status", status,
  ]);
}

function atomSummaries(path) {
  const code = [
    "import json, sys, xml.etree.ElementTree as ET",
    "root = ET.parse(sys.argv[1]).getroot()",
    "namespace = {'atom': 'http://www.w3.org/2005/Atom'}",
    "print(json.dumps([entry.findtext('atom:summary', namespaces=namespace) for entry in root.findall('atom:entry', namespace)]))",
  ].join("\n");
  const result = runPython(["-c", code, path]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("computeSignals counts a complete consecutive-day streak and the latest star delta", () => {
  const signals = computeSignals([
    { slug: "a/one", observed_date: "2026-08-24", stars_total: 10 },
    { slug: "a/one", observed_date: "2026-08-25", stars_total: 15 },
    { slug: "a/one", observed_date: "2026-08-26", stars_total: 21 },
  ]);
  assert.deepEqual(signals.get("a/one"), { streakDays: 3, starsChange: 6 });
});

test("computeSignals resets at a calendar gap and merges same-day sources by maximum", () => {
  const signals = computeSignals([
    { slug: "a/one", observed_date: "2026-08-20", stars_total: 7 },
    { slug: "a/one", observed_date: "2026-08-25", stars_total: 10 },
    { slug: "a/one", observed_date: "2026-08-26", stars_total: 11 },
    { slug: "a/one", observed_date: "2026-08-26", stars_total: 12 },
  ]);
  assert.deepEqual(signals.get("a/one"), { streakDays: 2, starsChange: 2 });
});

test("buildLatestFeed keeps the public schema and attaches current signals", () => {
  const repos = [{
    slug: "a/one", name: "a / one", desc: "d", lang: "JavaScript",
    topics: ["developer-tools", "automation"],
    stars: 21, forks: 2, issues: 3, contributors: 4, stars_daily: 5,
    summary: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" },
  }];
  const feed = buildLatestFeed({
    repos,
    snapshotId: "20260826182000-0123456789abcdef",
    statsDate: "2026-08-26",
    generatedAt: "2026-08-26T18:20:00.000Z",
    signals: new Map([["a/one", { streakDays: 2, starsChange: 6 }]]),
  });
  assert.equal(feed.count, 1);
  assert.equal(feed.snapshotId, "20260826182000-0123456789abcdef");
  assert.equal(feed.repos[0].description, "d");
  assert.equal("desc" in feed.repos[0], false);
  assert.deepEqual(feed.repos[0].gains, { daily: 5, weekly: null, monthly: null });
  assert.deepEqual(feed.repos[0].signal, { streakDays: 2, starsChange: 6 });
  assert.deepEqual(feed.repos[0].topics, ["developer-tools", "automation"]);
});

test("real latest JSON produces Atom summaries from the live producer contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-atom-contract-"));
  try {
    const repos = integrationRepos();
    const context = createRunContext(new Date("2026-08-26T10:07:00.000Z"));
    const latest = buildLatestFeed({
      repos,
      snapshotId: context.snapshotId,
      statsDate: context.statsDateKst,
      generatedAt: context.observedAtUtc,
      signals: new Map(),
    });
    const page = join(directory, "index.html");
    const latestPath = join(directory, "latest.json");
    const database = join(directory, "trending-membership.sqlite");
    const status = join(directory, "membership-status.json");
    const feed = join(directory, "feed.xml");
    const changes = join(directory, "changes.xml");
    await Promise.all([
      writeFile(page, pageFixture(repos, {
        _snapshot_id: context.snapshotId,
        _generated_at: context.observedAtUtc,
      }), "utf8"),
      writeFile(latestPath, `${JSON.stringify(latest)}\n`, "utf8"),
    ]);
    const membership = initializeMembership({
      page,
      latest: latestPath,
      database,
      status,
    });
    assert.equal(membership.status, 0, membership.stderr);
    const result = runPython([
      atomScript,
      "--page", page,
      "--latest", latestPath,
      "--database", database,
      "--status", status,
      "--feed", feed,
      "--changes", changes,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /atom_changed=true/);
    const [feedXml, changesXml] = await Promise.all([readFile(feed), readFile(changes)]);
    assert.ok(feedXml.length > 0);
    assert.ok(changesXml.length > 0);
    const summaries = atomSummaries(feed);
    assert.deepEqual(summaries, latest.repos.map(repo => repo.description));
    assert.ok(summaries.every(Boolean));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cross-run page and latest fail before membership or Atom publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-atom-cross-run-"));
  try {
    const repos = integrationRepos();
    const latestContext = createRunContext(new Date("2026-08-26T10:07:00.000Z"));
    const pageContext = createRunContext(new Date("2026-08-26T12:07:00.000Z"));
    const latest = buildLatestFeed({
      repos,
      snapshotId: latestContext.snapshotId,
      statsDate: latestContext.statsDateKst,
      generatedAt: latestContext.observedAtUtc,
      signals: new Map(),
    });
    const page = join(directory, "index.html");
    const latestPath = join(directory, "latest.json");
    const database = join(directory, "trending-membership.sqlite");
    const status = join(directory, "membership-status.json");
    const feed = join(directory, "feed.xml");
    const changes = join(directory, "changes.xml");
    await Promise.all([
      writeFile(page, pageFixture(repos, {
        _snapshot_id: pageContext.snapshotId,
        _generated_at: pageContext.observedAtUtc,
      }), "utf8"),
      writeFile(latestPath, `${JSON.stringify(latest)}\n`, "utf8"),
    ]);
    const membership = initializeMembership({
      page,
      latest: latestPath,
      database,
      status,
    });
    assert.notEqual(membership.status, 0);
    await assert.rejects(readFile(database));
    await assert.rejects(readFile(status));
    await assert.rejects(readFile(feed));
    await assert.rejects(readFile(changes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeLatestFeed atomically writes one newline-terminated JSON document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-feed-"));
  const path = join(directory, "latest.json");
  await writeLatestFeed(path, { version: 1 });
  assert.equal(await readFile(path, "utf8"), '{\n  "version": 1\n}\n');
});

test("writeLatestFeed rewrites a feed when its generatedAt changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-feed-no-change-"));
  const path = join(directory, "latest.json");
  const first = { generatedAt: "2026-08-26T18:20:00.000Z", count: 1, repos: [{ slug: "a/one" }] };
  assert.equal(await writeLatestFeed(path, first), true);
  const before = await readFile(path, "utf8");
  assert.equal(await writeLatestFeed(path, first), false);
  assert.equal(await writeLatestFeed(path, { ...first, generatedAt: "2026-08-26T18:30:00.000Z" }), true);
  assert.notEqual(await readFile(path, "utf8"), before);
});
