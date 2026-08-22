import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

await import("../favorites.js");
await import("../favorite-sync.js");
const FavoriteSync = globalThis.FavoriteSync;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeCloud(seed = {}) {
  const docs = new Map(Object.entries(seed).map(([uid, values]) => [uid, [...values]]));
  const watchers = new Map();
  const retired = new Map();
  const calls = [];
  const failures = new Map();
  const pending = new Map();
  const cloud = {
    docs,
    watchers,
    retired,
    calls,
    failNext(method, error = new Error("denied")) { failures.set(method, error); },
    deferNext(method) { const wait = deferred(); pending.set(method, wait); return wait; },
    async read(uid) {
      calls.push(["read", uid]);
      if (pending.has("read")) { const wait = pending.get("read"); pending.delete("read"); return wait.promise; }
      if (failures.has("read")) { const error = failures.get("read"); failures.delete("read"); throw error; }
      return docs.get(uid) || [];
    },
    async replace(uid, values) {
      calls.push(["replace", uid, [...values]]);
      if (pending.has("replace")) { const wait = pending.get("replace"); pending.delete("replace"); await wait.promise; }
      if (failures.has("replace")) { const error = failures.get("replace"); failures.delete("replace"); throw error; }
      docs.set(uid, [...values]);
    },
    async add(uid, slug) {
      calls.push(["add", uid, slug]);
      if (pending.has("add")) { const wait = pending.get("add"); pending.delete("add"); await wait.promise; }
      if (failures.has("add")) { const error = failures.get("add"); failures.delete("add"); throw error; }
      docs.set(uid, [...new Set([...(docs.get(uid) || []), slug])]);
    },
    async remove(uid, slug) {
      calls.push(["remove", uid, slug]);
      if (pending.has("remove")) { const wait = pending.get("remove"); pending.delete("remove"); await wait.promise; }
      if (failures.has("remove")) { const error = failures.get("remove"); failures.delete("remove"); throw error; }
      docs.set(uid, (docs.get(uid) || []).filter(value => value !== slug));
    },
    watch(uid, next, error) {
      calls.push(["watch", uid]);
      watchers.set(uid, { next, error });
      return () => {
        calls.push(["unsubscribe", uid]);
        retired.set(uid, watchers.get(uid));
        watchers.delete(uid);
      };
    },
    emit(uid, values = docs.get(uid) || []) { watchers.get(uid)?.next(values); },
    emitError(uid, error = new Error("watch denied")) { watchers.get(uid)?.error(error); },
  };
  return cloud;
}

function controllerOptions(storage, cloud, states = [], busyStates = [], messages = []) {
  return {
    storage,
    cloud,
    onState: values => states.push([...values]),
    onBusy: value => busyStates.push(value),
    onMessage: (...args) => messages.push(args),
  };
}

test("first login unions guest and cloud once, then cloud deletion stays deleted", async () => {
  const storage = memoryStorage({ "gh-favs-guest": '["a/one"]' });
  const cloud = fakeCloud({ alice: ["b/two"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await controller.setUser({ uid: "alice" });
  assert.deepEqual(cloud.docs.get("alice"), ["a/one", "b/two"]);
  assert.equal(storage.getItem("gh-favs-imported:alice"), "1");
  cloud.docs.set("alice", ["b/two"]);
  cloud.emit("alice");
  await controller.setUser(null);
  await controller.setUser({ uid: "alice" });
  assert.deepEqual(controller.favorites(), ["b/two"]);
  assert.equal(cloud.calls.filter(([method]) => method === "replace").length, 1);
});

test("failed first import does not set the imported marker", async () => {
  const storage = memoryStorage({ "gh-favs-guest": '["a/one"]' });
  const cloud = fakeCloud();
  cloud.failNext("replace");
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await assert.rejects(controller.setUser({ uid: "alice" }), /denied/);
  assert.equal(storage.getItem("gh-favs-imported:alice"), null);
});

test("first import refuses an over-limit case-sensitive union without overwriting cloud", async () => {
  const guest = ["Owner/Repo", ...Array.from({ length: 299 }, (_, index) => `guest/r${index}`)];
  const remote = ["owner/repo", ...Array.from({ length: 299 }, (_, index) => `cloud/r${index}`)];
  const storage = memoryStorage({ "gh-favs-guest": JSON.stringify(guest) });
  const cloud = fakeCloud({ alice: remote });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await assert.rejects(controller.setUser({ uid: "alice" }), /500/);
  assert.deepEqual(cloud.docs.get("alice"), remote);
  assert.equal(storage.getItem("gh-favs-imported:alice"), null);
  assert.equal(cloud.calls.some(([method]) => method === "replace"), false);
});

test("logout restores guest favorites without copying account values", async () => {
  const storage = memoryStorage({ "gh-favs-guest": '["guest/only"]', "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: ["account/only"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await controller.setUser({ uid: "alice" });
  await controller.setUser(null);
  assert.equal(controller.mode(), "guest");
  assert.deepEqual(controller.favorites(), ["guest/only"]);
  assert.equal(storage.getItem("gh-favs-guest"), '["guest/only"]');
  assert.equal(cloud.calls.filter(([method]) => ["add", "remove", "replace"].includes(method)).length, 0);
});

test("account switch unsubscribes first and ignores late callbacks from the old UID", async () => {
  const states = [];
  const storage = memoryStorage({ "gh-favs-imported:alice": "1", "gh-favs-imported:bob": "1" });
  const cloud = fakeCloud({ alice: ["alice/one"], bob: ["bob/two"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states));

  await controller.setUser({ uid: "alice" });
  const aliceCallback = cloud.watchers.get("alice");
  await controller.setUser({ uid: "bob" });
  assert.ok(cloud.calls.findIndex(([method, uid]) => method === "unsubscribe" && uid === "alice") < cloud.calls.findIndex(([method, uid]) => method === "watch" && uid === "bob"));
  aliceCallback.next(["alice/late"]);
  assert.deepEqual(controller.favorites(), ["bob/two"]);
  assert.deepEqual(states.at(-1), ["bob/two"]);
});

test("imported read failure displays only its account cache and performs no write", async () => {
  const storage = memoryStorage({
    "gh-favs-guest": '["guest/only"]',
    "gh-favs-imported:alice": "1",
    "gh-favs-cache:alice": '["cache/one","bad","cache/one"]',
  });
  const messages = [];
  const cloud = fakeCloud();
  cloud.failNext("read", new Error("offline"));
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, [], [], messages));

  await controller.setUser({ uid: "alice" });
  assert.deepEqual(controller.favorites(), ["cache/one"]);
  assert.equal(controller.mode(), "account");
  assert.equal(cloud.calls.some(([method]) => ["replace", "add", "remove"].includes(method)), false);
  assert.equal(messages.length, 1);
});

test("invalid slugs, busy toggles, and a 501st favorite are rejected before optimistic state", async () => {
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: [] });
  const wait = cloud.deferNext("read");
  const states = [];
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states));
  const login = controller.setUser({ uid: "alice" });

  await assert.rejects(controller.toggle("bad"), /invalid favorite slug/);
  await assert.rejects(controller.toggle("a/one"), /still synchronizing/);
  assert.equal(cloud.calls.some(([method]) => ["add", "remove"].includes(method)), false);
  wait.resolve([]);
  await login;

  const full = Array.from({ length: 500 }, (_, index) => `o/r${index}`);
  cloud.emit("alice", full);
  const stateBefore = states.length;
  await assert.rejects(controller.toggle("new/repo"), /500/);
  assert.deepEqual(controller.favorites(), full);
  assert.equal(states.length, stateBefore);
  assert.equal(cloud.calls.some(([method, , slug]) => method === "add" && slug === "new/repo"), false);
});

test("account toggles use exactly one add or remove and denied writes roll back", async () => {
  const states = [];
  const messages = [];
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: ["a/one"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states, [], messages));
  await controller.setUser({ uid: "alice" });

  assert.equal(await controller.toggle("b/two"), true);
  assert.equal(await controller.toggle("a/one"), false);
  assert.deepEqual(cloud.calls.filter(([method]) => method === "add"), [["add", "alice", "b/two"]]);
  assert.deepEqual(cloud.calls.filter(([method]) => method === "remove"), [["remove", "alice", "a/one"]]);

  cloud.failNext("add");
  await assert.rejects(controller.toggle("c/three"), /denied/);
  assert.deepEqual(controller.favorites(), ["b/two"]);
  assert.deepEqual(states.at(-1), ["b/two"]);
  assert.deepEqual(messages.at(-1), ["즐겨찾기를 동기화하지 못해 이전 상태로 되돌렸어요.", "error"]);
});

test("a denied write cannot roll back a newer accepted snapshot", async () => {
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: [] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));
  await controller.setUser({ uid: "alice" });
  const wait = cloud.deferNext("add");
  const toggle = controller.toggle("a/one");
  cloud.emit("alice", ["remote/newer"]);
  cloud.failNext("add");
  wait.resolve();

  await assert.rejects(toggle, /denied/);
  assert.deepEqual(controller.favorites(), ["remote/newer"]);
});

test("account changes while read, replace, or write is pending cannot publish stale state", async () => {
  const storage = memoryStorage({ "gh-favs-guest": '["guest/one"]', "gh-favs-imported:bob": "1" });
  const cloud = fakeCloud({ bob: ["bob/one"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  const readWait = cloud.deferNext("read");
  const aliceLogin = controller.setUser({ uid: "alice" });
  const bobLogin = controller.setUser({ uid: "bob" });
  readWait.resolve(["alice/one"]);
  await Promise.all([aliceLogin, bobLogin]);
  assert.deepEqual(controller.favorites(), ["bob/one"]);
  assert.equal(cloud.watchers.has("alice"), false);

  await controller.setUser(null);
  const replaceWait = cloud.deferNext("replace");
  const replaceLogin = controller.setUser({ uid: "carol" });
  await Promise.resolve();
  await controller.setUser({ uid: "bob" });
  replaceWait.resolve();
  await replaceLogin;
  assert.equal(storage.getItem("gh-favs-imported:carol"), null);
  assert.deepEqual(controller.favorites(), ["bob/one"]);

  const addWait = cloud.deferNext("add");
  const write = controller.toggle("bob/two");
  await controller.setUser(null);
  cloud.failNext("add");
  addWait.resolve();
  await assert.rejects(write, /denied/);
  assert.deepEqual(controller.favorites(), ["guest/one"]);
});

test("logout and dispose unsubscribe exactly once and reject late callbacks", async () => {
  const states = [];
  const storage = memoryStorage({ "gh-favs-guest": '["guest/one"]', "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: ["alice/one"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states));
  await controller.setUser({ uid: "alice" });
  const callback = cloud.watchers.get("alice");

  await controller.setUser(null);
  callback.next(["alice/late"]);
  assert.deepEqual(controller.favorites(), ["guest/one"]);
  controller.dispose();
  controller.dispose();
  assert.equal(cloud.calls.filter(([method, uid]) => method === "unsubscribe" && uid === "alice").length, 1);
  controller.dispose();
  await assert.rejects(controller.toggle("guest/two"), /disposed/);
});

test("dispose invalidates active account callbacks and their errors", async () => {
  const states = [];
  const messages = [];
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: ["alice/one"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states, [], messages));
  await controller.setUser({ uid: "alice" });
  const callback = cloud.watchers.get("alice");
  const stateCount = states.length;

  controller.dispose();
  callback.next(["alice/late"]);
  callback.error(new Error("late"));
  assert.equal(states.length, stateCount);
  assert.equal(messages.length, 0);
  assert.equal(cloud.calls.filter(([method, uid]) => method === "unsubscribe" && uid === "alice").length, 1);
});

test("watcher errors, duplicate callbacks, and normalized values stay scoped to the active account", async () => {
  const states = [];
  const messages = [];
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: [] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states, [], messages));
  await controller.setUser({ uid: "alice" });

  cloud.emit("alice", ["Owner/Repo", "bad", "Owner/Repo", "owner/repo"]);
  cloud.emit("alice", ["Owner/Repo", "bad", "Owner/Repo", "owner/repo"]);
  assert.deepEqual(controller.favorites(), ["Owner/Repo", "owner/repo"]);
  assert.equal(storage.getItem("gh-favs-cache:alice"), '["Owner/Repo","owner/repo"]');
  cloud.emitError("alice");
  assert.equal(messages.length, 1);

  const callback = cloud.watchers.get("alice");
  await controller.setUser(null);
  callback.error(new Error("late"));
  assert.equal(messages.length, 1);
});

test("storage read and write denial cannot leak or leave an unsaved optimistic guest state", async () => {
  const states = [];
  const deniedStorage = {
    getItem() { throw new Error("read denied"); },
    setItem() { throw new Error("write denied"); },
  };
  const controller = FavoriteSync.createController(controllerOptions(deniedStorage, fakeCloud(), states));
  assert.deepEqual(controller.favorites(), []);

  await assert.rejects(controller.toggle("guest/one"), /write denied/);
  assert.deepEqual(controller.favorites(), []);
  assert.deepEqual(states.at(-1), []);
});

test("account cache write denial does not turn a successful cloud operation into failure", async () => {
  const values = new Map([["gh-favs-imported:alice", "1"]]);
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (key.startsWith("gh-favs-cache:")) throw new Error("quota");
      values.set(key, String(value));
    },
  };
  const cloud = fakeCloud({ alice: [] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await controller.setUser({ uid: "alice" });
  assert.equal(await controller.toggle("a/one"), true);
  cloud.emit("alice", ["a/one", "b/two"]);
  assert.deepEqual(controller.favorites(), ["a/one", "b/two"]);
});

test("import marker read denial fails closed before any cloud access", async () => {
  const cloud = fakeCloud({ alice: ["cloud/one"] });
  const storage = {
    getItem(key) {
      if (key.startsWith("gh-favs-imported:")) throw new Error("marker denied");
      return null;
    },
    setItem() {},
  };
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await assert.rejects(controller.setUser({ uid: "alice" }), /marker denied/);
  assert.deepEqual(cloud.calls, []);
});

test("import marker write denial is reported after replace and never claims completion", async () => {
  const values = new Map([["gh-favs-guest", '["guest/one"]']]);
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (key.startsWith("gh-favs-imported:")) throw new Error("marker write denied");
      values.set(key, String(value));
    },
  };
  const cloud = fakeCloud({ alice: [] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await assert.rejects(controller.setUser({ uid: "alice" }), /marker write denied/);
  assert.deepEqual(cloud.docs.get("alice"), ["guest/one"]);
  assert.equal(values.has("gh-favs-imported:alice"), false);
});

test("classic browser and CommonJS execution expose the same controller factory", async () => {
  const favoritesSource = await readFile(new URL("../favorites.js", import.meta.url), "utf8");
  const source = await readFile(new URL("../favorite-sync.js", import.meta.url), "utf8");
  const browser = {};
  vm.runInNewContext(favoritesSource, browser);
  vm.runInNewContext(source, browser);
  assert.equal(typeof browser.FavoriteSync.createController, "function");

  const commonjs = { module: { exports: {} }, require: () => browser.Favorites };
  vm.runInNewContext(source, commonjs);
  assert.equal(typeof commonjs.module.exports.createController, "function");
});
