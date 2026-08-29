import assert from "node:assert/strict";
import test from "node:test";

await import("../auth-lifecycle.js");

const AuthLifecycle = globalThis.AuthLifecycle;

function eventTarget() {
  const listeners = new Map();
  const adds = new Map();
  const removes = new Map();
  return {
    addEventListener(type, listener) {
      adds.set(type, (adds.get(type) || 0) + 1);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      removes.set(type, (removes.get(type) || 0) + 1);
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    listeners(type) { return listeners.get(type)?.size || 0; },
    adds(type) { return adds.get(type) || 0; },
    removes(type) { return removes.get(type) || 0; },
  };
}

test("BFCache hide preserves resources and restore runs once", () => {
  const target = eventTarget();
  const calls = [];
  const lifecycle = AuthLifecycle.create({
    target,
    onDiscard: () => calls.push("discard"),
    onRestore: () => calls.push("restore"),
  });

  lifecycle.start();
  lifecycle.start();
  assert.equal(target.adds("pagehide"), 1);
  assert.equal(target.adds("pageshow"), 1);
  target.emit("pagehide", { persisted: true });
  target.emit("pageshow", { persisted: true });
  assert.deepEqual(calls, ["restore"]);
});

test("real discard runs once and stop removes both listeners idempotently", () => {
  const target = eventTarget();
  const calls = [];
  const lifecycle = AuthLifecycle.create({
    target,
    onDiscard: () => calls.push("discard"),
    onRestore: () => calls.push("restore"),
  });

  lifecycle.start();
  target.emit("pagehide", { persisted: false });
  target.emit("pagehide", { persisted: false });
  assert.deepEqual(calls, ["discard"]);
  lifecycle.stop();
  lifecycle.stop();
  assert.equal(target.listeners("pagehide"), 0);
  assert.equal(target.listeners("pageshow"), 0);
  assert.equal(target.removes("pagehide"), 1);
  assert.equal(target.removes("pageshow"), 1);
});

test("only exact false pagehide discards resources", () => {
  const target = eventTarget();
  const calls = [];
  const lifecycle = AuthLifecycle.create({
    target,
    onDiscard: () => calls.push("discard"),
    onRestore: () => calls.push("restore"),
  });

  lifecycle.start();
  for (const event of [
    undefined,
    {},
    { persisted: undefined },
    { persisted: null },
    { persisted: "false" },
    { persisted: "true" },
    { persisted: 0 },
    { persisted: 1 },
  ]) target.emit("pagehide", event);
  assert.deepEqual(calls, []);
  target.emit("pagehide", { persisted: false });
  target.emit("pagehide", { persisted: false });
  assert.deepEqual(calls, ["discard"]);
});
