import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  enrichTrendingRepositories,
  mergeTrendingPeriods,
  parseTrendingHtml,
} from "../scripts/update-trending.mjs";

const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("parses normalized slugs and the period's star gain", async () => {
  const daily = parseTrendingHtml(await fixture("trending-daily.html"), "daily");
  const weekly = parseTrendingHtml(await fixture("trending-weekly.html"), "weekly");

  assert.deepEqual(daily[0], { slug: "Alpha/one", stars_daily: 1234 });
  assert.deepEqual(weekly[0], { slug: "alpha/one", stars_weekly: 8765 });
  assert.equal(daily.length, 5);
  assert.equal(weekly.length, 5);
});

test("merges in daily, unseen weekly, then unseen monthly order", async () => {
  const periods = Object.fromEntries(await Promise.all(
    ["daily", "weekly", "monthly"].map(async period => [
      period,
      parseTrendingHtml(await fixture(`trending-${period}.html`), period),
    ]),
  ));

  const merged = mergeTrendingPeriods(periods);

  assert.deepEqual(merged.map(repo => repo.slug), [
    "Alpha/one", "Beta/two", "Gamma/three", "Delta/four", "Epsilon/five",
    "Zeta/six", "Eta/seven", "Theta/eight", "Iota/nine", "Kappa/ten",
  ]);
  assert.deepEqual(merged[0], {
    slug: "Alpha/one",
    stars_daily: 1234,
    stars_weekly: 8765,
    stars_monthly: 12345,
  });
});

test("fails closed on malformed, duplicate, and invalid-gain pages", async () => {
  const [daily, malformed, duplicates, invalidGain] = await Promise.all([
    fixture("trending-daily.html"),
    fixture("trending-malformed.html"),
    fixture("trending-duplicates.html"),
    fixture("trending-invalid-gain.html"),
  ]);

  assert.throws(
    () => parseTrendingHtml("", "daily"),
    /Trending HTML is empty/,
  );
  assert.throws(
    () => parseTrendingHtml(malformed, "daily"),
    /no Trending repositories/,
  );
  assert.throws(
    () => parseTrendingHtml(duplicates, "daily"),
    /duplicate repository/i,
  );
  assert.throws(
    () => parseTrendingHtml(invalidGain, "daily"),
    /invalid daily star gain/i,
  );
  assert.throws(
    () => parseTrendingHtml(daily.replace("1,234 stars today", "1,2 stars today"), "daily"),
    /invalid daily star gain/i,
  );
  assert.throws(
    () => parseTrendingHtml(daily.replace("<span>1,234 stars today</span>", "<p>123 stars today in docs</p><span>many stars today</span>"), "daily"),
    /invalid daily star gain/i,
  );
  assert.throws(
    () => parseTrendingHtml(daily.replace('href="/Alpha/one"', 'href="//evil.com/repo"'), "daily"),
    /invalid repository path/i,
  );
  assert.throws(
    () => parseTrendingHtml(daily.replace('href="/Alpha/one"', 'href="/Owner/repo/"'), "daily"),
    /invalid repository path/i,
  );
  assert.throws(
    () => parseTrendingHtml(daily.replace("1,234 stars today", "1,234 stars today in docs"), "daily"),
    /invalid daily star gain/i,
  );
});

test("fails closed when a page or union violates size gates", async () => {
  const daily = parseTrendingHtml(await fixture("trending-daily.html"), "daily");

  assert.throws(
    () => parseTrendingHtml('<article class="Box-row"><h2><a href="/A/one">A/one</a></h2><span>1 star today</span></article>', "daily"),
    /expected at least 5 repositories/,
  );
  assert.throws(
    () => mergeTrendingPeriods({
      daily,
      weekly: daily.map(({ slug, stars_daily }) => ({ slug, stars_weekly: stars_daily })),
      monthly: daily.map(({ slug, stars_daily }) => ({ slug, stars_monthly: stars_daily })),
    }),
    /union size 5 is outside 10-75/,
  );
  assert.throws(
    () => {
      const oversized = Array.from({ length: 76 }, (_, index) => ({ slug: `owner/repo-${index}`, stars_daily: index }));
      return mergeTrendingPeriods({
        daily: oversized,
        weekly: oversized.slice(0, 5).map(({ slug, stars_daily }) => ({ slug, stars_weekly: stars_daily })),
        monthly: oversized.slice(0, 5).map(({ slug, stars_daily }) => ({ slug, stars_monthly: stars_daily })),
      });
    },
    /union size 76 is outside 10-75/,
  );
});

test("seeded cache preserves every summary currently published in the page", async () => {
  const [page, cacheText] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../data/repo-summaries.json", import.meta.url), "utf8"),
  ]);
  const repos = JSON.parse(page.match(/const REPOS = (\[[^\n]+\]);\r?\nlet period=/)?.[1] ?? "null");
  const cache = JSON.parse(cacheText);

  assert.equal(repos.length, 46);
  assert.ok(Object.keys(cache).length >= 46);
  for (const repo of repos) {
    assert.deepEqual(cache[repo.slug], { summary: repo.summary, detail: repo.detail });
  }
});

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => typeof body === "string" ? body : JSON.stringify(body),
});

const discoveredRepos = (count = 10) => Array.from({ length: count }, (_, index) => ({
  slug: `owner/repo-${index}`,
  stars_daily: index + 1,
}));

const cachedSummary = index => ({
  summary: {
    goal: `goal-${index}`,
    usage: `usage-${index}`,
    pros: `pros-${index}`,
    cons: `cons-${index}`,
    fit: `fit-${index}`,
  },
  detail: {
    goal: `detail-goal-${index}`,
    usage: `detail-usage-${index}`,
    pros: `detail-pros-${index}`,
    cons: `detail-cons-${index}`,
    fit: `detail-fit-${index}`,
    stars_note: `stars-${index}`,
  },
});

function successfulGithubFetch({ failures = new Map(), requests = [] } = {}) {
  return async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    const failure = failures.get(path)?.shift();
    if (failure) return failure;
    if (path.endsWith("/contributors")) {
      return jsonResponse(200, [{ login: "one" }], { link: '<https://api.github.com/repositories/1/contributors?per_page=1&page=2>; rel="last"' });
    }
    if (path.endsWith("/readme")) return jsonResponse(200, "README introduction.");
    const slug = path.slice("/repos/".length);
    return jsonResponse(200, {
      full_name: slug,
      description: `Description for ${slug}`,
      language: "JavaScript",
      stargazers_count: 100,
      forks_count: 20,
      open_issues_count: 3,
    });
  };
}

test("enriches REST metadata and reuses cached summaries without modification", async () => {
  const discovered = discoveredRepos();
  const summaryCache = Object.fromEntries(discovered.map((repo, index) => [repo.slug, cachedSummary(index)]));
  const requests = [];

  const { repos, requestCount } = await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch({ requests }),
    token: "test-token-never-print",
    summaryCache,
    statsDate: "2026-08-23",
  });

  assert.equal(requestCount, 20);
  assert.equal(repos.length, 10);
  assert.equal(repos[0].summary, summaryCache[discovered[0].slug].summary);
  assert.equal(repos[0].detail, summaryCache[discovered[0].slug].detail);
  assert.deepEqual(repos[0], {
    slug: "owner/repo-0",
    name: "owner / repo-0",
    desc: "Description for owner/repo-0",
    lang: "JavaScript",
    stars: 100,
    forks: 20,
    stars_daily: 1,
    color: "#8b949e",
    summary: summaryCache[discovered[0].slug].summary,
    detail: summaryCache[discovered[0].slug].detail,
    issues: 3,
    contributors: 2,
    _stats_date: "2026-08-23",
  });
  assert.ok(requests.every(request => request.options.headers.Authorization === "Bearer test-token-never-print"));
  assert.equal(requests.some(request => request.url.endsWith("/readme")), false);
});

test("retries transient failures with bounded exponential backoff", async () => {
  const discovered = discoveredRepos();
  const summaryCache = Object.fromEntries(discovered.map((repo, index) => [repo.slug, cachedSummary(index)]));
  const sleeps = [];
  const failures = new Map([["/repos/owner/repo-0", [
    jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "1" }),
    jsonResponse(502, { message: "temporary" }),
  ]]]);

  const { requestCount } = await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch({ failures }),
    sleep: milliseconds => { sleeps.push(milliseconds); },
    token: "token",
    summaryCache,
    statsDate: "2026-08-23",
  });

  assert.equal(requestCount, 22);
  assert.deepEqual(sleeps, [1000, 500]);
});

test("retains known metadata after rate limit and omits an unresolved new repository", async () => {
  const discovered = discoveredRepos();
  const summaryCache = Object.fromEntries(discovered.map((repo, index) => [repo.slug, cachedSummary(index)]));
  const requests = [];
  const failures = new Map([
    ["/repos/owner/repo-0", [jsonResponse(403, { message: "rate limited" }, { "x-ratelimit-remaining": "0" })]],
    ["/repos/owner/repo-1", [jsonResponse(404, { message: "not found" })]],
  ]);
  const previousRepos = [{
    slug: "owner/repo-0",
    name: "owner / repo-0",
    desc: "Previous description",
    lang: "Rust",
    stars: 90,
    forks: 9,
    stars_weekly: 999,
    color: "#dea584",
    summary: summaryCache[discovered[0].slug].summary,
    detail: summaryCache[discovered[0].slug].detail,
    issues: 2,
    contributors: 7,
    _stats_date: "2026-08-22",
  }];

  const { repos } = await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch({ failures, requests }),
    token: "token",
    summaryCache,
    previousRepos,
    statsDate: "2026-08-23",
    minPublished: 5,
  });

  assert.equal(repos.length, 9);
  assert.equal(repos.some(repo => repo.slug === "owner/repo-1"), false);
  assert.equal(repos[0].desc, "Previous description");
  assert.equal(repos[0].stars_daily, 1);
  assert.equal("stars_weekly" in repos[0], false);
  assert.equal(repos[0].summary, summaryCache[discovered[0].slug].summary);
  assert.equal(repos[0]._stats_date, "2026-08-23");
  assert.equal(requests.filter(request => request.url.includes("repo-0")).length, 1);
});

test("creates a fact-only Korean fallback for new repositories", async () => {
  const discovered = discoveredRepos();
  const { repos, requestCount } = await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch(),
    token: "token",
    summaryCache: {},
    statsDate: "2026-08-23",
  });

  assert.equal(requestCount, 30);
  assert.match(repos[0].summary.goal, /Description for owner\/repo-0/);
  assert.match(repos[0].summary.pros, /오늘 1개/);
  assert.match(repos[0].summary.cons, /README 원문 확인/);
  assert.match(repos[0].summary.fit, /JavaScript/);
  assert.match(repos[0].detail.stars_note, /오늘 1개/);
  for (const repo of repos) {
    assert.deepEqual(Object.keys(repo.summary), ["goal", "usage", "pros", "cons", "fit"]);
    assert.deepEqual(Object.keys(repo.detail), ["goal", "usage", "pros", "cons", "fit", "stars_note"]);
  }
});

test("fails final coverage and request-count gates instead of publishing partial data", async () => {
  const discovered = discoveredRepos();
  const summaryCache = Object.fromEntries(discovered.map((repo, index) => [repo.slug, cachedSummary(index)]));
  const missing = new Map(discovered.slice(0, 3).map(repo => [
    `/repos/${repo.slug}`,
    [jsonResponse(404, { message: "not found" })],
  ]));

  await assert.rejects(
    enrichTrendingRepositories(discovered, {
      fetchImpl: successfulGithubFetch({ failures: missing }),
      token: "token",
      summaryCache,
      statsDate: "2026-08-23",
      minPublished: 5,
    }),
    /metadata coverage 70% is below 80%/i,
  );
  await assert.rejects(
    enrichTrendingRepositories(discovered, {
      fetchImpl: successfulGithubFetch(),
      token: "token",
      summaryCache,
      statsDate: "2026-08-23",
      maxRequests: 5,
    }),
    /GitHub request limit 5 exceeded/,
  );
});

test("terminal errors do not include the authorization token", async () => {
  const discovered = discoveredRepos();
  const summaryCache = Object.fromEntries(discovered.map((repo, index) => [repo.slug, cachedSummary(index)]));
  let message = "";

  try {
    await enrichTrendingRepositories(discovered, {
      fetchImpl: async () => jsonResponse(401, { message: "bad credentials" }),
      token: "super-secret-token",
      summaryCache,
      statsDate: "2026-08-23",
    });
  } catch (error) {
    message = error.message;
  }

  assert.match(message, /Published repository count|Metadata coverage/);
  assert.doesNotMatch(message, /super-secret-token/);
});
