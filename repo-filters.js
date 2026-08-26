(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RepoFilters = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FIELD_DEFINITIONS = [
    ["ai-ml", "AI·머신러닝", /\b(ai|artificial[- ]intelligence|machine[- ]learning|deep[- ]learning|llms?|gpt|claude|codex|agents?|agentic|rag|inference|neural|generative[- ]ai|computer[- ]vision|nlp)\b/i],
    ["web-app", "웹·앱 개발", /\b(web|frontend|react|vue|svelte|next\.?js|mobile|android|ios|browser|webapp)\b/i],
    ["dev-tools", "개발 도구", /\b(developer[- ]tools?|devtools?|coding|programming|compiler|sdk|ide|cli|automation|api|mcp|plugins?)\b/i],
    ["data", "데이터·DB", /\b(data|database|sql|analytics|warehouse|vector[- ]database|data[- ]engineering)\b/i],
    ["devops", "DevOps·인프라", /\b(devops|cloud|kubernetes|k8s|docker|infrastructure|ci[- /]?cd|observability|deployment)\b/i],
    ["security", "보안·프라이버시", /\b(security|privacy|pentest|osint|vulnerabilit(?:y|ies)|authentication|authorization|password|secrets?)\b/i],
    ["productivity", "앱·생산성", /\b(productivity|project[- ]management|note[- ]taking|knowledge[- ]management|job[- ]search|workflow|crm|finance|media|desktop[- ]app)\b/i],
    ["systems", "시스템·하드웨어", /\b(linux|operating[- ]system|kernel|embedded|hardware|robotics?|on[- ]device|wearables?|smart[- ]home)\b/i],
    ["learning", "학습·자료", /\b(awesome|learn|learning|tutorial|course|book|beginners?|curriculum|resources?)\b/i],
  ];
  const FORM_DEFINITIONS = [
    ["agent", "Agent", /\b(agents?|agentic)\b/i],
    ["mcp", "MCP", /\bmcp\b/i],
    ["plugin-skill", "Plugin·Skill", /\b(plugins?|skills?)\b/i],
    ["ide", "IDE·코딩 도구", /\b(ide|code[- ]editor|coding[- ]environment)\b/i],
    ["library", "Library·SDK", /\b(library|libraries|sdk|toolkit|package)\b/i],
    ["framework", "Framework", /\bframeworks?\b/i],
    ["cli", "CLI·Automation", /\b(cli|command[- ]line|automation|workflow)\b/i],
  ];
  const FIELD_IDS = new Set([...FIELD_DEFINITIONS.map(([id]) => id), "unclassified"]);
  const FORM_IDS = new Set(FORM_DEFINITIONS.map(([id]) => id));
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

  function classifyRepo(repo) {
    const text = sourceText(repo);
    const fields = FIELD_DEFINITIONS.filter(([, , pattern]) => pattern.test(text)).map(([id]) => id);
    const forms = FORM_DEFINITIONS.filter(([, , pattern]) => pattern.test(text)).map(([id]) => id);
    return { fields: fields.length ? fields : ["unclassified"], forms };
  }

  function normalizedList(value, allowed) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(item => typeof item === "string" && allowed.has(item)))];
  }

  function defaultState() {
    return { period: "all", sort: "trending", favOnly: false, q: "", lang: "", fields: [], forms: [], excludeAi: false };
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
    if (state.excludeAi && classification.fields.includes("ai-ml")) return false;
    if (state.fields?.length && !state.fields.some(id => classification.fields.includes(id))) return false;
    if (state.forms?.length && !state.forms.some(id => classification.forms.includes(id))) return false;
    if (state.lang && repo?.lang !== state.lang) return false;
    if (state.q && !sourceText(repo).includes(state.q.toLowerCase())) return false;
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
    if (selected === "trending") return original.map(({ repo }) => repo);
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
    fields: [...FIELD_DEFINITIONS.map(([id, label]) => ({ id, label })), { id: "unclassified", label: "미분류" }],
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
