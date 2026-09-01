(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RepoFilters = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TAG_RULE_VERSION = 1;
  const FIELD_DEFINITIONS = [
    ["ai-ml", "AI·머신러닝"],
    ["web-app", "웹·앱 개발"],
    ["dev-tools", "개발 도구"],
    ["data", "데이터·DB"],
    ["devops", "DevOps·인프라"],
    ["security", "보안·프라이버시"],
    ["productivity", "앱·생산성"],
    ["systems", "시스템·하드웨어"],
    ["learning", "학습·자료"],
    ["unclassified", "미분류"],
  ];
  const FORM_DEFINITIONS = [
    ["agent", "Agent"],
    ["mcp", "MCP"],
    ["plugin-skill", "Plugin·Skill"],
    ["ide", "IDE·코딩 도구"],
    ["library", "Library·SDK"],
    ["framework", "Framework"],
    ["cli", "CLI·Automation"],
  ];
  const FIELD_IDS = new Set(FIELD_DEFINITIONS.map(([id]) => id));
  const FORM_IDS = new Set(FORM_DEFINITIONS.map(([id]) => id));
  const FIELD_ORDER = new Map(FIELD_DEFINITIONS.map(([id], index) => [id, index]));
  const FORM_ORDER = new Map(FORM_DEFINITIONS.map(([id], index) => [id, index]));
  const PERIODS = new Set(["all", "daily", "weekly", "monthly"]);
  const SORT_DEFINITIONS = [
    ["trending", "Trending 원래 순서"],
    ["gain", "선택 기간 스타 증가"],
    ["stars", "총 스타"],
    ["pushed", "최근 푸시"],
    ["release", "최근 릴리스"],
  ];
  const SORT_IDS = new Set(SORT_DEFINITIONS.map(([id]) => id));

  function sourceText(repo) {
    return [
      repo?.slug,
      repo?.name,
      repo?.desc,
      repo?.lang,
      ...(Array.isArray(repo?.topics) ? repo.topics : []),
      repo?.summary?.goal,
      repo?.summary?.fit,
    ].filter(value => typeof value === "string").join(" ").toLowerCase();
  }

  function canonicalTags(value, allowed, order, required = false) {
    if (!Array.isArray(value) || (required && !value.length)) throw new Error("invalid repository classification");
    const seen = new Set();
    let previous = -1;
    for (const tag of value) {
      const position = order.get(tag);
      if (typeof tag !== "string" || !allowed.has(tag) || seen.has(tag) || position <= previous) {
        throw new Error("invalid repository classification");
      }
      seen.add(tag);
      previous = position;
    }
    return [...value];
  }

  function classifyRepo(repo) {
    if (!repo || repo.tag_rule_version !== TAG_RULE_VERSION) throw new Error("invalid repository classification");
    const fields = canonicalTags(repo.field_tags, FIELD_IDS, FIELD_ORDER, true);
    const forms = canonicalTags(repo.form_tags, FORM_IDS, FORM_ORDER);
    if (fields.includes("unclassified") && fields.length !== 1) throw new Error("invalid repository classification");
    return { fields, forms };
  }

  function normalizedList(value, allowed) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(item => typeof item === "string" && allowed.has(item)))];
  }

  function defaultState() {
    return { period: "all", sort: "trending", favOnly: false, q: "", lang: "", fields: [], forms: [], excludeAi: false, newOnly: false };
  }

  function normalizeSort(sort, period) {
    if (!SORT_IDS.has(sort)) return "trending";
    return period === "all" && sort === "gain" ? "trending" : sort;
  }

  function parseState(search, languages = []) {
    const state = defaultState();
    const params = new URLSearchParams(typeof search === "string" ? search : "");
    const period = params.get("period");
    if (PERIODS.has(period)) state.period = period;
    state.sort = normalizeSort(params.get("sort"), state.period);
    state.favOnly = params.get("view") === "favorites";
    const q = params.get("q") ?? "";
    state.q = q.length <= 120 ? q : "";
    const lang = params.get("lang") ?? "";
    state.lang = languages.includes(lang) ? lang : "";
    state.fields = normalizedList((params.get("field") ?? "").split(","), FIELD_IDS);
    state.forms = normalizedList((params.get("tag") ?? "").split(","), FORM_IDS);
    state.excludeAi = params.get("exclude") === "ai";
    const membership = params.getAll("membership");
    state.newOnly = membership.length === 1 && membership[0] === "new";
    return state;
  }

  function serializeState(value) {
    const state = { ...defaultState(), ...value };
    const params = new URLSearchParams();
    const period = PERIODS.has(state.period) ? state.period : "all";
    const sort = normalizeSort(state.sort, period);
    if (period !== "all") params.set("period", period);
    if (sort !== "trending") params.set("sort", sort);
    if (state.favOnly) params.set("view", "favorites");
    if (state.newOnly === true) params.set("membership", "new");
    if (typeof state.lang === "string" && state.lang) params.set("lang", state.lang);
    const fields = normalizedList(state.fields, FIELD_IDS);
    const forms = normalizedList(state.forms, FORM_IDS);
    if (fields.length) params.set("field", fields.join(","));
    if (forms.length) params.set("tag", forms.join(","));
    if (state.excludeAi) params.set("exclude", "ai");
    if (typeof state.q === "string" && state.q && state.q.length <= 120) params.set("q", state.q);
    const query = params.toString();
    return query ? `?${query}` : "";
  }

  function matchesRepo(repo, value = {}) {
    const state = { ...defaultState(), ...value };
    const classification = classifyRepo(repo);
    const period = PERIODS.has(state.period) ? state.period : "all";
    const belongsTo = candidate => {
      const rank = numericValue(repo?.[`rank_${candidate}`]);
      const gain = numericValue(repo?.[`stars_${candidate}`]);
      return rank !== null && rank > 0 && gain !== null && gain >= 0;
    };
    if (period === "all" ? !["daily", "weekly", "monthly"].some(belongsTo) : !belongsTo(period)) return false;
    if (state.excludeAi && classification.fields.includes("ai-ml")) return false;
    if (state.fields?.length && !state.fields.some(id => classification.fields.includes(id))) return false;
    if (state.forms?.length && !state.forms.some(id => classification.forms.includes(id))) return false;
    if (state.lang && repo?.lang !== state.lang) return false;
    if (state.q && !sourceText(repo).includes(state.q.toLowerCase())) return false;
    if (state.newOnly === true && repo?.membership_status !== "new") return false;
    return true;
  }

  function numericValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function dateValue(value) {
    const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const time = Date.UTC(year, month - 1, day);
    const date = new Date(time);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : null;
  }

  function sortRepos(repos, sort = "trending", period = "all") {
    const original = Array.isArray(repos) ? repos.map((repo, index) => ({ repo, index })) : [];
    const safePeriod = PERIODS.has(period) ? period : "all";
    const selected = normalizeSort(sort, safePeriod);
    if (selected === "trending") {
      if (safePeriod === "all") return original.map(({ repo }) => repo);
      return original.sort((left, right) => {
        const leftRank = numericValue(left.repo?.[`rank_${safePeriod}`]);
        const rightRank = numericValue(right.repo?.[`rank_${safePeriod}`]);
        if (leftRank === null && rightRank !== null) return 1;
        if (leftRank !== null && rightRank === null) return -1;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return left.index - right.index;
      }).map(({ repo }) => repo);
    }
    const valueOf = selected === "stars" ? repo => numericValue(repo?.stars)
      : selected === "pushed" ? repo => dateValue(repo?.pushed_at)
        : selected === "release" ? repo => dateValue(repo?.latest_release)
          : repo => numericValue(repo?.[safePeriod === "daily" ? "stars_daily" : safePeriod === "weekly" ? "stars_weekly" : "stars_monthly"]);
    return original.sort((left, right) => {
      const leftValue = valueOf(left.repo), rightValue = valueOf(right.repo);
      if (leftValue === null && rightValue !== null) return 1;
      if (leftValue !== null && rightValue === null) return -1;
      if (leftValue !== rightValue) return rightValue - leftValue;
      return left.index - right.index;
    }).map(({ repo }) => repo);
  }

  return {
    fields: FIELD_DEFINITIONS.map(([id, label]) => ({ id, label })),
    forms: FORM_DEFINITIONS.map(([id, label]) => ({ id, label })),
    sorts: SORT_DEFINITIONS.map(([id, label]) => ({ id, label })),
    classifyRepo,
    defaultState,
    parseState,
    serializeState,
    matchesRepo,
    sortRepos,
  };
});
