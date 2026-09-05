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

test("next refresh follows cron 7 3,9,15,21 * * * across slots, day, month, and year boundaries", async () => {
  const schedule = await loadSchedule();
  assert.equal(schedule.cron, "7 3,9,15,21 * * *");
  const cases = [
    // Just before the first slot of the day.
    ["2026-08-26T03:06:59.000Z", "2026-08-26T03:07:00.000Z"],
    // Exactly at a slot rolls to the next one (not "now").
    ["2026-08-26T03:07:00.000Z", "2026-08-26T09:07:00.000Z"],
    // Between slots, mid-morning.
    ["2026-08-26T05:00:00.000Z", "2026-08-26T09:07:00.000Z"],
    // Between slots, midday.
    ["2026-08-26T12:00:00.000Z", "2026-08-26T15:07:00.000Z"],
    // Between slots, evening.
    ["2026-08-26T18:00:00.000Z", "2026-08-26T21:07:00.000Z"],
    // Exactly at the last slot rolls to tomorrow's first slot.
    ["2026-08-26T21:07:00.000Z", "2026-08-27T03:07:00.000Z"],
    // After the last slot, still the same day.
    ["2026-08-26T23:00:00.000Z", "2026-08-27T03:07:00.000Z"],
    // Month boundary.
    ["2026-08-31T22:00:00.000Z", "2026-09-01T03:07:00.000Z"],
    // Leap-day entry: Feb 28 (non-leap-aware path) rolls into the leap day itself.
    ["2028-02-28T22:00:00.000Z", "2028-02-29T03:07:00.000Z"],
    // Leap-day exit: after the last slot on the leap day rolls into March 1.
    ["2028-02-29T22:00:00.000Z", "2028-03-01T03:07:00.000Z"],
    // Year boundary.
    ["2026-12-31T22:00:00.000Z", "2027-01-01T03:07:00.000Z"],
  ];
  for (const [now, expected] of cases) {
    assert.equal(schedule.nextRefreshTime(Date.parse(now)).toISOString(), expected);
  }
});
