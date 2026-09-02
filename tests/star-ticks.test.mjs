import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveStarAnchors, runDeriveStarAnchorsCli } from "../scripts/derive-star-anchors.mjs";

const OBSERVED_AT = "2026-09-02T00:02:00.000Z";
const daysBefore = days => new Date(Date.parse(OBSERVED_AT) - days * 86_400_000).toISOString();
const seconds = value => value.replace(/\.\d{3}Z$/, "Z");

function repository(overrides = {}) {
  return {
    slug: "owner/repo", display_slug: "Owner/Repo", stars: 1200,
    gain_daily: 100, gain_weekly: 300, gain_monthly: null, created_at: daysBefore(25),
    ...overrides,
  };
}
const facts = repositories => ({ observedAtUtc: OBSERVED_AT, repositories });

test("deriveStarAnchors emits created, weekly and daily anchors in time order and skips null gains", () => {
  const result = deriveStarAnchors(facts([repository()]));
  assert.equal(result.version, 1);
  assert.equal(result.generatedAt, OBSERVED_AT);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.anchors, {
    "Owner/Repo": [
      { at: seconds(daysBefore(25)), stars: 0, source: "github_created_at" },
      { at: "2026-08-26T00:02:00Z", stars: 900, source: "github_trending_gain_weekly" },
      { at: "2026-09-01T00:02:00Z", stars: 1100, source: "github_trending_gain_daily" },
    ],
  });
});

test("deriveStarAnchors drops a weekly anchor that exceeds the daily anchor and records a warning", () => {
  const result = deriveStarAnchors(facts([repository({ stars: 5000, gain_daily: 2819, gain_weekly: 2085, created_at: daysBefore(400) })]));
  assert.deepEqual(result.anchors["Owner/Repo"].map(anchor => anchor.source), ["github_trending_gain_daily"]);
  assert.deepEqual(result.warnings, [{ slug: "Owner/Repo", code: "non_monotonic", source: "github_trending_gain_weekly" }]);
});

test("deriveStarAnchors omits the created anchor when the repository is older than 30 days", () => {
  const result = deriveStarAnchors(facts([repository({ created_at: daysBefore(40) })]));
  assert.deepEqual(result.anchors["Owner/Repo"].map(anchor => anchor.source), ["github_trending_gain_weekly", "github_trending_gain_daily"]);
  assert.deepEqual(result.warnings, []);
});

test("deriveStarAnchors drops anchors dated before creation or with negative stars", () => {
  const result = deriveStarAnchors(facts([repository({ gain_weekly: 1300, gain_monthly: 1150 })]));
  assert.deepEqual(result.anchors["Owner/Repo"].map(anchor => anchor.source), ["github_created_at", "github_trending_gain_daily"]);
  assert.deepEqual(result.warnings.map(warning => warning.code).sort(), ["before_created", "negative"]);
});

test("deriveStarAnchors rejects malformed facts instead of guessing", () => {
  assert.throws(() => deriveStarAnchors({ observedAtUtc: "not-a-date", repositories: [repository()] }), /observedAtUtc/);
  assert.throws(() => deriveStarAnchors(facts([repository({ stars: -1 })])), /stars/);
  assert.throws(() => deriveStarAnchors(facts([repository({ gain_daily: 1.5 })])), /gain/);
  assert.throws(() => deriveStarAnchors(facts([repository(), repository()])), /duplicate/);
});

test("runDeriveStarAnchorsCli writes the anchors file from frozen facts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "star-anchors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const factsPath = join(directory, "facts.json");
  const outPath = join(directory, "data", "star-anchors.json");
  await writeFile(factsPath, JSON.stringify(facts([repository()])));
  const result = await runDeriveStarAnchorsCli({ factsPath, outPath, parse: bytes => JSON.parse(bytes.toString("utf8")) });
  assert.equal(result.repositories, 1);
  const written = JSON.parse(await readFile(outPath, "utf8"));
  assert.deepEqual(Object.keys(written), ["version", "generatedAt", "anchors", "warnings"]);
  assert.equal(written.version, 1);
  assert.equal(written.anchors["Owner/Repo"].length, 3);
});
