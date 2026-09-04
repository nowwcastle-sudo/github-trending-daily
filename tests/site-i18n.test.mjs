import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../site-i18n.js", import.meta.url), "utf8").catch(() => "");
const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const koreanReadme = await readFile(new URL("../README.ko.md", import.meta.url), "utf8");
const compatibilityReadme = await readFile(new URL("../README.en.md", import.meta.url), "utf8");

function load() {
  const context = { globalThis: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "site-i18n.js" });
  return context.globalThis.SiteI18n;
}

test("site shell supports the exact five approved locales with complete message keys", () => {
  const i18n = load();
  assert.deepEqual([...i18n.SUPPORTED_LOCALES], ["en", "ko", "zh-CN", "es", "ja"]);
  const englishKeys = Object.keys(i18n.MESSAGES.en).sort();
  assert.ok(englishKeys.length >= 60);
  for (const locale of i18n.SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(i18n.MESSAGES[locale]).sort(), englishKeys, `${locale} must not fall back key-by-key`);
    assert.equal(typeof i18n.MESSAGES[locale]["tooltip.unavailable"], "string");
    assert.ok(i18n.MESSAGES[locale]["tooltip.unavailable"].trim().length > 0);
  }
});

test("every rail group, shortcut hint, and held-retry message exists in all five locales", () => {
  const i18n = load();
  const required = [
    "nav.account", "nav.history", "nav.export",
    "nav.ariaAccount", "nav.ariaExplore", "nav.ariaHistory", "nav.ariaExport",
    "nav.titleAccount", "nav.titleExplore", "nav.titleHistory", "nav.titleExport",
    "nav.groups", "filter.copyLink", "tooltip.heldRetry",
    // RED TEAM 1 H4: star-history.js renders every one of these through the site `tr`.
    "history.title", "history.explanation", "history.observedSince",
    "history.ariaTrend", "history.waiting", "history.singleObservation",
  ];
  for (const locale of i18n.SUPPORTED_LOCALES) {
    for (const key of required) {
      const value = i18n.MESSAGES[locale][key];
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} ${key} must not be blank`);
    }
    // RED TEAM 1 M3: the filter-bar live region is empty at rest (.filter-bar-status reserves
    // min-height:1.45em), so this prompt is deliberately the empty string — its job is to let
    // SiteI18n.apply() clear a stale, wrong-language copy-link message on a locale switch.
    assert.equal(i18n.MESSAGES[locale]["filter.statusPrompt"], "", `${locale} filter.statusPrompt must be the empty prompt`);
    // R1 (re-review 1): the catalogue value alone does not prove what ships. `translate` reads
    // MESSAGES[locale][key] ?? MESSAGES.en[key] ?? key — an `??`-to-`||` mutation there falls
    // through the also-empty English string to the literal key, which a live region would then
    // announce. Render it through the real instance so that mutation is caught.
    const instance = i18n.create({ document: null, storage: null, navigator: { languages: [locale] } });
    assert.equal(instance.t("filter.statusPrompt"), "", `${locale} must render the empty prompt, not the key`);
    // RED TEAM 1 L5: #mobileNavToggle is the trigger for Account, History and Export too, so its
    // label must be group-neutral the way sidebar.close already is.
    assert.doesNotMatch(i18n.MESSAGES[locale]["nav.open"], /Explore|탐색|探索|Explorar/, `${locale} nav.open must be group-neutral`);
  }
  for (const [key, hint] of [["nav.titleAccount", "(a)"], ["nav.titleExplore", "(e)"], ["nav.titleHistory", "(h)"], ["nav.titleExport", "(x)"]]) {
    for (const locale of i18n.SUPPORTED_LOCALES) {
      assert.ok(i18n.MESSAGES[locale][key].endsWith(hint), `${locale} ${key} must end with the ${hint} shortcut hint`);
    }
  }
});

test("locale resolution prefers a saved choice, then browser language, then English", () => {
  const i18n = load();
  const storage = value => ({ getItem() { return value; } });
  assert.equal(i18n.resolveLocale(storage("es"), { languages: ["ko-KR"] }), "es");
  assert.equal(i18n.resolveLocale(storage(null), { languages: ["fr-FR", "zh-TW", "ja-JP"] }), "zh-CN");
  assert.equal(i18n.resolveLocale(storage(null), { language: "ko-KR" }), "ko");
  assert.equal(i18n.resolveLocale(storage(null), { languages: ["fr-FR"] }), "en");
  assert.equal(i18n.normalizeLocale("es-MX"), "es");
  assert.equal(i18n.normalizeLocale("zh-Hant"), "zh-CN");
  assert.equal(i18n.normalizeLocale("de"), null);
});

test("the checked-in page is English-first and exposes one persisted site-language control", () => {
  assert.match(page, /<html lang="en">/);
  assert.match(page, /<script src="site-i18n\.js"><\/script>/);
  assert.match(page, /id="siteLocale"[^>]*aria-label="Site language"/);
  assert.deepEqual([...page.matchAll(/<option value="(en|ko|zh-CN|es|ja)"/g)].map(match => match[1]), ["en", "ko", "zh-CN", "es", "ja"]);
  assert.match(page, /SiteI18n\.create\(/);
  assert.match(page, /siteLocale\.addEventListener\("change"/);
  assert.match(page, /addEventListener\("site-locale-change"/);
});

test("the product name is GITHUB INSIGHT in every locale", () => {
  const i18n = load();
  for (const locale of i18n.SUPPORTED_LOCALES) {
    assert.equal(i18n.MESSAGES[locale]["document.title"], "GITHUB INSIGHT", locale);
    assert.equal(i18n.MESSAGES[locale]["feed.current"], "GITHUB INSIGHT — Current repositories", locale);
    assert.equal(i18n.MESSAGES[locale]["feed.changes"], "GITHUB INSIGHT — New and re-entered repositories", locale);
  }
});

test("repository documentation is English-first with a complete Korean counterpart", () => {
  assert.match(readme, /^# GITHUB INSIGHT\r?\n\r?\n\[한국어\]\(README\.ko\.md\)/);
  assert.match(readme, /candidate-desktop-1440\.png/);
  assert.match(readme, /candidate-mobile-sidebar-390\.png/);
  assert.match(readme, /README variants from upstream only/);
  assert.match(koreanReadme, /^# GITHUB INSIGHT\r?\n\r?\n\[English\]\(README\.md\)/);
  assert.match(koreanReadme, /상류 저장소 README 언어판만 표시/);
  assert.match(koreanReadme, /최초 관측 후 최소 1일이면 히스토리 확인 가능/);
  assert.match(compatibilityReadme, /canonical English documentation is now \[README\.md\]\(README\.md\)/);
  for (const [document, headings] of [
    [readme, ["## Planned features", "## Requesting a feature"]],
    [koreanReadme, ["## 예정된 기능", "## 기능 요청"]],
  ]) {
    for (const heading of headings) assert.ok(document.includes(heading), `${heading} must exist`);
  }
  for (const document of [readme, koreanReadme]) {
    for (const token of ["Login", "Explore", "History", "Export", "`/`", "`e`", "`a`", "`h`", "`x`", "held"]) {
      assert.ok(document.includes(token), `${token} must be documented`);
    }
  }
});
