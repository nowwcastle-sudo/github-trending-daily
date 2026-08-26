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

test("next refresh follows cron 7 */2 * * * across hour and day boundaries", async () => {
  const schedule = await loadSchedule();
  assert.equal(schedule.cron, "7 */2 * * *");
  const cases = [
    ["2026-08-26T00:06:59.000Z", "2026-08-26T00:07:00.000Z"],
    ["2026-08-26T00:07:00.000Z", "2026-08-26T02:07:00.000Z"],
    ["2026-08-26T01:30:00.000Z", "2026-08-26T02:07:00.000Z"],
    ["2026-08-26T22:08:00.000Z", "2026-08-27T00:07:00.000Z"],
  ];
  for (const [now, expected] of cases) {
    assert.equal(schedule.nextRefreshTime(Date.parse(now)).toISOString(), expected);
  }
});
