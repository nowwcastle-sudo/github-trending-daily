export const README_VARIANT_LOCALES = Object.freeze(["en", "ko", "zh-CN", "es", "ja"]);

const ALIASES = Object.freeze({
  en: ["README.en.md", "README_EN.md", "README-English.md", "README-EN.md"],
  ko: ["README.ko.md", "README.ko-KR.md", "README_KO.md", "README-KR.md", "README_KR.md", "README-Korean.md"],
  "zh-CN": ["README.zh-CN.md", "README.zh_CN.md", "README.zh.md", "README_CN.md", "README-ZH.md", "README-Chinese.md"],
  es: ["README.es.md", "README_ES.md", "README-Spanish.md"],
  ja: ["README.ja.md", "README.jp.md", "README_JA.md", "README_JP.md", "README-Japanese.md"],
});

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)\S(?:.*\S)?$/;
const SHA = /^[a-f0-9]{40}$/;

function normalizedPath(value) {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || value.includes("\0") || value.includes("\\")) {
    throw new Error("README path is invalid");
  }
  return value;
}

function fileName(value) {
  return value.slice(value.lastIndexOf("/") + 1);
}

function directoryName(value) {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index + 1);
}

export function inferReadmeLocale(path) {
  const name = fileName(normalizedPath(path)).toLowerCase();
  for (const locale of README_VARIANT_LOCALES) {
    if (ALIASES[locale].some(alias => alias.toLowerCase() === name)) return locale;
  }
  return null;
}

export function detectReadmeVariantPaths(canonicalPath, treeEnvelope) {
  const canonical = normalizedPath(canonicalPath);
  if (!treeEnvelope || !Array.isArray(treeEnvelope.tree)) throw new Error("README variant tree is invalid");
  if (treeEnvelope.truncated !== false) throw new Error("README variant tree is truncated");

  const directory = directoryName(canonical);
  const canonicalKey = canonical.toLowerCase();
  const byName = new Map();
  for (const entry of treeEnvelope.tree) {
    if (!entry || entry.type !== "blob" || entry.mode !== "100644" || typeof entry.path !== "string" || !SHA.test(entry.sha ?? "")) continue;
    let path;
    try { path = normalizedPath(entry.path); } catch { continue; }
    if (directoryName(path).toLowerCase() !== directory.toLowerCase() || path.toLowerCase() === canonicalKey) continue;
    const name = fileName(path).toLowerCase();
    if (!byName.has(name)) byName.set(name, { path, blobSha: entry.sha });
  }

  const canonicalLocale = inferReadmeLocale(canonical);
  const variants = [];
  for (const locale of README_VARIANT_LOCALES) {
    if (locale === canonicalLocale) continue;
    const match = ALIASES[locale].map(alias => byName.get(alias.toLowerCase())).find(Boolean);
    if (match) variants.push(Object.freeze({ locale, ...match }));
  }
  return variants;
}

export function isReadmeVariantSet(value, canonicalPath = null) {
  if (!Array.isArray(value) || (canonicalPath !== null && typeof canonicalPath !== "string")) return false;
  const canonicalKey = canonicalPath?.toLowerCase() ?? null;
  const seen = new Set();
  let previous = -1;
  for (const variant of value) {
    if (!variant || Array.isArray(variant) || typeof variant !== "object"
        || Object.keys(variant).sort().join("\0") !== ["blob_sha", "content_sha256", "locale", "path"].sort().join("\0")
        || !README_VARIANT_LOCALES.includes(variant.locale) || seen.has(variant.locale)
        || typeof variant.path !== "string" || !SHA.test(variant.blob_sha ?? "")
        || !/^[a-f0-9]{64}$/.test(variant.content_sha256 ?? "")) return false;
    try { normalizedPath(variant.path); } catch { return false; }
    if (variant.path.toLowerCase() === canonicalKey || inferReadmeLocale(variant.path) !== variant.locale) return false;
    const position = README_VARIANT_LOCALES.indexOf(variant.locale);
    if (position <= previous) return false;
    previous = position;
    seen.add(variant.locale);
  }
  return true;
}
