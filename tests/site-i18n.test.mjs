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

test("repository documentation is English-first with a complete Korean counterpart", () => {
  assert.match(readme, /^# GitHub Trending Daily\r?\n\r?\n\[한국어\]\(README\.ko\.md\)/);
  assert.match(readme, /candidate-desktop-1440\.png/);
  assert.match(readme, /candidate-mobile-sidebar-390\.png/);
  assert.match(readme, /README variants from upstream only/);
  assert.match(koreanReadme, /^# GitHub Trending Daily\r?\n\r?\n\[English\]\(README\.md\)/);
  assert.match(koreanReadme, /상류 저장소 README 언어판만 표시/);
  assert.match(compatibilityReadme, /canonical English documentation is now \[README\.md\]\(README\.md\)/);
});
