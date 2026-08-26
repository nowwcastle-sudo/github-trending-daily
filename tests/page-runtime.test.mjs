import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("the generated page has unique element ids", () => {
  const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, []);
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
  assert.match(page, /id="refreshStatus" class="sidebar-refresh"/);
});

test("the refresh status appears once at the top of the sidebar and not in main", () => {
  assert.equal([...page.matchAll(/id="refreshStatus"/g)].length, 1);
  assert.match(page, /id="refreshStatus" class="sidebar-refresh" role="status" aria-live="polite" aria-atomic="true"/);
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<div id="sidebarScrim"/)?.[0] ?? "";
  const statusIndex = sidebar.indexOf('id="refreshStatus"');
  const accountIndex = sidebar.indexOf('id="accountTitle"');
  assert.ok(statusIndex >= 0 && statusIndex < accountIndex, "refresh status must precede the account section");
  const main = page.match(/<main class="wrap">([\s\S]*?)<\/main>/)?.[1] ?? "";
  assert.doesNotMatch(main, /id="refreshStatus"/);
  assert.match(page, /\.sidebar-refresh\{[^}]*font-variant-numeric:tabular-nums/);
});

test("refresh copy and calculation follow the approved two-hour schedule", () => {
  assert.match(page, /<script src="refresh-schedule\.js"><\/script>/);
  assert.match(page, /RefreshSchedule\.nextRefreshTime\(Date\.now\(\)\)/);
  assert.match(page, /2시간마다 · 서울 기준 홀수 시 07분/);
  assert.doesNotMatch(page, /매일 03:17 갱신|setUTCHours\(18,17/);
});

test("third-party browser scripts use exact versions and SHA-384 integrity", () => {
  const externalScripts = [...page.matchAll(/<script\s+src="(https:[^"]+)"([^>]*)><\/script>/g)];
  assert.equal(externalScripts.length, 2);
  for (const [, url, attributes] of externalScripts) {
    assert.match(url, /@\d+\.\d+\.\d+\//);
    assert.match(attributes, /\sintegrity="sha384-[A-Za-z0-9+/=]+"/);
    assert.match(attributes, /\scrossorigin="anonymous"/);
  }
});

test("landmarks, form controls, and hidden panels retain accessible boundaries", () => {
  assert.match(page, /<main class="wrap">[\s\S]*?<\/main>/);
  const main = page.match(/<main class="wrap">([\s\S]*?)<\/main>/)?.[1] ?? "";
  assert.match(main, /<div class="list" id="list"><\/div>/);
  assert.match(main, /class="signal-guide"[^>]*aria-label="배지 안내"/);
  assert.match(main, /class="list-stage" id="listStage"/);
  assert.match(main, /<footer>/);
  assert.match(page, /<select class="langsel" id="lang" aria-label="프로그래밍 언어"/);
  assert.match(page, /<input class="search" id="q" aria-label="저장소 검색"/);
  assert.match(page, /id="readmePanel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-hidden="true" inert/);
  assert.match(page, /id="tipLayer"[^>]*aria-hidden="true" inert/);
  assert.match(page, /panel\.inert=false[\s\S]*?panel\.setAttribute\("aria-hidden","false"\)/);
  assert.match(page, /panel\.setAttribute\("aria-hidden","true"\);\s*panel\.inert=true/);
  assert.doesNotMatch(page, /#tipLayer h3|<h3>\$\{esc\(r\.name\)\}<\/h3>/);
});

test("responsive sidebar owns account, favorites, and discovery filters", () => {
  assert.match(page, /<script src="repo-filters\.js"><\/script>/);
  assert.match(page, /id="navToggle"[^>]*aria-controls="filterSidebar"[^>]*aria-expanded="false"/);
  assert.match(page, /<div[^>]*id="filterSidebar"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="탐색 사이드바"[^>]*inert/);
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<\/div>\s*<div id="sidebarScrim"/)?.[0] ?? "";
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
  assert.match(page, /pageMain\.inert=true/);
  assert.match(page, /trapFocus\(sidebar,event\)/);
});

test("filter state is restored from and written to the URL", () => {
  assert.match(page, /RepoFilters\.parseState\(location\.search/);
  assert.match(page, /history\.(?:pushState|replaceState)\(/);
  assert.match(page, /addEventListener\("popstate"/);
  assert.match(page, /RepoFilters\.matchesRepo\(r,/);
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

test("light surfaces use semantic borders while dark and interaction states stay explicit", () => {
  assert.match(page, /--surface-border:rgba\(0,0,0,\.14\)/);
  assert.match(page, /--surface-border-strong:rgba\(0,0,0,\.24\)/);
  assert.match(page, /html\[data-theme="dark"\]\{[\s\S]*?--surface-border:var\(--hairline\); --surface-border-strong:var\(--border\)/);
  assert.match(page, /\.title-box\{[^}]*border:1px solid var\(--surface-border\)/);
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
