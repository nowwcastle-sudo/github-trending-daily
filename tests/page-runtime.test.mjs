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
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<\/div>\s*<button class="nav-toggle edge-tab"/)?.[0] ?? "";
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

test("browser-local hidden repositories have tooltip actions, undo, and sidebar recovery", () => {
  assert.match(page, /<script src="favorites\.js"><\/script>\s*<script src="hidden-repos\.js"><\/script>/);
  assert.match(page, /class="rdbtn js-hide-repo"[^>]*data-slug="\$\{r\.slug\}"[^>]*>관심 없음<\/button>/);
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
  assert.match(renderFlow, /현재 조건의 저장소를 모두 숨겼어요/);
  assert.match(renderFlow, /emptyManageHiddenBtn/);
  const urlFlow = page.match(/function syncUrl[\s\S]*?function toggleFilter/)?.[0] ?? "";
  assert.doesNotMatch(urlFlow, /hidden|slug/i);
});

test("the explore edge tab stays attached, reachable, and outside the inert page", () => {
  const sidebarIndex = page.indexOf('id="filterSidebar"');
  const navIndex = page.indexOf('id="navToggle"');
  const scrimIndex = page.indexOf('id="sidebarScrim"');
  const mainIndex = page.indexOf('<main class="wrap">');
  assert.ok(sidebarIndex >= 0 && sidebarIndex < navIndex && navIndex < scrimIndex && scrimIndex < mainIndex);
  const main = page.match(/<main class="wrap">([\s\S]*?)<\/main>/)?.[1] ?? "";
  assert.doesNotMatch(main, /id="navToggle"/);
  assert.match(page, /class="nav-toggle edge-tab" id="navToggle"[^>]*aria-label="탐색 사이드바 열기"[^>]*aria-controls="filterSidebar"[^>]*aria-expanded="false"/);
  assert.match(page, /id="navToggle"[\s\S]*?<path d="M4 7h16M7 12h10M10 17h4"\/>/);
  assert.match(page, /--sidebar-width:min\(360px,calc\(100vw - 44px\)\)/);
  assert.match(page, /\.filter-sidebar\{[\s\S]*?width:var\(--sidebar-width\)/);
  assert.match(page, /\.nav-toggle\{[^}]*position:fixed[^}]*z-index:330[^}]*left:0[^}]*top:max\(160px,calc\(env\(safe-area-inset-top\) \+ 68px\)\)[^}]*width:44px[^}]*height:48px/);
  assert.match(page, /\.nav-toggle\{[^}]*background:var\(--tip-bg\)[^}]*transition:transform \.3s cubic-bezier\(\.32,\.72,0,1\),opacity \.2s ease-out/);
  assert.match(page, /\.filter-sidebar\.open~\.nav-toggle\{transform:translate3d\(calc\(var\(--sidebar-width\) - 1px\),0,0\)/);
  assert.match(page, /navToggle\.setAttribute\("aria-label","탐색 사이드바 닫기"\)/);
  assert.match(page, /navToggle\.setAttribute\("aria-label","탐색 사이드바 열기"\)/);
  assert.match(page, /navToggle\.addEventListener\("click",\(\)=>sidebar\.classList\.contains\("open"\)\?closeSidebar\(\):openSidebar\(\)\)/);
  assert.match(page, /if\(readme\.classList\.contains\("open"\)\)closeReadme\(false\);\s*hideTip\(\)/);
  assert.match(page, /if\(restoreFocus&&sidebarTrigger instanceof HTMLElement\)sidebarTrigger\.focus\(\)/);
  assert.match(page, /@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?transition-duration:\.01ms!important/);
});

test("filter state is restored from and written to the URL", () => {
  assert.match(page, /RepoFilters\.parseState\(location\.search/);
  assert.match(page, /history\.(?:pushState|replaceState)\(/);
  assert.match(page, /addEventListener\("popstate"/);
  assert.match(page, /RepoFilters\.matchesRepo\(r,/);
});

test("membership history is loaded before semantic badges and recent exits are rendered", () => {
  assert.match(page, /<script src="membership-history\.js"><\/script>/);
  assert.match(page, /MembershipHistory\.load\("data\/membership-status\.json",fetch\)/);
  assert.match(page, /MEMBERSHIP_STATUS\.get\(r\.slug\.toLowerCase\(\)\)/);
  assert.match(page, />신규<\/span>/);
  assert.match(page, />재진입<\/span>/);
  assert.match(page, /id="recentExitsSection"[^>]*hidden/);
  assert.match(page, /id="recentExitsList"/);
  assert.match(page, /recentExitsList[\s\S]*?https:\/\/github\.com\//);
});

test("sorting is shareable, stable, and keeps the selected period in favorites", () => {
  assert.match(page, /<select class="langsel" id="sortSelect" aria-label="저장소 정렬"/);
  assert.match(page, /<option value="trending">Trending 원래 순서<\/option>/);
  assert.match(page, /<option value="gain">선택 기간 스타 증가<\/option>/);
  assert.match(page, /<option value="stars">총 스타<\/option>/);
  assert.match(page, /<option value="pushed">최근 푸시<\/option>/);
  assert.match(page, /<option value="release">최근 릴리스<\/option>/);
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
