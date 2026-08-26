(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MembershipHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function exactKeys(value, expected) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
  }

  function validDate(value) {
    const match = typeof value === "string" && DATE_RE.exec(value);
    if (!match) return false;
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const parsed = new Date(time);
    return parsed.getUTCFullYear() === Number(match[1])
      && parsed.getUTCMonth() === Number(match[2]) - 1
      && parsed.getUTCDate() === Number(match[3]);
  }

  function validTime(value) {
    return typeof value === "string" && TIME_RE.test(value) && Number.isFinite(Date.parse(value));
  }

  function checkedSlug(value) {
    if (typeof value !== "string" || value.length > 201 || !SLUG_RE.test(value)) {
      throw new Error("invalid membership slug");
    }
    return value;
  }

  function normalize(value) {
    if (!exactKeys(value, ["schemaVersion", "generatedAt", "statsDate", "baseline", "current", "exited"])) {
      throw new Error("invalid membership status schema");
    }
    if (value.schemaVersion !== 1 || typeof value.baseline !== "boolean" || !validTime(value.generatedAt) || !validDate(value.statsDate)) {
      throw new Error("invalid membership status metadata");
    }
    if (!Array.isArray(value.current) || value.current.length < 10 || value.current.length > 75) {
      throw new Error("invalid membership current list");
    }
    const currentSeen = new Set();
    const statuses = value.baseline ? new Set(["baseline"]) : new Set(["new", "reentered", "stayed"]);
    const current = value.current.map(item => {
      if (!exactKeys(item, ["slug", "status"]) || !statuses.has(item.status)) {
        throw new Error("invalid membership current item");
      }
      const slug = checkedSlug(item.slug);
      const key = slug.toLowerCase();
      if (currentSeen.has(key)) throw new Error("duplicate membership current slug");
      currentSeen.add(key);
      return { slug, status: item.status };
    });
    if (!Array.isArray(value.exited) || value.exited.length > 75 || (value.baseline && value.exited.length)) {
      throw new Error("invalid membership exited list");
    }
    const exitedSeen = new Set();
    const exited = value.exited.map(item => {
      if (!exactKeys(item, ["slug", "lastSeenAt", "exitedAt"])) throw new Error("invalid membership exited item");
      const slug = checkedSlug(item.slug);
      const key = slug.toLowerCase();
      if (
        currentSeen.has(key) || exitedSeen.has(key)
        || !validTime(item.lastSeenAt) || !validTime(item.exitedAt)
        || item.exitedAt !== value.generatedAt
      ) {
        throw new Error("invalid membership exited identity");
      }
      exitedSeen.add(key);
      return { slug, lastSeenAt: item.lastSeenAt, exitedAt: item.exitedAt };
    });
    return {
      schemaVersion: 1,
      generatedAt: value.generatedAt,
      statsDate: value.statsDate,
      baseline: value.baseline,
      current,
      exited,
    };
  }

  function currentStatus(value) {
    return new Map(value.current.map(item => [item.slug.toLowerCase(), item.status]));
  }

  async function load(url, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") throw new Error("membership fetch is unavailable");
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response?.ok) throw new Error(`membership HTTP ${Number.isInteger(response?.status) ? response.status : "error"}`);
    let body;
    try { body = await response.json(); }
    catch { throw new Error("membership response is not JSON"); }
    return normalize(body);
  }

  return { normalize, currentStatus, load };
});
