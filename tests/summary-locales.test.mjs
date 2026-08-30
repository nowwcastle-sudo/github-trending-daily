import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("summary tooltip exposes the exact five approved languages in one first row", () => {
  assert.match(page, /const SUMMARY_LOCALES=\["en","ko","zh-CN","es","ja"\]/);
  assert.match(page, /\[\["en","EN"\],\["ko","한국어"\],\["zh-CN","中文"\],\["es","ES"\],\["ja","日本語"\]\]/);
  assert.match(page, /<div class="summary-tabs" role="group" aria-label="\$\{tr\("tooltip\.language"\)\}">\$\{tabs\}<\/div>\s*<div class="tip-readme-row">/);
  assert.match(page, /\.summary-tabs\{[^}]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(page, /\.summary-tab\{[^}]*min-height:44px/);
});

test("README is the sole second-row primary action above detailed summary fields", () => {
  const tooltip = page.match(/function tipHTML\(r,[\s\S]*?\n\}/)?.[0] ?? "";
  const tabs = tooltip.indexOf('class="summary-tabs"');
  const readme = tooltip.indexOf('class="tip-readme-row"');
  const firstField = tooltip.indexOf('class="trow"');
  const hide = tooltip.indexOf('class="rdbtn js-hide-repo"');
  assert.ok(tabs >= 0 && tabs < readme && readme < firstField && firstField < hide);
  assert.equal((tooltip.match(/class="rdbtn js-readme"/g) || []).length, 1);
});

test("summary locale changes stay within a complete source-bound bundle", () => {
  assert.match(page, /function summaryAvailable\(summary\)\{return summary&&\["goal","usage","pros","cons","fit"\]\.every/);
  assert.match(page, /if\(summaryAvailable\(bundle\[preferred\]\)\)return preferred/);
  assert.match(page, /if\(summaryAvailable\(bundle\.en\)\)return "en"/);
  assert.match(page, /data-summary-locale="\$\{code\}"[^>]*disabled/);
  assert.match(page, /tipLayer\.querySelector\(`\[data-summary-locale="\$\{nextLocale\}"\]`\)\?\.focus\(\)/);
});

test("every tooltip discloses that its summary is AI-generated from the verified README", () => {
  assert.match(page, /class="tip-ai-note"[^>]*>\$\{tr\("tooltip\.aiNote"\)\}<\/p>/);
});
