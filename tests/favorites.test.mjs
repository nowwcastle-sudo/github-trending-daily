import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

await import("../favorites.js");
const Favorites = globalThis.Favorites;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

test("normalizeFavs keeps unique valid slugs and caps the list at 500", () => {
  const input = ["a/one", "bad", "a/one", ...Array.from({ length: 600 }, (_, index) => `o/r${index}`)];
  const result = Favorites.normalizeFavs(input);

  assert.equal(result[0], "a/one");
  assert.equal(new Set(result).size, result.length);
  assert.equal(result.length, 500);
});

test("slug validation rejects unsafe and oversized storage values", () => {
  assert.equal(Favorites.isValidSlug("owner/repository"), true);
  assert.equal(Favorites.isValidSlug("a.b-c_d/r.e-p_o"), true);
  assert.equal(Favorites.isValidSlug("owner/<img>"), false);
  assert.equal(Favorites.isValidSlug("owner/repo/extra"), false);
  assert.equal(Favorites.isValidSlug(`${"a".repeat(200)}/r`), false);
  assert.deepEqual(Favorites.normalizeFavs(null), []);
});

test("readFavs treats corrupt, non-array, and unavailable storage as empty", () => {
  assert.deepEqual(Favorites.readFavs(memoryStorage({ favs: "{" }), "favs"), []);
  assert.deepEqual(Favorites.readFavs(memoryStorage({ favs: '{"a":"b"}' }), "favs"), []);
  assert.deepEqual(Favorites.readFavs({ getItem() { throw new Error("denied"); } }, "favs"), []);
});

test("writeFavs stores only normalized values", () => {
  const storage = memoryStorage();

  assert.deepEqual(Favorites.writeFavs(storage, "favs", ["a/one", "bad", "a/one"]), ["a/one"]);
  assert.equal(storage.getItem("favs"), '["a/one"]');
});

test("migrateLegacyFavs copies valid values once without overwriting guest changes", () => {
  const storage = memoryStorage({ "gh-favs": '["a/one","bad"]' });

  assert.deepEqual(Favorites.migrateLegacyFavs(storage), ["a/one"]);
  storage.setItem("gh-favs-guest", '["b/two"]');
  storage.setItem("gh-favs", '["c/three"]');
  assert.deepEqual(Favorites.migrateLegacyFavs(storage), ["b/two"]);
});

test("migrateLegacyFavs returns an unsaved empty guest state when the existence probe is denied", () => {
  let writes = 0;
  const denied = new Error("storage denied");
  denied.name = "SecurityError";
  const storage = {
    getItem() { throw denied; },
    setItem() { writes += 1; },
  };

  assert.deepEqual(Favorites.migrateLegacyFavs(storage), []);
  assert.equal(writes, 0);
});

test("migrateLegacyFavs does not hide a failed guest write", () => {
  const storage = {
    getItem(key) { return key === "gh-favs-guest" ? null : '["a/one"]'; },
    setItem() { throw new Error("quota exceeded"); },
  };

  assert.throws(() => Favorites.migrateLegacyFavs(storage), /quota exceeded/);
});

test("parseFavs remains bound to the legacy key", () => {
  const storage = memoryStorage({
    "gh-favs": '["a/one","bad","a/one"]',
    "gh-favs-guest": '["b/two"]',
  });

  assert.deepEqual(Favorites.parseFavs(storage), ["a/one"]);
  assert.equal(Favorites.isFav(storage, "a/one"), true);
  assert.equal(Favorites.isFav(storage, "b/two"), false);
});

test("toggleFav adds and removes valid legacy favorites", () => {
  const storage = memoryStorage({ "gh-favs": '["a/one"]' });

  assert.equal(Favorites.toggleFav(storage, "b/two"), true);
  assert.deepEqual(Favorites.parseFavs(storage), ["a/one", "b/two"]);
  assert.equal(Favorites.toggleFav(storage, "a/one"), false);
  assert.deepEqual(Favorites.parseFavs(storage), ["b/two"]);
  assert.equal(Favorites.toggleFav(storage, "<img>/bad"), false);
  assert.deepEqual(Favorites.parseFavs(storage), ["b/two"]);
});

test("toggleFav cannot exceed the local favorite limit", () => {
  const full = Array.from({ length: 500 }, (_, index) => `o/r${index}`);
  const storage = memoryStorage({ "gh-favs": JSON.stringify(full) });

  assert.equal(Favorites.toggleFav(storage, "new/repo"), false);
  assert.deepEqual(Favorites.parseFavs(storage), full);
});

test("filterRepos applies favorite membership only when requested", () => {
  const repos = [{ slug: "a/one" }, { slug: "b/two" }];

  assert.equal(Favorites.filterRepos(repos, new Set(["b/two"]), false), repos);
  assert.deepEqual(Favorites.filterRepos(repos, new Set(["b/two"]), true), [{ slug: "b/two" }]);
});

test("favorites filter button has no period while a period button does", () => {
  assert.equal(Favorites.periodFromButton(null), null);
  assert.equal(Favorites.periodFromButton({ dataset: {} }), null);
  assert.equal(Favorites.periodFromButton({ dataset: { period: "weekly" } }), "weekly");
});

test("classic browser and CommonJS execution retain legacy globals", async () => {
  const source = await readFile(new URL("../favorites.js", import.meta.url), "utf8");
  const browser = {};
  vm.runInNewContext(source, browser);
  assert.equal(browser.Favorites.parseFavs, browser.parseFavs);
  assert.equal(browser.Favorites.toggleFav, browser.toggleFav);

  const commonjs = { module: { exports: {} } };
  vm.runInNewContext(source, commonjs);
  assert.deepEqual(
    Object.keys(commonjs.module.exports).sort(),
    ["filterRepos", "isFav", "isValidSlug", "migrateLegacyFavs", "normalizeFavs", "parseFavs", "periodFromButton", "readFavs", "toggleFav", "writeFavs"],
  );
});
