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

async function loadVisitTracker() {
  await import("../visit-tracker.js");
  return globalThis.VisitTracker;
}

test("the first visit marks nothing new and records what was on the page", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();

  const summary = VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two"], now: "2026-09-05T00:00:00.000Z" });

  assert.equal(summary.previousVisitAt, null);
  assert.deepEqual(summary.newSlugs, []);
  assert.deepEqual(VisitTracker.readSeen(storage), ["owner/one", "owner/two"]);
  assert.equal(VisitTracker.readLastVisit(storage), "2026-09-05T00:00:00.000Z");
});

test("a return visit reports only the repositories that were not there before", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();
  VisitTracker.recordVisit(storage, { slugs: ["owner/one"], now: "2026-09-03T00:00:00.000Z" });

  const summary = VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two", "owner/three"], now: "2026-09-05T00:00:00.000Z" });

  assert.equal(summary.previousVisitAt, "2026-09-03T00:00:00.000Z");
  assert.deepEqual(summary.newSlugs, ["owner/two", "owner/three"]);
  assert.equal(VisitTracker.readLastVisit(storage), "2026-09-05T00:00:00.000Z");
});

test("a repository seen once never becomes new again", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();
  VisitTracker.recordVisit(storage, { slugs: ["owner/one"], now: "2026-09-03T00:00:00.000Z" });
  VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two"], now: "2026-09-04T00:00:00.000Z" });

  const summary = VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two"], now: "2026-09-05T00:00:00.000Z" });

  assert.deepEqual(summary.newSlugs, []);
});

test("the seen set is capped at 1000 slugs, keeping the most recent", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();
  const first = Array.from({ length: 1000 }, (_, index) => `owner/old${index}`);
  VisitTracker.recordVisit(storage, { slugs: first, now: "2026-09-03T00:00:00.000Z" });

  VisitTracker.recordVisit(storage, { slugs: ["owner/fresh"], now: "2026-09-05T00:00:00.000Z" });
  const seen = VisitTracker.readSeen(storage);

  assert.equal(seen.length, VisitTracker.SEEN_LIMIT);
  assert.equal(seen.at(-1), "owner/fresh");
  assert.equal(seen.includes("owner/old0"), false, "the oldest entry is dropped, not the newest");
});

test("malformed slugs, malformed timestamps and unreadable storage never throw", async () => {
  const VisitTracker = await loadVisitTracker();

  const corrupt = memoryStorage({ "gi.visit.seen": "{not json", "gi.visit.lastAt": "yesterday" });
  assert.deepEqual(VisitTracker.readSeen(corrupt), []);
  assert.equal(VisitTracker.readLastVisit(corrupt), null);

  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const summary = VisitTracker.recordVisit(blocked, { slugs: ["owner/one"], now: "2026-09-05T00:00:00.000Z" });
  assert.equal(summary.previousVisitAt, null);
  assert.deepEqual(summary.newSlugs, []);

  const storage = memoryStorage();
  VisitTracker.recordVisit(storage, { slugs: ["owner/one", "not a slug", 7, "owner//two"], now: "not-a-time" });
  assert.deepEqual(VisitTracker.readSeen(storage), ["owner/one"]);
  assert.equal(VisitTracker.readLastVisit(storage), null, "an invalid timestamp is not written");
});
