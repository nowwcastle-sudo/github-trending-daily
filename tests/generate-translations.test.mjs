import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  slugToFile,
  extractReposFromIndex,
  hashReadme,
  planTranslations,
  findUntrackedTranslationSources,
  buildPrompt,
  parseModelResponse,
  enrichReposEntry,
  enrichSummaryCache,
} from "../scripts/generate-translations.mjs";

test("slugToFile converts slash to double underscore", () => {
  assert.equal(slugToFile("makeplane/plane"), "makeplane__plane.json");
});

test("extractReposFromIndex parses REPOS array with nested brackets", () => {
  const html = 'const REPOS = [{"slug":"a/b","meta":{"x":[1,2]}}];\nrest;';
  const repos = extractReposFromIndex(html);
  assert.equal(repos.length, 1);
  assert.deepEqual(repos[0].meta.x, [1, 2]);
});

test("translation planning charges only for new or README-changed repositories", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ua-test-"));
  for (const slug of ["exists/ok", "changed/repo", "baseline/only"]) {
    writeFileSync(path.join(dir, slugToFile(slug)), "{}");
  }
  const repos = [
    { slug: "exists/ok" },
    { slug: "changed/repo" },
    { slug: "baseline/only" },
    { slug: "missing/repo" },
    { slug: "bad-slug" },
  ];
  const readmes = new Map([
    ["exists/ok", "# Stable"],
    ["changed/repo", "# Changed"],
    ["baseline/only", "# Existing translation without a source baseline"],
    ["missing/repo", "# New"],
  ]);
  const sources = {
    "exists/ok": hashReadme("# Stable"),
    "changed/repo": hashReadme("# Old"),
  };

  const plan = planTranslations(repos, dir, sources, readmes);
  assert.deepEqual(plan.pending.map(({ slug, reason }) => ({ slug, reason })), [
    { slug: "changed/repo", reason: "readme-changed" },
    { slug: "missing/repo", reason: "missing" },
  ]);
  assert.deepEqual(plan.baselines.map(({ slug }) => slug), ["baseline/only"]);
  assert.equal(plan.pending.some(({ slug }) => slug === "exists/ok"), false);
});

test("an unchanged README creates an empty paid translation queue", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ua-cost-gate-"));
  writeFileSync(path.join(dir, slugToFile("exists/ok")), "{}");
  const markdown = "# Stable";
  const plan = planTranslations(
    [{ slug: "exists/ok" }],
    dir,
    { "exists/ok": hashReadme(markdown) },
    new Map([["exists/ok", markdown]]),
  );

  assert.equal(plan.pending.length, 0, "no item may reach callAnthropic");
});

test("historical translations receive a free source baseline before they can return", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ua-history-baseline-"));
  for (const slug of ["active/repo", "history/repo", "tracked/repo"]) {
    writeFileSync(path.join(dir, slugToFile(slug)), "{}");
  }
  const candidates = findUntrackedTranslationSources(
    {
      "active/repo": {},
      "history/repo": {},
      "tracked/repo": {},
      "missing/file": {},
      "bad-slug": {},
    },
    dir,
    { "tracked/repo": hashReadme("# Already tracked") },
    [{ slug: "active/repo" }],
  );

  assert.deepEqual(candidates.map(({ slug }) => slug), ["history/repo"]);
});

test("buildPrompt embeds README and requests JSON-only output", () => {
  const p = buildPrompt("# Hello");
  assert.ok(/<readme>\s*# Hello\s*<\/readme>/.test(p));
  assert.ok(p.includes("translated_markdown"));
});

test("parseModelResponse accepts valid JSON and rejects invalid", () => {
  const good = '{"translated_markdown":"# 안녕 내용","summary":{"goal":"g","usage":"u","pros":"p","cons":"c","fit":"f"},"detail":{"goal":"g","usage":"u","pros":"p","cons":"c","fit":"f","stars_note":"n"}}';
  const parsed = parseModelResponse(good);
  assert.equal(parsed.summary.goal, "g");
  assert.throws(() => parseModelResponse('{"foo":1}'));
  assert.throws(() => parseModelResponse("not json at all"));
});

test("enrichReposEntry updates summary/detail preserving trailing code", () => {
  const html = 'const REPOS = [{"slug":"a/b","stars":5}];\nconsole.log(x);';
  const { html: out } = enrichReposEntry(html, "a/b", {
    summary: { goal: "g" },
    detail: { goal: "g" },
  });
  const updated = JSON.parse(out.slice(out.indexOf("["), out.indexOf("]") + 1));
  assert.equal(updated[0].summary.goal, "g");
  assert.ok(out.includes("console.log(x);"), "trailing code preserved");
});

test("enrichSummaryCache updates the existing case-preserving key", () => {
  const cache = { "A/One": { summary: { goal: "old" }, detail: { goal: "old" } } };
  const parsed = {
    summary: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" },
    detail: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f", stars_note: "n" },
  };
  const next = enrichSummaryCache(cache, "a/one", parsed);
  assert.deepEqual(Object.keys(next), ["A/One"]);
  assert.equal(next["A/One"].summary.goal, "g");
});
