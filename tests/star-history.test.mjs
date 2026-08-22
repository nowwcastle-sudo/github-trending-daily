import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

await import("../star-history.js");
const StarHistory = globalThis.StarHistory;

test("displayPoints combines estimates with exact observations by date", () => {
  assert.deepEqual(StarHistory.displayPoints({
    estimated: [
      { date: "2026-08-22", stars: 90 },
      { date: "2026-08-01", stars: 80 },
    ],
    observed: [{ date: "2026-08-22", stars: 100 }],
  }), [
    { date: "2026-08-01", stars: 80 },
    { date: "2026-08-22", stars: 100 },
  ]);
});

test("historyHtml distinguishes one point, a trend, and missing data", () => {
  assert.match(StarHistory.historyHtml("a/one", {
    estimated: [],
    observed: [{ date: "2026-08-22", stars: 10 }],
  }), /관측 데이터 1일/);
  assert.match(StarHistory.historyHtml("a/one", {
    estimated: [{ date: "2026-08-01", stars: 8 }],
    observed: [{ date: "2026-08-22", stars: 10 }],
  }), /<svg/);
  assert.match(StarHistory.historyHtml("a/one", null), /스타 추이 데이터가 없어요/);
});

test("historyHtml uses fixed copy and never interpolates the slug", () => {
  const html = StarHistory.historyHtml('<img src=x onerror="alert(1)">', {
    estimated: [{ date: "2026-08-01", stars: 8 }],
    observed: [{ date: "2026-08-22", stars: 10 }],
  });

  assert.match(html, /GH Archive 기반 과거 추정 · 현재 총 스타는 GitHub 기준/);
  assert.doesNotMatch(html, /<img|onerror|alert/);
});

test("normalizeCache rejects unsupported versions and malformed repository entries", () => {
  assert.throws(() => StarHistory.normalizeCache({ version: 2, repositories: [] }), /version/);
  assert.throws(() => StarHistory.normalizeCache({
    version: 1,
    repositories: [{ slug: "bad", estimated: [], observed: [] }],
  }), /slug/);
  assert.throws(() => StarHistory.normalizeCache({
    version: 1,
    repositories: [
      { slug: "a/one", estimated: [], observed: [] },
      { slug: "A/ONE", estimated: [], observed: [] },
    ],
  }), /duplicate/);
  assert.throws(() => StarHistory.normalizeCache({
    version: 1,
    repositories: [{
      slug: "a/one",
      estimated: [{ date: "2026-02-30", stars: 1 }],
      observed: [],
    }],
  }), /date/);
});

test("load fetches once and returns a normalized map", async () => {
  let requests = 0;
  const map = await StarHistory.load("star-history.json", async url => {
    requests += 1;
    assert.equal(url, "star-history.json");
    return {
      ok: true,
      json: async () => ({
        version: 1,
        repositories: [{
          slug: "a/one",
          estimated: [],
          observed: [{ date: "2026-08-22", stars: 10 }],
        }],
      }),
    };
  });

  assert.equal(requests, 1);
  assert.equal(map.get("a/one").observed[0].stars, 10);
});

test("load reports concise HTTP and schema errors without response data", async () => {
  await assert.rejects(
    StarHistory.load("star-history.json", async () => ({ ok: false, status: 503 })),
    /^Error: star history HTTP 503$/,
  );
  await assert.rejects(
    StarHistory.load("star-history.json", async () => ({ ok: true, json: async () => ({ version: 2 }) })),
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
