import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveStarAnchors, runDeriveStarAnchorsCli } from "../scripts/derive-star-anchors.mjs";
import {
  appendLedger,
  assertAppendOnly,
  collectStarTicks,
  deriveStarHistoryV2,
  parseDailyLedger,
  parseTickLedger,
  RATE_LIMIT_RESERVE,
  resolveTier,
  rollupDaily,
  selectWatchSet,
} from "../scripts/star-ticks.mjs";

await import("../star-history.js");
const StarHistory = globalThis.StarHistory;

const OBSERVED_AT = "2026-09-02T00:02:00.000Z";
const daysBefore = days => new Date(Date.parse(OBSERVED_AT) - days * 86_400_000).toISOString();
const seconds = value => value.replace(/\.\d{3}Z$/, "Z");

function repository(overrides = {}) {
  return {
    slug: "Owner/Repo", display_slug: "Owner / Repo", stars: 1200,
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
  assert.throws(() => deriveStarAnchors(facts([repository({ slug: "Owner / Repo" })])), /slug/);
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

// ---------------------------------------------------------------- star-ticks

const TODAY = "2026-09-03";
const day = (offset, stars, extra = {}) => ({ date: new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10), stars, ...extra });
const dailyText = rows => `{"version":1}\n${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
const dailyRow = (slug, point, tier = "B") => (point.unavailable ? { date: point.date, slug, unavailable: true, tier } : { date: point.date, slug, stars: point.stars, tier });

test("parseDailyLedger requires the version header and exact row shapes", () => {
  const rows = parseDailyLedger(dailyText([dailyRow("A/x", day(-8, 10), "A"), dailyRow("a/x", day(-1, 100)), dailyRow("b/y", { ...day(-1), unavailable: true })]));
  assert.deepEqual([...rows.keys()], ["a/x", "b/y"]);
  assert.equal(rows.get("a/x").length, 2);
  assert.equal(rows.get("a/x")[1].stars, 100);
  assert.equal(rows.get("b/y")[0].unavailable, true);
  assert.throws(() => parseDailyLedger(""), /header/);
  assert.throws(() => parseDailyLedger('{"version":2}\n'), /header/);
  assert.throws(() => parseDailyLedger(dailyText([{ date: "2026-09-01", slug: "a/x", stars: -1, tier: "B" }])), /row/);
  assert.throws(() => parseDailyLedger(dailyText([{ date: "2026-09-01", slug: "a/x", stars: 1, tier: "C" }])), /row/);
  assert.throws(() => parseDailyLedger(dailyText([{ date: "2026-09-02", slug: "a/x", stars: 1, tier: "B" }, { date: "2026-09-01", slug: "a/x", stars: 1, tier: "B" }])), /order/);
});

test("parseTickLedger groups repository lines under their run header", () => {
  const runs = parseTickLedger('{"at":"2026-09-02T23:35:00Z","run_id":"1"}\n{"slug":"Owner/Repo","stars":10}\n{"slug":"owner/gone","unavailable":true}\n{"at":"2026-09-03T00:05:00Z","run_id":"2"}\n{"slug":"Owner/Repo","stars":11}\n');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].ticks, [{ slug: "Owner/Repo", stars: 10 }, { slug: "owner/gone", unavailable: true }]);
  assert.equal(runs[1].at, "2026-09-03T00:05:00Z");
  assert.throws(() => parseTickLedger('{"slug":"Owner/Repo","stars":10}\n'), /header/);
  assert.throws(() => parseTickLedger('{"at":"2026-09-02T23:35:00Z","run_id":"1"}\n{"slug":"Owner/Repo","stars":1.5}\n'), /tick/);
  assert.throws(() => parseTickLedger('{"at":"2026-09-02T23:35:00Z","run_id":"1"}\n{"at":"2026-09-02T23:05:00Z","run_id":"0"}\n'), /order/);
});

test("selectWatchSet keeps published repos, fills the cap by 7-day gain, and never evicts published", () => {
  const rows = parseDailyLedger(dailyText([
    dailyRow("a/x", day(-8, 10)), dailyRow("a/x", day(-1, 100)),
    dailyRow("a/y", day(-8, 10)), dailyRow("a/y", day(-1, 12)),
    dailyRow("a/z", day(-3, 5)),
    dailyRow("p/one", day(-8, 1000), "A"), dailyRow("p/one", day(-1, 5000), "A"),
  ]));
  const picked = selectWatchSet({ published: ["p/one"], dailyRows: rows, cap: 3, today: TODAY });
  assert.deepEqual(picked.tierA, ["p/one"]);
  assert.deepEqual(picked.tierB, ["a/x", "a/y"]);
  // The published repository has the largest gain but is never a Tier B candidate.
  assert.deepEqual(selectWatchSet({ published: ["p/one"], dailyRows: rows, cap: 2, today: TODAY }).tierB, ["a/x"]);
  const tiny = selectWatchSet({ published: ["p/one", "p/two"], dailyRows: rows, cap: 2, today: TODAY });
  assert.deepEqual(tiny.tierA, ["p/one", "p/two"]);
  assert.deepEqual(tiny.tierB, []);
});

test("selectWatchSet breaks ties by most recent tier-A day then slug and drops three consecutive unavailable", () => {
  const rows = parseDailyLedger(dailyText([
    dailyRow("b/late", day(-10, 10), "A"), dailyRow("b/late", day(-2, 20)),
    dailyRow("a/early", day(-20, 10), "A"), dailyRow("a/early", day(-2, 20)),
    dailyRow("c/none", day(-2, 20)),
    dailyRow("d/dead", day(-9, 500)), dailyRow("d/dead", { ...day(-3), unavailable: true }), dailyRow("d/dead", { ...day(-2), unavailable: true }), dailyRow("d/dead", { ...day(-1), unavailable: true }),
    dailyRow("e/back", day(-9, 400)), dailyRow("e/back", { ...day(-3), unavailable: true }), dailyRow("e/back", { ...day(-2), unavailable: true }), dailyRow("e/back", day(-1, 401)),
  ]));
  const picked = selectWatchSet({ published: [], dailyRows: rows, cap: 3, today: TODAY });
  assert.deepEqual(picked.tierB, ["b/late", "a/early", "e/back"]);
  const wide = selectWatchSet({ published: [], dailyRows: rows, cap: 10, today: TODAY });
  assert.deepEqual(wide.tierB, ["b/late", "a/early", "e/back", "c/none"]);
});

test("assertAppendOnly rejects a rewritten prefix and appendLedger only adds lines", () => {
  const existing = Buffer.from('{"version":1}\n{"slug":"a/x","stars":1}\n');
  assert.throws(() => assertAppendOnly(existing, Buffer.from('{"version":1}\n{"slug":"a/x","stars":2}\n')), /append-only/);
  assert.throws(() => assertAppendOnly(existing, Buffer.from('{"version":1}\n')), /append-only/);
  const appended = appendLedger({ existingBytes: existing, lines: ['{"slug":"a/y","stars":3}'] });
  assertAppendOnly(existing, appended);
  assert.equal(appended.toString("utf8"), '{"version":1}\n{"slug":"a/x","stars":1}\n{"slug":"a/y","stars":3}\n');
  assert.throws(() => appendLedger({ existingBytes: Buffer.from('{"version":1}'), lines: ["{}"] }), /newline/);
});

test("rollupDaily returns the last successful tick of the day per repository", () => {
  const runs = parseTickLedger([
    '{"at":"2026-09-02T00:05:00Z","run_id":"1"}', '{"slug":"Owner/Repo","stars":10}', '{"slug":"b/y","stars":1}',
    '{"at":"2026-09-02T23:35:00Z","run_id":"2"}', '{"slug":"Owner/Repo","stars":12}', '{"slug":"b/y","unavailable":true}',
    '{"at":"2026-09-03T00:05:00Z","run_id":"3"}', '{"slug":"Owner/Repo","stars":13}', "",
  ].join("\n"));
  const rolled = rollupDaily(runs, "2026-09-02");
  assert.deepEqual([...rolled.entries()], [["owner/repo", { slug: "Owner/Repo", stars: 12 }], ["b/y", { slug: "b/y", stars: 1 }]]);
  assert.equal(rollupDaily(runs, "2026-09-01").size, 0);
});

test("deriveStarHistoryV2 keeps ticks for 14 days, one daily point before, and suppresses anchors on observed days", () => {
  const now = "2026-09-03T00:35:00Z";
  const tickRuns = parseTickLedger([
    '{"at":"2026-08-19T00:05:00Z","run_id":"0"}', '{"slug":"Owner/Repo","stars":90}',
    '{"at":"2026-08-21T00:05:00Z","run_id":"1"}', '{"slug":"Owner/Repo","stars":100}',
    '{"at":"2026-09-02T14:31:02Z","run_id":"2"}', '{"slug":"Owner/Repo","stars":1310}', '{"slug":"x/other","stars":5}',
    '{"at":"2026-09-03T00:05:00Z","run_id":"3"}', '{"slug":"Owner/Repo","unavailable":true}', "",
  ].join("\n"));
  const dailyRows = parseDailyLedger(dailyText([
    { date: "2026-08-01", slug: "Owner/Repo", stars: 50, tier: "B" },
    { date: "2026-08-19", slug: "Owner/Repo", stars: 90, tier: "A" },
    { date: "2026-08-25", slug: "Owner/Repo", stars: 500, tier: "A" },
    { date: "2026-09-02", slug: "Owner/Repo", stars: 1300, tier: "A" },
  ]));
  const anchors = { version: 1, generatedAt: now, anchors: { "owner/repo": [
    { at: "2026-08-04T00:02:00Z", stars: 100, source: "github_trending_gain_monthly" },
    { at: "2026-09-02T00:02:00Z", stars: 1200, source: "github_trending_gain_daily" },
  ] }, warnings: [] };
  const history = deriveStarHistoryV2({ published: ["Owner/Repo"], tickRuns, dailyRows, anchors, now });
  assert.deepEqual(Object.keys(history), ["version", "generatedAt", "repositories"]);
  assert.equal(history.version, 2);
  assert.equal(history.generatedAt, now);
  assert.deepEqual(history.repositories, [{
    slug: "Owner/Repo",
    anchors: [{ at: "2026-08-04T00:02:00Z", stars: 100, source: "github_trending_gain_monthly" }],
    observed: [
      { at: "2026-08-01T23:59:59Z", stars: 50, source: "github_rest" },
      { at: "2026-08-19T23:59:59Z", stars: 90, source: "github_rest" },
      { at: "2026-08-21T00:05:00Z", stars: 100, source: "github_rest" },
      { at: "2026-08-25T23:59:59Z", stars: 500, source: "github_rest" },
      { at: "2026-09-02T14:31:02Z", stars: 1310, source: "github_rest" },
    ],
  }]);
  const empty = deriveStarHistoryV2({ published: ["new/repo"], tickRuns, dailyRows, anchors, now });
  assert.deepEqual(empty.repositories, [{ slug: "new/repo", anchors: [], observed: [] }]);
  // Producer/consumer contract: the page renderer accepts exactly what derive emits.
  assert.equal(StarHistory.normalizeCache(JSON.parse(JSON.stringify(history))).get("Owner/Repo").observed.length, 5);
  assert.throws(() => deriveStarHistoryV2({ published: ["Owner/Repo"], tickRuns, dailyRows, anchors: { ...anchors, generatedAt: 5 }, now }), /anchors/);
});

test("resolveTier observes tier B only in the :35 slot of odd UTC hours on schedule and honours the dispatch input", () => {
  const at = value => Date.parse(value);
  assert.equal(resolveTier({ nowMs: at("2026-09-03T01:36:10Z"), event: "schedule" }), "ab");
  assert.equal(resolveTier({ nowMs: at("2026-09-03T01:20:00Z"), event: "schedule" }), "ab");
  assert.equal(resolveTier({ nowMs: at("2026-09-03T01:19:59Z"), event: "schedule" }), "a");
  assert.equal(resolveTier({ nowMs: at("2026-09-03T02:36:10Z"), event: "schedule" }), "a");
  assert.equal(resolveTier({ nowMs: at("2026-09-03T01:36:10Z"), event: "workflow_dispatch", requested: "" }), "a");
  assert.equal(resolveTier({ nowMs: at("2026-09-03T02:06:10Z"), event: "workflow_dispatch", requested: "ab" }), "ab");
  assert.throws(() => resolveTier({ nowMs: at("2026-09-03T02:06:10Z"), event: "workflow_dispatch", requested: "c" }), /tier/);
});

test("deriveStarHistoryV2 caps observed points at 2000 keeping the most recent", () => {
  const now = "2026-09-03T00:35:00Z";
  const lines = ['{"version":1}'];
  for (let index = 0; index < 2100; index += 1) {
    const date = new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
    lines.push(JSON.stringify({ date, slug: "a/x", stars: index, tier: "B" }));
  }
  const history = deriveStarHistoryV2({ published: ["a/x"], tickRuns: [], dailyRows: parseDailyLedger(`${lines.join("\n")}\n`), anchors: { version: 1, generatedAt: now, anchors: {}, warnings: [] }, now });
  assert.equal(history.repositories[0].observed.length, 2000);
  assert.equal(history.repositories[0].observed.at(-1).stars, 2099);
});

function githubStub({ remaining = 900, repos = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    if (String(url).endsWith("/rate_limit")) return { ok: true, status: 200, json: async () => ({ resources: { core: { remaining } } }) };
    const slug = String(url).replace(/^https:\/\/api\.github\.com\/repos\//, "");
    const handler = repos[slug];
    if (typeof handler === "function") return handler();
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}
const ok = (stars, fullName) => async () => ({ ok: true, status: 200, json: async () => ({ stargazers_count: stars, full_name: fullName }) });
const status = code => async () => ({ ok: false, status: code, json: async () => ({}) });

async function ticksFixture(t, { ticksByMonth = {}, daily = '{"version":1}\n' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "star-ticks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ticksDir = join(directory, "star-ticks");
  await mkdir(ticksDir, { recursive: true });
  for (const [month, text] of Object.entries(ticksByMonth)) await writeFile(join(ticksDir, `${month}.jsonl`), text);
  const dailyPath = join(directory, "star-daily.jsonl");
  await writeFile(dailyPath, daily);
  return { directory, ticksDir, dailyPath };
}

test("collect skips the run when the rate limit remaining is below the tier reserve", async t => {
  const fixture = await ticksFixture(t);
  // Tier A needs at most 75 repository calls, so its reserve is 100; Tier B adds up to 425 more, so 550.
  assert.deepEqual(RATE_LIMIT_RESERVE, { a: 100, ab: 550 });
  const stub = githubStub({ remaining: 99, repos: { "Owner/Repo": ok(1, "Owner/Repo") } });
  const result = await collectStarTicks({ tier: "a", published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "t", now: () => Date.parse("2026-09-03T00:35:00Z"), runId: "7", sleep: async () => {} });
  assert.equal(result.skipped, true);
  assert.equal(result.reserve, 100);
  assert.equal(stub.calls.length, 1);
  const tierB = githubStub({ remaining: 549, repos: { "Owner/Repo": ok(1, "Owner/Repo") } });
  const skippedB = await collectStarTicks({ tier: "ab", published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: tierB.fetchImpl, token: "t", now: () => Date.parse("2026-09-03T01:35:00Z"), runId: "7b", sleep: async () => {} });
  assert.equal(skippedB.skipped, true);
  assert.equal(skippedB.reserve, 550);
  const separate = await ticksFixture(t);
  const tierAOk = githubStub({ remaining: 549, repos: { "Owner/Repo": ok(1, "Owner/Repo") } });
  const ran = await collectStarTicks({ tier: "a", published: ["Owner/Repo"], ticksDir: separate.ticksDir, dailyPath: separate.dailyPath, fetchImpl: tierAOk.fetchImpl, token: "t", now: () => Date.parse("2026-09-03T00:35:00Z"), runId: "7c", sleep: async () => {} });
  assert.equal(ran.skipped, false);
  assert.equal(await readFile(fixture.dailyPath, "utf8"), '{"version":1}\n');
  await assert.rejects(readFile(join(fixture.ticksDir, "2026-09.jsonl")), error => error.code === "ENOENT");
});

test("collect appends tier-A ticks, records 404 as unavailable, retries 5xx twice, and rolls yesterday into the daily ledger", async t => {
  const fixture = await ticksFixture(t, { ticksByMonth: { "2026-09": '{"at":"2026-09-02T23:35:00Z","run_id":"1"}\n{"slug":"Owner/Repo","stars":10}\n{"slug":"owner/flaky","stars":3}\n' } });
  let flaky = 0;
  const stub = githubStub({ repos: { "Owner/Repo": ok(12, "Owner/Repo"), "owner/gone": status(404), "owner/flaky": async () => { flaky += 1; return status(500)(); } } });
  const sleeps = [];
  const result = await collectStarTicks({ tier: "a", published: ["Owner/Repo", "owner/gone", "owner/flaky"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "secret-token", now: () => Date.parse("2026-09-03T00:35:00Z"), runId: "8", sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(result, { skipped: false, tierA: 3, tierB: 0, observed: 1, unavailable: 1, failed: 1, dailyAppended: 2, month: "2026-09" });
  assert.equal(flaky, 3);
  assert.deepEqual(sleeps, [2000, 8000]);
  assert.ok(stub.calls.slice(1).every(call => call.headers.authorization === "Bearer secret-token"));
  assert.equal(await readFile(join(fixture.ticksDir, "2026-09.jsonl"), "utf8"), '{"at":"2026-09-02T23:35:00Z","run_id":"1"}\n{"slug":"Owner/Repo","stars":10}\n{"slug":"owner/flaky","stars":3}\n{"at":"2026-09-03T00:35:00Z","run_id":"8"}\n{"slug":"Owner/Repo","stars":12}\n{"slug":"owner/gone","unavailable":true}\n');
  assert.equal(await readFile(fixture.dailyPath, "utf8"), '{"version":1}\n{"date":"2026-09-02","slug":"Owner/Repo","stars":10,"tier":"A"}\n{"date":"2026-09-02","slug":"owner/flaky","stars":3,"tier":"A"}\n');
  const again = await collectStarTicks({ tier: "a", published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "secret-token", now: () => Date.parse("2026-09-03T01:05:00Z"), runId: "9", sleep: async () => {} });
  assert.equal(again.dailyAppended, 0);
});

test("collect observes tier B in the same run, writes daily rows immediately, and crosses the month boundary", async t => {
  const fixture = await ticksFixture(t, {
    ticksByMonth: { "2026-09": '{"at":"2026-09-30T23:35:00Z","run_id":"1"}\n{"slug":"Owner/Repo","stars":10}\n' },
    daily: dailyText([{ date: "2026-09-20", slug: "old/one", stars: 5, tier: "B" }, { date: "2026-09-29", slug: "old/one", stars: 50, tier: "B" }, { date: "2026-09-20", slug: "old/two", stars: 5, tier: "B" }, { date: "2026-09-29", slug: "old/two", stars: 7, tier: "B" }, { date: "2026-09-29", slug: "old/gone", stars: 1, tier: "B" }]),
  });
  const stub = githubStub({ repos: { "Owner/Repo": ok(11, "Owner/Repo"), "old/one": ok(60, "old/one"), "old/two": ok(8, "old/two"), "old/gone": status(451) } });
  const result = await collectStarTicks({ tier: "ab", cap: 3, published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "t", now: () => Date.parse("2026-10-01T01:35:00Z"), runId: "10", sleep: async () => {} });
  assert.equal(result.tierB, 2);
  assert.equal(result.month, "2026-10");
  assert.equal(await readFile(join(fixture.ticksDir, "2026-10.jsonl"), "utf8"), '{"at":"2026-10-01T01:35:00Z","run_id":"10"}\n{"slug":"Owner/Repo","stars":11}\n');
  const daily = (await readFile(fixture.dailyPath, "utf8")).split("\n").filter(Boolean).slice(-3);
  assert.deepEqual(daily, [
    '{"date":"2026-09-30","slug":"Owner/Repo","stars":10,"tier":"A"}',
    '{"date":"2026-10-01","slug":"old/one","stars":60,"tier":"B"}',
    '{"date":"2026-10-01","slug":"old/two","stars":8,"tier":"B"}',
  ]);
  assert.ok(!stub.calls.some(call => call.url.endsWith("/repos/old/gone")));
});

test("collect records a renamed or replaced repository as unavailable and refuses a run older than the ledger", async t => {
  const fixture = await ticksFixture(t, { ticksByMonth: { "2026-09": '{"at":"2026-09-03T00:35:00Z","run_id":"1"}\n{"slug":"Owner/Repo","stars":10}\n' } });
  const stub = githubStub({ repos: { "Owner/Repo": ok(12, "NewOwner/Repo") } });
  const result = await collectStarTicks({ tier: "a", published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "t", now: () => Date.parse("2026-09-03T01:05:00Z"), runId: "12", sleep: async () => {} });
  assert.equal(result.unavailable, 1);
  assert.match(await readFile(join(fixture.ticksDir, "2026-09.jsonl"), "utf8"), /\{"slug":"Owner\/Repo","unavailable":true\}\n$/);
  await assert.rejects(collectStarTicks({ tier: "a", published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "t", now: () => Date.parse("2026-09-03T00:35:00Z"), runId: "13", sleep: async () => {} }), /later run/);
});

test("a second tier-B run on the same day observes nothing new", async t => {
  const fixture = await ticksFixture(t, { daily: dailyText([{ date: "2026-09-01", slug: "old/one", stars: 5, tier: "B" }, { date: "2026-09-03", slug: "old/one", stars: 9, tier: "B" }]) });
  const stub = githubStub({ repos: { "Owner/Repo": ok(1, "Owner/Repo"), "old/one": ok(10, "old/one") } });
  const result = await collectStarTicks({ tier: "ab", published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "t", now: () => Date.parse("2026-09-03T03:35:00Z"), runId: "14", sleep: async () => {} });
  assert.equal(result.tierB, 1);
  assert.equal(result.dailyAppended, 0);
  assert.ok(!stub.calls.some(call => call.url.endsWith("/repos/old/one")));
});

test("collect refuses to touch a ledger whose existing bytes changed underneath it", async t => {
  const fixture = await ticksFixture(t, { daily: '{"version":1}' });
  const stub = githubStub({ repos: { "Owner/Repo": ok(1, "Owner/Repo") } });
  await assert.rejects(collectStarTicks({ tier: "a", published: ["Owner/Repo"], ticksDir: fixture.ticksDir, dailyPath: fixture.dailyPath, fetchImpl: stub.fetchImpl, token: "t", now: () => Date.parse("2026-09-03T00:35:00Z"), runId: "11", sleep: async () => {} }), /newline/);
});
