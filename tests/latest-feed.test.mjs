import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  FIELD_TAG_IDS,
  FORM_TAG_IDS,
  TAG_RULE_VERSION,
  buildLatestFeed,
  updateLatestFeed,
  validateSnapshotExport,
  writeLatestFeed,
} from "../scripts/update-latest-feed.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function repository(overrides = {}) {
  return {
    slug: "owner/repo",
    name: "Owner / Repo",
    description: "A public repository",
    lang: "JavaScript",
    topics: ["automation", "developer-tools"],
    stars: 21,
    forks: 2,
    issues: 3,
    contributors: 4,
    gains: { daily: 5, weekly: null, monthly: null },
    signal: { streakDays: 2, starsChange: -1 },
    summary: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" },
    tag_rule_version: 1,
    field_tags: ["ai-ml", "dev-tools"],
    form_tags: ["agent", "cli"],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    version: 1,
    snapshotId: "20260826182000-d88e9972357720d2",
    generatedAt: "2026-08-26T18:20:00.000Z",
    statsDate: "2026-08-27",
    repositories: [repository()],
    ...overrides,
  };
}

test("pinned tag constants match the recorder definition order", async () => {
  assert.equal(TAG_RULE_VERSION, 1);
  assert.deepEqual(FIELD_TAG_IDS, ["ai-ml", "web-app", "dev-tools", "data", "devops", "security", "productivity", "systems", "learning"]);
  assert.deepEqual(FORM_TAG_IDS, ["agent", "mcp", "plugin-skill", "ide", "library", "framework", "cli"]);
  const recorder = await readFile(join(root, "scripts", "record_repository_observations.py"), "utf8");
  assert.match(recorder, /FIELD_TAGS = \("ai-ml", "web-app", "dev-tools", "data", "devops", "security", "productivity", "systems", "learning"\)/);
  assert.match(recorder, /FORM_TAGS = \("agent", "mcp", "plugin-skill", "ide", "library", "framework", "cli"\)/);
});

test("snapshot export becomes latest without losing existing fields or exact tags", () => {
  const exported = snapshot();
  const latest = buildLatestFeed(exported);
  assert.deepEqual(latest, {
    snapshotId: exported.snapshotId,
    generatedAt: exported.generatedAt,
    statsDate: exported.statsDate,
    count: 1,
    repos: exported.repositories,
  });
  assert.equal(latest.repos[0].description, "A public repository");
  assert.deepEqual(latest.repos[0].gains, { daily: 5, weekly: null, monthly: null });
  assert.deepEqual(latest.repos[0].signal, { streakDays: 2, starsChange: -1 });
  assert.equal(latest.repos[0].tag_rule_version, 1);
  assert.deepEqual(latest.repos[0].field_tags, ["ai-ml", "dev-tools"]);
  assert.deepEqual(latest.repos[0].form_tags, ["agent", "cli"]);
});

test("snapshot export rejects missing extra duplicate unknown unordered and drifted tags", () => {
  const invalid = [
    { ...snapshot(), repositories: [repository({ field_tags: undefined })] },
    { ...snapshot(), repositories: [{ ...repository(), extra: true }] },
    { ...snapshot(), repositories: [repository({ field_tags: ["ai-ml", "ai-ml"] })] },
    { ...snapshot(), repositories: [repository({ field_tags: ["unknown"] })] },
    { ...snapshot(), repositories: [repository({ field_tags: ["dev-tools", "ai-ml"] })] },
    { ...snapshot(), repositories: [repository({ field_tags: ["unclassified", "ai-ml"] })] },
    { ...snapshot(), repositories: [repository({ form_tags: ["cli", "agent"] })] },
    { ...snapshot(), repositories: [repository({ tag_rule_version: "1" })] },
    { ...snapshot(), repositories: [repository({ tag_rule_version: 2 })] },
    { ...snapshot(), repositories: [repository({ form_tags: ["agent", "agent"] })] },
  ];
  for (const value of invalid) assert.throws(() => validateSnapshotExport(value), /snapshot export is invalid/);
});

test("snapshot export rejects cross-run identity unsafe values and duplicate slugs content-free", () => {
  const secret = "sensitive-public-value-do-not-echo";
  const invalid = [
    snapshot({ snapshotId: "20260826182001-0123456789abcdef" }),
    snapshot({ generatedAt: "2026-08-26 18:20:00Z" }),
    snapshot({ repositories: [repository({ slug: secret })] }),
    snapshot({ repositories: [repository(), repository({ name: "duplicate" })] }),
    snapshot({ repositories: [repository({ stars: Number.MAX_SAFE_INTEGER + 1 })] }),
    snapshot({ repositories: [repository({ gains: { daily: 1, weekly: null } })] }),
  ];
  for (const value of invalid) {
    let thrown;
    try { validateSnapshotExport(value); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /snapshot export is invalid/);
    assert.doesNotMatch(thrown.message, new RegExp(secret));
  }
});

test("updateLatestFeed consumes only the supplied temp export and never a legacy star database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-export-"));
  try {
    const exportPath = join(directory, "repository-snapshot-export.json");
    const latestPath = join(directory, "latest.json");
    await writeFile(exportPath, `${JSON.stringify(snapshot())}\n`, "utf8");
    const result = await updateLatestFeed({ exportPath, latestPath });
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(await readFile(latestPath, "utf8")), buildLatestFeed(snapshot()));
    const source = await readFile(join(root, "scripts", "update-latest-feed.mjs"), "utf8");
    assert.doesNotMatch(source, /star-observations|node:sqlite|SELECT\s/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI accepts explicit candidate paths and emits no stored values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-cli-"));
  try {
    const exportPath = join(directory, "repository-snapshot-export.json");
    const latestPath = join(directory, "latest.json");
    await writeFile(exportPath, `${JSON.stringify(snapshot())}\n`, "utf8");
    const result = spawnSync(process.execPath, [
      join(root, "scripts", "update-latest-feed.mjs"),
      "--snapshot-export", exportPath,
      "--latest", latestPath,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "latest_changed=true count=1");
    assert.equal(JSON.parse(await readFile(latestPath, "utf8")).snapshotId, snapshot().snapshotId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate JSON keys fail before candidate publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-duplicate-"));
  try {
    const exportPath = join(directory, "repository-snapshot-export.json");
    const latestPath = join(directory, "latest.json");
    const text = JSON.stringify(snapshot()).replace('{"version":1', '{"version":1,"version":1');
    await writeFile(exportPath, text, "utf8");
    await assert.rejects(updateLatestFeed({ exportPath, latestPath }), /snapshot export is invalid/);
    await assert.rejects(readFile(latestPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeLatestFeed atomically writes one newline-terminated JSON document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-feed-"));
  try {
    const path = join(directory, "latest.json");
    await writeLatestFeed(path, { version: 1 });
    assert.equal(await readFile(path, "utf8"), '{\n  "version": 1\n}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeLatestFeed reports equivalent no-op and changed publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-feed-no-change-"));
  try {
    const path = join(directory, "latest.json");
    const first = buildLatestFeed(snapshot());
    assert.equal(await writeLatestFeed(path, first), true);
    assert.equal(await writeLatestFeed(path, first), false);
    const changed = { ...snapshot(), snapshotId: "20260826182001-b9c37b77b0e00ed1", generatedAt: "2026-08-26T18:20:01.000Z" };
    assert.equal(await writeLatestFeed(path, buildLatestFeed(changed)), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
