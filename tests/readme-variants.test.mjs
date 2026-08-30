import assert from "node:assert/strict";
import test from "node:test";

import {
  README_VARIANT_LOCALES,
  detectReadmeVariantPaths,
  inferReadmeLocale,
} from "../scripts/readme-variants.mjs";

const blob = (path, char) => ({ path, mode: "100644", type: "blob", sha: char.repeat(40) });

test("README variant discovery uses only deterministic same-directory aliases", () => {
  const result = detectReadmeVariantPaths("docs/README.md", {
    truncated: false,
    tree: [
      blob("README.ko.md", "a"),
      blob("docs/README.md", "b"),
      blob("docs/README.ko-KR.md", "c"),
      blob("docs/README.zh-CN.md", "d"),
      blob("docs/README_ES.md", "e"),
      blob("docs/README.ja.md", "f"),
      blob("docs/guide.fr.md", "1"),
      { path: "docs/README.en.md", mode: "040000", type: "tree", sha: "2".repeat(40) },
    ],
  });
  assert.deepEqual(result.map(({ locale, path }) => ({ locale, path })), [
    { locale: "ko", path: "docs/README.ko-KR.md" },
    { locale: "zh-CN", path: "docs/README.zh-CN.md" },
    { locale: "es", path: "docs/README_ES.md" },
    { locale: "ja", path: "docs/README.ja.md" },
  ]);
  assert.deepEqual(README_VARIANT_LOCALES, ["en", "ko", "zh-CN", "es", "ja"]);
});

test("canonical language filenames are inferred and never duplicated as variants", () => {
  assert.equal(inferReadmeLocale("README.md"), null);
  assert.equal(inferReadmeLocale("README.zh_CN.md"), "zh-CN");
  assert.equal(inferReadmeLocale("docs/README-Korean.md"), "ko");
  const result = detectReadmeVariantPaths("README.en.md", {
    truncated: false,
    tree: [blob("README.en.md", "a"), blob("README.md", "b"), blob("README.ja.md", "c")],
  });
  assert.deepEqual(result.map(value => value.locale), ["ja"]);
});

test("truncated or malformed tree evidence fails closed", () => {
  assert.throws(() => detectReadmeVariantPaths("README.md", { truncated: true, tree: [] }), /truncated/);
  assert.throws(() => detectReadmeVariantPaths("README.md", { truncated: false, tree: null }), /tree/);
  assert.throws(() => detectReadmeVariantPaths("../README.md", { truncated: false, tree: [] }), /path/);
});
