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

class RequestLimitError extends Error {}
class RetryDelayError extends Error {}

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function githubPath(slug, suffix = "") {
  return `/repos/${slug.split("/").map(encodeURIComponent).join("/")}${suffix}`;
}

function boundedDelay(milliseconds, maximum) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds > maximum) {
    throw new RetryDelayError(`Retry delay ${milliseconds}ms exceeds maximum ${maximum}ms`);
  }
  return milliseconds;
}

function retryDelay(response, attempt, maximum) {
  const header = response?.headers?.get("retry-after");
  return boundedDelay(header !== null && /^\d+$/.test(header)
    ? Number(header) * 1000
    : 250 * (2 ** attempt), maximum);
}

function shouldRetry(response) {
  if (response.status === 403) return /^\d+$/.test(response.headers.get("retry-after") ?? "");
  return response.status === 408 || response.status === 429 || response.status >= 500;
}

function contributorCount(response, contributors) {
  const last = response.headers.get("link")
    ?.split(",")
    .find(link => /rel="last"/.test(link))
    ?.match(/<([^>]+)>/)?.[1];
  if (!last) return contributors.length;
  const page = Number(new URL(last).searchParams.get("page"));
  return Number.isSafeInteger(page) && page >= contributors.length ? page : contributors.length;
}

function assertRepoMetadata(value, slug) {
  const counts = [value?.stargazers_count, value?.forks_count, value?.open_issues_count];
  if (
    typeof value?.full_name !== "string"
    || value.full_name.toLowerCase() !== slug.toLowerCase()
    || (value.description !== null && typeof value.description !== "string")
    || (value.language !== null && typeof value.language !== "string")
    || counts.some(count => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new Error(`Invalid GitHub metadata for ${slug}`);
  }
}

function readmeIntroduction(readme) {
  if (typeof readme !== "string") return "";
  return readme
    .split(/\r?\n\s*\r?\n/)
    .map(paragraph => paragraph
      .replace(/```[\s\S]*?```/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim())
    .find(Boolean) ?? "";
}

function trendNote(repo) {
  const labels = [
    ["stars_daily", "오늘"],
    ["stars_weekly", "이번 주"],
    ["stars_monthly", "이번 달"],
  ];
  return labels
    .filter(([field]) => Number.isSafeInteger(repo[field]))
    .map(([field, label]) => `${label} ${repo[field].toLocaleString("ko-KR")}개`)
    .join(", ");
}

function periodGains(repo) {
  return Object.fromEntries(Object.values(PERIODS)
    .map(({ field }) => [field, repo[field]])
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
}

function koreanFallback(repo, metadata, readme) {
  const source = metadata.description?.trim() || readmeIntroduction(readme) || `${repo.slug} 공개 저장소`;
  const language = metadata.language ? `${metadata.language} 기반 ` : "";
  const gains = trendNote(repo);
  const goal = `${source} GitHub에 공개된 ${language}저장소다.`;
  const usage = "구체적인 설치 및 사용 절차는 저장소 README 원문을 확인한다.";
  const pros = `${gains}의 스타 증가가 공개 Trending 데이터에서 확인됐다.`;
  const cons = "자동 요약은 공개 설명과 GitHub 메타데이터만 반영하므로 세부 기능과 제약은 README 원문 확인이 필요하다.";
  const fit = `${metadata.language || "오픈소스"} 저장소를 탐색하려는 사용자에게 참고 자료가 된다.`;
  return {
    summary: { goal, usage, pros, cons, fit },
    detail: { goal, usage, pros, cons, fit, stars_note: `${gains}의 스타 증가가 확인됐다.` },
  };
}

export async function enrichTrendingRepositories(discovered, {
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  token = "",
  summaryCache = {},
  previousRepos = [],
  statsDate,
  maxRequests = 250,
  maxAttempts = 3,
  maxRetryDelay = 300000,
  minPublished = 10,
  minCoverage = 0.8,
} = {}) {
  if (!Array.isArray(discovered) || discovered.length < 10 || discovered.length > 75) {
    throw new Error("Discovered repositories must contain 10-75 entries");
  }
  if (typeof fetchImpl !== "function" || typeof sleep !== "function") throw new Error("fetchImpl and sleep must be functions");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(statsDate ?? "")) throw new Error("statsDate must use YYYY-MM-DD");
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("maxRequests must be a positive integer");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("maxAttempts must be between 1 and 5");
  if (!Number.isSafeInteger(maxRetryDelay) || maxRetryDelay < 0) throw new Error("maxRetryDelay must be a non-negative integer");
  if (!Number.isSafeInteger(minPublished) || minPublished < 1) throw new Error("minPublished must be a positive integer");
  if (typeof minCoverage !== "number" || minCoverage <= 0 || minCoverage > 1) throw new Error("minCoverage must be between 0 and 1");

  let requestCount = 0;
  const request = async (path, { accept = "application/vnd.github+json", text = false } = {}) => {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (requestCount >= maxRequests) throw new RequestLimitError(`GitHub request limit ${maxRequests} exceeded`);
      requestCount += 1;
      let response;
      try {
        response = await fetchImpl(`https://api.github.com${path}`, {
          headers: {
            Accept: accept,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
      } catch (error) {
        lastError = error;
        if (attempt + 1 < maxAttempts) {
          await sleep(boundedDelay(250 * (2 ** attempt), maxRetryDelay));
          continue;
        }
        throw new Error(`GitHub request failed for ${path}`);
      }
      if (response.ok) return { response, value: text ? await response.text() : await response.json() };
      lastError = new Error(`GitHub request returned ${response.status} for ${path}`);
      if (!shouldRetry(response) || attempt + 1 >= maxAttempts) throw lastError;
      await sleep(retryDelay(response, attempt, maxRetryDelay));
    }
    throw lastError;
  };

  const summaries = new Map(Object.entries(summaryCache).map(([slug, value]) => [slug.toLowerCase(), value]));
  const previous = new Map(previousRepos.map(repo => [String(repo.slug).toLowerCase(), repo]));
  const repos = [];

  for (const discoveredRepo of discovered) {
    const slug = normalizeSlug(discoveredRepo?.slug ?? "");
    const key = slug.toLowerCase();
    const prior = previous.get(key);
    let metadata;
    let contributors;
    try {
      ({ value: metadata } = await request(githubPath(slug)));
      assertRepoMetadata(metadata, slug);
      const result = await request(`${githubPath(slug, "/contributors")}?anon=1&per_page=1`);
      if (!Array.isArray(result.value)) throw new Error(`Invalid GitHub contributors for ${slug}`);
      contributors = contributorCount(result.response, result.value);
    } catch (error) {
      if (error instanceof RequestLimitError || error instanceof RetryDelayError) throw error;
      if (!prior) continue;
      const retained = { ...prior };
      for (const { field } of Object.values(PERIODS)) delete retained[field];
      const cached = summaries.get(key);
      repos.push({
        ...retained,
        slug,
        ...periodGains(discoveredRepo),
        ...(cached ? { summary: cached.summary, detail: cached.detail } : {}),
        _stats_date: statsDate,
      });
      continue;
    }

    let cached = summaries.get(key);
    if (!cached) {
      let readme = "";
      try {
        ({ value: readme } = await request(githubPath(slug, "/readme"), {
          accept: "application/vnd.github.raw+json",
          text: true,
        }));
      } catch (error) {
        if (error instanceof RequestLimitError || error instanceof RetryDelayError) throw error;
      }
      cached = koreanFallback({ ...discoveredRepo, slug }, metadata, readme);
    }

    const [owner, name] = slug.split("/");
    repos.push({
      slug,
      name: `${owner} / ${name}`,
      desc: metadata.description ?? "",
      lang: metadata.language ?? "",
      stars: metadata.stargazers_count,
      forks: metadata.forks_count,
      ...periodGains(discoveredRepo),
      color: prior?.lang === metadata.language && prior.color ? prior.color : "#8b949e",
      summary: cached.summary,
      detail: cached.detail,
      issues: metadata.open_issues_count,
      contributors,
      _stats_date: statsDate,
    });
  }

  const coverage = repos.length / discovered.length;
  if (repos.length < minPublished) {
    throw new Error(`Published repository count ${repos.length} is below ${minPublished}`);
  }
  if (coverage < minCoverage) {
    throw new Error(`Metadata coverage ${Math.round(coverage * 100)}% is below ${Math.round(minCoverage * 100)}%`);
  }
  return { repos, requestCount };
}
