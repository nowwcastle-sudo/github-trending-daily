import assert from "node:assert/strict";
import test from "node:test";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

async function loadHiddenRepos() {
  await import("../favorites.js");
  await import("../hidden-repos.js");
  return globalThis.HiddenRepos;
}

test("hiding a repository persists across a browser reload", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const storage = memoryStorage();

  assert.deepEqual(HiddenRepos.hide(storage, "owner/project"), ["owner/project"]);
  assert.deepEqual(HiddenRepos.read(storage), ["owner/project"]);
});

test("a hidden repository can be restored without changing other hidden entries", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const storage = memoryStorage();
  HiddenRepos.hide(storage, "owner/one");
  HiddenRepos.hide(storage, "owner/two");

  assert.deepEqual(HiddenRepos.restore(storage, "owner/one"), ["owner/two"]);
  assert.deepEqual(HiddenRepos.read(storage), ["owner/two"]);
});

test("all hidden repositories can be restored in one action", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const storage = memoryStorage({ "gh-hidden-repos-v1": '["owner/one","owner/two"]' });

  assert.deepEqual(HiddenRepos.restoreAll(storage), []);
  assert.deepEqual(HiddenRepos.read(storage), []);
});

test("hiding a 501st repository fails without replacing an existing entry", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const full = Array.from({ length: 500 }, (_, index) => `owner/repo-${index}`);
  const storage = memoryStorage({ "gh-hidden-repos-v1": JSON.stringify(full) });

  assert.throws(() => HiddenRepos.hide(storage, "owner/overflow"), /cannot exceed 500/);
  assert.deepEqual(HiddenRepos.read(storage), full);
});

test("hidden membership wins over favorites without deleting favorite state", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const repos = [{ slug: "owner/one" }, { slug: "owner/two" }];
  const favorites = globalThis.Favorites.filterRepos(repos, new Set(["owner/one", "owner/two"]), true);

  assert.deepEqual(HiddenRepos.filterRepos(favorites, new Set(["owner/one"])), [{ slug: "owner/two" }]);
  assert.deepEqual(favorites, repos);
});

test("invalid, duplicate, corrupt, and denied storage values fail closed", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const storage = memoryStorage({ "gh-hidden-repos-v1": '["owner/one","bad","owner/one"]' });

  assert.deepEqual(HiddenRepos.read(storage), ["owner/one"]);
  assert.deepEqual(HiddenRepos.hide(storage, "owner/one"), ["owner/one"]);
  assert.throws(() => HiddenRepos.hide(storage, "owner/<script>"), /invalid hidden repository slug/);
  assert.deepEqual(HiddenRepos.read(memoryStorage({ "gh-hidden-repos-v1": "{" })), []);
  assert.deepEqual(HiddenRepos.read({ getItem() { throw new Error("denied"); } }), []);
});

test("a denied write never reports an unpersisted hidden state", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const storage = {
    getItem() { return "[]"; },
    setItem() { throw new Error("quota exceeded"); },
  };

  assert.throws(() => HiddenRepos.hide(storage, "owner/project"), /quota exceeded/);
  assert.deepEqual(HiddenRepos.read(storage), []);
});

test("favorite account switches leave browser-local hidden repositories untouched", async () => {
  const HiddenRepos = await loadHiddenRepos();
  const { createController } = await import("../favorite-sync.js").then(() => globalThis.FavoriteSync);
  const storage = memoryStorage();
  HiddenRepos.hide(storage, "owner/private-choice");
  const cloud = {
    importUnion: async () => [],
    read: async () => [],
    watch: () => () => {},
    add: async () => {},
    remove: async () => {},
  };
  const controller = createController({ storage, cloud });

  await controller.setUser({ uid: "account-a" });
  await controller.setUser({ uid: "account-b" });
  await controller.setUser(null);

  assert.deepEqual(HiddenRepos.read(storage), ["owner/private-choice"]);
});
