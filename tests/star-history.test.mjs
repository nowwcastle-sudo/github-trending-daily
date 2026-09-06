import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

await import("../star-history.js");
const StarHistory = globalThis.StarHistory;

// star-history.js holds no user-visible copy of its own any more: index.html's renderHist hands it
// the site `tr`. These tests translate through the real shipped catalogue, so a locale that loses a
// history.* value fails here as well as in tests/site-i18n.test.mjs. `ko` is the reference locale —
// its rendered output must stay byte-identical to the pre-localisation Korean strings.
const siteI18nSource = await readFile(new URL("../site-i18n.js", import.meta.url), "utf8");
function loadSiteMessages() {
  const context = { globalThis: {} };
  vm.createContext(context);
  vm.runInContext(siteI18nSource, context, { filename: "site-i18n-fixture.js" });
  return context.globalThis.SiteI18n.MESSAGES;
}
const MESSAGES = loadSiteMessages();
const trFor = locale => (key, parameters = {}) => String(MESSAGES[locale][key] ?? key)
  .replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => (Object.hasOwn(parameters, name) ? String(parameters[name]) : `{${name}}`));
const ko = trFor("ko");

const anchor =(at, stars, source = "github_trending_gain_daily") => ({ at, stars, source });
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
  assert.match(StarHistory.historyHtml("a/one", null, ko), /관측 시작 대기/);
  assert.match(StarHistory.historyHtml("a/one", { anchors: [], observed: [] }, ko), /관측 시작 대기/);
  assert.match(StarHistory.historyHtml("a/one", { anchors: [], observed: [observed("2026-09-02T14:31:02Z", 10)] }, ko), /관측 1회/);
  const html = StarHistory.historyHtml("a/one", validRepository(), ko);
  assert.match(html, /<svg/);
  assert.match(html, /<polyline[^>]*stroke-dasharray/);
  assert.match(html, /<polyline[^>]*class="hist-observed"/);
  assert.match(html, /<circle[^>]*fill="none"/);
  // P2-7: the 91-character methodology sentence was emitted under every card. It is stated once
  // now, in index.html's badge guide, and no card repeats it.
  assert.doesNotMatch(html, /이 사이트가 직접 관측한 총 스타/);
  assert.equal([...html.matchAll(/class="histnote"/g)].length, 1, "one caption, and it is the title");
  assert.match(html, /<p class="histnote" aria-hidden="true">📈 스타 히스토리<\/p>/);
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
  const html = StarHistory.historyHtml('<img src=x onerror="alert(1)">', validRepository(), ko);
  assert.doesNotMatch(html, /<img|onerror|alert/);
});

test("the explanation names the first observation time once observations exist", () => {
  const entry = {
    slug: "owner/repo",
    anchors: [{ at: "2026-08-04T00:00:00Z", stars: 100, source: "github_trending_gain_monthly" }],
    observed: [
      { at: "2026-09-03T11:58:00Z", stars: 300, source: "github_rest" },
      { at: "2026-09-03T12:28:00Z", stars: 305, source: "github_rest" },
    ],
  };
  // A card with a drawn line keeps no note at all: its numbers are in the SVG's own label.
  const html = StarHistory.historyHtml("owner/repo", entry, ko);
  assert.doesNotMatch(html, /관측 시작 2026-09-03/);
  assert.match(html, /<svg/);

  // A single observation is the unusual window the note is kept for, and there it stays announced
  // — no sparkline is drawn on that card, so the note is the only thing carrying the information.
  const single = StarHistory.historyHtml("owner/repo", { slug: "owner/repo", anchors: [], observed: [entry.observed[0]] }, ko);
  assert.match(single, /관측 1회/);
  assert.match(single, /관측 시작 2026-09-03 11:58 UTC/);
  assert.doesNotMatch(single, /aria-hidden/);
  assert.doesNotMatch(single, /이 사이트가 직접 관측한 총 스타/);

  const anchorsOnly = StarHistory.historyHtml("owner/repo", {
    slug: "owner/repo",
    anchors: [
      { at: "2026-08-04T00:00:00Z", stars: 100, source: "github_trending_gain_monthly" },
      { at: "2026-08-27T00:00:00Z", stars: 200, source: "github_trending_gain_weekly" },
    ],
    observed: [],
  }, ko);
  assert.doesNotMatch(anchorsOnly, /관측 시작 2/, "anchors alone must not claim an observation start");

  assert.equal(StarHistory.historyHtml("owner/repo", { slug: "owner/repo", anchors: [], observed: [] }, ko), '<p class="histnote">📈 관측 시작 대기</p>');
});

// RED TEAM 1, H4: before this round the module rendered Korean into every locale — 110 cards of
// Hangul with an `aria-label="스타 추이"` while document.documentElement.lang was "en" (WCAG 3.1.2).
test("the sparkline hard-codes no copy and renders every locale, with one shared UTC label", async () => {
  const source = await readFile(new URL("../star-history.js", import.meta.url), "utf8");
  const hangul = source.match(/"[^"]*[가-힣][^"]*"/g) ?? [];
  assert.deepEqual(hangul, [], `star-history.js must hold no hard-coded Korean: ${hangul.join(" | ")}`);

  const entry = {
    slug: "owner/repo",
    anchors: [{ at: "2026-08-04T00:00:00Z", stars: 100, source: "github_trending_gain_monthly" }],
    observed: [
      { at: "2026-09-03T11:58:00Z", stars: 300, source: "github_rest" },
      { at: "2026-09-03T12:28:00Z", stars: 305, source: "github_rest" },
    ],
  };
  const empty = { slug: "owner/repo", anchors: [], observed: [] };
  const single = { slug: "owner/repo", anchors: [], observed: [entry.observed[0]] };

  for (const locale of ["en", "ko", "zh-CN", "es", "ja"]) {
    const tr = trFor(locale);
    const html = StarHistory.historyHtml("owner/repo", entry, tr);
    assert.ok(html.includes(`<p class="histnote" aria-hidden="true">📈 ${tr("history.title")}</p>`), `${locale} title`);
    // The label is data now, not a category name: 300 -> 305 across one calendar day.
    assert.ok(html.includes(`aria-label="${tr("history.ariaSummary", { total: "305", gain: "+5", span: tr("history.ariaSpanDay") })}"`), `${locale} svg aria-label`);
    assert.ok(StarHistory.historyHtml("owner/repo", empty, tr).includes(tr("history.waiting")), `${locale} waiting`);
    const singleHtml = StarHistory.historyHtml("owner/repo", single, tr);
    assert.ok(singleHtml.includes(tr("history.singleObservation")), `${locale} single`);
    // The timestamp stays UTC and is labelled identically everywhere, so the module needs no Intl.
    assert.ok(singleHtml.includes(`${tr("history.observedSince")} 2026-09-03 11:58 UTC`), `${locale} observed-since`);
    if (locale !== "ko") {
      assert.doesNotMatch(html, /[가-힣]/, `${locale} must render no Korean`);
      assert.notEqual(html, StarHistory.historyHtml("owner/repo", entry, ko), `${locale} must differ from ko`);
    }
    assert.doesNotMatch(html, /history\.(title|explanation|observedSince|aria[A-Za-z]*|waiting|singleObservation)|\{(total|gain|span|days)\}/, `${locale} must resolve every key`);
  }

  // ko is the reference locale, and this is the whole of what a card with a drawn line emits.
  assert.equal(
    StarHistory.historyHtml("owner/repo", entry, ko),
    '<p class="histnote" aria-hidden="true">📈 스타 히스토리</p>'
      + StarHistory.sparkline(StarHistory.displayPoints(entry), 220, 40, ko),
  );
  assert.equal(StarHistory.historyHtml("owner/repo", empty, ko), '<p class="histnote">📈 관측 시작 대기</p>');
  assert.match(StarHistory.sparkline(StarHistory.displayPoints(entry), 220, 40, ko), /aria-label="스타 추이 — 총 스타 305, 1일간 \+5"/);
});

test("the sparkline label reports the observed window, not the distance from a back-calculated anchor", () => {
  const en = trFor("en");
  // A monthly anchor at 100 stars is a back-calculation from a Trending period total. Measuring
  // the gain from it would announce "+254k over 34 days" for a repository this site has watched
  // for three days: the total is the last drawn point, but the movement is the observed movement.
  const anchored = {
    slug: "owner/repo",
    anchors: [{ at: "2026-08-04T00:00:00Z", stars: 100, source: "github_trending_gain_monthly" }],
    observed: [
      { at: "2026-09-03T11:58:00Z", stars: 250300, source: "github_rest" },
      { at: "2026-09-06T12:28:00Z", stars: 254500, source: "github_rest" },
    ],
  };
  const label = html => html.match(/aria-label="([^"]+)"/)?.[1] ?? "";
  assert.equal(label(StarHistory.historyHtml("owner/repo", anchored, en)), "Star trend — 255k total stars, +4.2k over 3 days");
  // Same thresholds as index.html's fmt, so the figure heard matches the figure printed.
  assert.match(label(StarHistory.historyHtml("owner/repo", {
    slug: "owner/repo",
    anchors: [],
    observed: [
      { at: "2026-09-05T00:00:00Z", stars: 900, source: "github_rest" },
      { at: "2026-09-06T00:00:00Z", stars: 2400, source: "github_rest" },
    ],
  }, en)), /2\.4k total stars, \+1\.5k over 1 day/);
  // A line that only ever falls reports a signed loss rather than an unsigned number.
  assert.match(label(StarHistory.historyHtml("owner/repo", {
    slug: "owner/repo",
    anchors: [],
    observed: [
      { at: "2026-09-05T00:00:00Z", stars: 400, source: "github_rest" },
      { at: "2026-09-07T00:00:00Z", stars: 380, source: "github_rest" },
    ],
  }, en)), /380 total stars, -20 over 2 days/);
  // Only a chart with no two observations to measure falls back to the dashed series it draws.
  assert.equal(label(StarHistory.historyHtml("owner/repo", {
    slug: "owner/repo",
    anchors: [
      { at: "2026-08-04T00:00:00Z", stars: 100, source: "github_trending_gain_monthly" },
      { at: "2026-08-27T00:00:00Z", stars: 200, source: "github_trending_gain_weekly" },
    ],
    observed: [],
  }, en)), "Star trend — 200 total stars, +100 over 23 days");
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
