import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLatestFeed,
  computeSignals,
  writeLatestFeed,
} from "../scripts/update-latest-feed.mjs";

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
    stars: 21, forks: 2, issues: 3, contributors: 4, stars_daily: 5,
    summary: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" },
  }];
  const feed = buildLatestFeed({
    repos,
    statsDate: "2026-08-26",
    generatedAt: "2026-08-26T18:20:00.000Z",
    signals: new Map([["a/one", { streakDays: 2, starsChange: 6 }]]),
  });
  assert.equal(feed.count, 1);
  assert.deepEqual(feed.repos[0].gains, { daily: 5, weekly: null, monthly: null });
  assert.deepEqual(feed.repos[0].signal, { streakDays: 2, starsChange: 6 });
});

test("writeLatestFeed atomically writes one newline-terminated JSON document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-feed-"));
  const path = join(directory, "latest.json");
  await writeLatestFeed(path, { version: 1 });
  assert.equal(await readFile(path, "utf8"), '{\n  "version": 1\n}\n');
});

test("writeLatestFeed does not rewrite a feed when only generatedAt changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latest-feed-no-change-"));
  const path = join(directory, "latest.json");
  const first = { generatedAt: "2026-08-26T18:20:00.000Z", count: 1, repos: [{ slug: "a/one" }] };
  assert.equal(await writeLatestFeed(path, first), true);
  const before = await readFile(path, "utf8");
  assert.equal(await writeLatestFeed(path, { ...first, generatedAt: "2026-08-26T18:30:00.000Z" }), false);
  assert.equal(await readFile(path, "utf8"), before);
});
