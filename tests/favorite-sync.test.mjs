import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

await import("../favorites.js");
await import("../favorite-sync.js");
await import("../auth-lifecycle.js");
const FavoriteSync = globalThis.FavoriteSync;
const AuthLifecycle = globalThis.AuthLifecycle;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function recordingStorage(initial = {}) {
  const storage = memoryStorage(initial);
  const writes = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    writes.push([key, String(value)]);
    setItem(key, value);
  };
  return { storage, writes };
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
    async importUnion(uid, guestFavorites) {
      calls.push(["importUnion", uid, [...guestFavorites]]);
      if (pending.has("importUnion")) { const wait = pending.get("importUnion"); pending.delete("importUnion"); await wait.promise; }
      if (failures.has("importUnion")) { const error = failures.get("importUnion"); failures.delete("importUnion"); throw error; }
      const merged = [...new Set([...guestFavorites, ...(docs.get(uid) || [])])];
      if (merged.length > 500) throw new Error("favorites cannot exceed 500");
      docs.set(uid, merged);
      return [...merged];
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
  assert.equal(cloud.calls.filter(([method]) => method === "importUnion").length, 1);
  assert.equal(cloud.calls.some(([method]) => method === "read"), true);
});

test("failed first import does not set the imported marker", async () => {
  const storage = memoryStorage({ "gh-favs-guest": '["a/one"]' });
  const cloud = fakeCloud();
  cloud.failNext("importUnion");
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
  assert.equal(cloud.calls.filter(([method]) => method === "importUnion").length, 1);
});

test("501 raw unique guest favorites reject before any cloud import or marker write", async () => {
  const guest = Array.from({ length: 501 }, (_, index) => `guest/r${index}`);
  const storage = memoryStorage({ "gh-favs-guest": JSON.stringify(guest) });
  const cloud = fakeCloud({ alice: ["cloud/one"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await assert.rejects(controller.setUser({ uid: "alice" }), /500/);
  assert.deepEqual(cloud.calls, []);
  assert.deepEqual(cloud.docs.get("alice"), ["cloud/one"]);
  assert.equal(storage.getItem("gh-favs-imported:alice"), null);
});

test("atomic first import preserves a concurrent remote add and removal", async () => {
  const storage = memoryStorage({ "gh-favs-guest": '["guest/one"]' });
  const cloud = fakeCloud({ alice: ["remote/keep", "remote/remove"] });
  const wait = cloud.deferNext("importUnion");
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));
  const login = controller.setUser({ uid: "alice" });
  await Promise.resolve();

  cloud.docs.set("alice", ["remote/keep", "remote/add"]);
  wait.resolve();
  await login;
  assert.deepEqual(controller.favorites(), ["guest/one", "remote/keep", "remote/add"]);
  assert.deepEqual(cloud.docs.get("alice"), ["guest/one", "remote/keep", "remote/add"]);
  assert.equal(cloud.calls.some(([method]) => method === "read"), false);
  assert.equal(cloud.calls.some(([method]) => method === "replace"), false);
  assert.equal(storage.getItem("gh-favs-imported:alice"), "1");
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
  assert.equal(cloud.calls.filter(([method]) => ["add", "remove", "importUnion"].includes(method)).length, 0);
});

test("a restored Alice session replaces the guest list with only Alice's cloud list", async () => {
  const { storage, writes } = recordingStorage({
    "gh-favs-guest": '["guest/only"]',
    "gh-favs-imported:alice": "1",
  });
  const states = [];
  const cloud = fakeCloud({ alice: ["alice/only"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states));

  assert.equal(controller.mode(), "guest");
  assert.deepEqual(controller.favorites(), ["guest/only"]);
  await controller.setUser({ uid: "alice" });

  assert.equal(controller.mode(), "account");
  assert.deepEqual(controller.favorites(), ["alice/only"]);
  assert.deepEqual(states.at(-1), ["alice/only"]);
  assert.deepEqual(cloud.calls, [["read", "alice"], ["watch", "alice"]]);
  assert.deepEqual(writes, [["gh-favs-cache:alice", '["alice/only"]']]);
  assert.equal(storage.getItem("gh-favs-guest"), '["guest/only"]');
});

test("a pending Alice restore cannot replace Bob after Bob's auth callback wins", async () => {
  const { storage, writes } = recordingStorage({
    "gh-favs-guest": '["guest/only"]',
    "gh-favs-imported:alice": "1",
    "gh-favs-imported:bob": "1",
  });
  const states = [];
  const cloud = fakeCloud({ bob: ["bob/only"] });
  const lateAliceRead = cloud.deferNext("read");
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states));

  const alice = controller.setUser({ uid: "alice" });
  await Promise.resolve();
  await controller.setUser({ uid: "bob" });
  lateAliceRead.resolve(["alice/late"]);
  await alice;

  assert.equal(controller.mode(), "account");
  assert.deepEqual(controller.favorites(), ["bob/only"]);
  assert.deepEqual(states.at(-1), ["bob/only"]);
  assert.equal(cloud.watchers.has("alice"), false);
  assert.equal(cloud.watchers.has("bob"), true);
  assert.deepEqual(writes, [["gh-favs-cache:bob", '["bob/only"]']]);
  assert.equal(storage.getItem("gh-favs-guest"), '["guest/only"]');
});

test("a cross-tab signout restores only the preserved guest list", async () => {
  const { storage, writes } = recordingStorage({
    "gh-favs-guest": '["guest/only"]',
    "gh-favs-imported:alice": "1",
  });
  const cloud = fakeCloud({ alice: ["alice/only"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await controller.setUser({ uid: "alice" });
  await controller.setUser(null);

  assert.equal(controller.mode(), "guest");
  assert.deepEqual(controller.favorites(), ["guest/only"]);
  assert.deepEqual(cloud.calls, [["read", "alice"], ["watch", "alice"], ["unsubscribe", "alice"]]);
  assert.deepEqual(writes, [["gh-favs-cache:alice", '["alice/only"]']]);
  assert.equal(storage.getItem("gh-favs-guest"), '["guest/only"]');
});

test("an Alice listener error retains account mode and the last Alice cache", async () => {
  const { storage, writes } = recordingStorage({ "gh-favs-imported:alice": "1" });
  const messages = [];
  const cloud = fakeCloud({ alice: ["alice/initial"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, [], [], messages));

  await controller.setUser({ uid: "alice" });
  cloud.emit("alice", ["alice/cached"]);
  cloud.emitError("alice");

  assert.equal(controller.mode(), "account");
  assert.deepEqual(controller.favorites(), ["alice/cached"]);
  assert.equal(storage.getItem("gh-favs-cache:alice"), '["alice/cached"]');
  assert.equal(storage.getItem("gh-favs-guest"), null);
  assert.deepEqual(messages, [["즐겨찾기 실시간 동기화가 중단되었어요.", "error"]]);
  assert.deepEqual(writes, [
    ["gh-favs-cache:alice", '["alice/initial"]'],
    ["gh-favs-cache:alice", '["alice/cached"]'],
  ]);
});

test("logout then reload leaves account favorites outside the guest storage key", async () => {
  const { storage, writes } = recordingStorage({
    "gh-favs-guest": '["guest/only"]',
    "gh-favs-imported:alice": "1",
  });
  const cloud = fakeCloud({ alice: ["alice/only"] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));

  await controller.setUser({ uid: "alice" });
  await controller.setUser(null);
  const reloaded = FavoriteSync.createController(controllerOptions(storage, fakeCloud()));

  assert.equal(reloaded.mode(), "guest");
  assert.deepEqual(reloaded.favorites(), ["guest/only"]);
  assert.equal(storage.getItem("gh-favs-guest"), '["guest/only"]');
  assert.deepEqual(writes, [["gh-favs-cache:alice", '["alice/only"]']]);
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
  assert.equal(cloud.calls.some(([method]) => ["importUnion", "add", "remove"].includes(method)), false);
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

test("serialized account toggles keep a later successful slug when the first distinct slug fails", async () => {
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: [] });
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud));
  await controller.setUser({ uid: "alice" });
  const wait = cloud.deferNext("add");
  cloud.failNext("add");

  const failed = assert.rejects(controller.toggle("failed/one"), /denied/);
  const succeeded = controller.toggle("saved/two");
  await Promise.resolve();
  assert.deepEqual(cloud.calls.filter(([method]) => method === "add"), [["add", "alice", "failed/one"]]);
  wait.resolve();
  await failed;
  assert.equal(await succeeded, true);
  assert.deepEqual(controller.favorites(), ["saved/two"]);
  assert.deepEqual(cloud.docs.get("alice"), ["saved/two"]);
  assert.equal(storage.getItem("gh-favs-cache:alice"), '["saved/two"]');
});

test("account changes while read, atomic import, or write is pending cannot publish stale state", async () => {
  const storage = memoryStorage({ "gh-favs-guest": '["guest/one"]', "gh-favs-imported:alice": "1", "gh-favs-imported:bob": "1" });
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
  const importWait = cloud.deferNext("importUnion");
  const importLogin = controller.setUser({ uid: "carol" });
  await Promise.resolve();
  await controller.setUser({ uid: "bob" });
  importWait.resolve();
  await importLogin;
  assert.equal(storage.getItem("gh-favs-imported:carol"), null);
  assert.deepEqual(controller.favorites(), ["bob/one"]);

  const addWait = cloud.deferNext("add");
  const write = controller.toggle("bob/two");
  await Promise.resolve();
  await controller.setUser(null);
  cloud.failNext("add");
  addWait.resolve();
  await assert.rejects(write, /denied/);
  assert.deepEqual(controller.favorites(), ["guest/one"]);
});

test("overlapping same-UID logins accept only the newest generation", async () => {
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: ["alice/new"] });
  const wait = cloud.deferNext("read");
  const states = [];
  const controller = FavoriteSync.createController(controllerOptions(storage, cloud, states));
  const oldLogin = controller.setUser({ uid: "alice" });
  const newLogin = controller.setUser({ uid: "alice" });
  await newLogin;
  wait.resolve(["alice/old"]);
  await oldLogin;

  assert.deepEqual(controller.favorites(), ["alice/new"]);
  assert.deepEqual(states.at(-1), ["alice/new"]);
  assert.equal(cloud.calls.filter(([method]) => method === "watch").length, 1);
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

test("throwing callbacks cannot strand busy state or misclassify valid snapshots", async () => {
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: ["alice/one"] });
  const messages = [];
  const controller = FavoriteSync.createController({
    storage,
    cloud,
    onBusy() { throw new Error("busy callback"); },
    onState() { throw new Error("state callback"); },
    onMessage: (...args) => messages.push(args),
  });

  await controller.setUser({ uid: "alice" });
  assert.equal(await controller.toggle("alice/two"), true);
  cloud.emit("alice", ["alice/one", "alice/two", "alice/three"]);
  assert.deepEqual(controller.favorites(), ["alice/one", "alice/two", "alice/three"]);
  assert.deepEqual(messages, []);
});

test("throwing message callbacks do not escape watcher errors or block later snapshots", async () => {
  const storage = memoryStorage({ "gh-favs-imported:alice": "1" });
  const cloud = fakeCloud({ alice: [] });
  const controller = FavoriteSync.createController({
    storage,
    cloud,
    onState() {},
    onBusy() {},
    onMessage() { throw new Error("message callback"); },
  });
  await controller.setUser({ uid: "alice" });

  assert.doesNotThrow(() => cloud.emitError("alice"));
  assert.doesNotThrow(() => cloud.emit("alice", ["alice/after"]));
  assert.deepEqual(controller.favorites(), ["alice/after"]);
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

test("import marker write denial is reported after atomic import and never claims completion", async () => {
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

async function loadFirebaseClientForTest() {
  const source = await readFile(new URL("../firebase-client.js", import.meta.url), "utf8");
  const runnable = source
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"https:\/\/www\.gstatic\.com\/firebasejs\/12\.17\.1\/[^\"]+";\s*/g, "")
    .replace(/import\.meta\.url/g, '""')
    .replace(/\nbootstrap\(\)(?:\.catch\(keepGuestMode\))?;\s*$/m, "")
    + "\nglobalThis.__client = { createCloudAdapter, authErrorMessage, validateFirebaseConfig, setSyncStatus, syncModeLabel: typeof syncModeLabel === 'function' ? syncModeLabel : undefined };";
  const context = {
    Favorites: globalThis.Favorites,
    FavoriteSync,
    globalThis: null,
  };
  context.globalThis = context;
  vm.runInNewContext(runnable, context);
  return { source, ...context.__client };
}

function makeButton({ hidden = false, failAdd } = {}) {
  const listeners = new Map();
  let addCalls = 0;
  let removeCalls = 0;
  return {
    disabled: false,
    hidden,
    textContent: "Google로 로그인",
    addEventListener(type, listener) {
      addCalls += 1;
      if (failAdd) throw failAdd;
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      removeCalls += 1;
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    listenerCount: () => listeners.size,
    get addCalls() { return addCalls; },
    get removeCalls() { return removeCalls; },
  };
}

function deferredBootstrapRuntime(options = {}) {
  const persistence = options.persistence || options.persistences?.[0] || deferred();
  const persistences = [...(options.persistences || [persistence])];
  const statusAttributes = new Map();
  const statusMutations = [];
  const elements = {
    syncStatus: {
      textContent: "",
      title: "",
      dataset: {},
      setAttribute(name, value) {
        statusAttributes.set(name, String(value));
        statusMutations.push([name, String(value)]);
      },
      getAttribute(name) { return statusAttributes.get(name) ?? null; },
    },
    loginBtn: makeButton(),
    logoutBtn: makeButton({ hidden: true, failAdd: options.failLogoutAdd }),
  };
  let observerCalls = 0;
  let controllerCreations = 0;
  let unsubscribeCalls = 0;
  let snapshotUnsubscribes = 0;
  const calls = [];
  const controllers = [];
  const observers = [];
  const snapshots = [];
  const applied = [];
  const windowListeners = new Map();
  const guest = {
    disposeCalls: 0,
    dispose() { this.disposeCalls += 1; },
    favorites: () => ["guest/one"],
  };
  const auth = { currentUser: null, name: "auth-1" };
  const auths = options.auths || [auth];
  const browserLocalPersistence = {};
  const storage = options.storage || memoryStorage();
  let authIndex = 0;
  const context = {
    Favorites: globalThis.Favorites,
    FavoriteSync: {
      createController(controllerOptions) {
        controllerCreations += 1;
        if (options.controllerError) throw options.controllerError;
        const controller = options.realController ? globalThis.FavoriteSync.createController(controllerOptions) : {
          id: `controller-${controllerCreations}`,
          disposeCalls: 0,
          dispose() { this.disposeCalls += 1; },
          favorites: () => [`controller-${controllerCreations}/favorite`],
          setUser: async () => {},
        };
        controllers.push(controller);
        return controller;
      },
    },
    favoriteController: guest,
    applyFavoriteState(state) { applied.push(state); },
    fetch: async () => ({ ok: true, json: async () => ({
      projectId: "github-trending-nowwcastle",
      authDomain: "github-trending-nowwcastle.firebaseapp.com",
      appCheckSiteKey: "public-site-key",
    }) }),
    URL: class {},
    document: { getElementById: id => elements[id] },
    localStorage: storage,
    initializeApp: config => ({ config }),
    initializeAppCheck: options.appCheck || (() => ({})),
    ReCaptchaEnterpriseProvider: class {},
    getAuth: () => {
      const current = auths[Math.min(authIndex, auths.length - 1)];
      authIndex += 1;
      calls.push({ type: "getAuth", auth: current });
      return current;
    },
    getFirestore: () => {
      calls.push({ type: "getFirestore" });
      if (options.firestoreError) throw options.firestoreError;
      return {};
    },
    GoogleAuthProvider: class {},
    setPersistence: (receivedAuth, persistenceType) => {
      calls.push({ type: "setPersistence", auth: receivedAuth, persistenceType });
      return persistences.shift().promise;
    },
    browserLocalPersistence,
    onAuthStateChanged: (receivedAuth, callback) => {
      observerCalls += 1;
      observers.push({ auth: receivedAuth, callback });
      return () => { unsubscribeCalls += 1; };
    },
    signInWithPopup: async () => {},
    signOut: async () => {},
    arrayRemove: value => value,
    arrayUnion: value => value,
    doc: () => ({}),
    getDoc: options.getDoc || (async () => ({ exists: () => false })),
    onSnapshot: (_reference, _snapshotOptions, next, error) => {
      snapshots.push({ next, error });
      return () => { snapshotUnsubscribes += 1; };
    },
    runTransaction: async (_db, update) => update({ get: async () => ({ exists: () => false }), set() {} }),
    serverTimestamp: () => ({}),
    setDoc: async () => {},
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
    globalThis: null,
  };
  if (Object.hasOwn(options, "authLifecycle")) context.AuthLifecycle = options.authLifecycle;
  else context.AuthLifecycle = AuthLifecycle;
  context.globalThis = context;
  return {
    context,
    elements,
    guest,
    persistence,
    get observerCalls() { return observerCalls; },
    get controllerCreations() { return controllerCreations; },
    get unsubscribeCalls() { return unsubscribeCalls; },
    get snapshotUnsubscribes() { return snapshotUnsubscribes; },
    get calls() { return calls; },
    get controllers() { return controllers; },
    get observers() { return observers; },
    get snapshots() { return snapshots; },
    get applied() { return applied; },
    get statusMutations() { return statusMutations; },
    storage,
    browserLocalPersistence,
    triggerPagehide(event) { for (const listener of windowListeners.get("pagehide") || []) listener(event); },
    triggerPageshow(event) { for (const listener of windowListeners.get("pageshow") || []) listener(event); },
  };
}

async function runFirebaseBootstrap(options = {}) {
  const source = await readFile(new URL("../firebase-client.js", import.meta.url), "utf8");
  const runtime = deferredBootstrapRuntime(options);
  const runnable = source
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"https:\/\/www\.gstatic\.com\/firebasejs\/12\.17\.1\/[^\"]+";\s*/g, "")
    .replace(/import\.meta\.url/g, '""')
    .replace(/\nbootstrap\(\);\s*$/m, "\nglobalThis.__bootstrap = bootstrap;");
  vm.runInNewContext(runnable, runtime.context);
  runtime.start = () => runtime.context.__bootstrap();
  runtime.start();
  await flushBootstrap();
  return runtime;
}

async function flushBootstrap() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

test("local persistence resolves before observer and popup wiring", async () => {
  const { source } = await loadFirebaseClientForTest();
  const persistence = source.indexOf("await setPersistence(auth, browserLocalPersistence)");
  const authMatch = source.match(/auth\s*=\s*getAuth\(app\);/);
  const firestore = source.indexOf("db = getFirestore(app)");
  assert.ok(authMatch, "production getAuth assignment must exist");
  const auth = source.indexOf(authMatch[0]);
  assert.ok(auth >= 0);
  assert.ok(firestore >= 0);
  assert.ok(firestore < auth);
  assert.ok(persistence >= 0);
  assert.ok(persistence > auth);
  assert.ok(persistence < source.indexOf("onAuthStateChanged(auth"));
  assert.ok(persistence < source.indexOf('login.addEventListener("click"'));

  const runtime = await runFirebaseBootstrap();
  assert.deepEqual(runtime.calls.map(call => call.type), ["getFirestore", "getAuth", "setPersistence"]);
  assert.equal(runtime.calls[2].auth, runtime.calls[1].auth);
  assert.equal(runtime.calls[2].persistenceType, runtime.browserLocalPersistence);
  assert.equal(runtime.observerCalls, 0);
  assert.equal(runtime.controllerCreations, 0);
  assert.equal(runtime.guest.disposeCalls, 0);
  assert.equal(runtime.elements.loginBtn.disabled, true);
  assert.equal(runtime.elements.loginBtn.listenerCount(), 0);

  runtime.persistence.resolve();
  await flushBootstrap();
  assert.equal(runtime.observerCalls, 1);
  assert.equal(runtime.controllerCreations, 1);
  assert.equal(runtime.guest.disposeCalls, 1);
  assert.equal(runtime.elements.loginBtn.disabled, false);
  assert.equal(runtime.elements.loginBtn.listenerCount(), 1);
});

test("a real null auth observer callback visibly restores only the guest list", async () => {
  const { storage, writes } = recordingStorage({
    "gh-favs-guest": '["guest/only"]',
    "gh-favs-imported:alice": "1",
  });
  const runtime = await runFirebaseBootstrap({
    realController: true,
    storage,
    getDoc: async () => ({ exists: () => true, data: () => ({ favorites: ["alice/only"] }) }),
  });
  runtime.persistence.resolve();
  await flushBootstrap();
  const auth = runtime.observers[0].auth;
  auth.currentUser = { uid: "alice" };
  runtime.observers[0].callback(auth.currentUser);
  await flushBootstrap();

  auth.currentUser = null;
  runtime.observers[0].callback(null);
  await flushBootstrap();

  assert.equal(runtime.context.favoriteController.mode(), "guest");
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.applied.at(-1))), { favorites: ["guest/only"], busy: false });
  assert.equal(runtime.snapshotUnsubscribes, 1);
  assert.deepEqual(writes, [["gh-favs-cache:alice", '["alice/only"]']]);
  assert.equal(storage.getItem("gh-favs-guest"), '["guest/only"]');
  assert.equal(runtime.elements.loginBtn.hidden, false);
  assert.equal(runtime.elements.loginBtn.disabled, false);
  assert.equal(runtime.elements.logoutBtn.hidden, true);
  assert.equal(runtime.elements.logoutBtn.disabled, true);
  assert.equal(runtime.elements.syncStatus.textContent, "브라우저 동기화");
  assert.equal(runtime.elements.syncStatus.title, "브라우저 동기화");
  assert.equal(runtime.elements.syncStatus.getAttribute("aria-label"), "브라우저 동기화");
  assert.equal(runtime.elements.syncStatus.dataset.tone, "normal");
});

test("a real Alice Firestore listener error keeps the cached account list visibly labeled", async () => {
  const { storage, writes } = recordingStorage({
    "gh-favs-guest": '["guest/only"]',
    "gh-favs-imported:alice": "1",
    "gh-favs-cache:alice": '["alice/cached"]',
  });
  const runtime = await runFirebaseBootstrap({
    realController: true,
    storage,
    getDoc: async () => { throw new Error("offline"); },
  });
  runtime.persistence.resolve();
  await flushBootstrap();
  const auth = runtime.observers[0].auth;
  auth.currentUser = { uid: "alice" };
  runtime.observers[0].callback(auth.currentUser);
  await flushBootstrap();
  runtime.snapshots[0].error(new Error("listener offline"));

  assert.equal(runtime.context.favoriteController.mode(), "account");
  assert.equal(auth.currentUser.uid, "alice");
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.applied.at(-1))), { favorites: ["alice/cached"], busy: false });
  assert.deepEqual(writes, []);
  assert.equal(storage.getItem("gh-favs-guest"), '["guest/only"]');
  assert.equal(runtime.elements.syncStatus.textContent, "즐겨찾기 실시간 동기화가 중단되었어요.");
  assert.equal(runtime.elements.syncStatus.title, "즐겨찾기 실시간 동기화가 중단되었어요.");
  assert.equal(runtime.elements.syncStatus.getAttribute("aria-label"), "구글 계정 동기화. 즐겨찾기 실시간 동기화가 중단되었어요.");
  assert.equal(runtime.elements.syncStatus.dataset.tone, "notice");
});

test("Firestore initialization fails closed before Auth with the generic login-unavailable message", async () => {
  const runtime = await runFirebaseBootstrap({ firestoreError: new Error("raw Firestore detail") });

  assert.deepEqual(runtime.calls.map(call => call.type), ["getFirestore"]);
  assert.equal(runtime.guest.disposeCalls, 0);
  assert.equal(runtime.observerCalls, 0);
  assert.equal(runtime.elements.loginBtn.listenerCount(), 0);
  assert.equal(runtime.elements.logoutBtn.listenerCount(), 0);
  assert.equal(runtime.elements.syncStatus.textContent, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
  assert.doesNotMatch(runtime.elements.syncStatus.textContent, /raw Firestore detail/);
});

test("partial account bundle cleanup unsubscribes and removes both handlers exactly once", async () => {
  const runtime = await runFirebaseBootstrap({ failLogoutAdd: new Error("second handler failure") });
  runtime.persistence.resolve();
  await flushBootstrap();

  assert.equal(runtime.guest.disposeCalls, 0);
  assert.equal(runtime.context.favoriteController, runtime.guest);
  assert.equal(runtime.observerCalls, 1);
  assert.equal(runtime.unsubscribeCalls, 1);
  assert.equal(runtime.controllers.length, 1);
  assert.equal(runtime.controllers[0].disposeCalls, 1);
  assert.equal(runtime.elements.loginBtn.removeCalls, 1);
  assert.equal(runtime.elements.logoutBtn.removeCalls, 1);
  assert.equal(runtime.elements.loginBtn.listenerCount(), 0);
  assert.equal(runtime.elements.logoutBtn.listenerCount(), 0);
});

test("published bundle disposal is idempotent", async () => {
  const runtime = await runFirebaseBootstrap();
  runtime.persistence.resolve();
  await flushBootstrap();

  runtime.triggerPagehide({ persisted: false });
  runtime.triggerPagehide({ persisted: false });
  assert.equal(runtime.unsubscribeCalls, 1);
  assert.equal(runtime.controllers[0].disposeCalls, 1);
  assert.equal(runtime.elements.loginBtn.removeCalls, 1);
  assert.equal(runtime.elements.logoutBtn.removeCalls, 1);
});

test("BFCache restore keeps the published Auth bundle and reapplies visible state once", async () => {
  const runtime = await runFirebaseBootstrap();
  runtime.persistence.resolve();
  await flushBootstrap();
  const controller = runtime.controllers[0];
  runtime.calls.find(call => call.type === "getAuth").auth.currentUser = { uid: "alice" };

  runtime.triggerPagehide({ persisted: true });
  assert.equal(runtime.unsubscribeCalls, 0);
  assert.equal(controller.disposeCalls, 0);
  runtime.elements.syncStatus.textContent = "stale";
  runtime.elements.syncStatus.title = "stale";
  runtime.elements.syncStatus.dataset.tone = "notice";
  runtime.elements.syncStatus.setAttribute("aria-label", "stale");
  const beforeRestore = {
    auth: runtime.calls.filter(call => call.type === "getAuth").length,
    controllers: runtime.controllerCreations,
    applied: runtime.applied.length,
    statusMutations: runtime.statusMutations.length,
  };
  runtime.triggerPageshow({ persisted: true });

  assert.equal(runtime.unsubscribeCalls, 0);
  assert.equal(controller.disposeCalls, 0);
  assert.equal(runtime.calls.filter(call => call.type === "getAuth").length, beforeRestore.auth);
  assert.equal(runtime.controllerCreations, beforeRestore.controllers);
  assert.equal(runtime.applied.length, beforeRestore.applied + 1);
  assert.equal(runtime.elements.loginBtn.hidden, true);
  assert.equal(runtime.elements.logoutBtn.hidden, false);
  assert.equal(runtime.elements.logoutBtn.disabled, false);
  assert.equal(runtime.elements.syncStatus.textContent, "구글 계정 동기화");
  assert.equal(runtime.elements.syncStatus.title, "구글 계정 동기화");
  assert.equal(runtime.elements.syncStatus.getAttribute("aria-label"), "구글 계정 동기화");
  assert.equal(runtime.elements.syncStatus.dataset.tone, "normal");
  assert.equal(runtime.statusMutations.length, beforeRestore.statusMutations + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.applied.at(-1))), { favorites: ["controller-1/favorite"], busy: false });
});

test("real page discard disposes the published Auth bundle and lifecycle exactly once", async () => {
  const runtime = await runFirebaseBootstrap();
  runtime.persistence.resolve();
  await flushBootstrap();

  runtime.triggerPagehide({ persisted: false });
  runtime.triggerPagehide({ persisted: false });
  assert.equal(runtime.unsubscribeCalls, 1);
  assert.equal(runtime.controllers[0].disposeCalls, 1);
});

test("missing or malformed lifecycle helpers retain guest mode before Firebase resources", async () => {
  for (const authLifecycle of [undefined, {}, { create: true }]) {
    const runtime = await runFirebaseBootstrap({ authLifecycle });
    assert.deepEqual(runtime.calls, []);
    assert.equal(runtime.guest.disposeCalls, 0);
    assert.equal(runtime.context.favoriteController, runtime.guest);
    assert.equal(runtime.observerCalls, 0);
    assert.equal(runtime.controllerCreations, 0);
    assert.equal(runtime.elements.loginBtn.listenerCount(), 0);
    assert.equal(runtime.elements.logoutBtn.listenerCount(), 0);
    assert.equal(runtime.elements.loginBtn.hidden, true);
    assert.equal(runtime.elements.logoutBtn.hidden, true);
    assert.equal(runtime.elements.syncStatus.textContent, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
  }
});

test("lifecycle construction and startup failure clean phase B before guest publication", async () => {
  for (const authLifecycle of [
    { create() { throw new Error("raw lifecycle create detail"); } },
    { create() { return { start() { throw new Error("raw lifecycle start detail"); }, stop() {} }; } },
  ]) {
    const runtime = await runFirebaseBootstrap({ authLifecycle });
    runtime.persistence.resolve();
    await flushBootstrap();
    assert.equal(runtime.guest.disposeCalls, 0);
    assert.equal(runtime.context.favoriteController, runtime.guest);
    assert.equal(runtime.observerCalls, 1);
    assert.equal(runtime.unsubscribeCalls, 1);
    assert.equal(runtime.controllerCreations, 1);
    assert.equal(runtime.controllers[0].disposeCalls, 1);
    assert.equal(runtime.elements.loginBtn.listenerCount(), 0);
    assert.equal(runtime.elements.logoutBtn.listenerCount(), 0);
    assert.equal(runtime.elements.syncStatus.textContent, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
    assert.doesNotMatch(runtime.elements.syncStatus.textContent, /raw lifecycle/);
  }
});

test("an older persistence bootstrap cannot publish after a newer one", async () => {
  const first = deferred();
  const second = deferred();
  const runtime = await runFirebaseBootstrap({
    persistences: [first, second],
    auths: [{ currentUser: null, name: "older" }, { currentUser: null, name: "newer" }],
  });
  runtime.start();
  await flushBootstrap();

  second.resolve();
  await flushBootstrap();
  const newestController = runtime.context.favoriteController;
  assert.equal(runtime.guest.disposeCalls, 1);
  assert.equal(newestController, runtime.controllers[0]);

  first.resolve();
  await flushBootstrap();
  assert.equal(runtime.guest.disposeCalls, 1);
  assert.equal(runtime.context.favoriteController, newestController);
});

test("persistence rejection retains guest mode with the storage-specific safe message", async () => {
  const runtime = await runFirebaseBootstrap();
  runtime.persistence.reject(new Error("raw persistence detail"));
  await flushBootstrap();

  assert.equal(runtime.guest.disposeCalls, 0);
  assert.equal(runtime.observerCalls, 0);
  assert.equal(runtime.elements.loginBtn.listenerCount(), 0);
  assert.equal(runtime.elements.logoutBtn.listenerCount(), 0);
  assert.equal(runtime.elements.loginBtn.hidden, true);
  assert.equal(runtime.elements.loginBtn.disabled, true);
  assert.equal(runtime.elements.logoutBtn.hidden, true);
  assert.equal(runtime.elements.logoutBtn.disabled, true);
  assert.equal(runtime.elements.syncStatus.textContent, "이 브라우저에서 로그인 상태를 저장할 수 없어 브라우저 저장으로 사용합니다.");
  assert.doesNotMatch(runtime.elements.syncStatus.textContent, /raw persistence detail/);
});

test("App Check initialization rejection retains guest mode with the security safe message", async () => {
  const runtime = await runFirebaseBootstrap({ appCheck: () => Promise.reject(new Error("raw App Check detail")) });
  await flushBootstrap();

  assert.equal(runtime.guest.disposeCalls, 0);
  assert.equal(runtime.observerCalls, 0);
  assert.equal(runtime.elements.loginBtn.listenerCount(), 0);
  assert.equal(runtime.elements.logoutBtn.listenerCount(), 0);
  assert.equal(runtime.elements.loginBtn.hidden, true);
  assert.equal(runtime.elements.loginBtn.disabled, true);
  assert.equal(runtime.elements.syncStatus.textContent, "로그인 보안 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
  assert.doesNotMatch(runtime.elements.syncStatus.textContent, /raw App Check detail/);
});

test("later account resource rejection retains guest mode with a distinct safe message", async () => {
  const runtime = await runFirebaseBootstrap({ controllerError: new Error("raw resource detail") });
  runtime.persistence.resolve();
  await flushBootstrap();

  assert.equal(runtime.guest.disposeCalls, 0);
  assert.equal(runtime.observerCalls, 0);
  assert.equal(runtime.elements.loginBtn.listenerCount(), 0);
  assert.equal(runtime.elements.logoutBtn.listenerCount(), 0);
  assert.equal(runtime.elements.loginBtn.hidden, true);
  assert.equal(runtime.elements.loginBtn.disabled, true);
  assert.equal(runtime.elements.syncStatus.textContent, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
  assert.doesNotMatch(runtime.elements.syncStatus.textContent, /raw resource detail/);
});

test("App Check uses the pinned Enterprise provider before Firebase services", async () => {
  const { source, validateFirebaseConfig } = await loadFirebaseClientForTest();
  const config = JSON.parse(await readFile(new URL("../firebase-config.json", import.meta.url), "utf8"));
  assert.match(source, /https:\/\/www\.gstatic\.com\/firebasejs\/12\.17\.1\/firebase-app-check\.js/);
  assert.match(source, /new ReCaptchaEnterpriseProvider\(config\.appCheckSiteKey\)/);
  assert.match(source, /isTokenAutoRefreshEnabled:\s*true/);
  const appIndex = source.indexOf("initializeApp(config)");
  const appCheckIndex = source.indexOf("initializeAppCheck(app");
  assert.ok(appIndex >= 0 && appIndex < appCheckIndex);
  assert.ok(appCheckIndex < source.indexOf("getAuth(app)"));
  assert.ok(appCheckIndex < source.indexOf("getFirestore(app)"));
  assert.equal(validateFirebaseConfig(config), config);
  assert.throws(() => validateFirebaseConfig({ ...config, authDomain: "wrong.example" }), /auth domain/);
  assert.throws(() => validateFirebaseConfig({ ...config, appCheckSiteKey: "" }), /App Check site key/);
  assert.throws(() => validateFirebaseConfig({ ...config, appCheckSiteKey: 123 }), /App Check site key/);
});

test("a configuration failure stays on the existing guest controller", async () => {
  const source = await readFile(new URL("../firebase-client.js", import.meta.url), "utf8");
  const runnable = source
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"https:\/\/www\.gstatic\.com\/firebasejs\/12\.17\.1\/[^"]+";\s*/g, "")
    .replace(/import\.meta\.url/g, '""');
  const elements = {
    syncStatus: { textContent: "" },
    loginBtn: { hidden: false },
    logoutBtn: { hidden: false },
  };
  let applied;
  const context = {
    Favorites: globalThis.Favorites,
    FavoriteSync,
    AuthLifecycle,
    favoriteController: { favorites: () => ["guest/one"] },
    applyFavoriteState: state => { applied = state; },
    fetch: async () => ({ ok: true, json: async () => ({ projectId: "github-trending-nowwcastle", appCheckSiteKey: "public-site-key" }) }),
    URL: class {},
    document: { getElementById: id => elements[id] },
    initializeApp: config => ({ config }),
    initializeAppCheck() { throw new Error("App Check unavailable"); },
    ReCaptchaEnterpriseProvider: class {},
    globalThis: null,
  };
  context.globalThis = context;
  vm.runInNewContext(runnable, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.syncStatus.textContent, "로그인 보안 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
  assert.equal(elements.loginBtn.hidden, true);
  assert.equal(elements.logoutBtn.hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), { favorites: ["guest/one"], busy: false });
});

test("Firebase client uses pinned official modules and the required page script order", async () => {
  const { source } = await loadFirebaseClientForTest();
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const module of ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"]) {
    assert.match(source, new RegExp(`https://www\\.gstatic\\.com/firebasejs/12\\.17\\.1/${module.replace(".", "\\.")}`));
  }
  assert.match(source, /\brunTransaction\b/);
  assert.ok(html.indexOf('<script src="favorites.js"></script>') < html.indexOf('<script src="favorite-sync.js"></script>'));
  assert.ok(html.indexOf('<script src="favorite-sync.js"></script>') < html.indexOf('<script src="auth-lifecycle.js"></script>'));
  assert.ok(html.indexOf('<script src="auth-lifecycle.js"></script>') < html.indexOf('import("./firebase-client.js").catch'));
  assert.doesNotMatch(html, /<script type="module" src="firebase-client\.js"><\/script>/);
});

test("a Firebase module dependency failure activates guest fallback outside the failed module", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const boundary = html.match(/<script type="module">([\s\S]*?import\("\.\/firebase-client\.js"\)\.catch[\s\S]*?)<\/script>/)?.[1] || "";
  assert.match(boundary, /status\.textContent="Google 동기화를 사용할 수 없어 이 브라우저에 저장합니다\."/);
  assert.match(boundary, /login\.hidden=true/);
  assert.match(boundary, /logout\.hidden=true/);
  assert.match(boundary, /globalThis\.applyFavoriteState\(\{favorites:globalThis\.favoriteController\.favorites\(\),busy:false\}\)/);
  assert.ok(html.indexOf("globalThis.favoriteController=guestController") < html.indexOf('import("./firebase-client.js").catch'));
});

test("Firebase first import unions against the transaction's latest exact-case document", async () => {
  const { createCloudAdapter } = await loadFirebaseClientForTest();
  let remote = ["Remote/Keep", "Remote/Remove"];
  let committed;
  let attempts = 0;
  const timestamp = {};
  const transaction = {
    async get() { return { exists: () => true, data: () => ({ favorites: remote }) }; },
    set(_reference, value) { committed = value; },
  };
  const sdk = {
    doc: (_db, collection, uid) => `${collection}/${uid}`,
    runTransaction: async (_db, update) => {
      attempts += 1;
      await update(transaction);
      remote = ["Remote/Keep", "remote/keep", "Remote/Added"];
      attempts += 1;
      return update(transaction);
    },
    serverTimestamp: () => timestamp,
  };
  const cloud = createCloudAdapter("db", sdk);

  const result = await cloud.importUnion("alice", ["Guest/One", "Remote/Keep"]);
  assert.equal(attempts, 2);
  assert.deepEqual(Array.from(result), ["Guest/One", "Remote/Keep", "remote/keep", "Remote/Added"]);
  assert.deepEqual(Array.from(committed.favorites), Array.from(result));
  assert.equal(committed.updatedAt, timestamp);
});

test("Firebase transaction rejects an over-limit import before writing", async () => {
  const { createCloudAdapter } = await loadFirebaseClientForTest();
  let writes = 0;
  const sdk = {
    doc: () => "users/alice",
    runTransaction: (_db, update) => update({
      get: async () => ({
        exists: () => true,
        data: () => ({ favorites: Array.from({ length: 500 }, (_, index) => `remote/r${index}`) }),
      }),
      set() { writes += 1; },
    }),
    serverTimestamp: () => ({}),
  };
  const cloud = createCloudAdapter("db", sdk);

  await assert.rejects(cloud.importUnion("alice", ["guest/one"]), /500/);
  assert.equal(writes, 0);
});

test("Firebase add and remove use only atomic merge writes", async () => {
  const { createCloudAdapter } = await loadFirebaseClientForTest();
  const calls = [];
  const sdk = {
    arrayUnion: slug => ["union", slug],
    arrayRemove: slug => ["remove", slug],
    doc: (_db, collection, uid) => `${collection}/${uid}`,
    serverTimestamp: () => "timestamp",
    setDoc: (...args) => { calls.push(args); },
  };
  const cloud = createCloudAdapter("db", sdk);

  await cloud.add("alice", "Owner/Repo");
  await cloud.remove("alice", "Owner/Repo");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["users/alice", { favorites: ["union", "Owner/Repo"], updatedAt: "timestamp" }, { merge: true }],
    ["users/alice", { favorites: ["remove", "Owner/Repo"], updatedAt: "timestamp" }, { merge: true }],
  ]);
});

test("auth errors map to safe Korean messages without raw details", async () => {
  const { authErrorMessage } = await loadFirebaseClientForTest();
  const expected = new Map([
    ["auth/popup-blocked", "팝업"],
    ["auth/popup-closed-by-user", "취소"],
    ["auth/cancelled-popup-request", "로그인 창"],
    ["auth/network-request-failed", "네트워크"],
    ["auth/unauthorized-domain", "사이트 주소"],
    ["auth/internal-error", "로그인 설정"],
  ]);
  for (const [code, word] of expected) {
    const message = authErrorMessage({ code, message: "SECRET_TOKEN_VALUE" });
    assert.match(message, new RegExp(word));
    assert.doesNotMatch(message, /SECRET_TOKEN_VALUE/);
  }
  assert.doesNotMatch(authErrorMessage({ message: "SECRET_TOKEN_VALUE" }), /SECRET_TOKEN_VALUE/);
});

test("login failures expose their recovery message as visible status text", async () => {
  const { setSyncStatus } = await loadFirebaseClientForTest();
  const element = { textContent: "", title: "", dataset: {}, setAttribute() {} };

  setSyncStatus(element, null, "팝업을 허용한 뒤 다시 시도해 주세요.", "error");

  assert.equal(element.textContent, "팝업을 허용한 뒤 다시 시도해 주세요.");
  assert.equal(element.dataset.tone, "error");
});

test("sync mode exposes only the browser and Google account labels", async () => {
  const { syncModeLabel } = await loadFirebaseClientForTest();
  assert.equal(typeof syncModeLabel, "function");
  assert.equal(syncModeLabel(null), "브라우저 동기화");
  assert.equal(syncModeLabel({ uid: "alice" }), "구글 계정 동기화");
});

test("an authenticated synchronization failure retains the account mode label", async () => {
  const source = await readFile(new URL("../firebase-client.js", import.meta.url), "utf8");
  const authHandler = source.match(/const applyAuthState = async user => \{[\s\S]*?const onLogin/m)?.[0] || "";

  assert.match(authHandler, /catch\s*\{[\s\S]*?setSyncStatus\(status, user, "즐겨찾기 동기화를 시작하지 못했어요/);
});

test("guest fallback details remain visible and accessible", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /status\.setAttribute\("aria-label",`브라우저 동기화\. \$\{message\}`\)/);
  assert.match(html, /status\.setAttribute\("aria-label","브라우저 동기화\. Google 동기화를 사용할 수 없어 이 브라우저에 저장합니다\."\)/);
  assert.match(html, /status\.textContent="Google 동기화를 사용할 수 없어 이 브라우저에 저장합니다\."/);
});

test("account controls are accessible and favorites route only through the controller", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="syncStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="loginBtn"[^>]*type="button"/);
  assert.match(html, /id="logoutBtn"[^>]*type="button"[^>]*hidden/);
  assert.match(html, /\.account-btn:focus-visible\s*\{[^}]*outline/);
  assert.match(html, /\.favbtn:disabled\s*\{[^}]*cursor:wait[^}]*opacity:\.55/);
  assert.match(html, /favoriteBusy\?" disabled":""/);
  assert.match(html, /Favorites\.migrateLegacyFavs\(storage\)/);
  assert.match(html, /globalThis\.applyFavoriteState\s*=/);
  assert.match(html, /await globalThis\.favoriteController\.toggle\(btn\.dataset\.slug\)/);
  const clickHandler = html.match(/\/\* 즐겨찾기 \*\/[\s\S]*?document\.getElementById\("favOnlyBtn"\)/)?.[0] || "";
  assert.doesNotMatch(clickHandler, /toggleFav\(/);
});
