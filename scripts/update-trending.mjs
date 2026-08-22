const PERIODS = {
  daily: { field: "stars_daily", label: "today" },
  weekly: { field: "stars_weekly", label: "this week" },
  monthly: { field: "stars_monthly", label: "this month" },
};

function periodConfig(period) {
  const config = PERIODS[period];
  if (!config) throw new Error(`Unsupported Trending period: ${period}`);
  return config;
}

function normalizeSlug(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`Invalid repository path: ${path}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(decoded)) {
    throw new Error(`Invalid repository path: ${path}`);
  }
  return decoded;
}

export function parseTrendingHtml(html, period) {
  const { field, label } = periodConfig(period);
  if (typeof html !== "string" || !html.trim()) throw new Error("Trending HTML is empty");

  const repos = [];
  const seen = new Set();
  const articles = html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi);
  for (const [, attributes, body] of articles) {
    if (!/\bclass\s*=\s*(?:"[^"]*\bBox-row\b[^"]*"|'[^']*\bBox-row\b[^']*')/i.test(attributes)) continue;

    const heading = body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "";
    const path = heading.match(/<a\b[^>]*\bhref\s*=\s*(?:"\/([^"?#]+)"|'\/([^'?#]+)')/i);
    if (!path) throw new Error("Invalid Trending repository link");
    const slug = normalizeSlug(path[1] ?? path[2]);

    const gainPattern = new RegExp(`^([\\d,]+)\\s+stars?\\s+${label.replaceAll(" ", "\\s+")}$`, "i");
    const gains = [...body.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      .map(([, content]) => content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().match(gainPattern))
      .filter(Boolean);
    const rawGain = gains.length === 1 ? gains[0][1] : "";
    const value = /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(rawGain)
      ? Number(rawGain.replaceAll(",", ""))
      : NaN;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${period} star gain for ${slug}`);

    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate repository in ${period} Trending: ${slug}`);
    seen.add(key);
    repos.push({ slug, [field]: value });
  }

  if (!repos.length) throw new Error("Trending page contains no Trending repositories");
  if (repos.length < 5) throw new Error(`Trending ${period} expected at least 5 repositories, got ${repos.length}`);
  return repos;
}

export function mergeTrendingPeriods(periods) {
  const merged = [];
  const bySlug = new Map();

  for (const period of Object.keys(PERIODS)) {
    const repos = periods?.[period];
    const { field } = PERIODS[period];
    if (!Array.isArray(repos) || repos.length < 5) {
      throw new Error(`Trending ${period} expected at least 5 repositories`);
    }

    const seen = new Set();
    for (const repo of repos) {
      const slug = normalizeSlug(repo?.slug ?? "");
      const gain = repo?.[field];
      if (!Number.isSafeInteger(gain) || gain < 0) throw new Error(`Invalid ${period} star gain for ${slug}`);

      const key = slug.toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate repository in ${period} Trending: ${slug}`);
      seen.add(key);

      const existing = bySlug.get(key);
      if (existing) existing[field] = gain;
      else {
        const added = { slug, [field]: gain };
        bySlug.set(key, added);
        merged.push(added);
      }
    }
  }

  if (merged.length < 10 || merged.length > 75) {
    throw new Error(`Trending union size ${merged.length} is outside 10-75`);
  }
  return merged;
}
