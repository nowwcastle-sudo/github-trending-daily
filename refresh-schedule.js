(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RefreshSchedule = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Single obvious place to change the daily refresh hour: 0 = 00:07 UTC = 09:07 Asia/Seoul.
  const REFRESH_UTC_HOUR = 0;
  const REFRESH_UTC_MINUTE = 7;
  const cron = `${REFRESH_UTC_MINUTE} ${REFRESH_UTC_HOUR} * * *`;

  function nextRefreshTime(nowMs) {
    if (!Number.isFinite(nowMs)) throw new Error("current time must be finite");
    const next = new Date(nowMs);
    next.setUTCHours(REFRESH_UTC_HOUR, REFRESH_UTC_MINUTE, 0, 0);
    if (next.getTime() <= nowMs) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  return { cron, nextRefreshTime };
});
