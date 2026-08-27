import assert from "node:assert/strict";
import test from "node:test";

import { selectMatchingReceipt, resolveEffectiveReceipt } from "../scripts/verify-refresh-chain.mjs";

const expected = {
  runId: 20,
  sourceSha: "a".repeat(40),
  snapshotId: "20260826100700-0123456789abcdef",
  manifestSha256: "b".repeat(64),
};
const later = {
  runId: 21,
  sourceSha: "c".repeat(40),
  snapshotId: "20260826120700-fedcba9876543210",
  manifestSha256: "d".repeat(64),
};

test("exact expected production keeps the expected receipt", () => {
  assert.deepEqual(resolveEffectiveReceipt({ expected, production: expected, laterReceipts: [], isAncestor: () => true, originMain: "f".repeat(40) }), { expectedRunId: 20, effectiveRunId: 20, receipt: expected });
});

test("one later fast-forward receipt may replace the expected receipt", () => {
  assert.deepEqual(resolveEffectiveReceipt({ expected, production: later, laterReceipts: [later], isAncestor: () => true, originMain: later.sourceSha }), { expectedRunId: 20, effectiveRunId: 21, receipt: later });
});

test("later replacement fails on non-fast-forward, zero matches, or two matches", () => {
  assert.throws(() => resolveEffectiveReceipt({ expected, production: later, laterReceipts: [later], isAncestor: () => false, originMain: later.sourceSha }), /fast-forward/i);
  assert.throws(() => resolveEffectiveReceipt({ expected, production: later, laterReceipts: [], isAncestor: () => true, originMain: later.sourceSha }), /exactly one/i);
  assert.throws(() => resolveEffectiveReceipt({ expected, production: later, laterReceipts: [later, { ...later, runId: 22 }], isAncestor: () => true, originMain: later.sourceSha }), /exactly one/i);
});

test("current production accepts exactly one matching receipt and exact origin main", () => {
  assert.deepEqual(selectMatchingReceipt(later, [expected, later]), later);
  assert.throws(() => selectMatchingReceipt(later, []), /exactly one/i);
  assert.throws(() => selectMatchingReceipt(later, [later, { ...later, runId: 22 }]), /exactly one/i);
  assert.throws(() => resolveEffectiveReceipt({ expected: null, production: later, laterReceipts: [later], isAncestor: () => true, originMain: expected.sourceSha }), /origin\/main/i);
});
