import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadMembershipHistory() {
  const source = await readFile(new URL("../membership-history.js", import.meta.url), "utf8");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.MembershipHistory;
}

const baseline = {
  schemaVersion: 1,
  generatedAt: "2026-08-26T10:07:00.000Z",
  statsDate: "2026-08-26",
  baseline: true,
  current: Array.from({ length: 10 }, (_, index) => ({ slug: `owner/repo-${index}`, status: "baseline" })),
  exited: [],
};

test("membership status accepts a neutral baseline and preserves current order", async () => {
  const MembershipHistory = await loadMembershipHistory();
  const normalized = MembershipHistory.normalize(baseline);

  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.current)),
    baseline.current,
  );
  assert.equal(MembershipHistory.currentStatus(normalized).get("owner/repo-0"), "baseline");
});

test("membership status accepts new, reentered, stayed, and exited public events", async () => {
  const MembershipHistory = await loadMembershipHistory();
  const value = {
    ...baseline,
    baseline: false,
    current: [
      { slug: "owner/new", status: "new" },
      { slug: "owner/back", status: "reentered" },
      ...Array.from({ length: 8 }, (_, index) => ({ slug: `owner/stayed-${index}`, status: "stayed" })),
    ],
    exited: [{
      slug: "owner/gone",
      lastSeenAt: "2026-08-26T08:07:00.000Z",
      exitedAt: "2026-08-26T10:07:00.000Z",
    }],
  };

  const normalized = MembershipHistory.normalize(value);
  assert.equal(MembershipHistory.currentStatus(normalized).get("owner/back"), "reentered");
  assert.equal(normalized.exited[0].slug, "owner/gone");
});

test("S1 S2 and S3 preserve baseline new exited and reentered transitions", async () => {
  const MembershipHistory = await loadMembershipHistory();
  const stable = Array.from({ length: 9 }, (_, index) => ({ slug: `owner/stable-${index}`, status: "stayed" }));
  const s2 = {
    ...baseline,
    generatedAt: "2026-08-28T03:01:01.001Z",
    statsDate: "2026-08-28",
    baseline: false,
    current: [...stable, { slug: "owner/newcomer", status: "new" }],
    exited: [{ slug: "owner/returning", lastSeenAt: baseline.generatedAt, exitedAt: "2026-08-28T03:01:01.001Z" }],
  };
  const s3 = {
    ...s2,
    generatedAt: "2026-08-28T05:01:01.001Z",
    current: [
      ...stable,
      { slug: "owner/newcomer", status: "stayed" },
      { slug: "owner/returning", status: "reentered" },
    ],
    exited: [],
  };

  assert.equal(MembershipHistory.normalize(baseline).baseline, true);
  assert.equal(MembershipHistory.currentStatus(MembershipHistory.normalize(s2)).get("owner/newcomer"), "new");
  assert.equal(MembershipHistory.normalize(s2).exited[0].slug, "owner/returning");
  assert.equal(MembershipHistory.currentStatus(MembershipHistory.normalize(s3)).get("owner/newcomer"), "stayed");
  assert.equal(MembershipHistory.currentStatus(MembershipHistory.normalize(s3)).get("owner/returning"), "reentered");
});

test("membership status rejects malformed schemas, identities, and baseline lies", async () => {
  const MembershipHistory = await loadMembershipHistory();
  const cases = [
    { ...baseline, schemaVersion: 2 },
    { ...baseline, generatedAt: "2026-08-26" },
    { ...baseline, statsDate: "2026-02-30" },
    { ...baseline, extra: true },
    { ...baseline, current: baseline.current.slice(0, 9) },
    { ...baseline, current: baseline.current.map((item, index) => index ? item : { slug: "bad", status: "baseline" }) },
    { ...baseline, current: [...baseline.current.slice(0, 9), { slug: "OWNER/REPO-0", status: "baseline" }] },
    { ...baseline, current: baseline.current.map((item, index) => index ? item : { ...item, status: "new" }) },
    { ...baseline, baseline: false },
    { ...baseline, exited: [{ slug: "owner/gone", lastSeenAt: "bad", exitedAt: baseline.generatedAt }] },
  ];
  for (const value of cases) assert.throws(() => MembershipHistory.normalize(value));
});

test("membership loader reports HTTP and schema failures without response data", async () => {
  const MembershipHistory = await loadMembershipHistory();
  await assert.rejects(
    MembershipHistory.load("membership.json", async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    MembershipHistory.load("membership.json", async () => ({ ok: true, json: async () => ({ secret: "not echoed" }) })),
    error => !String(error).includes("not echoed"),
  );
});
