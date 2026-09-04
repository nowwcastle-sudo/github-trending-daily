import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadSchedule() {
  const source = await readFile(new URL("../refresh-schedule.js", import.meta.url), "utf8");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.RefreshSchedule;
}

test("next refresh follows cron 7 0 * * * across day, month, and year boundaries", async () => {
  const schedule = await loadSchedule();
  assert.equal(schedule.cron, "7 0 * * *");
  const cases = [
    ["2026-08-26T00:06:59.000Z", "2026-08-26T00:07:00.000Z"],
    ["2026-08-26T00:07:00.000Z", "2026-08-27T00:07:00.000Z"],
    ["2026-08-26T12:00:00.000Z", "2026-08-27T00:07:00.000Z"],
    ["2026-08-31T23:00:00.000Z", "2026-09-01T00:07:00.000Z"],
    ["2028-02-28T23:59:00.000Z", "2028-02-29T00:07:00.000Z"],
    ["2028-02-29T23:00:00.000Z", "2028-03-01T00:07:00.000Z"],
    ["2026-12-31T23:59:00.000Z", "2027-01-01T00:07:00.000Z"],
  ];
  for (const [now, expected] of cases) {
    assert.equal(schedule.nextRefreshTime(Date.parse(now)).toISOString(), expected);
  }
});
