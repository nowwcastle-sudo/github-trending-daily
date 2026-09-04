(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StarHistory = api;
}(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  // star-history.json v2 (2026-09-03 design §5.1): exact star totals observed by
  // this site's star-ticks workflow plus dashed anchors back-calculated from
  // GitHub Trending period gains. Anchors are approximations and are drawn
  // dashed with hollow markers; observations are solid and break at gaps.
  const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const ANCHOR_SOURCES = ["github_created_at", "github_trending_gain_daily", "github_trending_gain_weekly", "github_trending_gain_monthly"];
  const OBSERVED_SOURCE = "github_rest";
  const MAX_ANCHORS = 4;
  const MAX_OBSERVED = 2000;
  const GAP_MS = 36 * 60 * 60 * 1000;
  const EXPLANATION = "이 사이트가 직접 관측한 총 스타(30분 간격) · 점선은 GitHub Trending 기간 집계로 역산한 앵커";
  const OBSERVED_SINCE_PREFIX = "관측 시작 ";

  function validTime(value) {
    if (typeof value !== "string" || !TIME_RE.test(value)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z") === value;
  }

  function exactKeys(value, expected) {
    return value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
  }

  function validPoint(point, sources) {
    return exactKeys(point, ["at", "stars", "source"])
      && validTime(point.at)
      && Number.isSafeInteger(point.stars)
      && point.stars >= 0
      && sources.includes(point.source);
  }

  function validOrderedPoints(points, maximum, sources) {
    return Array.isArray(points)
      && points.length <= maximum
      && points.every((point, index) => validPoint(point, sources) && (index === 0 || points[index - 1].at < point.at));
  }

  function normalizeCache(value) {
    if (
      !exactKeys(value, ["version", "generatedAt", "repositories"])
      || value.version !== 2
      || !validTime(value.generatedAt)
      || !Array.isArray(value.repositories)
      || value.repositories.length > 75
    ) {
      throw new Error("invalid cache schema");
    }
    const seen = new Set();
    const result = new Map();
    for (const entry of value.repositories) {
      if (
        !exactKeys(entry, ["slug", "anchors", "observed"])
        || typeof entry.slug !== "string"
        || !REPO_RE.test(entry.slug)
        || !validOrderedPoints(entry.anchors, MAX_ANCHORS, ANCHOR_SOURCES)
        || !validOrderedPoints(entry.observed, MAX_OBSERVED, [OBSERVED_SOURCE])
      ) {
        throw new Error("invalid cache schema");
      }
      const key = entry.slug.toLowerCase();
      if (seen.has(key)) throw new Error("invalid cache schema");
      seen.add(key);
      result.set(entry.slug, {
        slug: entry.slug,
        anchors: entry.anchors.map(({ at, stars, source }) => ({ at, stars, source })),
        observed: entry.observed.map(({ at, stars, source }) => ({ at, stars, source })),
      });
    }
    return result;
  }

  function displayPoints(entry) {
    if (!entry) return [];
    const points = [];
    for (const point of entry.anchors || []) {
      if (validPoint(point, ANCHOR_SOURCES)) points.push({ at: point.at, stars: point.stars, kind: "anchor" });
    }
    for (const point of entry.observed || []) {
      if (validPoint(point, [OBSERVED_SOURCE])) points.push({ at: point.at, stars: point.stars, kind: "observed" });
    }
    return points.sort((a, b) => a.at.localeCompare(b.at));
  }

  function sparkline(points, width = 220, height = 40) {
    if (!Array.isArray(points) || points.length < 2) return "";
    const w = Number.isFinite(width) && width > 0 ? width : 220;
    const h = Number.isFinite(height) && height > 0 ? height : 40;
    const times = points.map(point => Date.parse(point.at));
    const values = points.map(point => point.stars);
    if (times.some(time => !Number.isFinite(time)) || values.some(value => !Number.isSafeInteger(value) || value < 0)) return "";
    const tMin = Math.min(...times);
    const tSpan = Math.max(Math.max(...times) - tMin, 1);
    const min = Math.min(...values);
    const span = Math.max(Math.max(...values) - min, 1);
    const coordinate = index => ({
      x: Number((((times[index] - tMin) / tSpan) * w).toFixed(1)),
      y: Number((h - ((values[index] - min) / span) * (h - 4) - 2).toFixed(1)),
    });
    const pair = index => { const { x, y } = coordinate(index); return `${x},${y}`; };
    const parts = [];
    // Anchors: dashed line through the anchors and on to the first observation.
    const anchorIndexes = points.map((point, index) => (point.kind === "anchor" ? index : -1)).filter(index => index >= 0);
    const firstObserved = points.findIndex(point => point.kind === "observed");
    const anchorLine = firstObserved >= 0 ? [...anchorIndexes.filter(index => index < firstObserved), firstObserved] : anchorIndexes;
    if (anchorLine.length >= 2) {
      parts.push(`<polyline class="hist-anchor" points="${anchorLine.map(pair).join(" ")}" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="3 3"/>`);
    }
    for (const index of anchorIndexes) {
      const { x, y } = coordinate(index);
      parts.push(`<circle class="hist-anchor-dot" cx="${x}" cy="${y}" r="2.5" fill="none" stroke="var(--text-3)" stroke-width="1.5"/>`);
    }
    // Observations: solid segments, broken wherever consecutive points are far apart.
    let segment = [];
    const flush = () => {
      if (segment.length >= 2) {
        parts.push(`<polyline class="hist-observed" points="${segment.map(pair).join(" ")}" fill="none" stroke="var(--hot)" stroke-width="2" stroke-linejoin="round"/>`);
      } else if (segment.length === 1) {
        const { x, y } = coordinate(segment[0]);
        parts.push(`<circle class="hist-observed-dot" cx="${x}" cy="${y}" r="2" fill="var(--hot)"/>`);
      }
      segment = [];
    };
    for (let index = 0; index < points.length; index += 1) {
      if (points[index].kind !== "observed") continue;
      if (segment.length > 0 && times[index] - times[segment[segment.length - 1]] > GAP_MS) flush();
      segment.push(index);
    }
    flush();
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="스타 추이">${parts.join("")}</svg>`;
  }

  function observedStartLabel(points) {
    const first = points.find(point => point.kind === "observed");
    return first ? `${OBSERVED_SINCE_PREFIX}${first.at.slice(0, 10)} ${first.at.slice(11, 16)} UTC` : "";
  }

  function historyHtml(slug, entry) {
    const points = displayPoints(entry);
    const observedCount = points.filter(point => point.kind === "observed").length;
    if (points.length === 0 || (observedCount === 0 && points.length < 2)) return '<p class="histnote">📈 관측 시작 대기</p>';
    const since = observedStartLabel(points);
    const explanation = since ? `${EXPLANATION} · ${since}` : EXPLANATION;
    if (points.length === 1) return `<p class="histnote">📈 관측 1회 · ${explanation}</p>`;
    return `<p class="histnote">📈 스타 히스토리</p>${sparkline(points)}<p class="histnote">${explanation}</p>`;
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
