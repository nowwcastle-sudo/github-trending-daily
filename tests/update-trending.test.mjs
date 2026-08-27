import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRunContext } from "../scripts/run-context.mjs";

import {
  createPageSnapshot,
  enrichTrendingRepositories,
  fetchCanonicalReadme,
  fetchRepositoryFacts,
  installPageSnapshot,
  mergeTrendingPeriods,
  parseTrendingHtml,
  runTrendingUpdate,
} from "../scripts/update-trending.mjs";
import {
  extractRepos as extractStarRepos,
  updateCache as updateStarHistoryCache,
} from "../scripts/update-star-history.mjs";

const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("canonical README uses API path and immutable blob SHA", async () => {
  const readme = JSON.parse(await fixture("github-readme.json"));
  const requests = [];
  const result = await fetchCanonicalReadme("Owner/Repo", {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(200, readme);
    },
  });

  assert.equal(result.path, "docs/README.rst");
  assert.equal(result.blobSha, "a".repeat(40));
  assert.equal(result.status, "present");
  assert.equal(result.markdown, "# Repo\n\nCanonical readme.");
  assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(requests[0].url, "https://api.github.com/repos/Owner/Repo/readme");
  assert.equal(requests[0].options.headers.Accept, "application/vnd.github+json");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test("README 404 is absence but repository 500 cannot reuse stale metadata", async () => {
  const absent = await fetchCanonicalReadme("Owner/NoReadme", {
    fetchImpl: async () => jsonResponse(404, { message: "not found" }),
  });
  assert.deepEqual(absent, {
    status: "absent",
    path: null,
    blobSha: null,
    markdown: null,
    contentSha256: null,
  });

  const discovered = discoveredRepos();
  const prior = discovered.map((repo, index) => ({
    ...repo,
    stars: 999 + index,
    description: "stale metadata",
  }));
  await assert.rejects(
    enrichTrendingRepositories(discovered, {
      fetchImpl: async () => jsonResponse(500, { message: "temporary" }),
      sleep: async () => {},
      previousRepos: prior,
      statsDate: "2026-08-23",
    }),
    /GitHub metadata/,
  );
});

test("repository facts expose the complete allowlist and no private fields", async () => {
  const expectedRepositoryFactKeys = [
    "archived", "contributors", "created_at", "default_branch", "default_branch_head_sha",
    "description", "display_rank", "display_slug", "field_tags", "forks", "form_tags",
    "gain_daily", "gain_monthly", "gain_weekly", "is_fork", "language_color",
    "license_spdx", "open_issues_and_pull_requests", "primary_language", "provenance", "readme_blob_sha",
    "readme_content_sha256", "readme_path", "readme_status",
    "pushed_at", "rank_daily", "rank_monthly", "rank_weekly", "slug", "stars",
    "subscribers", "tag_rule_version", "topics", "updated_at",
  ].sort();
  const facts = await fetchRepositoryFacts("Owner/Repo", { fetchImpl: canonicalGithubFetch() });

  assert.deepEqual(Object.keys(facts).sort(), expectedRepositoryFactKeys);
  assert.equal("owner" in facts, false);
  assert.equal("permissions" in facts, false);
});

test("parses normalized slugs and the period's star gain", async () => {
  const daily = parseTrendingHtml(await fixture("trending-daily.html"), "daily");
  const weekly = parseTrendingHtml(await fixture("trending-weekly.html"), "weekly");

  assert.deepEqual(daily[0], {
    slug: "Alpha/one",
    stars_daily: 1234,
    sourceRank: 1,
    languageColor: null,
  });
  assert.deepEqual(weekly[0], {
    slug: "alpha/one",
    stars_weekly: 8765,
    sourceRank: 1,
    languageColor: null,
  });
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
    rank_daily: 1,
    gain_daily: 1234,
    rank_weekly: 1,
    gain_weekly: 8765,
    rank_monthly: 1,
    gain_monthly: 12345,
    languageColor: null,
  });
});

test("preserves the observed Trending language color and leaves missing color null", async () => {
  const html = (await fixture("trending-daily.html")).replace(
    "<span>1,234 stars today</span>",
    '<span itemprop="programmingLanguage"><span style="background-color: #F1E05A" class="repo-language-color"></span>JavaScript</span><span>1,234 stars today</span>',
  );
  const parsed = parseTrendingHtml(html, "daily");

  assert.equal(parsed[0].languageColor, "#f1e05a");
  assert.equal(parsed[1].languageColor, null);
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
  const repos = JSON.parse(page.match(/\/\/ GENERATED:TRENDING-REPOS:START\r?\nconst REPOS = (\[[^\n]+\]);\r?\n\/\/ GENERATED:TRENDING-REPOS:END/)?.[1] ?? "null");
  const cache = JSON.parse(cacheText);

  assert.ok(repos.length >= 10 && repos.length <= 75);
  assert.ok(Object.keys(cache).length >= repos.length);
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
  rank_daily: index + 1,
  gain_daily: index + 1,
  languageColor: null,
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
    if (path.endsWith("/readme")) return jsonResponse(200, {
      path: "docs/README.rst",
      sha: "a".repeat(40),
      encoding: "base64",
      content: Buffer.from("# Repo\n\nCanonical readme.").toString("base64"),
    });
    if (path.includes("/commits/")) return jsonResponse(200, { sha: "b".repeat(40) });
    const slug = path.slice("/repos/".length);
    return jsonResponse(200, {
      full_name: slug,
      description: `Description for ${slug}`,
      language: "JavaScript",
      topics: ["developer-tools", "automation"],
      stargazers_count: 100,
      forks_count: 20,
      open_issues_count: 3,
      subscribers_count: 7,
      archived: false,
      fork: false,
      default_branch: "main",
      created_at: "2020-01-02T03:04:05Z",
      updated_at: "2026-08-22T11:22:33Z",
      pushed_at: "2026-08-22T10:20:30Z",
      license: { spdx_id: "MIT" },
      owner: { login: slug.split("/")[0] },
      permissions: { admin: true },
    });
  };
}

const canonicalGithubFetch = options => successfulGithubFetch(options);

test("enriches every repository from canonical GitHub sources", async () => {
  const discovered = discoveredRepos();
  const requests = [];

  const repos = await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch({ requests }),
    token: "test-token-never-print",
  });

  assert.equal(repos.requestCount, 40);
  assert.equal(repos.length, 10);
  assert.equal(repos[0].slug, "owner/repo-0");
  assert.equal(repos[0].display_rank, 1);
  assert.equal(repos[0].rank_daily, 1);
  assert.equal(repos[0].gain_daily, 1);
  assert.equal(repos[0].language_color, null);
  assert.equal(repos[0].open_issues_and_pull_requests, 3);
  assert.equal(repos[0].subscribers, 7);
  assert.equal(repos[0].default_branch_head_sha, "b".repeat(40));
  assert.equal(repos[0].readme_blob_sha, "a".repeat(40));
  assert.match(repos[0].provenance.repository.fact_sha256, /^[a-f0-9]{64}$/);
  assert.equal(repos[0].provenance.readme.blob_api_path, `/repos/owner/repo-0/git/blobs/${"a".repeat(40)}`);
  assert.equal(requests.some(request => /raw\.githubusercontent\.com|\/HEAD\//.test(request.url)), false);
  assert.ok(requests.every(request => request.options.headers.Authorization === "Bearer test-token-never-print"));
  assert.ok(requests.every(request => request.options.signal instanceof AbortSignal));
});

test("retries only timeout, 429, and 5xx with the bounded 2s/8s schedule", async () => {
  const discovered = discoveredRepos();
  const sleeps = [];
  const failures = new Map([["/repos/owner/repo-0", [
    jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "120" }),
    jsonResponse(502, { message: "temporary" }),
  ]]]);

  const repos = await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch({ failures }),
    sleep: milliseconds => { sleeps.push(milliseconds); },
    token: "token",
  });

  assert.equal(repos.requestCount, 42);
  assert.deepEqual(sleeps, [120000, 8000]);

  await assert.rejects(
    enrichTrendingRepositories(discovered, {
      fetchImpl: successfulGithubFetch({ failures: new Map([["/repos/owner/repo-0", [jsonResponse(403, {})]]]) }),
      sleep: async () => assert.fail("403 must not retry"),
    }),
    /GitHub metadata/,
  );
});

test("retries a timeout after 2s and caps attempts at three", async () => {
  const sleeps = [];
  const requests = [];
  const rest = successfulGithubFetch({ requests });
  let timedOut = false;
  const repos = await enrichTrendingRepositories(discoveredRepos(), {
    fetchImpl: async (url, options) => {
      if (!timedOut) {
        timedOut = true;
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }
      return rest(url, options);
    },
    sleep: milliseconds => { sleeps.push(milliseconds); },
  });

  assert.deepEqual(sleeps, [2000]);
  assert.equal(repos.requestCount, 41);
  await assert.rejects(
    enrichTrendingRepositories(discoveredRepos(), {
      fetchImpl: successfulGithubFetch(),
      maxAttempts: 4,
    }),
    /maxAttempts must be between 1 and 3/,
  );
});

test("canonical README rejects mutable or oversized metadata and retries transient failure", async () => {
  const invalidValues = [
    { path: "README.md", sha: "short", encoding: "base64", content: "YQ==" },
    { path: "README.md", sha: "a".repeat(40), encoding: "utf-8", content: "text" },
    { path: "README.md", sha: "a".repeat(40), encoding: "base64", content: "not base64" },
    { path: "README.md", sha: "a".repeat(40), encoding: "base64", content: Buffer.alloc(512 * 1024 + 1).toString("base64") },
  ];
  for (const value of invalidValues) {
    await assert.rejects(
      fetchCanonicalReadme("Owner/Repo", { fetchImpl: async () => jsonResponse(200, value) }),
      /Invalid canonical README metadata/,
    );
  }

  const sleeps = [];
  await assert.rejects(
    fetchCanonicalReadme("Owner/Repo", {
      fetchImpl: async () => jsonResponse(503, { message: "temporary" }),
      sleep: milliseconds => { sleeps.push(milliseconds); },
    }),
    /GitHub request returned 503/,
  );
  assert.deepEqual(sleeps, [2000, 8000]);
});

test("fails closed when Retry-After exceeds the explicit maximum", async () => {
  const discovered = discoveredRepos();
  const sleeps = [];
  const requests = [];
  const failures = new Map([["/repos/owner/repo-0", [
    jsonResponse(429, { message: "secondary rate limit" }, { "retry-after": "301" }),
  ]]]);

  await assert.rejects(
    enrichTrendingRepositories(discovered, {
      fetchImpl: successfulGithubFetch({ failures, requests }),
      sleep: milliseconds => { sleeps.push(milliseconds); },
      token: "token",
      maxRetryDelay: 300000,
    }),
    /Retry delay 301000ms exceeds maximum 300000ms/,
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(sleeps, []);
});

test("omits Authorization when no token is configured", async () => {
  const discovered = discoveredRepos();
  const requests = [];

  await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch({ requests }),
  });

  assert.ok(requests.every(request => !("Authorization" in request.options.headers)));
});

test("repository terminal failures reject the whole enrichment without stale relabeling", async () => {
  const discovered = discoveredRepos();
  const requests = [];
  const failures = new Map([["/repos/owner/repo-0", [jsonResponse(404, { message: "not found" })]]]);
  const previousRepos = [{
    slug: "owner/repo-0",
    description: "Previous description",
    stars: 90,
  }];

  await assert.rejects(
    enrichTrendingRepositories(discovered, {
      fetchImpl: successfulGithubFetch({ failures, requests }),
      token: "token",
      previousRepos,
    }),
    /GitHub metadata unavailable for owner\/repo-0/,
  );
  assert.equal(requests.filter(request => request.url.includes("repo-0")).length, 1);
});

test("README absence is explicit and never persists the decoded body", async () => {
  const discovered = discoveredRepos();
  const failures = new Map([["/repos/owner/repo-0/readme", [jsonResponse(404, { message: "not found" })]]]);
  const repos = await enrichTrendingRepositories(discovered, {
    fetchImpl: successfulGithubFetch({ failures }),
  });

  assert.equal(repos.requestCount, 40);
  assert.equal(repos[0].readme_status, "absent");
  assert.equal(repos[0].readme_path, null);
  assert.equal(repos[0].readme_blob_sha, null);
  assert.equal(repos[0].readme_content_sha256, null);
  assert.equal("markdown" in repos[0], false);
});

test("fails request-count and canonical-value gates instead of publishing partial facts", async () => {
  const discovered = discoveredRepos();
  await assert.rejects(
    enrichTrendingRepositories(discovered, {
      fetchImpl: successfulGithubFetch(),
      token: "token",
      maxRequests: 5,
    }),
    /GitHub request limit 5 exceeded/,
  );

  const invalid = successfulGithubFetch();
  await assert.rejects(
    fetchRepositoryFacts("owner/repo-0", {
      fetchImpl: async (url, options) => {
        const response = await invalid(url, options);
        if (new URL(url).pathname === "/repos/owner/repo-0") {
          const body = await response.json();
          body.subscribers_count = -1;
          return jsonResponse(200, body);
        }
        return response;
      },
    }),
    /Invalid GitHub metadata/,
  );
  await assert.rejects(
    fetchRepositoryFacts("owner/repo-0", {
      fetchImpl: async (url, options) => {
        const response = await invalid(url, options);
        if (new URL(url).pathname === "/repos/owner/repo-0") {
          const body = await response.json();
          body.created_at = "2026-02-30T03:04:05Z";
          return jsonResponse(200, body);
        }
        return response;
      },
    }),
    /Invalid GitHub metadata/,
  );
});

test("terminal errors do not include the authorization token", async () => {
  const discovered = discoveredRepos();
  let message = "";

  try {
    await enrichTrendingRepositories(discovered, {
      fetchImpl: async () => jsonResponse(401, { message: "bad credentials" }),
      token: "super-secret-token",
    });
  } catch (error) {
    message = error.message;
  }

  assert.match(message, /GitHub metadata unavailable/);
  assert.doesNotMatch(message, /super-secret-token/);
});

const markedPage = `<!doctype html>
<footer>
<!-- GENERATED:TRENDING-DATE:START -->
<time id="lastUpdated" datetime="2026-08-22">2026-08-22 (Asia/Seoul)</time>
<!-- GENERATED:TRENDING-DATE:END -->
</footer>
<script>
const untouched = "keep me";
// GENERATED:TRENDING-REPOS:START
const REPOS = [];
// GENERATED:TRENDING-REPOS:END
</script>`;

function publishableRepo(index, statsDate = "2026-08-23") {
  const cached = cachedSummary(index);
  return {
    slug: `owner/repo-${index}`,
    name: `owner / repo-${index}`,
    desc: `Description ${index}`,
    lang: "JavaScript",
    topics: ["developer-tools"],
    stars: 100 + index,
    forks: 20,
    stars_daily: index + 1,
    color: "#f1e05a",
    summary: cached.summary,
    detail: cached.detail,
    issues: 3,
    contributors: 2,
    _stats_date: statsDate,
  };
}

const publishableRepos = (count = 10, statsDate = "2026-08-23") => (
  Array.from({ length: count }, (_, index) => publishableRepo(index, statsDate))
);

test("final snapshot rejects invalid collection sizes and incomplete UI fields", () => {
  for (const count of [9, 76]) {
    assert.throws(
      () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: publishableRepos(count), statsDate: "2026-08-23" }),
      /10-75 repositories/i,
    );
  }

  const encodedSlug = publishableRepos();
  encodedSlug[0].slug = "owner%2Frepo-0";
  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: encodedSlug, statsDate: "2026-08-23" }),
    /normalized slug/i,
  );

  const missingField = publishableRepos();
  delete missingField[0].desc;
  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: missingField, statsDate: "2026-08-23" }),
    /valid UI schema/i,
  );

  const emptyName = publishableRepos();
  emptyName[0].name = "";
  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: emptyName, statsDate: "2026-08-23" }),
    /valid UI schema/i,
  );

  for (const invalid of [-1, 1.5]) {
    const invalidNumber = publishableRepos();
    invalidNumber[0].contributors = invalid;
    assert.throws(
      () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: invalidNumber, statsDate: "2026-08-23" }),
      /valid UI schema/i,
    );
  }

  const noPeriodGain = publishableRepos();
  delete noPeriodGain[0].stars_daily;
  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: noPeriodGain, statsDate: "2026-08-23" }),
    /period gain/i,
  );

  const unsafeColor = publishableRepos();
  unsafeColor[0].color = "red;position:fixed";
  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: unsafeColor, statsDate: "2026-08-23" }),
    /valid UI schema/i,
  );

  const unsafeTopics = publishableRepos();
  unsafeTopics[0].topics = ["safe", "<script>"];
  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: unsafeTopics, statsDate: "2026-08-23" }),
    /valid UI schema/i,
  );
});

test("summary cache rejects case-insensitive duplicate keys during snapshot creation", () => {
  assert.throws(
    () => createPageSnapshot({
      page: markedPage,
      summaryCache: {
        "Owner/Repo": cachedSummary(0),
        "owner/repo": cachedSummary(1),
      },
      repos: publishableRepos(),
      statsDate: "2026-08-23",
    }),
    /duplicate summary cache key/i,
  );
});

test("page snapshot changes only marked regions and persists complete new summaries", () => {
  const repos = publishableRepos();
  const snapshot = createPageSnapshot({
    page: markedPage,
    summaryCache: { "existing/repo": cachedSummary(9) },
    repos,
    statsDate: "2026-08-23",
  });

  const outsideMarkers = value => value
    .replace(/\/\/ GENERATED:TRENDING-REPOS:START[\s\S]*?\/\/ GENERATED:TRENDING-REPOS:END/, "REPOS")
    .replace(/<!-- GENERATED:TRENDING-DATE:START -->[\s\S]*?<!-- GENERATED:TRENDING-DATE:END -->/, "DATE");
  assert.equal(outsideMarkers(snapshot.page), outsideMarkers(markedPage));
  assert.match(snapshot.page, /const REPOS = \[\{"slug":"owner\/repo-0"/);
  assert.match(snapshot.page, /datetime="2026-08-23">2026-08-23 \(Asia\/Seoul\)/);
  assert.deepEqual(JSON.parse(snapshot.summaryCacheText)[repos[0].slug], {
    summary: repos[0].summary,
    detail: repos[0].detail,
  });
});

test("page snapshot cannot terminate the inline script through repository metadata", () => {
  const repos = publishableRepos();
  repos[0].desc = "</script><script>alert('xss')</script>";

  const snapshot = createPageSnapshot({
    page: markedPage,
    summaryCache: {},
    repos,
    statsDate: "2026-08-23",
  });
  const generated = snapshot.page.match(/\/\/ GENERATED:TRENDING-REPOS:START([\s\S]*?)\/\/ GENERATED:TRENDING-REPOS:END/)[1];

  assert.doesNotMatch(generated, /<\/script>/i);
  assert.match(generated, /\\u003c\/script\\u003e/);
});

test("page snapshot rejects duplicate markers, invalid dates, and incomplete published summaries", () => {
  const incomplete = publishableRepos();
  incomplete[0].detail.stars_note = "";

  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: incomplete, statsDate: "2026-08-23" }),
    /complete summary/i,
  );
  assert.throws(
    () => createPageSnapshot({ page: markedPage, summaryCache: {}, repos: publishableRepos(), statsDate: "2026-02-30" }),
    /valid YYYY-MM-DD/,
  );
  assert.throws(
    () => createPageSnapshot({
      page: `${markedPage}\n// GENERATED:TRENDING-REPOS:START\n// GENERATED:TRENDING-REPOS:END`,
      summaryCache: {},
      repos: publishableRepos(),
      statsDate: "2026-08-23",
    }),
    /exactly one.*REPOS/i,
  );
});

test("atomic installer restores both tracked files when the second replacement fails", async t => {
  const directory = await mkdtemp(join(tmpdir(), "trending-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pagePath = join(directory, "index.html");
  const cachePath = join(directory, "data", "repo-summaries.json");
  await mkdir(join(directory, "data"));
  await Promise.all([
    writeFile(pagePath, markedPage),
    writeFile(cachePath, "{}\n"),
  ]);
  const original = await Promise.all([readFile(pagePath), readFile(cachePath)]);
  const snapshot = createPageSnapshot({
    page: markedPage,
    summaryCache: {},
    repos: publishableRepos(),
    statsDate: "2026-08-23",
  });
  const { rename } = await import("node:fs/promises");

  await assert.rejects(
    installPageSnapshot({
      pagePath,
      cachePath,
      ...snapshot,
      renameImpl: async (from, to) => {
        if (from.includes(".pending-") && to === cachePath) throw new Error("simulated second install failure");
        await rename(from, to);
      },
    }),
    /simulated second install failure/,
  );
  const after = await Promise.all([readFile(pagePath), readFile(cachePath)]);
  assert.deepEqual(after, original);

  assert.equal(await installPageSnapshot({ pagePath, cachePath, ...snapshot }), true);
  assert.deepEqual(await Promise.all([readFile(pagePath, "utf8"), readFile(cachePath, "utf8")]), [
    snapshot.page,
    snapshot.summaryCacheText,
  ]);
  assert.equal(await installPageSnapshot({ pagePath, cachePath, ...snapshot }), false);
});

test("prepared snapshot validation rejects case-insensitive duplicate summary-cache keys", async t => {
  const directory = await mkdtemp(join(tmpdir(), "trending-cache-duplicate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pagePath = join(directory, "index.html");
  const cachePath = join(directory, "data", "repo-summaries.json");
  await mkdir(join(directory, "data"));
  await Promise.all([writeFile(pagePath, markedPage), writeFile(cachePath, "{}\n")]);
  const original = await Promise.all([readFile(pagePath), readFile(cachePath)]);
  const snapshot = createPageSnapshot({
    page: markedPage,
    summaryCache: {},
    repos: publishableRepos(),
    statsDate: "2026-08-23",
  });
  const duplicate = JSON.parse(snapshot.summaryCacheText);
  duplicate["Owner/Repo-0"] = duplicate["owner/repo-0"];

  await assert.rejects(
    installPageSnapshot({
      pagePath,
      cachePath,
      page: snapshot.page,
      summaryCacheText: `${JSON.stringify(duplicate, null, 2)}\n`,
    }),
    /duplicate summary cache key/i,
  );
  assert.deepEqual(await Promise.all([readFile(pagePath), readFile(cachePath)]), original);
});

test("Trending update takes its date from the supplied run context", () => {
  assert.equal(createRunContext(new Date("2026-08-22T14:59:59Z")).statsDateKst, "2026-08-22");
  assert.equal(createRunContext(new Date("2026-08-22T15:00:00Z")).statsDateKst, "2026-08-23");
});

test("check mode fetches all three Trending pages and REST data without writing tracked files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "trending-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pagePath = join(directory, "index.html");
  const cachePath = join(directory, "data", "repo-summaries.json");
  await mkdir(join(directory, "data"));
  const summaryCache = Object.fromEntries(discoveredRepos().map((repo, index) => [repo.slug, cachedSummary(index)]));
  await Promise.all([
    writeFile(pagePath, markedPage),
    writeFile(cachePath, `${JSON.stringify(summaryCache, null, 2)}\n`),
  ]);
  const before = await Promise.all([readFile(pagePath), readFile(cachePath)]);
  const trending = Object.fromEntries(await Promise.all(["daily", "weekly", "monthly"].map(async period => [
    `https://github.com/trending?since=${period}`,
    await fixture(`trending-${period}.html`),
  ])));
  const requests = [];
  const rest = successfulGithubFetch({ requests });
  const fetchImpl = async (url, options) => {
    if (trending[url]) {
      requests.push({ url, options });
      return jsonResponse(200, trending[url]);
    }
    return rest(url, options);
  };

  const result = await runTrendingUpdate({
    check: true,
    pagePath,
    cachePath,
    fetchImpl,
    token: "check-token-never-print",
    context: createRunContext(new Date("2026-08-22T15:00:00Z")),
  });

  assert.equal(result.repos.length, 10);
  assert.equal(result.changed, true);
  assert.equal(result.statsDate, "2026-08-23");
  assert.deepEqual(requests.filter(request => request.url.startsWith("https://github.com/trending")).map(request => request.url), Object.keys(trending));
  assert.ok(requests.every(request => request.options.signal instanceof AbortSignal));
  assert.deepEqual(await Promise.all([readFile(pagePath), readFile(cachePath)]), before);
});

test("daily update gives star history the exact finalized repositories and isolates unavailable history", async t => {
  const directory = await mkdtemp(join(tmpdir(), "daily-integrated-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pagePath = join(directory, "index.html");
  const cachePath = join(directory, "data", "repo-summaries.json");
  const starCachePath = join(directory, "star-history.json");
  await mkdir(join(directory, "data"));
  const summaryCache = Object.fromEntries(discoveredRepos().map((repo, index) => [repo.slug, cachedSummary(index)]));
  await Promise.all([
    writeFile(pagePath, markedPage),
    writeFile(cachePath, `${JSON.stringify(summaryCache, null, 2)}\n`),
    writeFile(starCachePath, `${JSON.stringify({
      version: 1,
      generatedAt: "2026-08-22",
      repositories: [
        { slug: "Alpha/one", estimated: [{ date: "2026-07-01", stars: 50 }], observed: [] },
        { slug: "stale/orphan", estimated: [], observed: [] },
      ],
    }, null, 2)}\n`),
  ]);
  const trending = Object.fromEntries(await Promise.all(["daily", "weekly", "monthly"].map(async period => [
    `https://github.com/trending?since=${period}`,
    await fixture(`trending-${period}.html`),
  ])));
  const rest = successfulGithubFetch();
  const starRequests = [];

  const result = await runTrendingUpdate({
    pagePath,
    cachePath,
    fetchImpl: async (url, options) => trending[url] ? jsonResponse(200, trending[url]) : rest(url, options),
    context: createRunContext(new Date("2026-08-22T15:00:00Z")),
  });
  const starHistory = await updateStarHistoryCache({
    htmlPath: pagePath,
    cachePath: starCachePath,
    fetchImpl: async url => {
      starRequests.push(url);
      return starRequests.length === 1
        ? jsonResponse(503, {})
        : jsonResponse(200, { data: { rows: [] } });
    },
    log: () => {},
    date: result.statsDate,
  });

  const pageSlugs = extractStarRepos(await readFile(pagePath, "utf8")).map(repo => repo.slug);
  const starCache = JSON.parse(await readFile(starCachePath, "utf8"));
  const starSlugs = starCache.repositories.map(repo => repo.slug);
  assert.deepEqual(starSlugs, result.repos.map(repo => repo.slug));
  assert.deepEqual(starSlugs, pageSlugs);
  assert.equal(starRequests.length, result.repos.length);
  assert.deepEqual(starHistory.failed, [result.repos[0].slug]);
  assert.deepEqual(starCache.repositories[0].estimated, [{ date: "2026-07-01", stars: 50 }]);
  assert.deepEqual(starCache.repositories[0].observed, [{ date: "2026-08-23", stars: 100 }]);
});

test("failed Trending generation leaves every last-good file byte-identical and never starts star history", async t => {
  const directory = await mkdtemp(join(tmpdir(), "daily-integrated-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pagePath = join(directory, "index.html");
  const cachePath = join(directory, "data", "repo-summaries.json");
  const starCachePath = join(directory, "star-history.json");
  await mkdir(join(directory, "data"));
  const summaryCache = Object.fromEntries(discoveredRepos().map((repo, index) => [repo.slug, cachedSummary(index)]));
  await Promise.all([
    writeFile(pagePath, markedPage),
    writeFile(cachePath, `${JSON.stringify(summaryCache, null, 2)}\n`),
    writeFile(starCachePath, '{"version":1,"generatedAt":"2026-08-22","repositories":[]}\n'),
  ]);
  const before = await Promise.all([pagePath, cachePath, starCachePath].map(path => readFile(path)));
  const [malformed, weekly, monthly] = await Promise.all([
    fixture("trending-malformed.html"),
    fixture("trending-weekly.html"),
    fixture("trending-monthly.html"),
  ]);
  const pages = {
    "https://github.com/trending?since=daily": malformed,
    "https://github.com/trending?since=weekly": weekly,
    "https://github.com/trending?since=monthly": monthly,
  };
  let starUpdates = 0;
  let starRequests = 0;

  const update = async () => {
    const trending = await runTrendingUpdate({
      pagePath,
      cachePath,
      fetchImpl: async url => jsonResponse(200, pages[url]),
      context: createRunContext(new Date("2026-08-22T15:00:00Z")),
    });
    starUpdates += 1;
    await updateStarHistoryCache({
      htmlPath: pagePath,
      cachePath: starCachePath,
      date: trending.statsDate,
      fetchImpl: async () => {
        starRequests += 1;
        return jsonResponse(200, { data: { rows: [] } });
      },
      log: () => {},
    });
  };

  await assert.rejects(update(), /no Trending repositories/);

  assert.equal(starUpdates, 0);
  assert.equal(starRequests, 0);
  assert.deepEqual(await Promise.all([pagePath, cachePath, starCachePath].map(path => readFile(path))), before);
});
