import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

await import("../star-history.js");
const StarHistory = globalThis.StarHistory;

const anchor = (at, stars, source = "github_trending_gain_daily") => ({ at, stars, source });
const observed = (at, stars) => ({ at, stars, source: "github_rest" });
const validRepository = () => ({
  slug: "a/one",
  anchors: [anchor("2026-08-04T00:02:00Z", 100, "github_trending_gain_monthly"), anchor("2026-08-27T00:02:00Z", 900, "github_trending_gain_weekly")],
  observed: [observed("2026-09-02T14:31:02Z", 1310), observed("2026-09-02T15:01:02Z", 1320)],
});
const validCache = () => ({ version: 2, generatedAt: "2026-09-03T00:35:12Z", repositories: [validRepository()] });

test("normalizeCache accepts the v2 schema and returns a slug-keyed map", () => {
  const map = StarHistory.normalizeCache(validCache());
  assert.deepEqual([...map.keys()], ["a/one"]);
  assert.deepEqual(map.get("a/one"), validRepository());
});

test("normalizeCache rejects the retired v1 schema", () => {
  assert.throws(() => StarHistory.normalizeCache({
    version: 1,
    generatedAt: "2026-08-22",
    repositories: [{ slug: "a/one", estimated: [], observed: [{ date: "2026-08-22", stars: 10 }] }],
  }), /version|schema/);
  // A v2-shaped payload that still declares version 1 is rejected on the version alone.
  assert.throws(() => StarHistory.normalizeCache({ ...validCache(), version: 1 }), /version|schema/);
});

test("normalizeCache requires exact keys, second-precision UTC times, and known sources", () => {
  const cases = [];
  const missingGeneratedAt = validCache(); delete missingGeneratedAt.generatedAt; cases.push(missingGeneratedAt);
  cases.push({ ...validCache(), generatedAt: "2026-09-03T00:35:12.000Z" });
  cases.push({ ...validCache(), extra: true });
  const missingRepositoryKey = validCache(); delete missingRepositoryKey.repositories[0].anchors; cases.push(missingRepositoryKey);
  const extraRepositoryKey = validCache(); extraRepositoryKey.repositories[0].estimated = []; cases.push(extraRepositoryKey);
  const missingPointKey = validCache(); delete missingPointKey.repositories[0].observed[0].source; cases.push(missingPointKey);
  const badObservedSource = validCache(); badObservedSource.repositories[0].observed[0].source = "github_trending_gain_daily"; cases.push(badObservedSource);
  const badAnchorSource = validCache(); badAnchorSource.repositories[0].anchors[0].source = "guess"; cases.push(badAnchorSource);
  const badTime = validCache(); badTime.repositories[0].observed[0].at = "2026-02-30T00:00:00Z"; cases.push(badTime);
  const negative = validCache(); negative.repositories[0].observed[0].stars = -1; cases.push(negative);
  const badSlug = validCache(); badSlug.repositories[0].slug = "bad"; cases.push(badSlug);
  const duplicate = validCache(); duplicate.repositories.push({ ...validRepository(), slug: "A/ONE" }); cases.push(duplicate);
  for (const value of cases) assert.throws(() => StarHistory.normalizeCache(value), /schema/);
});

test("normalizeCache rejects unsorted or duplicate times and point-count overflow", () => {
  const unsorted = validCache(); unsorted.repositories[0].observed.reverse();
  const duplicateTime = validCache(); duplicateTime.repositories[0].observed[1].at = duplicateTime.repositories[0].observed[0].at;
  const anchorOverflow = validCache(); anchorOverflow.repositories[0].anchors = Array.from({ length: 5 }, (_, index) => anchor(`2026-08-0${index + 1}T00:00:00Z`, index));
  const observedOverflow = validCache(); observedOverflow.repositories[0].observed = Array.from({ length: 2001 }, (_, index) => observed(new Date(Date.UTC(2020, 0, 1) + index * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"), index));
  for (const value of [unsorted, duplicateTime, anchorOverflow, observedOverflow]) assert.throws(() => StarHistory.normalizeCache(value), /schema/);
});

test("displayPoints merges anchors and observations sorted by time and tags their kind", () => {
  assert.deepEqual(StarHistory.displayPoints({
    anchors: [anchor("2026-09-01T00:02:00Z", 1200)],
    observed: [observed("2026-09-02T14:31:02Z", 1310), observed("2026-08-30T00:00:00Z", 1000)],
  }), [
    { at: "2026-08-30T00:00:00Z", stars: 1000, kind: "observed" },
    { at: "2026-09-01T00:02:00Z", stars: 1200, kind: "anchor" },
    { at: "2026-09-02T14:31:02Z", stars: 1310, kind: "observed" },
  ]);
  assert.deepEqual(StarHistory.displayPoints(null), []);
});

test("historyHtml distinguishes waiting, one observation, and a trend with dashed anchors", () => {
  assert.match(StarHistory.historyHtml("a/one", null), /관측 시작 대기/);
  assert.match(StarHistory.historyHtml("a/one", { anchors: [], observed: [] }), /관측 시작 대기/);
  assert.match(StarHistory.historyHtml("a/one", { anchors: [], observed: [observed("2026-09-02T14:31:02Z", 10)] }), /관측 1회/);
  const html = StarHistory.historyHtml("a/one", validRepository());
  assert.match(html, /<svg/);
  assert.match(html, /<polyline[^>]*stroke-dasharray/);
  assert.match(html, /<polyline[^>]*class="hist-observed"/);
  assert.match(html, /<circle[^>]*fill="none"/);
  assert.match(html, /이 사이트가 직접 관측한 총 스타\(30분 간격\) · 점선은 GitHub Trending 기간 집계로 역산한 앵커/);
  assert.doesNotMatch(html, /GH Archive|추정|매일 GitHub에서 직접 관측/);
});

test("sparkline scales by time, breaks observed lines at gaps, and draws anchors dashed", () => {
  const points = StarHistory.displayPoints({
    anchors: [anchor("2026-08-01T00:00:00Z", 10)],
    observed: [observed("2026-08-10T00:00:00Z", 20), observed("2026-08-10T12:00:00Z", 22), observed("2026-09-01T00:00:00Z", 40), observed("2026-09-01T12:00:00Z", 44)],
  });
  const svg = StarHistory.sparkline(points);
  assert.equal((svg.match(/<polyline[^>]*class="hist-observed"/g) ?? []).length, 2);
  assert.equal((svg.match(/<polyline[^>]*class="hist-anchor"/g) ?? []).length, 1);
  assert.equal((svg.match(/<circle[^>]*class="hist-anchor-dot"/g) ?? []).length, 1);
  const xs = [...svg.matchAll(/points="([^"]+)"/g)].flatMap(match => match[1].split(" ").map(pair => Number(pair.split(",")[0])));
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 220);
  // 2026-08-10 is 9 of the 31.5 spanned days: x scales by time, not by point index.
  assert.match(svg, /class="hist-anchor" points="0,[\d.]+ 62\.9,/);
  assert.equal(StarHistory.sparkline([points[0]]), "");
});

test("historyHtml uses fixed copy and never interpolates the slug", () => {
  const html = StarHistory.historyHtml('<img src=x onerror="alert(1)">', validRepository());
  assert.doesNotMatch(html, /<img|onerror|alert/);
});

test("load fetches once and returns a normalized map", async () => {
  let requests = 0;
  const map = await StarHistory.load("star-history.json", async url => {
    requests += 1;
    assert.equal(url, "star-history.json");
    return { ok: true, json: async () => validCache() };
  });
  assert.equal(requests, 1);
  assert.equal(map.get("a/one").observed[0].stars, 1310);
});

test("load reports concise HTTP and schema errors without response data", async () => {
  await assert.rejects(
    StarHistory.load("star-history.json", async () => ({ ok: false, status: 503 })),
    /^Error: star history HTTP 503$/,
  );
  await assert.rejects(
    StarHistory.load("star-history.json", async () => ({ ok: true, json: async () => ({ version: 1 }) })),
    /^Error: star history schema:/,
  );
});

test("classic CommonJS execution receives module.exports", async () => {
  const source = await readFile(new URL("../star-history.js", import.meta.url), "utf8");
  const context = { module: { exports: {} } };
  vm.runInNewContext(source, context);

  assert.deepEqual(
    Object.keys(context.module.exports).sort(),
    ["displayPoints", "historyHtml", "load", "normalizeCache", "sparkline"],
  );
});

test("the tracked star-history.json is an empty v2 payload until the first tick run", async () => {
  const value = JSON.parse(await readFile(new URL("../star-history.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(value), ["version", "generatedAt", "repositories"]);
  assert.equal(value.version, 2);
  assert.doesNotThrow(() => StarHistory.normalizeCache(value));
});
