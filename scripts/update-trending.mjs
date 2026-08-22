import { randomUUID } from "node:crypto";
import {
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const REPOS_START = "// GENERATED:TRENDING-REPOS:START";
const REPOS_END = "// GENERATED:TRENDING-REPOS:END";
const DATE_START = "<!-- GENERATED:TRENDING-DATE:START -->";
const DATE_END = "<!-- GENERATED:TRENDING-DATE:END -->";
const SUMMARY_FIELDS = ["goal", "usage", "pros", "cons", "fit"];

function assertValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  const date = match && new Date(`${value}T00:00:00Z`);
  if (
    !match
    || Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error("statsDate must be a valid YYYY-MM-DD date");
  }
}

function markedRegion(value, start, end, name) {
  const starts = value.split(start).length - 1;
  const ends = value.split(end).length - 1;
  if (starts !== 1 || ends !== 1) throw new Error(`Expected exactly one ${name} marker pair`);
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  if (to < from) throw new Error(`Invalid ${name} marker order`);
  return { from, to: to + end.length, bodyFrom: from + start.length, bodyTo: to };
}

function replaceMarkedRegion(value, start, end, name, body) {
  const region = markedRegion(value, start, end, name);
  return `${value.slice(0, region.bodyFrom)}\n${body}\n${value.slice(region.bodyTo)}`;
}

function parsePageRepos(page) {
  const region = markedRegion(page, REPOS_START, REPOS_END, "REPOS");
  const body = page.slice(region.bodyFrom, region.bodyTo).trim();
  const match = /^const REPOS = (\[[\s\S]*\]);$/.exec(body);
  if (!match) throw new Error("Generated REPOS region is malformed");
  const repos = JSON.parse(match[1]);
  if (!Array.isArray(repos)) throw new Error("Generated REPOS value must be an array");
  return repos;
}

function assertCompleteSummary(repo, statsDate) {
  const slug = normalizeSlug(repo?.slug ?? "");
  if (repo._stats_date !== statsDate) throw new Error(`Published ${slug} has the wrong stats date`);
  const complete = [
    ...SUMMARY_FIELDS.map(field => repo?.summary?.[field]),
    ...SUMMARY_FIELDS.map(field => repo?.detail?.[field]),
    repo?.detail?.stars_note,
  ].every(value => typeof value === "string" && value.trim());
  if (!complete) throw new Error(`Published ${slug} must have a complete summary and detail`);
  return slug;
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function validateSnapshotPair(page, summaryCacheText, statsDate) {
  assertValidDate(statsDate);
  const repos = parsePageRepos(page);
  const cache = JSON.parse(summaryCacheText);
  if (!cache || Array.isArray(cache) || typeof cache !== "object") throw new Error("Summary cache must be an object");
  const cachedBySlug = new Map(Object.entries(cache).map(([slug, value]) => [slug.toLowerCase(), value]));
  const seen = new Set();
  for (const repo of repos) {
    const slug = assertCompleteSummary(repo, statsDate);
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate published repository: ${slug}`);
    seen.add(key);
    const cached = cachedBySlug.get(key);
    if (!cached || JSON.stringify(cached.summary) !== JSON.stringify(repo.summary) || JSON.stringify(cached.detail) !== JSON.stringify(repo.detail)) {
      throw new Error(`Summary cache does not match published ${slug}`);
    }
  }
  const dateRegion = markedRegion(page, DATE_START, DATE_END, "date");
  const dateBody = page.slice(dateRegion.bodyFrom, dateRegion.bodyTo).trim();
  if (dateBody !== `<time id="lastUpdated" datetime="${statsDate}">${statsDate} (Asia/Seoul)</time>`) {
    throw new Error("Generated update date is malformed");
  }
  return repos;
}

export function createPageSnapshot({ page, summaryCache, repos, statsDate }) {
  if (typeof page !== "string" || !Array.isArray(repos)) throw new Error("Page and repositories are required");
  assertValidDate(statsDate);
  if (!summaryCache || Array.isArray(summaryCache) || typeof summaryCache !== "object") {
    throw new Error("Summary cache must be an object");
  }

  const nextCache = { ...summaryCache };
  const cacheKeys = new Map(Object.keys(nextCache).map(slug => [slug.toLowerCase(), slug]));
  const seen = new Set();
  for (const repo of repos) {
    const slug = assertCompleteSummary(repo, statsDate);
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate published repository: ${slug}`);
    seen.add(key);
    const cacheKey = cacheKeys.get(key) ?? slug;
    nextCache[cacheKey] = { summary: repo.summary, detail: repo.detail };
    cacheKeys.set(key, cacheKey);
  }

  let nextPage = replaceMarkedRegion(page, REPOS_START, REPOS_END, "REPOS", `const REPOS = ${inlineJson(repos)};`);
  nextPage = replaceMarkedRegion(
    nextPage,
    DATE_START,
    DATE_END,
    "date",
    `<time id="lastUpdated" datetime="${statsDate}">${statsDate} (Asia/Seoul)</time>`,
  );
  const summaryCacheText = `${JSON.stringify(nextCache, null, 2)}\n`;
  validateSnapshotPair(nextPage, summaryCacheText, statsDate);
  return { page: nextPage, summaryCacheText };
}

async function cleanup(paths) {
  await Promise.all(paths.map(path => rm(path, { force: true }).catch(() => {})));
}

export async function installPageSnapshot({
  pagePath,
  cachePath,
  page,
  summaryCacheText,
  renameImpl = rename,
}) {
  const originals = await Promise.all([readFile(pagePath), readFile(cachePath)]);
  if (originals[0].equals(Buffer.from(page)) && originals[1].equals(Buffer.from(summaryCacheText))) return false;

  const suffix = `${process.pid}-${randomUUID()}`;
  const pagePending = `${pagePath}.pending-${suffix}`;
  const cachePending = `${cachePath}.pending-${suffix}`;
  const pageBackup = `${pagePath}.backup-${suffix}`;
  const cacheBackup = `${cachePath}.backup-${suffix}`;
  const temporary = [pagePending, cachePending, pageBackup, cacheBackup];
  let pageBacked = false;
  let cacheBacked = false;
  let pageInstalled = false;
  let cacheInstalled = false;

  try {
    await Promise.all([
      writeFile(pagePending, page),
      writeFile(cachePending, summaryCacheText),
    ]);
    const prepared = await Promise.all([readFile(pagePending, "utf8"), readFile(cachePending, "utf8")]);
    const statsDate = parsePageRepos(prepared[0])[0]?._stats_date;
    validateSnapshotPair(prepared[0], prepared[1], statsDate);

    await renameImpl(pagePath, pageBackup);
    pageBacked = true;
    await renameImpl(cachePath, cacheBackup);
    cacheBacked = true;
    await renameImpl(pagePending, pagePath);
    pageInstalled = true;
    await renameImpl(cachePending, cachePath);
    cacheInstalled = true;
    await cleanup([pageBackup, cacheBackup]);
    return true;
  } catch (error) {
    const rollbackErrors = [];
    if (pageInstalled) await rm(pagePath, { force: true }).catch(rollbackError => rollbackErrors.push(rollbackError));
    if (cacheInstalled) await rm(cachePath, { force: true }).catch(rollbackError => rollbackErrors.push(rollbackError));
    if (pageBacked) await rename(pageBackup, pagePath).catch(rollbackError => rollbackErrors.push(rollbackError));
    if (cacheBacked) await rename(cacheBackup, cachePath).catch(rollbackError => rollbackErrors.push(rollbackError));
    await cleanup(temporary);
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Snapshot installation and rollback failed");
    throw error;
  }
}

export function seoulDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function fetchTrendingPage(period, { fetchImpl, sleep, maxAttempts = 3, maxRetryDelay = 300000 }) {
  const url = `https://github.com/trending?since=${period}`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: "text/html" } });
    } catch {
      if (attempt + 1 >= maxAttempts) throw new Error(`Trending request failed for ${period}`);
      await sleep(boundedDelay(250 * (2 ** attempt), maxRetryDelay));
      continue;
    }
    if (response.ok) return response.text();
    if (!shouldRetry(response) || attempt + 1 >= maxAttempts) {
      throw new Error(`Trending request returned ${response.status} for ${period}`);
    }
    await sleep(retryDelay(response, attempt, maxRetryDelay));
  }
  throw new Error(`Trending request failed for ${period}`);
}

export async function runTrendingUpdate({
  check = false,
  pagePath,
  cachePath,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  token = "",
  now = new Date(),
} = {}) {
  if (!pagePath || !cachePath) throw new Error("pagePath and cachePath are required");
  const [page, cacheText] = await Promise.all([readFile(pagePath, "utf8"), readFile(cachePath, "utf8")]);
  const summaryCache = JSON.parse(cacheText);
  const previousRepos = parsePageRepos(page);
  const periods = Object.fromEntries(await Promise.all(Object.keys(PERIODS).map(async period => [
    period,
    parseTrendingHtml(await fetchTrendingPage(period, { fetchImpl, sleep }), period),
  ])));
  const discovered = mergeTrendingPeriods(periods);
  const statsDate = seoulDate(now);
  const { repos, requestCount } = await enrichTrendingRepositories(discovered, {
    fetchImpl,
    sleep,
    token,
    summaryCache,
    previousRepos,
    statsDate,
  });
  const snapshot = createPageSnapshot({ page, summaryCache, repos, statsDate });
  const changed = page !== snapshot.page || cacheText !== snapshot.summaryCacheText;
  if (!check && changed) await installPageSnapshot({ pagePath, cachePath, ...snapshot });
  return { changed, repos, requestCount, statsDate };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--check") || args.filter(arg => arg === "--check").length > 1) {
    throw new Error("Usage: node scripts/update-trending.mjs [--check]");
  }
  const check = args.includes("--check");
  const result = await runTrendingUpdate({
    check,
    pagePath: fileURLToPath(new URL("../index.html", import.meta.url)),
    cachePath: fileURLToPath(new URL("../data/repo-summaries.json", import.meta.url)),
    token: process.env.GITHUB_TOKEN ?? "",
  });
  console.log(`${check ? "Validated" : result.changed ? "Updated" : "Unchanged"}: ${result.repos.length} repositories for ${result.statsDate} (Asia/Seoul)`);
}
