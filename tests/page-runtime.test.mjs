import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const uiMotionSource = await readFile(new URL("../ui-motion.js", import.meta.url), "utf8");
const repoFiltersSource = await readFile(new URL("../repo-filters.js", import.meta.url), "utf8");

function sidebarHarness({ hoverCapable = true } = {}) {
  const start = page.indexOf('const sidebar=document.getElementById("filterSidebar")');
  const end = page.indexOf("\nfunction syncUrl", start);
  const showTipStart = page.indexOf("function showTip(card){");
  const showTipEnd = page.indexOf("\nfunction positionTip", showTipStart);
  assert.ok(start >= 0 && end > start, "sidebar runtime fixture must be isolated");
  assert.ok(showTipStart >= 0 && showTipEnd > showTipStart, "tooltip runtime fixture must be isolated");

  class ClassList {
    constructor() { this.values = new Set(); }
    add(...values) { values.forEach(value => this.values.add(value)); }
    remove(...values) { values.forEach(value => this.values.delete(value)); }
    contains(value) { return this.values.has(value); }
  }

  const trace = [];
  let documentRef;
  class FakeHTMLElement {
    constructor(id) {
      this.id = id;
      this.attributes = new Map();
      this.classList = new ClassList();
      this.dataset = {};
      this._inert = false;
      this.listeners = new Map();
      this.focusCount = 0;
      this.focusWithin = false;
      this.canFocus = true;
      this.tagName = "DIV";
      this.role = null;
      this.tabIndex = undefined;
      this.parentElement = null;
      this.isConnected = true;
      this.withinSidebar = false;
      this.width = 320;
      this.capturedPointer = null;
      this.style = {
        transform: "",
        removeProperty(name) { if (name === "transform") this.transform = ""; },
      };
    }
    set inert(value) { this._inert = value; trace.push(`${this.id}:inert:${value}`); }
    get inert() { return this._inert; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    dispatch(type, properties = {}) {
      const event = {
        type,
        target: this,
        currentTarget: this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; trace.push(`${type}:preventDefault`); },
        immediatePropagationStopped: false,
        stopImmediatePropagation() { this.immediatePropagationStopped = true; trace.push(`${type}:stopImmediatePropagation`); },
        ...properties,
      };
      for (const listener of this.listeners.get(type) || []) {
        listener(event);
        if (event.immediatePropagationStopped) break;
      }
      return event;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); trace.push(`${this.id}:${name}:${value}`); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    matches(selector) {
      if (selector === ":focus-within") return this.focusWithin;
      if (selector === ":focus") return documentRef.activeElement === this;
      return false;
    }
    closest(selector) {
      const selectors = selector.split(",").map(value => value.trim().toLowerCase());
      for (let node = this; node; node = node.parentElement) {
        const tagName = String(node.tagName || "").toLowerCase();
        if (selectors.some(value => value === tagName
          || (value === '[role="button"]' && node.role === "button")
          || (value === "[tabindex]" && node.tabIndex !== undefined))) return node;
      }
      return null;
    }
    contains(node) {
      for (let current = node; current; current = current.parentElement) if (current === this) return true;
      return Boolean(node?.withinSidebar);
    }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { width: this.width }; }
    setPointerCapture(pointerId) { this.capturedPointer = pointerId; trace.push(`${this.id}:capture:${pointerId}`); }
    hasPointerCapture(pointerId) { return this.capturedPointer === pointerId; }
    releasePointerCapture(pointerId) {
      if (this.capturedPointer === pointerId) this.capturedPointer = null;
      trace.push(`${this.id}:release:${pointerId}`);
    }
    focus() {
      if (!this.canFocus) { trace.push(`${this.id}:focus-noop`); return; }
      documentRef.activeElement = this;
      this.focusWithin = true;
      this.focusCount += 1;
      trace.push(`${this.id}:focus`);
    }
  }

  const nodes = new Map([
    ["filterSidebar", new FakeHTMLElement("filterSidebar")],
    ["sidebarScrim", new FakeHTMLElement("sidebarScrim")],
    ["navToggle", new FakeHTMLElement("navToggle")],
    ["mobileNavToggle", new FakeHTMLElement("mobileNavToggle")],
    ["sidebarClose", new FakeHTMLElement("sidebarClose")],
    ["readmePanel", new FakeHTMLElement("readmePanel")],
    ["tipLayer", new FakeHTMLElement("tipLayer")],
  ]);
  const pageMain = new FakeHTMLElement("pageMain");
  const outside = new FakeHTMLElement("outside");
  const body = new FakeHTMLElement("body");
  const documentListeners = new Map();
  const windowListeners = new Map();
  function dispatchListeners(listeners, type, properties = {}) {
    const event = {
      type,
      target: properties.target ?? documentRef,
      currentTarget: documentRef,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; trace.push(`${type}:preventDefault`); },
      immediatePropagationStopped: false,
      stopImmediatePropagation() { this.immediatePropagationStopped = true; trace.push(`${type}:stopImmediatePropagation`); },
      ...properties,
    };
    for (const listener of listeners.get(type) || []) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return event;
  }
  documentRef = {
    activeElement: outside,
    body,
    getElementById(id) { return nodes.get(id); },
    querySelector(selector) { return selector === ".wrap" ? pageMain : null; },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    dispatch(type, properties = {}) { return dispatchListeners(documentListeners, type, properties); },
  };
  const windowRef = {
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
    dispatch(type, properties = {}) { return dispatchListeners(windowListeners, type, properties); },
  };

  let now = 0;
  let timerId = 0;
  const timers = new Map();
  function setTimer(callback, delay = 0) {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay });
    return id;
  }
  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = target;
  }

  const calls = { closeReadme: 0, hideTip: 0 };
  const context = {
    document: documentRef,
    window: windowRef,
    HTMLElement: FakeHTMLElement,
    performance: { now: () => now },
    matchMedia(query) { return { matches: query.includes("pointer:coarse") ? !hoverCapable : hoverCapable }; },
    closeReadme() { calls.closeReadme += 1; nodes.get("readmePanel").classList.remove("open"); },
    hideTip() {
      calls.hideTip += 1;
      const tipLayer = nodes.get("tipLayer");
      tipLayer.classList.remove("on");
      tipLayer.setAttribute("aria-hidden", "true");
      tipLayer.inert = true;
    },
    setTimeout: setTimer,
    clearTimeout(id) { timers.delete(id); },
    tr(key) { return key; },
  };
  context.globalThis = context;
  context.__repos = [{ summary: { goal: "goal" } }];
  context.__tipLayer = nodes.get("tipLayer");
  context.__positionCount = 0;
  vm.createContext(context);
  vm.runInContext(uiMotionSource, context, { filename: "ui-motion-fixture.js" });
  vm.runInContext(page.slice(start, end), context, { filename: "sidebar-runtime-fixture.js" });
  vm.runInContext(`
    const REPOS=globalThis.__repos,tipLayer=globalThis.__tipLayer;
    let activeTipIndex=null,hideTimer=null;
    function tipHTML(){return "tooltip"}
    function positionTip(){globalThis.__positionCount+=1}
    ${page.slice(showTipStart, showTipEnd)}
    globalThis.__showTip=showTip;
  `, context, { filename: "tooltip-runtime-fixture.js" });

  return {
    sidebar: nodes.get("filterSidebar"),
    scrim: nodes.get("sidebarScrim"),
    toggle: nodes.get("navToggle"),
    close: nodes.get("sidebarClose"),
    readme: nodes.get("readmePanel"),
    tipLayer: nodes.get("tipLayer"),
    pageMain,
    body,
    outside,
    document: documentRef,
    window: windowRef,
    UiMotion: context.UiMotion,
    calls,
    trace,
    advance,
    showTip(card = { dataset: { idx: "0" } }) { context.__showTip(card); },
    positionCount() { return context.__positionCount; },
    createTarget(id, options = {}) {
      const target = new FakeHTMLElement(id);
      Object.assign(target, options);
      return target;
    },
    listenerCount(type) { return documentListeners.get(type)?.length ?? 0; },
  };
}

function renderContractHarness(classification = { forms: [], fields: ["unclassified"] }, repos = []) {
  const start = page.indexOf("function newOnlyGate(");
  const end = page.indexOf("\n/* render */", start);
  assert.ok(start >= 0 && end > start, "render contract helpers must be isolated");
  const context = {
    MEMBERSHIP_STATUS: new Map(),
    RepoFilters: {
      fields: [
        { id: "ai-ml", label: "AI·머신러닝" },
        { id: "dev-tools", label: "개발 도구" },
        { id: "security", label: "보안·프라이버시" },
        { id: "unclassified", label: "미분류" },
      ],
      forms: [
        { id: "agent", label: "Agent" },
        { id: "mcp", label: "MCP" },
      ],
      classifyRepo() { return classification; },
    },
    MembershipHistory: {
      currentStatus(status) { return status.currentStatus; },
    },
    REPOS: repos,
    esc(value) { return String(value); },
    tr(key, parameters = {}) {
      const messages = {
        "new.loading": "Loading new-repository status…",
        "new.loadingSummary": "Loading new-repository status.",
        "new.error": "New-repository status could not be loaded, so this filter is unavailable.",
        "result.count": `${parameters.count} repositories`,
        "classification.form": "Form",
        "classification.field": "Field and technology",
        "classification.ai": "AI related",
      };
      return messages[key] ?? key;
    },
    filterLabel(kind, id) {
      return ({ agent: "Agent", mcp: "MCP", "dev-tools": "Developer tools", security: "Security and privacy", unclassified: "Unclassified" })[id] ?? id;
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${page.slice(start, end)}
    globalThis.__renderContract={newOnlyGate,transientMembershipRepo,membershipStatusForRepos,classificationBadges};
  `, context, { filename: "render-contract-fixture.js" });
  return { context, contract: context.__renderContract };
}

function cardRenderHarness(period, membership = "stayed") {
  const start = page.indexOf('const list=document.getElementById("list"),empty=document.getElementById("empty")');
  const end = page.indexOf("\n/* 즐겨찾기 */", start);
  assert.ok(start >= 0 && end > start, "card render runtime must be isolated");
  const nodes = new Map([
    ["list", { innerHTML: "" }],
    ["empty", { style: {} }],
    ["emptyText", { textContent: "" }],
    ["emptyResetBtn", { hidden: false }],
    ["emptyManageHiddenBtn", { hidden: false }],
    ["filterSummary", { textContent: "" }],
  ]);
  const repository = {
    slug: "owner/project", name: "owner / project", desc: "A repository", lang: "JavaScript", color: "#f1e05a",
    topics: [], tag_rule_version: 1, field_tags: ["unclassified"], form_tags: [], membership_status: membership === "baseline" ? "baseline_present" : membership,
    rank_daily: 1, stars_daily: 1200, rank_weekly: null, stars_weekly: null, rank_monthly: null, stars_monthly: null,
    stars: 5000, forks: 20, contributors: 4, issues: 3,
  };
  const context = {
    globalThis: null,
    URLSearchParams,
    document: { getElementById(id) { return nodes.get(id); } },
    period,
    filterState: { period, sort: "trending", favOnly: false, q: "", lang: "", fields: [], forms: [], excludeAi: false, newOnly: false },
    membershipLoadState: "ready",
    currentVisibleRepos: [],
    REPOS: [repository],
    favOnly: false,
    favSet: new Set(),
    hiddenSet: new Set(),
    HiddenRepos: { filterRepos(repositories) { return repositories; } },
    SIGNALS: new Map(),
    MEMBERSHIP_STATUS: new Map([[repository.slug, membership]]),
    favoriteBusy: false,
    newOnlyGate() { return null; },
    transientMembershipRepo(value) { return value; },
    updateHiddenManager() {},
    activeDiscoveryCount() { return 0; },
    classificationBadges() { return ""; },
    renderHist() {},
    esc(value) { return String(value ?? ""); },
    fmt(value) { return String(value); },
    tr(key, parameters = {}) { return key === "result.count" ? `${parameters.count} repositories` : key; },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(uiMotionSource, context, { filename: "ui-motion-card-fixture.js" });
  vm.runInContext(repoFiltersSource, context, { filename: "repo-filters-card-fixture.js" });
  vm.runInContext(`${page.slice(start, end)}\nglobalThis.__render=render;`, context, { filename: "card-render-fixture.js" });
  context.__render();
  return { html: nodes.get("list").innerHTML, visible: context.currentVisibleRepos };
}

function scrollTopHarness({ reducedMotion = false } = {}) {
  const start = page.indexOf("/* scroll-to-top runtime */");
  const end = page.indexOf("/* scroll-to-top runtime end */", start);
  assert.ok(start >= 0 && end > start, "scroll-to-top runtime must be isolated");
  class ClassList {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
  }
  const button = {
    hidden: true,
    inert: true,
    tabIndex: -1,
    classList: new ClassList(),
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
      getPropertyValue(name) { return this.values.get(name) ?? ""; },
    },
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    dispatch(type) { this.listeners.get(type)?.({ currentTarget: this }); },
    getBoundingClientRect() { return { top: 0, width: 48, height: 48 }; },
  };
  const listeners = new Map(), frames = [], scrollCalls = [];
  const windowRef = {
    scrollY: 0,
    innerHeight: 800,
    addEventListener(type, listener, options) { listeners.set(type, { listener, options }); },
    scrollTo(options) { scrollCalls.push(options); },
  };
  const hiddenNotice = {
    hidden: true,
    height: 0,
    getBoundingClientRect() {
      return { top: windowRef.innerHeight - 20 - this.height, height: this.height };
    },
  };
  const context = {
    document: { getElementById(id) { return id === "scrollTopBtn" ? button : id === "hiddenNotice" ? hiddenNotice : null; } },
    window: windowRef,
    sidebar: { dataset: {} },
    sidebarScrim: { classList: new ClassList() },
    panel: { classList: new ClassList() },
    scrim: { classList: new ClassList() },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    matchMedia() { return { matches: reducedMotion }; },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(page.slice(start, end), context, { filename: "scroll-top-fixture.js" });
  return {
    button,
    sidebar: context.sidebar,
    sidebarScrim: context.sidebarScrim,
    panel: context.panel,
    scrim: context.scrim,
    scrollCalls,
    listener(type) { return listeners.get(type); },
    dispatch(type) { listeners.get(type)?.listener({ type }); },
    setViewport(scrollY, innerHeight = 800) { windowRef.scrollY = scrollY; windowRef.innerHeight = innerHeight; },
    setUndo(hidden, height = 0) { hiddenNotice.hidden = hidden; hiddenNotice.height = height; },
    offset() { return button.style.getPropertyValue("--scroll-top-offset"); },
    pendingFrames() { return frames.length; },
    flush() { const callbacks = frames.splice(0); callbacks.forEach(callback => callback()); },
    click() { button.dispatch("click"); },
    openModal() { context.sidebar.dataset.openMode = "modal"; context.hideScrollTopImmediately(); },
  };
}

test("the generated page has unique element ids", () => {
  const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, []);
});

test("the BFCache lifecycle helper loads before the dynamic Firebase client", () => {
  const lifecycle = page.indexOf('<script src="auth-lifecycle.js"></script>');
  const firebase = page.indexOf('import("./firebase-client.js").catch');
  assert.ok(lifecycle >= 0, "auth lifecycle helper must be loaded by the page");
  assert.ok(firebase >= 0 && lifecycle < firebase, "auth lifecycle helper must load before dynamic Firebase import");
});

test("repository signals are initialized before rendering and refreshed from the feed", () => {
  const declaration = page.indexOf("const SIGNALS=new Map()");
  const render = page.indexOf("function render(){");
  assert.ok(declaration >= 0 && declaration < render, "SIGNALS must exist before the first render");
  assert.match(page, /SIGNALS\.get\(r\.slug\)/);
  assert.match(page, /SIGNALS\.set\(repo\.slug,repo\.signal\)/);
  assert.match(page, /SIGNALS\.set\(repo\.slug,repo\.signal\)[\s\S]*?render\(\)/);
});

test("tooltip cleanup and refresh status contain no merged JavaScript tokens", () => {
  assert.doesNotMatch(page, /nulldocument/);
  assert.match(page, /activeTipIndex=null;listStage\.style\.transform=""/);
  assert.doesNotMatch(page, /activeSummaryLocale/);
  assert.match(page, /id="refreshStatus" class="sidebar-refresh"/);
});

test("tooltip runtime has one detailed content path", () => {
  assert.match(page, /function tipHTML\(r/);
  assert.match(page, /const bundle=summaryBundle\(r\),s=locale\?bundle\[locale\]:null/);
  assert.match(page, /tipLayer\.innerHTML=tipHTML\(repo,resolveSummaryLocale\(repo,siteI18n\.locale\)\)/);
  assert.doesNotMatch(page, /tipHTML\(r,detailed\)|r\.detail|mobile summary/i);
  assert.doesNotMatch(page, /UiMotion\.mobileTooltipHtml/);
  for (const field of ["goal", "usage", "pros", "cons", "fit"]) {
    assert.match(page, new RegExp(`esc\\(s\\.${field}\\)`));
  }
  for (const key of ["goal", "usage", "pros", "cons", "fit"]) {
    assert.match(page, new RegExp(`tr\\(\"tooltip\\.${key}\"\\)`));
  }
});

test("tooltip renders the fixed held copy instead of a summary for held repositories", async () => {
  assert.match(page, /r\.summary_status==="held"/);
  assert.match(page, /tr\("tooltip\.held"\)/);
  const i18n = await readFile(new URL("../site-i18n.js", import.meta.url), "utf8");
  assert.equal([...i18n.matchAll(/"tooltip\.held":/g)].length, 5);
  assert.match(i18n, /"tooltip\.held":"요약 검증 중입니다/);
});

test("site-locale changes re-render an open tooltip from the one persisted locale", () => {
  const localeChange = page.match(/document\.addEventListener\("site-locale-change",\(\)=>\{[\s\S]*?\n\}\);/)?.[0] ?? "";
  assert.match(localeChange, /tipLayer\.innerHTML=tipHTML\(repo,resolveSummaryLocale\(repo,siteI18n\.locale\)\)/);
  assert.doesNotMatch(localeChange, /activeSummaryLocale/);
});

test("the refresh status appears once at the top of the sidebar and not in main", () => {
  assert.equal([...page.matchAll(/id="refreshStatus"/g)].length, 1);
  assert.match(page, /id="refreshStatus" class="sidebar-refresh" role="status" aria-live="polite" aria-atomic="true"/);
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<div id="sidebarScrim"/)?.[0] ?? "";
  const statusIndex = sidebar.indexOf('id="refreshStatus"');
  const accountIndex = sidebar.indexOf('id="accountSection"');
  assert.ok(statusIndex >= 0 && statusIndex < accountIndex, "refresh status must precede the account section");
  const main = page.match(/<main class="wrap">([\s\S]*?)<\/main>/)?.[1] ?? "";
  assert.doesNotMatch(main, /id="refreshStatus"/);
  assert.match(page, /\.sidebar-refresh\{[^}]*font-variant-numeric:tabular-nums/);
});

test("sidebar sections follow the approved priority and keyboard order", () => {
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<\/div>\s*<nav class="nav-rail"/)?.[0] ?? "";
  const sectionIds = [
    "refreshStatus", "accountSection", "viewSection", "periodSection", "languageSection",
    "fieldSection", "formSection", "sortSection", "resultSection", "hiddenRepoSection",
    "recentExitsSection", "exportSection",
  ];
  let previous = -1;
  for (const id of sectionIds) {
    const position = sidebar.indexOf(`id="${id}"`);
    assert.ok(position > previous, `${id} must exist after the preceding sidebar section`);
    previous = position;
  }

  const focusOrder = [
    "loginBtn", "logoutBtn", "allReposBtn", "favOnlyBtn", "periodSeg", "lang",
    "fieldFilters", "excludeAi", "formFilters", "sortSelect", "clearFiltersBtn",
    "restoreAllHiddenBtn", "recentExitsList", "exportCsvBtn", "exportJsonBtn", "copyViewUrlBtn",
  ];
  previous = -1;
  for (const id of focusOrder) {
    const position = sidebar.indexOf(`id="${id}"`);
    assert.ok(position > previous, `${id} must retain keyboard order inside its sidebar section`);
    previous = position;
  }
  assert.match(sidebar, /<section[^>]*id="hiddenRepoSection"[^>]*hidden[\s\S]*?id="restoreAllHiddenBtn"/);
  assert.match(sidebar, /<section[^>]*id="recentExitsSection"[^>]*hidden[\s\S]*?id="recentExitsList"/);
  assert.match(page, /filter\(el=>!el\.hidden&&!el\.closest\("\[hidden\]"\)\)/);
});

test("refresh copy and calculation follow the approved two-hour schedule", () => {
  const refresh = page.match(/<section[^>]*id="refreshStatus"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.equal([...page.matchAll(/Dashboard menu/g)].length, 1);
  assert.equal([...refresh.matchAll(/<p\b/g)].length, 3);
  assert.match(refresh, /<p id="luLast" data-i18n="refresh\.loading">Last refreshed: loading…<\/p>/);
  assert.match(refresh, /<p id="luNext" data-i18n="refresh\.next">Next refresh: —<\/p>/);
  assert.match(refresh, /<p id="luCadence" data-i18n="refresh\.cadence">Refreshes every 2 hours<\/p>/);
  assert.match(page, /<script src="refresh-schedule\.js"><\/script>/);
  assert.match(page, /RefreshSchedule\.nextRefreshTime\(Date\.now\(\)\)/);
  assert.match(page, /function updateRefreshStatus\(nextLastValue\)/);
  assert.match(page, /document\.getElementById\("luCadence"\)\.textContent=tr\("refresh\.cadence"\)/);
  assert.doesNotMatch(page, /서울 기준 홀수 시 07분|매일 03:17 갱신|setUTCHours\(18,17/);
});

test("README rendering does not load third-party HTML parsers", () => {
  const externalScripts = [...page.matchAll(/<script\s+src="(https:[^"]+)"([^>]*)><\/script>/g)];
  assert.equal(externalScripts.length, 0);
});

test("README tabs consume only Markdown tied to immutable repository metadata", () => {
  assert.match(page, /<script src="readme-markdown\.js"><\/script>/);
  assert.match(page, /function readmeMetadata\(repo\)/);
  assert.match(page, /readme_path/);
  assert.match(page, /readme_blob_sha/);
  assert.match(page, /default_branch_head_sha/);
  assert.match(page, /readme_variants/);
  assert.match(page, /https:\/\/api\.github\.com\/repos\/\$\{state\.slug\}\/contents\/\$\{encodeReadmePath\(variant\.path\)\}\?ref=\$\{state\.metadata\.defaultBranchHeadSha\}/);
  assert.match(page, /payload\.sha!==variant\.blobSha/);
  assert.match(page, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(page, /actual!==expectedHash\.toLowerCase\(\)/);
  assert.match(page, /ReadmeMarkdown\.render\(markdown,\{repositoryUrl:`https:\/\/github\.com\/\$\{state\.slug\}`,blobSha:variant\.blobSha,commitSha:state\.metadata\.defaultBranchHeadSha\}\)/);
  assert.doesNotMatch(page, /translations\/|translated_markdown|translation_applicable/);
  assert.doesNotMatch(page, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(page, /HEAD\/README\.md/);
});

test("README runtime refuses a mismatched immutable Contents response without using HEAD", async () => {
  const start = page.indexOf('const panel=document.getElementById("readmePanel")');
  const end = page.indexOf("/* 제목·빈 결과 버튼");
  assert.ok(start >= 0 && end > start, "README runtime fixture must isolate the panel code");
  const nodes = new Map();
  const node = () => ({
    attributes: new Map(), classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, animate() {}, focus() {}, setAttribute(name, value) { this.attributes.set(name, value); },
    innerHTML: "", textContent: "", inert: true, onclick: null,
  });
  const getNode = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const requested = [];
  const rendered = [];
  const expectedSha = "a".repeat(40);
  const context = {
    globalThis: { __README_RUNTIME_TEST__: true },
    REPOS: [{ slug: "owner/repo", readme_path: "README.md", readme_blob_sha: expectedSha, readme_content_sha256: "c".repeat(64), default_branch_head_sha: expectedSha }],
    document: {
      getElementById: getNode,
      querySelector(selector) { return selector.startsWith(".rp-tabs") ? { id: "tabOrig" } : node(); },
      addEventListener() {},
      body: node(),
    },
    pageMain: node(), sidebar: node(), closeSidebar() {}, hideTip() {}, matchMedia() { return { matches: true }; },
    window: { open() {} }, location: { reload() {} },
    ReadmeMarkdown: { render(markdown) { rendered.push(markdown); return `<p>${markdown}</p>`; } },
    SUMMARY_LOCALES: ["en", "ko", "zh-CN", "es", "ja"],
    siteI18n: { locale: "en" },
    tr(key) { return ({ "readme.default": "Default", "readme.loading": "Loading…", "readme.unavailable": "README is unavailable.", "readme.direct": "View directly on GitHub ↗" })[key] ?? key; },
    fetch: async url => {
      requested.push(url);
      return { ok: true, json: async () => ({ path: "README.md", sha: "b".repeat(40), encoding: "base64", content: "IyBSZXBv" }) };
    },
    TextDecoder, TextEncoder, Uint8Array, atob, crypto: globalThis.crypto, Error, Promise, Map,
  };
  vm.runInNewContext(page.slice(start, end), context, { filename: "readme-runtime-fixture.js" });
  await context.globalThis.ReadmeRuntime.openReadme("owner/repo", "Repo");
  assert.deepEqual(requested, [`https://api.github.com/repos/owner/repo/contents/README.md?ref=${expectedSha}`]);
  assert.equal(requested.some(url => url.includes("HEAD/README.md")), false);
  assert.deepEqual(rendered, []);
  assert.match(getNode("readmeBody").innerHTML, /README is unavailable\./);
});

test("landmarks, form controls, and hidden panels retain accessible boundaries", () => {
  assert.match(page, /<main class="wrap">[\s\S]*?<\/main>/);
  const main = page.match(/<main class="wrap">([\s\S]*?)<\/main>/)?.[1] ?? "";
  assert.match(main, /<div class="list" id="list"><\/div>/);
  assert.match(main, /class="signal-guide"[^>]*aria-label="Badge guide"[^>]*data-i18n-aria-label="badges\.aria"/);
  assert.match(main, /class="list-stage" id="listStage"/);
  assert.match(main, /<footer>/);
  assert.match(page, /<select class="langsel" id="lang" aria-label="Programming language"[^>]*data-i18n-aria-label="language\.title"/);
  assert.match(page, /<input class="search" id="q" aria-label="Search repositories"[^>]*data-i18n-aria-label="search\.aria"/);
  assert.match(page, /id="readmePanel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-hidden="true" inert/);
  assert.match(page, /id="tipLayer"[^>]*aria-hidden="true" inert/);
  assert.match(page, /panel\.inert=false[\s\S]*?panel\.setAttribute\("aria-hidden","false"\)/);
  assert.match(page, /panel\.setAttribute\("aria-hidden","true"\);\s*panel\.inert=true/);
  assert.doesNotMatch(page, /#tipLayer h3|<h3>\$\{esc\(r\.name\)\}<\/h3>/);
});

test("fine pointers expose the selected 64px compact Explore rail", () => {
  assert.match(page, /\.filter-sidebar\{[\s\S]*?height:100vh;height:100dvh[\s\S]*?transform:translate3d\(-105%,0,0\)/);
  const finePointer = page.match(/@media\(hover:hover\) and \(pointer:fine\)\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(finePointer, /\.nav-rail\{[^}]*display:flex/);
  assert.match(finePointer, /\.filter-sidebar\{[^}]*left:64px[^}]*width:min\(336px,calc\(100vw - 64px\)\)/);
  assert.match(page, /\.nav-rail\{[^}]*width:64px[^}]*height:100vh[^}]*height:100dvh/);
  assert.match(page, /\.nav-toggle:hover,\.nav-toggle:focus-visible,[^}]*\.nav-toggle\{[^}]*background:var\(--accent-soft\)[^}]*color:var\(--accent-selected\)/);
});

test("hover-open sidebar stays passive and exposes non-modal dialog semantics", () => {
  const harness = sidebarHarness();
  harness.toggle.dispatch("pointerenter");

  assert.equal(harness.sidebar.dataset.openMode, "hover");
  assert.equal(harness.sidebar.classList.contains("open"), true);
  assert.equal(harness.sidebar.getAttribute("aria-hidden"), "false");
  assert.equal(harness.sidebar.getAttribute("aria-modal"), null);
  assert.equal(harness.pageMain.inert, false);
  assert.equal(harness.scrim.classList.contains("on"), false);
  assert.equal(harness.body.classList.contains("overlay-open"), false);
  assert.equal(harness.close.focusCount, 0);
  assert.equal(harness.calls.hideTip, 1);
});

test("README modal blocks incidental hover and yields to explicit sidebar activation", () => {
  const harness = sidebarHarness();
  harness.readme.classList.add("open");
  harness.toggle.dispatch("pointerenter");
  assert.equal(harness.sidebar.dataset.openMode, undefined);
  assert.equal(harness.calls.closeReadme, 0);

  harness.toggle.dispatch("click");
  assert.equal(harness.calls.closeReadme, 1);
  assert.equal(harness.readme.classList.contains("open"), false);
  assert.equal(harness.sidebar.dataset.openMode, "modal");
});

test("hover close starts immediately outside the combined rail and sidebar while preserving focus", () => {
  const harness = sidebarHarness();
  harness.toggle.dispatch("pointerenter");
  harness.sidebar.dispatch("pointerenter");
  harness.sidebar.focusWithin = true;
  harness.sidebar.dispatch("focusin");
  harness.toggle.dispatch("pointerleave", { relatedTarget: harness.sidebar });
  assert.equal(harness.sidebar.dataset.openMode, "hover", "rail to sidebar movement must stay open");
  harness.sidebar.dispatch("pointerleave");
  assert.equal(harness.sidebar.dataset.openMode, "hover", "focus inside must keep hover mode open");

  harness.sidebar.focusWithin = false;
  harness.document.activeElement = harness.outside;
  harness.sidebar.dispatch("focusout", { relatedTarget: harness.outside });
  assert.equal(harness.sidebar.dataset.openMode, undefined);
  assert.equal(harness.sidebar.classList.contains("open"), false);

  harness.toggle.dispatch("pointerenter");
  assert.equal(harness.sidebar.dataset.openMode, "hover");
  harness.toggle.dispatch("pointerleave", { relatedTarget: harness.outside });
  assert.equal(harness.sidebar.dataset.openMode, undefined, "outside pointerleave must not wait for a timer");
});

test("click and keyboard activation upgrade hover-open sidebar exactly once", () => {
  for (const activation of ["click", "keyboard"]) {
    const harness = sidebarHarness();
    harness.toggle.dispatch("pointerenter");
    harness.toggle.dispatch("click", { detail: activation === "keyboard" ? 0 : 1 });

    assert.equal(harness.sidebar.dataset.openMode, "modal", `${activation} must upgrade to modal`);
    assert.equal(harness.sidebar.getAttribute("aria-modal"), "true");
    assert.equal(harness.pageMain.inert, true);
    assert.equal(harness.scrim.classList.contains("on"), true);
    assert.equal(harness.body.classList.contains("overlay-open"), true);
    assert.equal(harness.close.focusCount, 1, `${activation} must apply modal focus exactly once`);
    assert.equal(harness.toggle.listeners.get("keydown")?.length ?? 0, 0, "native button click must be the only activation path");
  }
});

test("tooltip opening closes a passive sidebar before showing its overlay", () => {
  const showTipFlow = page.match(/function showTip\(card\)\{[\s\S]*?function positionTip/)?.[0] ?? "";
  assert.match(showTipFlow, /if\(sidebar\.dataset\.openMode==="hover"\)\{[\s\S]*?closeSidebar\(false\)/);
  assert.ok(showTipFlow.indexOf('closeSidebar(false)') < showTipFlow.indexOf('tipLayer.classList.add("on")'));
});

test("tooltip does not inert a focused hover sidebar or its focused rail", () => {
  for (const focusOwner of ["sidebar", "rail"]) {
    const harness = sidebarHarness();
    harness.toggle.dispatch("pointerenter");
    if (focusOwner === "sidebar") {
      harness.sidebar.focusWithin = true;
      harness.document.activeElement = harness.close;
    } else {
      harness.toggle.focus();
    }

    harness.showTip();
    assert.equal(harness.sidebar.dataset.openMode, "hover", `${focusOwner} focus must retain hover mode`);
    assert.equal(harness.sidebar.inert, false);
    assert.equal(harness.tipLayer.classList.contains("on"), false);
    assert.equal(harness.positionCount(), 0);
  }
});

test("incidental rail hover preserves a focused tooltip but modal activation closes it", () => {
  const harness = sidebarHarness();
  harness.tipLayer.classList.add("on");
  harness.tipLayer.inert = false;
  harness.tipLayer.focusWithin = true;
  harness.document.activeElement = harness.tipLayer;

  harness.toggle.dispatch("pointerenter");
  assert.equal(harness.sidebar.dataset.openMode, undefined);
  assert.equal(harness.tipLayer.classList.contains("on"), true);
  assert.equal(harness.tipLayer.inert, false);
  assert.equal(harness.calls.hideTip, 0);

  harness.toggle.dispatch("click", { detail: 1 });
  assert.equal(harness.sidebar.dataset.openMode, "modal");
  assert.equal(harness.tipLayer.classList.contains("on"), false);
  assert.equal(harness.tipLayer.inert, true);
  assert.equal(harness.calls.hideTip, 1);
});

test("hover close button restores rail focus before hiding and inerting the sidebar", () => {
  const harness = sidebarHarness();
  harness.toggle.dispatch("pointerenter");
  harness.sidebar.focusWithin = true;
  harness.close.focus();
  harness.trace.length = 0;

  harness.close.dispatch("click");
  const focusIndex = harness.trace.indexOf("navToggle:focus");
  const hiddenIndex = harness.trace.indexOf("filterSidebar:aria-hidden:true");
  const inertIndex = harness.trace.indexOf("filterSidebar:inert:true");
  assert.ok(focusIndex >= 0 && focusIndex < hiddenIndex && focusIndex < inertIndex);
  assert.equal(harness.document.activeElement, harness.toggle);
  assert.equal(harness.sidebar.dataset.openMode, undefined);
});

test("coarse pointers hide the rail and keep the mobile trigger visually hidden until keyboard focus", () => {
  const coarse = page.match(/@media\(hover:none\),\(pointer:coarse\)\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(coarse, /body\{touch-action:pan-y pinch-zoom\}/);
  assert.match(coarse, /\.nav-rail\{display:none\}/);
  assert.doesNotMatch(coarse, /\.mobile-nav-toggle\{display:inline-flex\}/);
  assert.match(coarse, /\.filter-sidebar\{touch-action:pan-y pinch-zoom\}/);
  assert.match(page, /\.filter-sidebar\.dragging\{transition:none\}/);
  const mobileButton = page.match(/<button class="mobile-nav-toggle" id="mobileNavToggle"[^>]*>/)?.[0] ?? "";
  assert.match(mobileButton, /tabindex="-1"/);
  assert.match(mobileButton, /aria-hidden="true"/);
  assert.match(mobileButton, /\binert\b/);
  const baseStyle = page.match(/\.mobile-nav-toggle\{[^}]*\}/)?.[0] ?? "";
  assert.match(baseStyle, /width:1px/);
  assert.match(baseStyle, /height:1px/);
  assert.match(baseStyle, /overflow:hidden/);
  const focusStyle = page.match(/\.mobile-nav-toggle:focus-visible\{[^}]*\}/)?.[0] ?? "";
  assert.match(focusStyle, /position:fixed/);
  assert.match(focusStyle, /min-width:44px/);
  assert.match(focusStyle, /min-height:44px/);
  assert.match(page, /function updateMobileNavAccess\(\)/);
  assert.match(page, /mobileNavToggle\.tabIndex=available\?0:-1/);
  assert.match(page, /mobileNavToggle\.inert=!available/);
  assert.match(page, /mobileNavToggle\.setAttribute\("aria-hidden",String\(!available\)\)/);
  assert.doesNotMatch(page, /id="(?:swipeEdge|edgeHitTarget)"|class="[^"]*(?:hamburger|swipe-edge|edge-hit-target)/i);
});

test("an unclaimed 24px-edge tap preserves first-detail then same-card navigation", () => {
  const harness = sidebarHarness({ hoverCapable: false });
  assert.ok(harness.listenerCount("pointerdown") > 0);
  assert.ok(harness.listenerCount("pointermove") > 0);
  const state = { activeIndex: null, tooltipOpen: false, visited: [] };
  function card(index) {
    const target = harness.createTarget(`card${index}`);
    target.dataset.idx = String(index);
    target.href = `https://github.com/owner/repo${index}`;
    target.addEventListener("click", () => {
      const action = harness.UiMotion.touchCardAction({
        activeIndex: state.activeIndex,
        cardIndex: index,
        tooltipOpen: state.tooltipOpen,
      });
      if (action === "navigate") state.visited.push(target.href);
      else { state.activeIndex = index; state.tooltipOpen = true; }
    });
    return target;
  }
  function tap(target, pointerId) {
    const down = harness.document.dispatch("pointerdown", { target, pointerId, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
    const up = harness.document.dispatch("pointerup", { target, pointerId, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
    target.dispatch("click");
    assert.equal(down.defaultPrevented, false);
    assert.equal(up.defaultPrevented, false);
    assert.equal(target.capturedPointer, null);
  }

  const first = card(0), different = card(1);
  tap(first, 1);
  assert.equal(state.activeIndex, 0);
  assert.deepEqual(state.visited, []);
  tap(first, 2);
  assert.deepEqual(state.visited, ["https://github.com/owner/repo0"]);
  tap(different, 3);
  assert.equal(state.activeIndex, 1);
  assert.equal(state.visited.length, 1);
});

test("pointerdown, vertical intent, x=25, and interactive targets remain unclaimed", () => {
  const harness = sidebarHarness({ hoverCapable: false });
  assert.ok(harness.listenerCount("pointerdown") > 0);
  const gestureRuntime = page.match(/const sidebarCoarseMedia=[\s\S]*?function syncUrl/)?.[0] ?? "";
  assert.match(gestureRuntime, /document\.addEventListener\("pointerdown",handleSidebarGestureDown,true\)/);
  assert.match(gestureRuntime, /document\.addEventListener\("pointermove",handleSidebarGestureMove,\{passive:false\}\)/);
  const downFlow = gestureRuntime.match(/function handleSidebarGestureDown[\s\S]*?function handleSidebarGestureMove/)?.[0] ?? "";
  assert.doesNotMatch(downFlow, /preventDefault\s*\(|setPointerCapture\s*\(/);
  const plain = harness.createTarget("plain");
  const down = harness.document.dispatch("pointerdown", { target: plain, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
  assert.equal(down.defaultPrevented, false);
  assert.equal(plain.capturedPointer, null);
  const vertical = harness.document.dispatch("pointermove", { target: plain, pointerId: 1, clientX: 20, clientY: 140 });
  assert.equal(vertical.defaultPrevented, false);
  assert.equal(plain.capturedPointer, null);
  assert.equal(harness.pageMain.tabIndex, undefined);

  const undecided = harness.createTarget("undecided");
  harness.document.dispatch("pointerdown", { target: undecided, pointerId: 5, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
  const diagonal = harness.document.dispatch("pointermove", { target: undecided, pointerId: 5, clientX: 22, clientY: 109 });
  assert.equal(diagonal.defaultPrevented, false);
  assert.equal(undecided.capturedPointer, null);
  harness.document.dispatch("pointerup", { target: undecided, pointerId: 5, clientX: 22, clientY: 109 });

  for (const [target, x, pointerId] of [
    [harness.createTarget("outside-edge"), 25, 2],
    [harness.createTarget("button", { tagName: "BUTTON" }), 12, 3],
    [harness.createTarget("link", { tagName: "A" }), 12, 4],
    [harness.createTarget("input", { tagName: "INPUT" }), 12, 11],
    [harness.createTarget("select", { tagName: "SELECT" }), 12, 12],
    [harness.createTarget("textarea", { tagName: "TEXTAREA" }), 12, 13],
    [harness.createTarget("role-button", { role: "button" }), 12, 14],
  ]) {
    const candidate = harness.document.dispatch("pointerdown", { target, pointerId, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: 100 });
    const move = harness.document.dispatch("pointermove", { target, pointerId, clientX: x + 70, clientY: 102 });
    harness.document.dispatch("pointerup", { target, pointerId, clientX: x + 70, clientY: 102 });
    assert.equal(candidate.defaultPrevented, false);
    assert.equal(move.defaultPrevented, false);
    assert.equal(target.capturedPointer, null);
  }
  assert.equal(harness.sidebar.dataset.openMode, undefined);

  harness.toggle.dispatch("click", { detail: 1 });
  const outsideOpen = harness.createTarget("outside-open");
  harness.document.dispatch("pointerdown", { target: outsideOpen, pointerId: 6, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
  const outsideMove = harness.document.dispatch("pointermove", { target: outsideOpen, pointerId: 6, clientX: 80, clientY: 102 });
  assert.equal(outsideMove.defaultPrevented, false);
  assert.equal(harness.sidebar.dataset.openMode, "modal");
});

test("a claimed short swipe consumes exactly its matching synthetic click", () => {
  const harness = sidebarHarness({ hoverCapable: false });
  const card = harness.createTarget("claimed-card", { tagName: "ARTICLE", tabIndex: 0 });
  let navigations = 0;
  card.addEventListener("click", () => { navigations += 1; });
  function claimedCancel(pointerId) {
    harness.document.dispatch("pointerdown", { target: card, pointerId, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
    const move = harness.document.dispatch("pointermove", { target: card, pointerId, clientX: 32, clientY: 102 });
    assert.equal(move.defaultPrevented, true);
    harness.document.dispatch("pointerup", { target: card, pointerId, clientX: 32, clientY: 102 });
    assert.equal(harness.sidebar.dataset.openMode, undefined);
  }
  function click(pointerId) {
    const event = harness.document.dispatch("click", { target: card, pointerId, detail: 1 });
    if (!event.immediatePropagationStopped) card.dispatch("click", { pointerId, detail: 1 });
    return event;
  }

  claimedCancel(41);
  const synthetic = click(undefined);
  assert.equal(synthetic.defaultPrevented, true);
  assert.equal(synthetic.immediatePropagationStopped, true);
  assert.equal(navigations, 0);
  assert.equal(click(42).defaultPrevented, false);
  assert.equal(navigations, 1);

  claimedCancel(47);
  assert.equal(click(47).defaultPrevented, true);
  assert.equal(navigations, 1);

  claimedCancel(43);
  assert.equal(click(44).defaultPrevented, false);
  assert.equal(navigations, 2);

  claimedCancel(45);
  harness.advance(501);
  assert.equal(click(45).defaultPrevented, false);
  assert.equal(navigations, 3);

  claimedCancel(46);
  card.isConnected = false;
  assert.equal(click(46).defaultPrevented, false);
  assert.equal(navigations, 4);
});

test("horizontal intent claims only the move and follows the measured sidebar width", () => {
  const harness = sidebarHarness({ hoverCapable: false });
  harness.sidebar.width = 400;
  const target = harness.createTarget("edge-card");
  const down = harness.document.dispatch("pointerdown", { target, pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
  assert.equal(down.defaultPrevented, false);
  assert.equal(target.capturedPointer, null);

  const move = harness.document.dispatch("pointermove", { target, pointerId: 7, clientX: 112, clientY: 104 });
  assert.equal(move.defaultPrevented, true);
  assert.equal(target.capturedPointer, 7);
  assert.equal(harness.sidebar.classList.contains("dragging"), true);
  assert.equal(harness.sidebar.style.transform, "translate3d(-300px,0,0)");

  const up = harness.document.dispatch("pointerup", { target, pointerId: 7, clientX: 112, clientY: 104 });
  assert.equal(up.defaultPrevented, true);
  assert.equal(harness.sidebar.dataset.openMode, "modal");
  assert.equal(harness.sidebar.style.transform, "");
  assert.equal(harness.sidebar.classList.contains("dragging"), false);
});

test("a swipe-open modal restores focus to the nearest card or a focusable main fallback", () => {
  for (const nearestCard of [true, false]) {
    const harness = sidebarHarness({ hoverCapable: false });
    const card = harness.createTarget(`card-${nearestCard}`, { tagName: "ARTICLE", tabIndex: 0 });
    const target = harness.createTarget(`copy-${nearestCard}`, {
      canFocus: false,
      parentElement: nearestCard ? card : null,
    });
    harness.document.dispatch("pointerdown", { target, pointerId: 17, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
    harness.document.dispatch("pointermove", { target, pointerId: 17, clientX: 80, clientY: 102 });
    harness.document.dispatch("pointerup", { target, pointerId: 17, clientX: 80, clientY: 102 });
    assert.equal(harness.sidebar.dataset.openMode, "modal");
    assert.equal(harness.pageMain.tabIndex, nearestCard ? undefined : -1);
    assert.equal(harness.document.activeElement, harness.close);

    harness.scrim.dispatch("click");
    assert.equal(harness.document.activeElement, nearestCard ? card : harness.pageMain);
    assert.equal(harness.pageMain.inert, false);
    assert.equal(harness.sidebar.inert, true);
  }
});

test("a 48px left swipe inside an open modal closes it", () => {
  const harness = sidebarHarness({ hoverCapable: false });
  harness.toggle.dispatch("click", { detail: 1 });
  const target = harness.createTarget("sidebar-blank", { withinSidebar: true });
  harness.document.dispatch("pointerdown", { target, pointerId: 8, pointerType: "touch", isPrimary: true, button: 0, clientX: 260, clientY: 100 });
  const move = harness.document.dispatch("pointermove", { target, pointerId: 8, clientX: 211, clientY: 104 });
  assert.equal(move.defaultPrevented, true);
  harness.document.dispatch("pointerup", { target, pointerId: 8, clientX: 211, clientY: 104 });
  assert.equal(harness.sidebar.dataset.openMode, undefined);
  assert.equal(harness.sidebar.classList.contains("open"), false);
});

test("pointer cancellation and viewport changes idempotently restore the exact prior state", () => {
  for (const priorOpen of [false, true]) {
    for (const cancellation of ["pointercancel", "lostpointercapture", "resize", "orientationchange"]) {
      const harness = sidebarHarness({ hoverCapable: false });
      if (priorOpen) harness.toggle.dispatch("click", { detail: 1 });
      const target = harness.createTarget(`target-${cancellation}-${priorOpen}`, { withinSidebar: priorOpen });
      const pointerId = priorOpen ? 10 : 9;
      const startX = priorOpen ? 260 : 12;
      const moveX = priorOpen ? 220 : 80;
      harness.document.dispatch("pointerdown", { target, pointerId, pointerType: "touch", isPrimary: true, button: 0, clientX: startX, clientY: 100 });
      harness.document.dispatch("pointermove", { target, pointerId, clientX: moveX, clientY: 103 });
      assert.equal(harness.sidebar.classList.contains("dragging"), true);
      if (cancellation === "resize" || cancellation === "orientationchange") harness.window.dispatch(cancellation);
      else harness.document.dispatch(cancellation, { target, pointerId });
      if (cancellation === "resize" || cancellation === "orientationchange") harness.window.dispatch(cancellation);
      else harness.document.dispatch(cancellation, { target, pointerId });
      assert.equal(harness.sidebar.dataset.openMode, priorOpen ? "modal" : undefined);
      assert.equal(harness.sidebar.classList.contains("open"), priorOpen);
      assert.equal(harness.sidebar.classList.contains("dragging"), false);
      assert.equal(harness.sidebar.style.transform, "");
    }
  }
});

test("pinch cancellation restores the exact state before the claimed drag", () => {
  for (const priorOpen of [false, true]) {
    const harness = sidebarHarness({ hoverCapable: false });
    if (priorOpen) harness.toggle.dispatch("click", { detail: 1 });
    const target = harness.createTarget(`pinch-${priorOpen}`, { withinSidebar: priorOpen });
    const startX = priorOpen ? 260 : 12;
    const moveX = priorOpen ? 220 : 80;
    harness.document.dispatch("pointerdown", { target, pointerId: 51, pointerType: "touch", isPrimary: true, button: 0, clientX: startX, clientY: 100 });
    harness.document.dispatch("pointermove", { target, pointerId: 51, clientX: moveX, clientY: 103 });
    assert.equal(harness.sidebar.classList.contains("dragging"), true);
    harness.document.dispatch("pointercancel", { target, pointerId: 51, pointerType: "touch", pinch: true });
    assert.equal(harness.sidebar.dataset.openMode, priorOpen ? "modal" : undefined);
    assert.equal(harness.sidebar.classList.contains("open"), priorOpen);
    assert.equal(harness.sidebar.classList.contains("dragging"), false);
    assert.equal(harness.sidebar.style.transform, "");
    assert.equal(target.capturedPointer, null);
  }
});

test("gesture cancellation never consumes the next normal click", () => {
  for (const cancellation of ["pointercancel", "lostpointercapture", "resize", "orientationchange"]) {
    const harness = sidebarHarness({ hoverCapable: false });
    const target = harness.createTarget(`cancel-click-${cancellation}`, { tagName: "ARTICLE", tabIndex: 0 });
    let clicks = 0;
    target.addEventListener("click", () => { clicks += 1; });
    harness.document.dispatch("pointerdown", { target, pointerId: 61, pointerType: "touch", isPrimary: true, button: 0, clientX: 12, clientY: 100 });
    harness.document.dispatch("pointermove", { target, pointerId: 61, clientX: 80, clientY: 103 });
    assert.equal(harness.sidebar.classList.contains("dragging"), true);
    if (cancellation === "resize" || cancellation === "orientationchange") harness.window.dispatch(cancellation);
    else harness.document.dispatch(cancellation, { target, pointerId: 61 });
    assert.equal(harness.sidebar.dataset.openMode, undefined);

    const click = harness.document.dispatch("click", { target, pointerId: 61, detail: 1 });
    if (!click.immediatePropagationStopped) target.dispatch("click", { pointerId: 61, detail: 1 });
    assert.equal(click.defaultPrevented, false);
    assert.equal(click.immediatePropagationStopped, false);
    assert.equal(clicks, 1);
  }
});

test("responsive sidebar owns account, favorites, and discovery filters", () => {
  assert.match(page, /<script src="repo-filters\.js"><\/script>/);
  assert.match(page, /id="navToggle"[^>]*aria-controls="filterSidebar"[^>]*aria-expanded="false"/);
  const sidebarTag = page.match(/<div[^>]*id="filterSidebar"[^>]*>/)?.[0] ?? "";
  assert.match(sidebarTag, /role="dialog"/);
  assert.match(sidebarTag, /aria-label="Explore sidebar"/);
  assert.match(sidebarTag, /aria-hidden="true" inert/);
  assert.doesNotMatch(sidebarTag, /aria-modal=/);
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<\/div>\s*<nav class="nav-rail"/)?.[0] ?? "";
  assert.match(sidebar, /id="syncStatus"/);
  assert.match(sidebar, /id="loginBtn"/);
  assert.match(sidebar, /id="favOnlyBtn"/);
  assert.match(sidebar, /id="lang"/);
  assert.match(sidebar, /id="fieldFilters"/);
  assert.match(sidebar, /id="formFilters"/);
  assert.match(sidebar, /id="excludeAi"/);
  assert.match(page, /id="sidebarScrim"/);
  assert.match(page, /\.filter-sidebar\{[\s\S]*?transform:translate3d\(-105%,0,0\)/);
  assert.match(page, /\.filter-sidebar\.open\{transform:translate3d\(0,0,0\)/);
  assert.match(page, /if\(mode==="modal"\)[\s\S]*?pageMain\.inert=true/);
  assert.match(page, /if\(sidebar\.dataset\.openMode==="modal"\)trapFocus\(sidebar,event\)/);
});

test("static account markup is fail-closed while Firebase prepares login", () => {
  const status = page.match(/<p[^>]*id="syncStatus"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  const login = page.match(/<button[^>]*id="loginBtn"[^>]*>/)?.[0] ?? "";
  const logout = page.match(/<button[^>]*id="logoutBtn"[^>]*>/)?.[0] ?? "";

  assert.match(status, /title="Preparing sign-in\."/);
  assert.match(status, /aria-label="Browser sync\. Preparing sign-in\."/);
  assert.match(status, /data-tone="notice"/);
  assert.match(status, />Preparing sign-in\.<\/p>$/);
  assert.match(login, /\bdisabled\b/);
  assert.doesNotMatch(login, /\bhidden\b/);
  assert.match(logout, /\bhidden\b/);
  assert.match(logout, /\bdisabled\b/);
});

test("browser-local hidden repositories have tooltip actions, undo, and sidebar recovery", () => {
  assert.match(page, /<script src="favorites\.js"><\/script>\s*<script src="hidden-repos\.js"><\/script>/);
  assert.match(page, /class="rdbtn js-hide-repo"[^>]*data-slug="\$\{r\.slug\}"[^>]*>\$\{tr\("tooltip\.hide"\)\}<\/button>/);
  assert.match(page, /id="hiddenRepoSection"[^>]*hidden/);
  assert.match(page, /id="hiddenRepoList"/);
  assert.match(page, /id="restoreAllHiddenBtn"/);
  assert.match(page, /id="hiddenNotice"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(page, /id="undoHideBtn"/);
  assert.match(page, /HiddenRepos\.hide\(storage,slug\)/);
  assert.match(page, /HiddenRepos\.restore\(storage,slug\)/);
  assert.match(page, /HiddenRepos\.restoreAll\(storage\)/);
  assert.match(page, /\.tip-actions \.rdbtn\{[^}]*min-height:44px/);
});

test("keyboard users can hide the focused card without a permanent card icon", () => {
  assert.match(page, /id="cardKeyboardHint" class="sr-only"/);
  assert.match(page, /aria-describedby="cardKeyboardHint" aria-keyshortcuts="Delete"/);
  assert.match(page, /if\(e\.key==="Delete"&&e\.target===card\)/);
  assert.match(page, /hideRepository\(REPOS\[\+card\.dataset\.idx\]\.slug,true\)/);
});

test("undo clears its notice before focus returns to the restored card", () => {
  const restoreFlow = page.match(/function restoreRepository[\s\S]*?function tipHTML/)?.[0] ?? "";
  assert.match(restoreFlow, /if\(focusCard\)dismissHiddenNotice\(\);else showHiddenNotice/);
  assert.match(restoreFlow, /document\.querySelector\(`\.card\[data-idx=/);
});

test("hidden repositories are removed after favorites without entering URL state", () => {
  const renderFlow = page.match(/function render\(\)\{[\s\S]*?\/\* 즐겨찾기 \*\//)?.[0] ?? "";
  assert.match(renderFlow, /if\(favOnly\)items=items\.filter\(r=>favSet\.has\(r\.slug\)\)/);
  assert.match(renderFlow, /const matchedCount=items\.length;\s*items=HiddenRepos\.filterRepos\(items,hiddenSet\)/);
  assert.match(renderFlow, /hiddenOnly=!items\.length&&matchedCount>0/);
  assert.match(renderFlow, /tr\("empty\.hiddenAll"\)/);
  assert.match(renderFlow, /emptyManageHiddenBtn/);
  const urlFlow = page.match(/function syncUrl[\s\S]*?function toggleFilter/)?.[0] ?? "";
  assert.doesNotMatch(urlFlow, /hidden|slug/i);
});

test("the selected compact Explore rail stays reachable and outside the inert page", () => {
  const sidebarIndex = page.indexOf('id="filterSidebar"');
  const navIndex = page.indexOf('id="navToggle"');
  const scrimIndex = page.indexOf('id="sidebarScrim"');
  const mainIndex = page.indexOf('<main class="wrap">');
  assert.ok(sidebarIndex >= 0 && sidebarIndex < navIndex && navIndex < scrimIndex && scrimIndex < mainIndex);
  const main = page.match(/<main class="wrap">([\s\S]*?)<\/main>/)?.[1] ?? "";
  assert.doesNotMatch(main, /id="navToggle"/);
  assert.match(page, /<nav class="nav-rail"[^>]*aria-label="Quick navigation"[^>]*data-i18n-aria-label="nav\.quick">[\s\S]*?class="nav-toggle" id="navToggle"[^>]*aria-label="Open Explore sidebar"[^>]*data-i18n-aria-label="nav\.open"[^>]*aria-controls="filterSidebar"[^>]*aria-expanded="false"/);
  assert.match(page, /id="navToggle"[\s\S]*?<span class="nav-glyph" aria-hidden="true"><\/span>[\s\S]*?<span class="nav-label" data-i18n="nav\.explore">Explore<\/span>/);
  assert.match(page, /--sidebar-width:min\(360px,calc\(100vw - 44px\)\)/);
  assert.match(page, /\.filter-sidebar\{[\s\S]*?width:var\(--sidebar-width\)/);
  assert.match(page, /\.nav-rail\{[^}]*background:var\(--bg-elev\)[^}]*backdrop-filter:blur\(24px\) saturate\(160%\)/);
  assert.doesNotMatch(page, /\.filter-sidebar\.open~\.nav-toggle\{transform:/);
  assert.match(page, /@media\(hover:hover\) and \(pointer:fine\) and \(min-width:721px\) and \(max-width:1147px\)\{\.wrap\{padding-left:calc\(env\(safe-area-inset-left\) \+ 80px\)\}\}/);
  assert.match(page, /id="mobileNavToggle"[^>]*aria-controls="filterSidebar"[^>]*aria-expanded="false"/);
  assert.match(page, /@media\(max-width:560px\)\{[\s\S]*?h1\{white-space:normal;overflow-wrap:anywhere\}/);
  assert.match(page, /\.repo-link\{[^}]*min-width:0[^}]*overflow-wrap:anywhere[^}]*word-break:break-word/);
  assert.match(page, /@media\(max-width:560px\)\{[\s\S]*?\.undo-bar\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}[\s\S]*?\.undo-bar span\{grid-column:1\/-1;min-width:0\}/);
  assert.match(page, /setSidebarTriggerState\(tr\("nav\.close"\),true\)/);
  assert.match(page, /setSidebarTriggerState\(tr\("nav\.open"\),false\)/);
  assert.match(page, /navToggle\.addEventListener\("pointerenter"/);
  assert.match(page, /navToggle\.addEventListener\("click",activateSidebar\)/);
  assert.doesNotMatch(page, /navToggle\.addEventListener\("keydown"/);
  assert.match(page, /trigger:event\.detail===0\?"keyboard":"click"/);
  assert.match(page, /if\(readme\.classList\.contains\("open"\)\)[\s\S]*?closeReadme\(false\)/);
  assert.match(page, /if\(restoreFocus&&sidebarTrigger instanceof HTMLElement\)sidebarTrigger\.focus\(\)/);
  assert.match(page, /@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?transition-duration:0ms!important/);
});

test("filter state is restored from and written to the URL", () => {
  assert.match(page, /RepoFilters\.parseState\(location\.search/);
  assert.match(page, /history\.(?:pushState|replaceState)\(/);
  assert.match(page, /addEventListener\("popstate"/);
  assert.match(page, /RepoFilters\.matchesRepo\(transientMembershipRepo\(r\),/);
});

test("membership history is loaded before semantic badges and recent exits are rendered", () => {
  assert.match(page, /<script src="membership-history\.js"><\/script>/);
  assert.match(page, /MembershipHistory\.load\("data\/membership-status\.json",fetch\)/);
  assert.match(page, /MEMBERSHIP_STATUS\.get\(r\.slug\.toLowerCase\(\)\)/);
  assert.match(page, /tr\("badges\.newLabel"\)/);
  assert.match(page, /tr\("badges\.reenteredLabel"\)/);
  assert.match(page, /id="recentExitsSection"[^>]*hidden/);
  assert.match(page, /id="recentExitsList"/);
  assert.match(page, /recentExitsList[\s\S]*?https:\/\/github\.com\//);
});

test("new-only control follows AI exclusion and owns the complete public view state", () => {
  const fieldSection = page.match(/<section class="sidebar-section" id="fieldSection"[\s\S]*?<\/section>/)?.[0] ?? "";
  const excludeIndex = fieldSection.indexOf('id="excludeAi"');
  const newOnlyIndex = fieldSection.indexOf('id="newOnly"');
  assert.ok(excludeIndex >= 0 && excludeIndex < newOnlyIndex);
  assert.equal([...fieldSection.matchAll(/id="newOnly"/g)].length, 1);
  assert.match(fieldSection, /<fieldset class="filter-switch-row">[\s\S]*?<legend class="sr-only" data-i18n="field\.quick">Quick filters<\/legend>/);
  assert.match(fieldSection, /<label class="filter-switch"><input id="newOnly" type="checkbox"> <span data-i18n="field\.newOnly">New repositories only<\/span><\/label>/);
  assert.match(page, /\.filter-switch-row\{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(min\(140px,100%\),1fr\)\)/);
  assert.match(page, /document\.getElementById\("newOnly"\)\.checked=filterState\.newOnly/);
  assert.match(page, /activeDiscoveryCount\(\)[\s\S]*?\+\(filterState\.newOnly\?1:0\)/);
  assert.match(page, /document\.getElementById\("newOnly"\)\.addEventListener\("change",event=>\{[\s\S]*?newOnly:event\.target\.checked[\s\S]*?syncUrl\(\);render\(\)/);
  assert.match(page, /clearFiltersBtn[\s\S]*?newOnly:false/);
  assert.match(page, /function currentExportState\(\)\{return \{\.\.\.filterState,period,favOnly\}\}/);
  assert.match(page, /window\.addEventListener\("popstate",\(\)=>applyFilterState\(RepoFilters\.parseState\(location\.search,LANGUAGES\)\)\)/);
});

test("new-only waits for membership and fails closed with one canonical baseline boundary", () => {
  const { context, contract } = renderContractHarness();
  assert.equal(JSON.stringify(contract.newOnlyGate({ newOnly: true }, "loading")), JSON.stringify({
    message: "Loading new-repository status…",
    summary: "Loading new-repository status.",
  }));
  assert.equal(JSON.stringify(contract.newOnlyGate({ newOnly: true }, "error")), JSON.stringify({
    message: "New-repository status could not be loaded, so this filter is unavailable.",
    summary: "0 repositories · New-repository status could not be loaded, so this filter is unavailable.",
  }));
  assert.equal(contract.newOnlyGate({ newOnly: true }, "ready"), null);
  assert.equal(contract.newOnlyGate({ newOnly: false }, "loading"), null);
  context.MEMBERSHIP_STATUS.set("owner/repo", "baseline");
  const transient = contract.transientMembershipRepo({ slug: "Owner/Repo", name: "Repo" });
  assert.equal(transient.membership_status, "baseline_present");
  assert.equal(transient.name, "Repo");

  const renderFlow = page.match(/function render\(\)\{[\s\S]*?\/\* 즐겨찾기 \*\//)?.[0] ?? "";
  const gateIndex = renderFlow.indexOf("const newOnlyBlock=newOnlyGate(filterState,membershipLoadState)");
  const filterIndex = renderFlow.indexOf("REPOS.filter");
  assert.ok(gateIndex >= 0 && gateIndex < filterIndex, "membership gate must run before repository filtering");
  assert.match(renderFlow, /if\(newOnlyBlock\)\{[\s\S]*?currentVisibleRepos=\[\][\s\S]*?list\.innerHTML=""[\s\S]*?newOnlyBlock\.message[\s\S]*?return/);
  assert.match(page, /let membershipLoadState="loading"/);
  assert.match(page, /membershipLoadState="ready"[\s\S]*?renderRecentExits\(status\.exited\);render\(\)/);
  assert.match(page, /membershipLoadState="error"[\s\S]*?MEMBERSHIP_STATUS\.clear\(\)[\s\S]*?renderRecentExits\(\);render\(\)/);
});

test("membership readiness requires an exact normalized current-slug join", () => {
  const repos = [{ slug: "Owner/One" }, { slug: "owner/two" }];
  const { contract } = renderContractHarness(undefined, repos);
  const complete = new Map([["owner/one", "baseline"], ["owner/two", "new"]]);
  assert.equal(contract.membershipStatusForRepos({ currentStatus: complete }), complete);

  assert.throws(
    () => contract.membershipStatusForRepos({ currentStatus: new Map([["owner/one", "baseline"]]) }),
    /membership current rows do not exactly match repositories/,
    "a missing repository row must reject readiness",
  );
  assert.throws(
    () => contract.membershipStatusForRepos({ currentStatus: new Map([["owner/one", "baseline"], ["owner/unexpected", "new"]]) }),
    /membership current rows do not exactly match repositories/,
    "an equal-sized unexpected row must reject readiness rather than passing a count-only mutation",
  );

  const helper = page.match(/function membershipStatusForRepos\(status\)\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(helper, /current\.size!==repoSlugs\.size/);
  assert.match(helper, /\[\.\.\.repoSlugs\]\.some\(slug=>!current\.has\(slug\)\)/);
});

test("canonical card badges preserve every form and non-AI field before one AI badge", () => {
  const classification = { forms: ["agent", "mcp"], fields: ["ai-ml", "dev-tools", "security"] };
  const html = renderContractHarness(classification).contract.classificationBadges({});
  const order = ["Agent", "MCP", "Developer tools", "Security and privacy", 'data-category="ai"'].map(value => html.indexOf(value));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.equal([...html.matchAll(/data-category="form"/g)].length, 2);
  assert.equal([...html.matchAll(/data-category="field"/g)].length, 2);
  assert.equal([...html.matchAll(/data-category="ai"/g)].length, 1);
  for (const category of ["Form:", "Field and technology:", "AI related:"]) {
    assert.match(html, new RegExp(`class="category-label" aria-hidden="true">${category}`));
    assert.match(html, new RegExp(`class="sr-only">${category} `));
  }
  assert.doesNotMatch(html, /\+\d|\+N/);
  const helper = page.match(/function classificationBadges\(repo\)\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(helper, /RepoFilters\.classifyRepo\(repo\)/);
  assert.doesNotMatch(helper, /repo\.(?:slug|desc|description|topics|summary)|RegExp|\.test\(/);
  assert.match(page, /<div class="category-badges">\$\{classificationBadges\(r\)\}<\/div>/);
  assert.match(page, /\.category-badge\{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
});

test("repository issue counts use the selected locale label in cards and tooltips", () => {
  assert.equal([...page.matchAll(/tr\("repo\.issues"\)/g)].length, 2);
  assert.equal([...page.matchAll(/\$\{fmt\(r\.issues\|\|0\)\}/g)].length, 2);
  assert.doesNotMatch(page, /\$\{fmt\(r\.issues\|\|0\)\} issues/);
});

test("scroll-to-top is native, thresholded, coalesced, overlay-safe, and motion-aware", () => {
  assert.match(page, /<button class="scroll-top" id="scrollTopBtn" type="button" aria-label="Back to top" data-i18n-aria-label="scroll\.top" hidden tabindex="-1" inert>/);
  const style = page.match(/\.scroll-top\{[^}]*\}/)?.[0] ?? "";
  assert.match(style, /position:fixed/);
  assert.match(style, /min-width:48px/);
  assert.match(style, /min-height:48px/);
  assert.match(style, /right:calc\(env\(safe-area-inset-right\) \+ 16px\)/);
  assert.match(style, /bottom:max\(calc\(env\(safe-area-inset-bottom\) \+ 16px\),var\(--scroll-top-offset,16px\)\)/);
  assert.match(page, /@media\(max-width:1147px\)\{\.list-stage\{padding-right:calc\(56px \+ env\(safe-area-inset-right\)\)\}\}/);

  const harness = scrollTopHarness();
  for (const type of ["scroll", "resize", "orientationchange"]) {
    assert.equal(JSON.stringify(harness.listener(type)?.options), JSON.stringify({ passive: true }));
  }
  assert.equal(harness.pendingFrames(), 1);
  harness.flush();
  assert.equal(harness.button.hidden, true);
  assert.equal(harness.button.inert, true);
  assert.equal(harness.button.tabIndex, -1);
  assert.equal(harness.button.classList.contains("visible"), false);

  harness.setViewport(800, 800);
  harness.dispatch("scroll");
  harness.dispatch("resize");
  harness.dispatch("orientationchange");
  assert.equal(harness.pendingFrames(), 1);
  harness.flush();
  assert.equal(harness.button.hidden, true);

  harness.setViewport(801, 800);
  harness.dispatch("scroll");
  harness.flush();
  assert.equal(harness.button.hidden, false);
  assert.equal(harness.button.inert, false);
  assert.equal(harness.button.tabIndex, 0);
  assert.equal(harness.button.classList.contains("visible"), true);
  assert.equal(harness.offset(), "16px");

  harness.openModal();
  assert.equal(harness.button.hidden, true);
  assert.equal(harness.button.inert, true);
  assert.equal(harness.button.tabIndex, -1);
  assert.equal(harness.button.classList.contains("visible"), false);
  assert.match(page, /if\(mode==="modal"&&typeof hideScrollTopImmediately==="function"\)hideScrollTopImmediately\(\)/);
  assert.match(page, /panel\.inert=false[\s\S]*?if\(typeof hideScrollTopImmediately==="function"\)hideScrollTopImmediately\(\)/);
  harness.sidebar.dataset.openMode = "hover";
  harness.dispatch("resize");
  harness.flush();
  assert.equal(harness.button.hidden, false);

  harness.setUndo(false, 120);
  harness.dispatch("resize");
  harness.flush();
  assert.equal(harness.offset(), "156px");
  harness.setUndo(true);

  harness.sidebar.dataset.openMode = "modal";
  harness.dispatch("resize");
  harness.flush();
  assert.equal(harness.button.hidden, true);
  assert.equal(harness.button.inert, true);
  harness.sidebar.dataset.openMode = "hover";
  harness.dispatch("resize");
  harness.flush();
  assert.equal(harness.button.hidden, false);

  for (const [overlay, className] of [[harness.sidebarScrim, "on"], [harness.panel, "open"], [harness.scrim, "on"]]) {
    overlay.classList.add(className);
    harness.dispatch("resize");
    harness.flush();
    assert.equal(harness.button.hidden, true);
    assert.equal(harness.button.inert, true);
    overlay.classList.remove(className);
  }
  harness.dispatch("resize");
  harness.flush();
  harness.click();
  assert.equal(JSON.stringify(harness.scrollCalls.at(-1)), JSON.stringify({ top: 0, behavior: "smooth" }));

  const reduced = scrollTopHarness({ reducedMotion: true });
  reduced.flush();
  reduced.click();
  assert.equal(JSON.stringify(reduced.scrollCalls.at(-1)), JSON.stringify({ top: 0, behavior: "auto" }));
});

test("sidebar, tooltip, and scroll-top motion use the exact bounded tokens", () => {
  const root = page.match(/:root\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(root, /--sidebar-open-duration:260ms/);
  assert.match(root, /--sidebar-close-duration:210ms/);
  assert.match(root, /--tooltip-duration:160ms/);

  const sidebar = page.match(/\.filter-sidebar\{[\s\S]*?\n\}/)?.[0] ?? "";
  const sidebarTransition = sidebar.match(/transition:([^;]+);/)?.[1] ?? "";
  assert.match(sidebarTransition, /transform var\(--sidebar-close-duration\)/);
  assert.match(sidebarTransition, /opacity var\(--sidebar-close-duration\)/);
  assert.doesNotMatch(sidebarTransition, /\b(?:width|left|height|margin|padding)\b/);
  assert.match(page, /\.filter-sidebar\.open\{[^}]*transition-duration:var\(--sidebar-open-duration\),var\(--sidebar-open-duration\)/);
  assert.match(page, /\.filter-sidebar\.dragging\{transition:none\}/);

  const tooltip = page.match(/#tipLayer\{[\s\S]*?\n\}/)?.[0] ?? "";
  const tooltipTransition = tooltip.match(/transition:([^;]+);/)?.[1] ?? "";
  assert.match(tooltipTransition, /opacity var\(--tooltip-duration\)/);
  assert.match(tooltipTransition, /transform var\(--tooltip-duration\)/);
  assert.doesNotMatch(tooltipTransition, /\b(?:width|left|top|height|margin|padding)\b/);

  const scrollTop = page.match(/\.scroll-top\{[^}]*\}/)?.[0] ?? "";
  assert.match(scrollTop, /opacity:0/);
  assert.match(scrollTop, /transform:translate3d\(0,8px,0\)/);
  assert.match(scrollTop, /transition:opacity \.18s[^,]*,transform \.18s/);
  assert.match(page, /\.scroll-top\.visible\{opacity:1;transform:translate3d\(0,0,0\);pointer-events:auto\}/);
  assert.match(page, /function setScrollTopVisible\(visible\)\{[\s\S]*?scrollTopButton\.getBoundingClientRect\(\)[\s\S]*?classList\.add\("visible"\)/);

  const reduced = page.match(/@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reduced, /--sidebar-open-duration:0ms/);
  assert.match(reduced, /--sidebar-close-duration:0ms/);
  assert.match(reduced, /--tooltip-duration:0ms/);
  assert.match(reduced, /\.filter-sidebar,#tipLayer,\.scroll-top\{transition:none!important\}/);
  assert.match(reduced, /\.scroll-top,\.scroll-top\.visible[^}]*transform:none!important/);
});

test("the closed README panel does not inflate the narrow zoomed viewport", () => {
  const panel = page.match(/#readmePanel\{[^}]*\}/)?.[0] ?? "";
  assert.match(panel, /right:0/);
  assert.match(panel, /transform:translate3d\(100%,0,0\)/);
  assert.doesNotMatch(panel, /transform:translate3d\(102%,0,0\)/);
  assert.match(page, /#readmePanel\.open\{transform:translate3d\(0,0,0\)\}/);
});

test("badge guide descriptions can shrink inside a 200 percent zoom viewport", () => {
  const description = page.match(/\.signal-guide dd\{[^}]*\}/)?.[0] ?? "";
  assert.match(description, /min-width:0/);
  assert.match(description, /overflow-wrap:anywhere/);
});

test("the page head advertises both exact Atom subscription endpoints", () => {
  const alternates = [...page.matchAll(/<link rel="alternate" type="application\/atom\+xml" title="([^"]+)" href="([^"]+)">/g)];
  assert.deepEqual(alternates.map(match => match.slice(1)), [
    ["GitHub Trending Daily — Current repositories", "https://nowwcastle-sudo.github.io/github-trending-daily/feed.xml"],
    ["GitHub Trending Daily — New and re-entered repositories", "https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml"],
  ]);
});

test("current-view export uses the exact rendered array and keeps private state out", () => {
  assert.match(page, /<script src="current-view-export\.js"><\/script>/);
  assert.match(page, /id="exportCsvBtn"[^>]*data-i18n="export\.csv">Download CSV<\/button>/);
  assert.match(page, /id="exportJsonBtn"[^>]*data-i18n="export\.json">Download JSON<\/button>/);
  assert.match(page, /id="copyViewUrlBtn"[^>]*data-i18n="export\.copy">Copy current link<\/button>/);
  assert.match(page, /id="exportStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(page, /\.export-actions button\{[^}]*min-height:44px/);
  const sort = page.indexOf("items=RepoFilters.sortRepos(items,filterState.sort,viewPeriod)");
  const assignment = page.indexOf("currentVisibleRepos=items");
  const cards = page.indexOf("list.innerHTML=items.map");
  assert.ok(sort >= 0 && sort < assignment && assignment < cards);
  assert.match(page, /CurrentViewExport\.buildModel\(\{[\s\S]*?repositories:currentVisibleRepos[\s\S]*?membershipStatus:MEMBERSHIP_STATUS[\s\S]*?gainOf:r=>UiMotion\.periodGain\(r,period\)/);
  assert.match(page, /CurrentViewExport\.buildSourceUrl\(location,[\s\S]*?RepoFilters\.serializeState\)/);
  assert.match(page, /CurrentViewExport\.downloadText\(/);
  assert.match(page, /CurrentViewExport\.copyText\(/);
  assert.doesNotMatch(page, /buildModel\(\{[\s\S]{0,500}(?:hiddenSet|favSet|guestFavorites|localStorage)/);
});

test("All cards render total stars without period gain HOT or the gain bar", () => {
  const { html, visible } = cardRenderHarness("all");

  assert.deepEqual(visible.map(repository => repository.slug), ["owner/project"]);
  assert.doesNotMatch(html, /class="today"/);
  assert.doesNotMatch(html, />HOT</);
  assert.doesNotMatch(html, /<div class="spark">/);
  assert.match(html, /<div class="stars">5000<\/div>/);
  assert.match(html, /class="sparkhist"/);
});

test("baseline new and reentered membership render only their exact card badges", () => {
  const baselineHtml = cardRenderHarness("daily", "baseline").html;
  const newHtml = cardRenderHarness("daily", "new").html;
  const reenteredHtml = cardRenderHarness("daily", "reentered").html;

  assert.doesNotMatch(baselineHtml, /membership-(?:new|reentered)/);
  assert.match(newHtml, /class="badge membership-new"[^>]*>badges\.newLabel<\/span>/);
  assert.doesNotMatch(newHtml, /membership-reentered/);
  assert.match(reenteredHtml, /class="badge membership-reentered"[^>]*>badges\.reenteredLabel<\/span>/);
  assert.doesNotMatch(reenteredHtml, /membership-new/);
});

test("sorting is shareable, stable, and keeps the selected period in favorites", () => {
  assert.match(page, /<select class="langsel" id="sortSelect" aria-label="Repository sort order"[^>]*data-i18n-aria-label="sort\.aria"/);
  assert.match(page, /<option value="trending" data-i18n="sort\.original">Original Trending order<\/option>/);
  assert.match(page, /<option value="gain" data-i18n="sort\.gain">Stars gained in selected period<\/option>/);
  assert.match(page, /<option value="stars" data-i18n="sort\.stars">Total stars<\/option>/);
  assert.match(page, /<option value="pushed" data-i18n="sort\.pushed">Latest push<\/option>/);
  assert.match(page, /<option value="release" data-i18n="sort\.release">Latest release<\/option>/);
  assert.match(page, /\.langsel\{[^}]*min-height:44px/);
  assert.match(page, /gainOption\.disabled=period==="all"/);
  assert.match(page, /const viewPeriod=period;/);
  assert.doesNotMatch(page, /const viewPeriod=favOnly\?"daily":period/);
  assert.match(page, /items=RepoFilters\.sortRepos\(items,filterState\.sort,viewPeriod\)/);
  assert.match(page, /sortSel\.addEventListener\("change"/);
  assert.match(page, /period:p,sort:nextSort,favOnly:false/);
});

test("desktop tooltip motion keeps layout geometry stable", () => {
  assert.doesNotMatch(page, /\.wrap\.tip-open|transition:margin/);
  assert.match(page, /\.list-stage\{[^}]*transition:transform/);
  assert.match(page, /@media\(min-width:1100px\) and \(max-width:1399px\)/);
  assert.match(page, /UiMotion\.tooltipLayout/);
  assert.match(page, /position\.mode==="rail"&&position\.shift<0/);
});

test("light and dark semantic colors use the reviewed contrast palette", () => {
  assert.match(page, /--text-3:#6e6e73/);
  assert.match(page, /--hot:#a83200/);
  assert.match(page, /--hot:#ff9e3d/);
  assert.match(page, /--text-3:#a89984/);
  assert.match(page, /\.rankchg\{[^}]*color:#5f6000/);
});

test("selected discovery controls use an accessible semantic accent text token", () => {
  assert.match(page, /--accent-selected:#005fc7/);
  assert.match(page, /html\[data-theme="dark"\]\{[\s\S]*?--accent-selected:#a7c7bd/);
  assert.match(page, /\.filter-count\{[^}]*color:var\(--accent-selected\)/);
  assert.match(page, /\.sidebar-nav button\[aria-pressed="true"\]\{[^}]*color:var\(--accent-selected\)/);
  assert.match(page, /\.sidebar-note\{[^}]*color:var\(--text-2\)/);
});

test("light surfaces use semantic borders while dark and interaction states stay explicit", () => {
  assert.match(page, /--surface-border:rgba\(0,0,0,\.14\)/);
  assert.match(page, /--surface-border-strong:rgba\(0,0,0,\.24\)/);
  assert.match(page, /html\[data-theme="dark"\]\{[\s\S]*?--surface-border:var\(--hairline\); --surface-border-strong:var\(--border\)/);
  const title = page.match(/\.title-box\{[^}]*\}/)?.[0] ?? "";
  assert.match(title, /background:var\(--bg\)/);
  assert.match(title, /border:none/);
  assert.doesNotMatch(title, /var\(--(?:bg-elev|card|surface)|box-shadow|backdrop-filter/);
  assert.match(page, /<div class="title-box">\s*<h1><button class="title-reset"/);
  assert.match(page, /header\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(page, /\.card\{[\s\S]*?border:1px solid var\(--surface-border\)/);
  assert.match(page, /\.card:hover\{[^}]*border-color:var\(--surface-border-strong\)/);
  assert.match(page, /\.card:focus-visible\{[^}]*outline:3px solid var\(--accent\)[^}]*border-color:var\(--surface-border-strong\)/);
});

test("cards do not nest favorite buttons inside a full-card anchor", () => {
  assert.match(page, /return `<article class="card"/);
  assert.match(page, /<button type="button" class="favbtn/);
  assert.match(page, /<a class="repo-link"[^>]*target="_blank" rel="noopener">/);
  assert.doesNotMatch(page, /return `<a class="card"/);
  assert.match(page, /list\.addEventListener\("keydown"/);
});

test("touch cards preserve controls and navigate only on the same card's second tap", () => {
  const handler = page.match(/list\.addEventListener\("click",async e=>\{[\s\S]*?\n\}\);/)?.[0] ?? "";
  assert.match(handler, /if\(e\.target\.closest\("\.favbtn,\.js-readme,\.js-hide-repo,button,a"\)\)return/);
  assert.match(handler, /UiMotion\.touchCardAction\(\{[\s\S]*?activeIndex:activeTipIndex,[\s\S]*?cardIndex:\+card\.dataset\.idx,[\s\S]*?tooltipOpen:tipLayer\.classList\.contains\("on"\)/);
  assert.match(handler, /if\(action==="show"\)\{[\s\S]*?showTip\(card\)[\s\S]*?\}else\{[\s\S]*?window\.open\(card\.dataset\.href,"_blank","noopener"\)/);
});

test("a touch tooltip body forwards the covered same-card second tap without stealing explicit controls", () => {
  const helperStart = page.indexOf("function touchCardBehindTip(event){");
  const listenerStart = page.indexOf('tipLayer.addEventListener("click",e=>{', helperStart);
  const listenerEnd = page.indexOf('\ntipLayer.addEventListener("mouseleave"', listenerStart);
  assert.ok(helperStart >= 0 && listenerStart > helperStart && listenerEnd > listenerStart,
    "touch tooltip second-tap runtime must be isolated");

  class TipLayer {
    addEventListener(type, listener) { if (type === "click") this.click = listener; }
  }
  const tipLayer = new TipLayer();
  const card = {
    dataset: { idx: "3", href: "https://github.com/owner/repo" },
    closest(selector) { return selector === ".card" ? this : null; },
  };
  const otherCard = {
    dataset: { idx: "4", href: "https://github.com/owner/other" },
    closest(selector) { return selector === ".card" ? this : null; },
  };
  const tooltipParagraph = { closest() { return null; } };
  const calls = { opened: [], readme: 0, hidden: 0 };
  const context = {
    __touch: true,
    __stack: [tooltipParagraph, card],
    __tipLayer: tipLayer,
    document: { elementsFromPoint() { return context.__stack; } },
    window: { open(href, target, features) { calls.opened.push(`${href}|${target}|${features}`); } },
    touchLayout() { return context.__touch; },
    activeTipIndex: 3,
    hideRepository() { calls.hidden += 1; },
    openReadme() { calls.readme += 1; },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`
    const tipLayer=globalThis.__tipLayer;
    let activeTipIndex=globalThis.activeTipIndex;
    ${page.slice(helperStart, listenerStart)}
    ${page.slice(listenerStart, listenerEnd)}
  `, context, { filename: "touch-tooltip-second-tap-fixture.js" });

  function dispatch(target, properties = {}) {
    const event = { target, clientX: 24, clientY: 180, detail: 1, prevented: false,
      preventDefault() { this.prevented = true; }, ...properties };
    tipLayer.click(event);
    return event;
  }

  dispatch(tooltipParagraph);
  assert.deepEqual(calls.opened, ["https://github.com/owner/repo|_blank|noopener"]);

  context.__stack = [tooltipParagraph, otherCard];
  dispatch(tooltipParagraph);
  assert.equal(calls.opened.length, 1, "a different covered card must not inherit the active card's navigation");

  context.__touch = false;
  context.__stack = [tooltipParagraph, card];
  dispatch(tooltipParagraph);
  assert.equal(calls.opened.length, 1, "desktop tooltip content must retain its existing behavior");
  context.__touch = true;

  const readmeButton = {
    dataset: { slug: "owner/repo", name: "Repo" },
    closest(selector) { return selector === ".js-readme" ? this : null; },
  };
  const readmeEvent = dispatch(readmeButton);
  assert.equal(readmeEvent.prevented, true);
  assert.equal(calls.readme, 1);
  assert.equal(calls.opened.length, 1);

  const hideButton = {
    dataset: { slug: "owner/repo" },
    closest(selector) { return selector === ".js-hide-repo" ? this : null; },
  };
  const hideEvent = dispatch(hideButton);
  assert.equal(hideEvent.prevented, true);
  assert.equal(calls.hidden, 1);
  assert.equal(calls.opened.length, 1);

  const explicitLink = {
    closest(selector) { return selector.startsWith("button,a,input,select,textarea") ? this : null; },
  };
  dispatch(explicitLink);
  assert.equal(calls.opened.length, 1, "an explicit tooltip control must own its tap");
});
