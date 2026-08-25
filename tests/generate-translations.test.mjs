import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  slugToFile,
  extractReposFromIndex,
  findPending,
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

test("findPending flags only repos without translation files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ua-test-"));
  writeFileSync(path.join(dir, "exists__ok.json"), "{}");
  const repos = [{ slug: "exists/ok" }, { slug: "missing/repo" }, { slug: "bad-slug" }];
  const pending = findPending(repos, dir);
  assert.deepEqual(pending.map((p) => p.slug), ["missing/repo"]);
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
