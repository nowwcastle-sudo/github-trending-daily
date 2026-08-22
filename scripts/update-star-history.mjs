const REPOS_START = "// GENERATED:TRENDING-REPOS:START";
const REPOS_END = "// GENERATED:TRENDING-REPOS:END";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ESTIMATED_POINTS = 500;
const MAX_OBSERVED_POINTS = 730;

function markerRegion(value) {
  const starts = value.split(REPOS_START).length - 1;
  const ends = value.split(REPOS_END).length - 1;
  if (starts !== 1 || ends !== 1) throw new Error("Expected exactly one REPOS marker pair");
  const from = value.indexOf(REPOS_START) + REPOS_START.length;
  const to = value.indexOf(REPOS_END, from);
  if (to < from) throw new Error("Invalid REPOS marker order");
  return value.slice(from, to).trim();
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  const date = match && new Date(`${value}T00:00:00Z`);
  return Boolean(
    match
    && !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]),
  );
}

function assertDate(value) {
  if (!validDate(value)) throw new Error(`invalid cache date: ${String(value)}`);
}

function validateRepo(repo) {
  if (typeof repo?.slug !== "string" || !REPO_RE.test(repo.slug)) {
    throw new Error(`invalid slug: ${String(repo?.slug)}`);
  }
  if (!Number.isSafeInteger(repo.stars) || repo.stars < 0) {
    throw new Error(`invalid stars: ${repo.slug}`);
  }
  return { slug: repo.slug, stars: repo.stars };
}

function validateRepos(repos) {
  if (!Array.isArray(repos) || repos.length < 10 || repos.length > 75) {
    throw new Error("REPOS must contain 10-75 repositories");
  }
  const seen = new Set();
  return repos.map(value => {
    const repo = validateRepo(value);
    const key = repo.slug.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate slug: ${repo.slug}`);
    seen.add(key);
    return repo;
  });
}

function validPoint(value) {
  return validDate(value?.date) && Number.isSafeInteger(value?.stars) && value.stars >= 0;
}

function normalizePoints(points, maximum) {
  if (!Array.isArray(points)) return [];
  const byDate = new Map();
  for (const point of points) {
    if (validPoint(point)) byDate.set(point.date, { date: point.date, stars: point.stars });
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-maximum);
}

function parseStars(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function extractRepos(html) {
  if (typeof html !== "string") throw new Error("REPOS page must be text");
  const match = /^const REPOS = (\[[\s\S]*\]);$/.exec(markerRegion(html));
  if (!match) throw new Error("Generated REPOS region is malformed");
  return validateRepos(JSON.parse(match[1]));
}

export function normalizeEstimatedRows(rows) {
  if (!Array.isArray(rows)) throw new Error("OSS Insight rows must be an array");
  const byDate = new Map();
  for (const row of rows.slice(0, MAX_ESTIMATED_POINTS)) {
    const stars = parseStars(row?.stargazers);
    if (validDate(row?.date) && stars !== null) {
      byDate.set(row.date, { date: row.date, stars });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function mergeRepository(repoValue, prior, rows, date) {
  const repo = validateRepo(repoValue);
  assertDate(date);
  const estimated = rows === null
    ? normalizePoints(prior?.estimated, MAX_ESTIMATED_POINTS)
    : normalizeEstimatedRows(rows);
  const observed = normalizePoints([
    ...(Array.isArray(prior?.observed) ? prior.observed : []),
    { date, stars: repo.stars },
  ], MAX_OBSERVED_POINTS);
  return { slug: repo.slug, estimated, observed };
}

function keyedEntries(entries, label) {
  const keyed = new Map();
  for (const [slug, value] of entries) {
    if (typeof slug !== "string" || !REPO_RE.test(slug)) throw new Error(`invalid ${label} slug: ${String(slug)}`);
    const key = slug.toLowerCase();
    if (keyed.has(key)) throw new Error(`duplicate ${label} slug: ${slug}`);
    keyed.set(key, value);
  }
  return keyed;
}

export function buildCache(repoValues, priorCache, responses, date) {
  assertDate(date);
  const repos = validateRepos(repoValues);
  if (!(responses instanceof Map)) throw new Error("responses must be a Map");
  if (
    priorCache !== null
    && priorCache !== undefined
    && (priorCache?.version !== 1 || !Array.isArray(priorCache.repositories))
  ) {
    throw new Error("prior cache must use version 1");
  }

  const priorEntries = (priorCache?.repositories ?? []).map(entry => [entry?.slug, entry]);
  const priorBySlug = keyedEntries(priorEntries, "cache");
  const responsesBySlug = keyedEntries(responses.entries(), "response");
  return {
    version: 1,
    generatedAt: date,
    repositories: repos.map(repo => {
      const key = repo.slug.toLowerCase();
      return mergeRepository(
        repo,
        priorBySlug.get(key),
        responsesBySlug.has(key) ? responsesBySlug.get(key) : null,
        date,
      );
    }),
  };
}
