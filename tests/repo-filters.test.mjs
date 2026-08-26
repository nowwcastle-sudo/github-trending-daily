import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadRepoFilters() {
  const source = await readFile(new URL("../repo-filters.js", import.meta.url), "utf8");
  const context = { globalThis: null, URLSearchParams };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.RepoFilters;
}

test("classification keeps independent field and form tags", async () => {
  const RepoFilters = await loadRepoFilters();
  const result = RepoFilters.classifyRepo({
    slug: "Tencent/AI-Infra-Guard",
    name: "Tencent / AI-Infra-Guard",
    desc: "Security rules and MCP tools for AI coding agents",
    lang: "Python",
    topics: ["artificial-intelligence", "security", "mcp"],
  });

  assert.deepEqual([...result.fields].sort(), ["ai-ml", "dev-tools", "security"]);
  assert.deepEqual([...result.forms].sort(), ["agent", "mcp"]);
});

test("classification falls back to public text and never hides an unclassified repo", async () => {
  const RepoFilters = await loadRepoFilters();

  assert.deepEqual(
    JSON.parse(JSON.stringify(RepoFilters.classifyRepo({
      slug: "basecamp/omarchy",
      name: "basecamp / omarchy",
      desc: "Beautiful, Modern & Opinionated Linux",
      lang: "Shell",
    }))),
    { fields: ["systems"], forms: [] },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(RepoFilters.classifyRepo({ slug: "owner/project", name: "owner / project" }))),
    { fields: ["unclassified"], forms: [] },
  );
});

test("multi-select filters use OR within a group and AND between groups", async () => {
  const RepoFilters = await loadRepoFilters();
  const repos = [
    { slug: "a/one", name: "AI MCP server", desc: "agent tools", lang: "Python", topics: ["ai", "mcp"] },
    { slug: "b/two", name: "Secure CLI", desc: "security automation", lang: "Python", topics: ["security", "cli"] },
    { slug: "c/three", name: "Web framework", desc: "frontend framework", lang: "TypeScript", topics: ["web", "framework"] },
  ];

  const state = { q: "", lang: "Python", fields: ["ai-ml", "security"], forms: ["mcp"] };
  assert.deepEqual(repos.filter(repo => RepoFilters.matchesRepo(repo, state)).map(repo => repo.slug), ["a/one"]);
  assert.deepEqual(
    repos.filter(repo => RepoFilters.matchesRepo(repo, { ...state, forms: [] })).map(repo => repo.slug),
    ["a/one", "b/two"],
  );
});

test("AI exclusion overrides positive filters", async () => {
  const RepoFilters = await loadRepoFilters();
  const aiRepo = { slug: "a/one", name: "AI agent", topics: ["artificial-intelligence"] };
  const regularRepo = { slug: "b/two", name: "Project manager", topics: ["productivity"] };

  assert.equal(RepoFilters.matchesRepo(aiRepo, { fields: [], forms: [], excludeAi: true }), false);
  assert.equal(RepoFilters.matchesRepo(regularRepo, { fields: [], forms: [], excludeAi: true }), true);
});

test("URL state round-trips known values and drops unknown or oversized input", async () => {
  const RepoFilters = await loadRepoFilters();
  const parsed = RepoFilters.parseState(
    "?period=weekly&view=favorites&lang=Python&field=security,ai-ml,bad&tag=mcp,cli&exclude=ai&q=agent",
    ["Python", "Rust"],
  );

  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    period: "weekly",
    sort: "trending",
    favOnly: true,
    q: "agent",
    lang: "Python",
    fields: ["security", "ai-ml"],
    forms: ["mcp", "cli"],
    excludeAi: true,
  });
  assert.equal(
    RepoFilters.serializeState(parsed),
    "?period=weekly&view=favorites&lang=Python&field=security%2Cai-ml&tag=mcp%2Ccli&exclude=ai&q=agent",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(RepoFilters.parseState(`?period=yearly&lang=Ruby&q=${"x".repeat(300)}`, ["Python"]))),
    { period: "all", sort: "trending", favOnly: false, q: "", lang: "", fields: [], forms: [], excludeAi: false },
  );
});

test("URL sorting is whitelisted, omits the default, and rejects gain for all periods", async () => {
  const RepoFilters = await loadRepoFilters();

  assert.equal(RepoFilters.parseState("?period=weekly&sort=gain").sort, "gain");
  assert.equal(RepoFilters.serializeState({ period: "weekly", sort: "gain" }), "?period=weekly&sort=gain");
  assert.equal(RepoFilters.serializeState({ period: "weekly", sort: "trending" }), "?period=weekly");
  assert.equal(RepoFilters.parseState("?sort=stars").sort, "stars");
  assert.equal(RepoFilters.parseState("?sort=unknown").sort, "trending");
  assert.equal(RepoFilters.parseState("?period=all&sort=gain").sort, "trending");
  assert.equal(RepoFilters.serializeState({ period: "all", sort: "gain" }), "");
});

test("sorting keeps Trending order by default and uses original order to break ties", async () => {
  const RepoFilters = await loadRepoFilters();
  const repos = [
    { slug: "owner/first", stars: 10, pushed_at: "2026-08-20", latest_release: null },
    { slug: "owner/second", stars: 30, pushed_at: null, latest_release: "2026-08-21" },
    { slug: "owner/third", stars: 30, pushed_at: "2026-08-25", latest_release: "invalid" },
    { slug: "owner/fourth", stars: null, pushed_at: "invalid", latest_release: "2026-08-24" },
  ];

  assert.deepEqual(RepoFilters.sortRepos(repos, "trending", "daily").map(repo => repo.slug), [
    "owner/first", "owner/second", "owner/third", "owner/fourth",
  ]);
  assert.deepEqual(RepoFilters.sortRepos(repos, "stars", "daily").map(repo => repo.slug), [
    "owner/second", "owner/third", "owner/first", "owner/fourth",
  ]);
  assert.deepEqual(RepoFilters.sortRepos(repos, "pushed", "daily").map(repo => repo.slug), [
    "owner/third", "owner/first", "owner/second", "owner/fourth",
  ]);
  assert.deepEqual(RepoFilters.sortRepos(repos, "release", "daily").map(repo => repo.slug), [
    "owner/fourth", "owner/second", "owner/first", "owner/third",
  ]);
  assert.equal(repos[0].slug, "owner/first");
});

test("gain sorting follows the selected period and is unavailable for all periods", async () => {
  const RepoFilters = await loadRepoFilters();
  const repos = [
    { slug: "owner/first", stars_daily: 5, stars_weekly: 50, stars_monthly: null },
    { slug: "owner/second", stars_daily: 20, stars_weekly: 10, stars_monthly: 100 },
    { slug: "owner/third", stars_daily: null, stars_weekly: 50, stars_monthly: 30 },
  ];

  assert.deepEqual(RepoFilters.sortRepos(repos, "gain", "daily").map(repo => repo.slug), [
    "owner/second", "owner/first", "owner/third",
  ]);
  assert.deepEqual(RepoFilters.sortRepos(repos, "gain", "weekly").map(repo => repo.slug), [
    "owner/first", "owner/third", "owner/second",
  ]);
  assert.deepEqual(RepoFilters.sortRepos(repos, "gain", "monthly").map(repo => repo.slug), [
    "owner/second", "owner/third", "owner/first",
  ]);
  assert.deepEqual(RepoFilters.sortRepos(repos, "gain", "all").map(repo => repo.slug), [
    "owner/first", "owner/second", "owner/third",
  ]);
});
