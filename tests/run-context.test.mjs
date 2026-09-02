import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createRunContext,
  readRunContext,
  validateRunContext,
} from "../scripts/run-context.mjs";

test("one context remains on the same KST date after wall clock midnight", () => {
  const parent = { snapshotId: "20260826120700-0123456789abcdef", sourceSha: "a".repeat(40) };
  const context = createRunContext(new Date("2026-08-26T14:59:59.900Z"), parent);
  assert.equal(context.statsDateKst, "2026-08-26");
  assert.equal(context.observedAtKst, "2026-08-26T23:59:59.900+09:00");
  assert.equal(validateRunContext(context).snapshotId, context.snapshotId);
  assert.equal(context.parentSourceSha, parent.sourceSha);
  assert.throws(() => validateRunContext({ ...context, observedAtKst: "2026-08-26T23:59:59+09:00" }));
  assert.throws(() => validateRunContext({ ...context, observedAtKst: "2026-08-26T23:59:59.901+09:00" }));
});

test("context rejects a mismatched KST date and malformed snapshot id", () => {
  const context = createRunContext(new Date("2026-08-26T15:00:00.000Z"), { snapshotId: null, sourceSha: null });
  assert.throws(() => validateRunContext({ ...context, statsDateKst: "2026-08-26" }));
  assert.throws(() => validateRunContext({ ...context, snapshotId: "../../bad" }));
  assert.throws(() => validateRunContext({ ...context, parentSourceSha: "a".repeat(40) }));
});

test("readRunContext validates injected JSON and creates one local context when absent", () => {
  const context = createRunContext(new Date("2026-08-26T15:00:00.000Z"));
  assert.deepEqual(readRunContext({ RUN_CONTEXT_JSON: JSON.stringify(context) }), context);
  assert.equal(readRunContext({}, new Date("2026-08-26T14:59:59.900Z")).statsDateKst, "2026-08-26");
  assert.throws(() => readRunContext({ RUN_CONTEXT_JSON: "not json" }), /run context/i);
});

test("valid injected context does not construct a wall-clock Date", () => {
  const context = createRunContext(new Date("2026-08-26T15:00:00.000Z"));
  const OriginalDate = globalThis.Date;
  let zeroArgumentCalls = 0;
  let explicitArgumentCalls = 0;
  globalThis.Date = class TrackingDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) zeroArgumentCalls += 1;
      else explicitArgumentCalls += 1;
      super(...args);
    }
  };
  try {
    assert.deepEqual(readRunContext({ RUN_CONTEXT_JSON: JSON.stringify(context) }), context);
  } finally {
    globalThis.Date = OriginalDate;
  }
  assert.equal(zeroArgumentCalls, 0);
  assert.ok(explicitArgumentCalls > 0);
});

test("the collector owns the run clock and derivative CLIs require explicit artifacts", async () => {
  const [collector, latest, starHistory] = await Promise.all([
    "scripts/update-trending.mjs",
    "scripts/update-latest-feed.mjs",
    "scripts/derive-star-anchors.mjs",
  ].map(path => readFile(path, "utf8")));

  assert.match(collector, /readRunContext\(process\.env\)/);
  for (const source of [latest, starHistory]) {
    assert.doesNotMatch(source, /readRunContext\(process\.env\)/);
    assert.doesNotMatch(source, /seoulDate\(new Date\(\)\)/);
  }
  assert.match(latest, /--snapshot-export/);
  assert.match(starHistory, /--facts/);
});
