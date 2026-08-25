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
  assert.match(page, /activeTipIndex=null;document\.querySelector\("\.wrap"\)/);
  assert.match(page, /id="refreshStatus" class="last-updated"/);
});

test("the refresh status gets a full header row on desktop and mobile", () => {
  assert.match(page, /\.header-actions\{[^}]*display:grid[^}]*grid-template-columns:auto auto/);
  assert.match(page, /\.last-updated\{[^}]*grid-column:1\/-1/);
  assert.match(page, /@media\(max-width:560px\)\{[\s\S]*?\.header-actions\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
});

test("refresh copy and calculation follow the approved daily 03:17 Seoul schedule", () => {
  assert.match(page, /next\.setUTCHours\(18,17,0,0\)/);
  assert.match(page, /매일 03:17 갱신/);
  assert.doesNotMatch(page, /2시간마다 갱신|lastMs\+2\*3600\*1000/);
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
  assert.match(main, /<footer>/);
  assert.match(page, /<select class="langsel" id="lang" aria-label="프로그래밍 언어"/);
  assert.match(page, /<input class="search" id="q" aria-label="저장소 검색"/);
  assert.match(page, /id="readmePanel" aria-hidden="true" inert/);
  assert.match(page, /id="tipLayer"[^>]*aria-hidden="true" inert/);
  assert.match(page, /panel\.inert=false[\s\S]*?panel\.setAttribute\("aria-hidden","false"\)/);
  assert.match(page, /panel\.setAttribute\("aria-hidden","true"\);\s*panel\.inert=true/);
  assert.doesNotMatch(page, /#tipLayer h3|<h3>\$\{esc\(r\.name\)\}<\/h3>/);
});

test("light and dark semantic colors use the reviewed contrast palette", () => {
  assert.match(page, /--text-3:#6e6e73/);
  assert.match(page, /--hot:#a83200/);
  assert.match(page, /--hot:#ff9e3d/);
  assert.match(page, /--text-3:#a89984/);
  assert.match(page, /\.rankchg\{[^}]*color:#5f6000/);
});

test("cards do not nest favorite buttons inside a full-card anchor", () => {
  assert.match(page, /return `<article class="card"/);
  assert.match(page, /<button type="button" class="favbtn/);
  assert.match(page, /<a class="repo-link"[^>]*target="_blank" rel="noopener">/);
  assert.doesNotMatch(page, /return `<a class="card"/);
  assert.match(page, /list\.addEventListener\("keydown"/);
});
