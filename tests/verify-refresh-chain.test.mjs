import assert from "node:assert/strict";
import test from "node:test";

import { assertSourceBoundToRunHead, selectMatchingReceipt, resolveEffectiveReceipt, validateWorkflowRun, verifyRefreshChain } from "../scripts/verify-refresh-chain.mjs";

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

test("workflow receipt requires exact run identity and exact deploy/probe jobs", () => {
  const run = {
    databaseId: 20, headSha: expected.sourceSha, event: "workflow_dispatch", status: "completed", conclusion: "success",
    createdAt: "2026-08-26T10:07:00Z", url: "https://github.com/owner/repo/actions/runs/20",
    jobs: [
      { databaseId: 1, name: "Deploy candidate Pages artifact", status: "completed", conclusion: "success" },
      { databaseId: 2, name: "Probe production candidate", status: "completed", conclusion: "success" },
    ],
  };
  assert.equal(validateWorkflowRun(run, 20, { requireDispatchEvent: true }), run);
  assert.throws(() => validateWorkflowRun({ ...run, databaseId: 21 }, 20), /invalid/i);
  assert.throws(() => validateWorkflowRun({ ...run, jobs: run.jobs.map(job => ({ ...job, name: `renamed ${job.name}` })) }, 20), /exact successful job/i);
  assert.throws(() => validateWorkflowRun({ ...run, event: "schedule" }, 20, { requireDispatchEvent: true }), /invalid/i);
  assert.throws(() => validateWorkflowRun({ ...run, url: "https://example.test/actions/runs/20" }, 20), /invalid/i);
});

test("artifact source is the run head or exactly one permitted generated child", () => {
  const head = "a".repeat(40);
  const child = "b".repeat(40);
  assert.equal(assertSourceBoundToRunHead(head, head, () => assert.fail("Git must not run")), true);
  assert.equal(assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "data/latest.json\nindex.html"), true);
  assert.throws(() => assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? "c".repeat(40) : "data/latest.json"), /direct generated/i);
  assert.throws(() => assertSourceBoundToRunHead(head, child, args => args[0] === "show" ? head : "repo-filters.js"), /non-generated/i);
});

test("assembled verifyRefreshChain binds expected, later run, origin and final probe", async () => {
  const calls = [];
  const laterWithTime = { ...later, headSha: later.sourceSha, createdAt: "2026-08-26T12:07:00Z" };
  const expectedWithTime = { ...expected, headSha: expected.sourceSha, createdAt: "2026-08-26T10:07:00Z" };
  const dependencies = {
    fetchOrigin: () => calls.push("fetch"),
    productionReceipt: async () => later,
    receiptForRun: async runId => runId === expected.runId ? expectedWithTime : laterWithTime,
    listSuccessfulRuns: () => [{ databaseId: later.runId, createdAt: laterWithTime.createdAt }],
    originMain: () => later.sourceSha,
    isAncestor: () => true,
    probeProduction: async options => calls.push(["probe", options.sourceSha, options.snapshotId]),
  };
  const result = await verifyRefreshChain({ baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha, expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256 }, dependencies);
  assert.equal(result.effectiveRunId, later.runId);
  assert.deepEqual(calls, ["fetch", ["probe", later.sourceSha, later.snapshotId]]);

  await assert.rejects(verifyRefreshChain({ baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha, expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256 }, {
    ...dependencies, productionReceipt: async () => expected, receiptForRun: async () => ({ ...expectedWithTime, runId: 999 }),
  }), /wrong run id/i);
  await assert.rejects(verifyRefreshChain({ baseUrl: "https://example.invalid/", expectedRunId: expected.runId, expectedSourceSha: expected.sourceSha, expectedSnapshotId: expected.snapshotId, expectedManifestSha256: expected.manifestSha256 }, {
    ...dependencies, originMain: () => expected.sourceSha,
  }), /origin\/main/i);
});
