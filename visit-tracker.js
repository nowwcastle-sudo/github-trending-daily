(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VisitTracker = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LAST_VISIT_KEY = "gi.visit.lastAt";
  const SEEN_KEY = "gi.visit.seen";
  const SEEN_LIMIT = 1000;
  const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function isValidSlug(value) {
    return typeof value === "string" && value.length <= 201 && SLUG_RE.test(value);
  }

  function normalizeSlugs(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(isValidSlug))].slice(-SEEN_LIMIT);
  }

  function checkedTime(value) {
    if (typeof value !== "string" || !TIME_RE.test(value)) return null;
    return new Date(value).toISOString() === value ? value : null;
  }

  function readSeen(storage) {
    try { return normalizeSlugs(JSON.parse(storage.getItem(SEEN_KEY) || "[]")); }
    catch { return []; }
  }

  function readLastVisit(storage) {
    try { return checkedTime(storage.getItem(LAST_VISIT_KEY)); }
    catch { return null; }
  }

  function newSlugs({ slugs, seen }) {
    const known = new Set(normalizeSlugs(seen));
    return normalizeSlugs(slugs).filter(slug => !known.has(slug));
  }

  // A reader who has never been here has no "new to you" set — everything is new, which is the
  // same as nothing being marked. previousVisitAt === null is what the page renders the plain
  // heading from.
  function recordVisit(storage, { slugs, now }) {
    const current = normalizeSlugs(slugs);
    const previousVisitAt = readLastVisit(storage);
    const seen = readSeen(storage);
    const fresh = previousVisitAt === null ? [] : newSlugs({ slugs: current, seen });
    const merged = normalizeSlugs([...seen, ...current]);
    const stamp = checkedTime(now);
    try {
      storage.setItem(SEEN_KEY, JSON.stringify(merged));
      if (stamp) storage.setItem(LAST_VISIT_KEY, stamp);
    } catch { /* a browser with storage off still renders the list */ }
    return { previousVisitAt, newSlugs: fresh, seen: merged };
  }

  return { LAST_VISIT_KEY, SEEN_KEY, SEEN_LIMIT, isValidSlug, normalizeSlugs, readSeen, readLastVisit, newSlugs, recordVisit };
});
