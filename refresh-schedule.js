(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RefreshSchedule = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const cron = "7 */2 * * *";

  function nextRefreshTime(nowMs) {
    if (!Number.isFinite(nowMs)) throw new Error("current time must be finite");
    const next = new Date(nowMs);
    let hour = next.getUTCHours();
    if (hour % 2 !== 0) hour += 1;
    next.setUTCHours(hour, 7, 0, 0);
    if (next.getTime() <= nowMs) next.setUTCHours(next.getUTCHours() + 2, 7, 0, 0);
    return next;
  }

  return { cron, nextRefreshTime };
});
