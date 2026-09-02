import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

await import("../star-history.js");
const StarHistory = globalThis.StarHistory;

const validRepository = () => ({
  slug: "a/one",
  estimated: [{ date: "2026-08-01", stars: 8 }],
  observed: [{ date: "2026-08-22", stars: 10 }],
});
const validCache = () => ({
  version: 1,
  generatedAt: "2026-08-22",
  repositories: [validRepository()],
});

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

  assert.match(html, /매일 GitHub에서 직접 관측한 총 스타 추이/);
  assert.doesNotMatch(html, /GH Archive|추정/);
  assert.doesNotMatch(html, /<img|onerror|alert/);
});

test("normalizeCache rejects unsupported versions and malformed repository entries", () => {
  assert.throws(() => StarHistory.normalizeCache({
    version: 2,
    generatedAt: "2026-08-22",
    repositories: [],
  }), /version|schema/);
  assert.throws(() => StarHistory.normalizeCache({
    version: 1,
    generatedAt: "2026-08-22",
    repositories: [{ slug: "bad", estimated: [], observed: [] }],
  }), /slug|schema/);
  assert.throws(() => StarHistory.normalizeCache({
    version: 1,
    generatedAt: "2026-08-22",
    repositories: [
      { slug: "a/one", estimated: [], observed: [] },
      { slug: "A/ONE", estimated: [], observed: [] },
    ],
  }), /duplicate|schema/);
  assert.throws(() => StarHistory.normalizeCache({
    version: 1,
    generatedAt: "2026-08-22",
    repositories: [{
      slug: "a/one",
      estimated: [{ date: "2026-02-30", stars: 1 }],
      observed: [],
    }],
  }), /date|schema/);
});

test("normalizeCache requires exact top-level keys and a real generated date", () => {
  const missingGeneratedAt = validCache();
  delete missingGeneratedAt.generatedAt;

  assert.throws(() => StarHistory.normalizeCache(missingGeneratedAt), /schema/);
  assert.throws(() => StarHistory.normalizeCache({ ...validCache(), generatedAt: "2026-02-30" }), /schema/);
  assert.throws(() => StarHistory.normalizeCache({ ...validCache(), extra: true }), /schema/);
});

test("normalizeCache requires exact repository and point keys", () => {
  const missingRepositoryKey = validCache();
  delete missingRepositoryKey.repositories[0].observed;
  const extraRepositoryKey = validCache();
  extraRepositoryKey.repositories[0].extra = true;
  const missingPointKey = validCache();
  delete missingPointKey.repositories[0].estimated[0].stars;
  const extraPointKey = validCache();
  extraPointKey.repositories[0].estimated[0].extra = true;

  for (const value of [missingRepositoryKey, extraRepositoryKey, missingPointKey, extraPointKey]) {
    assert.throws(() => StarHistory.normalizeCache(value), /schema/);
  }
});

test("normalizeCache rejects duplicate and unsorted point dates", () => {
  const duplicate = validCache();
  duplicate.repositories[0].estimated.push({ date: "2026-08-01", stars: 9 });
  const unsorted = validCache();
  unsorted.repositories[0].estimated.unshift({ date: "2026-08-02", stars: 9 });

  assert.throws(() => StarHistory.normalizeCache(duplicate), /schema/);
  assert.throws(() => StarHistory.normalizeCache(unsorted), /schema/);
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
        generatedAt: "2026-08-22",
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
