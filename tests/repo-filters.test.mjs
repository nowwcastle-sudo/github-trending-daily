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

function canonicalRepo(overrides = {}) {
  return {
    slug: "owner/project",
    name: "owner / project",
    desc: "A repository",
    lang: "Python",
    topics: [],
    summary: { goal: "A goal", fit: "A fit" },
    tag_rule_version: 1,
    field_tags: ["unclassified"],
    form_tags: [],
    membership_status: "stayed",
    ...overrides,
  };
}

test("public tag definitions expose every canonical id in definition order", async () => {
  const RepoFilters = await loadRepoFilters();
  assert.deepEqual(JSON.parse(JSON.stringify(RepoFilters.fields)), [
    { id: "ai-ml", label: "AI·머신러닝" },
    { id: "web-app", label: "웹·앱 개발" },
    { id: "dev-tools", label: "개발 도구" },
    { id: "data", label: "데이터·DB" },
    { id: "devops", label: "DevOps·인프라" },
    { id: "security", label: "보안·프라이버시" },
    { id: "productivity", label: "앱·생산성" },
    { id: "systems", label: "시스템·하드웨어" },
    { id: "learning", label: "학습·자료" },
    { id: "unclassified", label: "미분류" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(RepoFilters.forms)), [
    { id: "agent", label: "Agent" },
    { id: "mcp", label: "MCP" },
    { id: "plugin-skill", label: "Plugin·Skill" },
    { id: "ide", label: "IDE·코딩 도구" },
    { id: "library", label: "Library·SDK" },
    { id: "framework", label: "Framework" },
    { id: "cli", label: "CLI·Automation" },
  ]);
});

test("classification accepts only canonical field and form facts", async () => {
  const RepoFilters = await loadRepoFilters();
  const result = RepoFilters.classifyRepo(canonicalRepo({
    field_tags: ["ai-ml", "dev-tools", "security"],
    form_tags: ["agent", "mcp"],
  }));

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    fields: ["ai-ml", "dev-tools", "security"],
    forms: ["agent", "mcp"],
  });
});

test("classification rejects missing, unknown, duplicate, unordered, and mismatched canonical facts", async () => {
  const RepoFilters = await loadRepoFilters();
  const invalid = [
    canonicalRepo({ tag_rule_version: 2 }),
    canonicalRepo({ tag_rule_version: "1" }),
    canonicalRepo({ field_tags: undefined }),
    canonicalRepo({ field_tags: [] }),
    canonicalRepo({ field_tags: ["unknown"] }),
    canonicalRepo({ field_tags: ["security", "security"] }),
    canonicalRepo({ field_tags: ["security", "dev-tools"] }),
    canonicalRepo({ field_tags: ["unclassified", "security"] }),
    canonicalRepo({ form_tags: undefined }),
    canonicalRepo({ form_tags: ["unknown"] }),
    canonicalRepo({ form_tags: ["mcp", "mcp"] }),
    canonicalRepo({ form_tags: ["mcp", "agent"] }),
  ];

  for (const repository of invalid) {
    assert.throws(() => RepoFilters.classifyRepo(repository), /invalid repository classification/);
  }
});

test("classification and AI filtering never infer from repository or LLM prose", async () => {
  const RepoFilters = await loadRepoFilters();
  const ordinary = canonicalRepo({ field_tags: ["productivity"], form_tags: ["library"] });
  const aiLooking = canonicalRepo({
    ...ordinary,
    slug: "ai-agent/gpt-codex",
    name: "AI MCP agent",
    desc: "Claude GPT machine learning framework",
    topics: ["ai", "llm", "agentic"],
    summary: { goal: "Artificial intelligence", fit: "RAG and neural inference" },
  });

  assert.equal(JSON.stringify(RepoFilters.classifyRepo(ordinary)), JSON.stringify(RepoFilters.classifyRepo(aiLooking)));
  assert.equal(RepoFilters.matchesRepo(ordinary, { excludeAi: true }), true);
  assert.equal(RepoFilters.matchesRepo(aiLooking, { excludeAi: true }), true);
  assert.equal(RepoFilters.matchesRepo(aiLooking, { fields: ["ai-ml"] }), false);
  assert.equal(RepoFilters.matchesRepo(ordinary, { q: "claude" }), false);
  assert.equal(RepoFilters.matchesRepo(aiLooking, { q: "claude" }), true);
});

test("multi-select filters use OR within a group and AND between groups", async () => {
  const RepoFilters = await loadRepoFilters();
  const repos = [
    canonicalRepo({ slug: "a/one", lang: "Python", field_tags: ["ai-ml"], form_tags: ["mcp"] }),
    canonicalRepo({ slug: "b/two", lang: "Python", field_tags: ["security"], form_tags: ["cli"] }),
    canonicalRepo({ slug: "c/three", lang: "TypeScript", field_tags: ["web-app"], form_tags: ["framework"] }),
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
  const aiRepo = canonicalRepo({ slug: "a/one", field_tags: ["ai-ml"] });
  const regularRepo = canonicalRepo({ slug: "b/two", field_tags: ["productivity"] });

  assert.equal(RepoFilters.matchesRepo(aiRepo, { fields: [], forms: [], excludeAi: true }), false);
  assert.equal(RepoFilters.matchesRepo(regularRepo, { fields: [], forms: [], excludeAi: true }), true);
});

test("URL state round-trips known values and drops unknown or oversized input", async () => {
  const RepoFilters = await loadRepoFilters();
  const parsed = RepoFilters.parseState(
    "?period=weekly&view=favorites&membership=new&lang=Python&field=security,ai-ml,bad&tag=mcp,cli&exclude=ai&q=agent",
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
    newOnly: true,
  });
  assert.equal(
    RepoFilters.serializeState(parsed),
    "?period=weekly&view=favorites&membership=new&lang=Python&field=security%2Cai-ml&tag=mcp%2Ccli&exclude=ai&q=agent",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(RepoFilters.parseState(`?period=yearly&lang=Ruby&membership=${"x".repeat(300)}&q=${"x".repeat(300)}`, ["Python"]))),
    { period: "all", sort: "trending", favOnly: false, q: "", lang: "", fields: [], forms: [], excludeAi: false, newOnly: false },
  );
});

test("new-only state accepts and serializes only exact membership new", async () => {
  const RepoFilters = await loadRepoFilters();

  assert.equal(RepoFilters.defaultState().newOnly, false);
  assert.equal(RepoFilters.parseState("?membership=new").newOnly, true);
  for (const value of ["baseline_present", "reentered", "stayed", "NEW", "new ", "", "x".repeat(300)]) {
    assert.equal(RepoFilters.parseState(`?membership=${encodeURIComponent(value)}`).newOnly, false);
  }
  for (const query of ["?membership=new&membership=stayed", "?membership=new&membership=new", "?membership=&membership=new"]) {
    assert.equal(RepoFilters.parseState(query).newOnly, false);
  }
  assert.equal(RepoFilters.serializeState({ newOnly: true }), "?membership=new");
  assert.equal(RepoFilters.serializeState({ newOnly: false }), "");
  assert.equal(RepoFilters.serializeState({ newOnly: "true" }), "");
});

test("new-only filtering includes only exact new membership", async () => {
  const RepoFilters = await loadRepoFilters();
  const repositories = ["new", "reentered", "stayed", "baseline_present", "unknown", undefined]
    .map((membership_status, index) => canonicalRepo({ slug: `owner/repo-${index}`, membership_status }));

  assert.deepEqual(
    repositories.filter(repository => RepoFilters.matchesRepo(repository, { newOnly: true })).map(repository => repository.membership_status),
    ["new"],
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
