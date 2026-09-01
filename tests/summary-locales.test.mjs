import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const page = await readFile(new URL("../index.html", import.meta.url), "utf8");

function repository() {
  const summaries = Object.fromEntries([
    ["en", "English"],
    ["ko", "한국어"],
    ["zh-CN", "简体中文"],
    ["es", "Español"],
    ["ja", "日本語"],
  ].map(([locale, label]) => [locale, {
    goal: `${label} goal`,
    usage: `${label} usage`,
    pros: `${label} pros`,
    cons: `${label} cons`,
    fit: `${label} fit`,
  }]));
  return {
    slug: "owner/repository",
    name: "Owner / Repository",
    stars: 100,
    forks: 10,
    contributors: 2,
    issues: 3,
    lang: "JavaScript",
    summaries,
  };
}

function summaryHarness(locale = "en") {
  const start = page.indexOf("const SUMMARY_LOCALES=");
  const end = page.indexOf("\nfunction newOnlyGate", start);
  assert.ok(start >= 0 && end > start, "summary runtime fixture must be isolated");
  const messages = {
    "repo.contributors": "contributors",
    "repo.issues": "open issues and PRs",
    "readme.view": "View README",
    "tooltip.unavailable": "Summary is unavailable for the selected site language.",
    "tooltip.goal": "Project goal",
    "tooltip.usage": "How to use",
    "tooltip.pros": "Strengths",
    "tooltip.cons": "Cautions",
    "tooltip.fit": "Best fit",
    "tooltip.aiNote": "AI-generated from the verified repository README",
    "tooltip.hide": "Not interested",
  };
  const context = {
    siteI18n: { locale },
    tr(key) { return messages[key] ?? key; },
    esc(value) { return String(value ?? ""); },
    fmt(value) { return String(value); },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${page.slice(start, end)}
    globalThis.__summaryRuntime={summaryBundle,summaryAvailable,resolveSummaryLocale,tipHTML};
  `, context, { filename: "summary-runtime-fixture.js" });
  return context.__summaryRuntime;
}

test("tooltip follows the site locale and exposes no separate summary-language controls", () => {
  const runtime = summaryHarness("ja");
  const repo = repository();
  assert.equal(runtime.resolveSummaryLocale(repo, "ja"), "ja");
  const html = runtime.tipHTML(repo, "ja");
  assert.match(html, /日本語 goal/);
  assert.doesNotMatch(html, /English goal/);
  assert.doesNotMatch(html, /summary-tabs|summary-tab|data-summary-locale|tooltip\.language/);
  assert.equal((html.match(/class="rdbtn js-readme"/g) || []).length, 1);
});

test("a missing selected locale fails closed instead of silently falling back to English", () => {
  const runtime = summaryHarness("ja");
  const repo = repository();
  delete repo.summaries.ja;
  assert.equal(runtime.resolveSummaryLocale(repo, "ja"), null);
  const html = runtime.tipHTML(repo, null);
  assert.match(html, /Summary is unavailable for the selected site language\./);
  assert.doesNotMatch(html, /English goal/);
});

test("every complete tooltip keeps the five source-bound field roles and AI disclosure", () => {
  const runtime = summaryHarness("ko");
  const html = runtime.tipHTML(repository(), "ko");
  for (const value of ["한국어 goal", "한국어 usage", "한국어 pros", "한국어 cons", "한국어 fit"]) {
    assert.match(html, new RegExp(value));
  }
  assert.match(html, /AI-generated from the verified repository README/);
});
