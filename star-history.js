(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StarHistory = api;
}(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const EXPLANATION = "GH Archive 기반 과거 추정 · 현재 총 스타는 GitHub 기준";

  function validDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    const date = match && new Date(`${value}T00:00:00Z`);
    return Boolean(match
      && !Number.isNaN(date.getTime())
      && date.getUTCFullYear() === Number(match[1])
      && date.getUTCMonth() + 1 === Number(match[2])
      && date.getUTCDate() === Number(match[3]));
  }

  function validPoint(point) {
    return point
      && validDate(point.date)
      && Number.isSafeInteger(point.stars)
      && point.stars >= 0;
  }

  function exactKeys(value, expected) {
    return value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
  }

  function validOrderedPoints(points, maximum) {
    return Array.isArray(points)
      && points.length <= maximum
      && points.every((point, index) => (
        exactKeys(point, ["date", "stars"])
        && validPoint(point)
        && (index === 0 || points[index - 1].date < point.date)
      ));
  }

  function normalizeCache(value) {
    if (
      !exactKeys(value, ["version", "generatedAt", "repositories"])
      || value.version !== 1
      || !validDate(value.generatedAt)
      || !Array.isArray(value.repositories)
      || value.repositories.length > 75
    ) {
      throw new Error("invalid cache schema");
    }
    const seen = new Set();
    const result = new Map();
    for (const entry of value.repositories) {
      if (
        !exactKeys(entry, ["slug", "estimated", "observed"])
        || typeof entry.slug !== "string"
        || !REPO_RE.test(entry.slug)
        || !validOrderedPoints(entry.estimated, 500)
        || !validOrderedPoints(entry.observed, 730)
      ) {
        throw new Error("invalid cache schema");
      }
      const key = entry.slug.toLowerCase();
      if (seen.has(key)) throw new Error("invalid cache schema");
      seen.add(key);
      result.set(entry.slug, {
        slug: entry.slug,
        estimated: entry.estimated.map(({ date, stars }) => ({ date, stars })),
        observed: entry.observed.map(({ date, stars }) => ({ date, stars })),
      });
    }
    return result;
  }

  function displayPoints(entry) {
    if (!entry) return [];
    const byDate = new Map();
    for (const point of entry.estimated || []) {
      if (validPoint(point)) byDate.set(point.date, { date: point.date, stars: point.stars });
    }
    for (const point of entry.observed || []) {
      if (validPoint(point)) byDate.set(point.date, { date: point.date, stars: point.stars });
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  function sparkline(points, width = 220, height = 40) {
    if (!Array.isArray(points) || points.length < 2 || !points.every(validPoint)) return "";
    const w = Number.isFinite(width) && width > 0 ? width : 220;
    const h = Number.isFinite(height) && height > 0 ? height : 40;
    const values = points.map(point => point.stars);
    const min = Math.min(...values);
    const span = Math.max(Math.max(...values) - min, 1);
    const step = w / (points.length - 1);
    const coordinates = values.map((value, index) =>
      `${(index * step).toFixed(1)},${(h - ((value - min) / span) * (h - 4) - 2).toFixed(1)}`
    ).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="스타 추이"><polyline points="${coordinates}" fill="none" stroke="var(--hot)" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }

  function historyHtml(slug, entry) {
    const points = displayPoints(entry);
    if (points.length === 0) return '<p class="histnote">📈 스타 추이 데이터가 없어요</p>';
    if (points.length === 1) {
      return `<p class="histnote">📈 관측 데이터 1일 · ${EXPLANATION}</p>`;
    }
    return `<p class="histnote">📈 스타 히스토리</p>${sparkline(points)}<p class="histnote">${EXPLANATION}</p>`;
  }

  async function load(url, fetchImpl) {
    let response;
    try {
      response = await fetchImpl(url);
    } catch {
      throw new Error("star history request failed");
    }
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? ` ${response.status}` : "";
      throw new Error(`star history HTTP${status}`);
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error("star history JSON");
    }
    try {
      return normalizeCache(value);
    } catch (error) {
      throw new Error(`star history schema: ${error.message}`);
    }
  }

  return { normalizeCache, displayPoints, sparkline, historyHtml, load };
}));
