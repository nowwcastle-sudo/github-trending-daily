import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = {
  repositoryUrl: "https://github.com/owner/repo",
  blobSha: "a".repeat(40),
};

async function loadRenderer() {
  const code = await readFile(new URL("../readme-markdown.js", import.meta.url), "utf8");
  const context = { globalThis: {}, URL };
  vm.runInNewContext(code, context, { filename: "readme-markdown.js" });
  return context.globalThis.ReadmeMarkdown;
}

test("raw HTML and dangerous URL schemes never survive rendering", async () => {
  const ReadmeMarkdown = await loadRenderer();
  const html = ReadmeMarkdown.render('<img src=x onerror=alert(1)>\n[x](javascript:alert(1))', source);
  assert.doesNotMatch(html, /<img|javascript:/i);
  assert.match(html, /&lt;img/);
});

test("code, headings, lists and safe relative links preserve content", async () => {
  const ReadmeMarkdown = await loadRenderer();
  const html = ReadmeMarkdown.render('# 제목\n- 항목\n`<script>`\n[문서](docs/a.md)', source);
  assert.match(html, /<h1>제목<\/h1>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /github\.com\/owner\/repo\/blob\/[a-f0-9]{40}\/docs\/a\.md/);
});

test("escaped raw HTML and code preserve their exact text", async () => {
  const ReadmeMarkdown = await loadRenderer();
  const html = ReadmeMarkdown.render('`<button onclick="save()">`\n\n```html\n<button onclick="save()">\n```', source);
  assert.match(html, /&lt;button onclick=&quot;save\(\)&quot;&gt;/);
  assert.match(html, /<pre><code>&lt;button onclick=&quot;save\(\)&quot;&gt;<\/code><\/pre>/);
});

test("safe relative images use immutable raw-content URLs", async () => {
  const ReadmeMarkdown = await loadRenderer();
  const html = ReadmeMarkdown.render('![로고](docs/logo.png)', source);
  assert.match(html, /<img src="https:\/\/raw\.githubusercontent\.com\/owner\/repo\/[a-f0-9]{40}\/docs\/logo\.png" alt="로고">/);
  assert.doesNotMatch(html, /github\.com\/owner\/repo\/blob\/[a-f0-9]{40}\/docs\/logo\.png/);
});
