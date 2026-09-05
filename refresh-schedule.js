(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RefreshSchedule = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Single obvious place to change the refresh hours: four UTC hours a day, sorted
  // ascending, each 6 hours apart. These specific hours (03, 09, 15, 21 UTC) are the
  // four Asia/Seoul quarter-day marks 12:07, 18:07, 00:07 (next day) and 06:07 --
  // i.e. Asia/Seoul 00:07/06:07/12:07/18:07 minus the fixed 9-hour offset.
  const REFRESH_UTC_HOURS = [3, 9, 15, 21];
  const REFRESH_UTC_MINUTE = 7;
  const cron = `${REFRESH_UTC_MINUTE} ${REFRESH_UTC_HOURS.join(",")} * * *`;

  function nextRefreshTime(nowMs) {
    if (!Number.isFinite(nowMs)) throw new Error("current time must be finite");
    for (const hour of REFRESH_UTC_HOURS) {
      const candidate = new Date(nowMs);
      candidate.setUTCHours(hour, REFRESH_UTC_MINUTE, 0, 0);
      if (candidate.getTime() > nowMs) return candidate;
    }
    const next = new Date(nowMs);
    next.setUTCHours(REFRESH_UTC_HOURS[0], REFRESH_UTC_MINUTE, 0, 0);
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  return { cron, nextRefreshTime };
});
