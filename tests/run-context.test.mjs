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
  assert.equal(validateRunContext(context).snapshotId, context.snapshotId);
  assert.equal(context.parentSourceSha, parent.sourceSha);
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

test("CLI generators receive the one run context instead of reading a fresh clock", async () => {
  const sources = await Promise.all([
    "scripts/update-trending.mjs",
    "scripts/update-latest-feed.mjs",
    "scripts/update-star-history.mjs",
  ].map(path => readFile(path, "utf8")));

  for (const source of sources) {
    assert.match(source, /readRunContext\(process\.env\)/);
    assert.doesNotMatch(source, /seoulDate\(new Date\(\)\)/);
  }
});
