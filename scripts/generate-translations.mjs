// generate-translations.mjs — Detect new trending repos and produce Korean
// summaries + README translations via the Anthropic API. Idempotent: repos that
// already have a translations/<slug>.json are skipped.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPageSnapshot, installPageSnapshot } from "./update-trending.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_README_BYTES = 512 * 1024; // 512 KiB cap per README
const MAX_TRANSLATIONS_PER_RUN = 20; // cost guard
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

export function slugToFile(slug) {
  return `${slug.replace(/\//g, "__")}.json`;
}

export function extractReposFromIndex(html) {
  const start = html.indexOf("const REPOS = ");
  if (start < 0) throw new Error("REPOS constant not found in index.html");
  const open = html.indexOf("[", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(open, i + 1));
    }
  }
  throw new Error("REPOS array not terminated");
}

export function findPending(repos, translationsDir) {
  const pending = [];
  for (const repo of repos) {
    const slug = String(repo.slug || "");
    if (!REPO_RE.test(slug)) continue;
    const file = path.join(translationsDir, slugToFile(slug));
    if (!existsSync(file)) {
      pending.push({ slug, reason: "missing" });
    }
  }
  return pending;
}

export function buildPrompt(readmeMarkdown) {
  return `아래 GitHub 저장소의 README.md를 한국어 사용자를 위해 번역하고 요약해 주세요.

규칙:
1. 마크다운 구조(제목#, 리스트-, 표, 코드블록, 링크)는 원본 그대로 유지
2. 문장만 자연스러운 한국어로 번역. 개발 용어(React, Docker, inference 등)는 영어 유지
3. 300줄 초과 시 앞부분만 번역하고 마지막에 "> *(이하 원문 참조)*" 추가

README 내용:
<readme>
${readmeMarkdown}
</readme>

다음 JSON 형식"만" 출력하세요 (마크다운 코드펜스 없이):
{"translated_markdown":"...","summary":{"goal":"...","usage":"...","pros":"...","cons":"...","fit":"..."},"detail":{"goal":"...","usage":"...","pros":"...","cons":"...","fit":"...","stars_note":"..."}}`;
}

export function parseModelResponse(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const parsed = JSON.parse(trimmed);
  if (typeof parsed.translated_markdown !== "string" || parsed.translated_markdown.length < 5) {
    throw new Error("model response missing translated_markdown");
  }
  if (!parsed.summary || typeof parsed.summary.goal !== "string") throw new Error("model response missing summary.goal");
  if (!parsed.detail || typeof parsed.detail.stars_note !== "string") throw new Error("model response missing detail.stars_note");
  for (const section of [parsed.summary, parsed.detail]) {
    for (const key of ["goal", "usage", "pros", "cons", "fit"]) {
      if (typeof section[key] !== "string") throw new Error(`model response missing ${key}`);
    }
  }
  return parsed;
}

export async function callAnthropic(apiKey, prompt, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic API request failed (${response.status})`);
  }
  const data = await response.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text) throw new Error("Anthropic API returned empty content");
  return text;
}

export async function fetchReadme(slug, token = "", fetchImpl = globalThis.fetch) {
  const headers = { "User-Agent": "github-trending-daily" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`https://raw.githubusercontent.com/${slug}/HEAD/README.md`, { headers });
  if (!response.ok) throw new Error(`README fetch failed (${response.status})`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_README_BYTES) throw new Error(`README too large: ${buffer.byteLength} bytes`);
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

export function toFirestoreSummary(parsed) {
  // shape used by index.html REPOS entries
  return {
    summary: parsed.summary,
    detail: parsed.detail,
  };
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set — skipping translation generation.");
    process.exit(0); // not a failure: allow pipeline to continue without translations
  }
  const githubToken = process.env.GITHUB_TOKEN || "";
  const translationsDir = path.join(projectRoot, "translations");
  await mkdir(translationsDir, { recursive: true });

  const pagePath = path.join(projectRoot, "index.html");
  const cachePath = path.join(projectRoot, "data", "repo-summaries.json");
  const indexHtml = await readFile(pagePath, "utf8");
  const repos = extractReposFromIndex(indexHtml);
  const pending = findPending(repos, translationsDir).slice(0, MAX_TRANSLATIONS_PER_RUN);

  if (pending.length === 0) {
    console.log("No new translations needed.");
    return;
  }
  console.log(`${pending.length} repo(s) need translation (capped at ${MAX_TRANSLATIONS_PER_RUN}).`);

  const summaryCache = JSON.parse(await readFile(cachePath, "utf8"));
  const failures = [];
  const completed = [];
  let enrichedHtml = indexHtml;
  let enrichedCache = summaryCache;

  for (const { slug } of pending) {
    try {
      const markdown = await fetchReadme(slug, githubToken);
      const text = await callAnthropic(apiKey, buildPrompt(markdown));
      const parsed = parseModelResponse(text);

      const enriched = enrichReposEntry(enrichedHtml, slug, toFirestoreSummary(parsed));
      enrichedHtml = enriched.html;
      enrichedCache = enrichSummaryCache(enrichedCache, slug, parsed);
      completed.push({
        path: path.join(translationsDir, slugToFile(slug)),
        text: `${JSON.stringify({ html: parsed.translated_markdown }, null, 2)}\n`,
      });
      console.log(`✓ ${slug}`);
    } catch (error) {
      failures.push({ slug, error: String(error.message || error) });
      console.error(`✗ ${slug}: ${error.message || error}`);
    }
  }

  if (completed.length > 0) {
    const enrichedRepos = extractReposFromIndex(enrichedHtml);
    const dates = new Set(enrichedRepos.map(repo => repo._stats_date));
    if (dates.size !== 1) throw new Error("translated repositories must share one stats date");
    const snapshot = createPageSnapshot({
      page: indexHtml,
      summaryCache: enrichedCache,
      repos: enrichedRepos,
      statsDate: [...dates][0],
    });
    await installPageSnapshot({ pagePath, cachePath, ...snapshot });
    for (const output of completed) await writeFile(output.path, output.text, "utf8");
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f.slug}: ${f.error}`);
    console.error("Deterministic summaries remain available for failed repositories.");
  } else {
    console.log(`Done. ${pending.length - failures.length}/${pending.length} translated.`);
  }
}

export function enrichReposEntry(html, slug, summaryDetail) {
  const start = html.indexOf("const REPOS = ");
  if (start < 0) throw new Error("REPOS constant not found");
  const open = html.indexOf("[", start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  const repos = JSON.parse(html.slice(open, close + 1));
  const entry = repos.find((r) => r.slug === slug);
  if (!entry) throw new Error(`repo not found in REPOS: ${slug}`);
  entry.summary = summaryDetail.summary;
  entry.detail = summaryDetail.detail;
  // preserve everything after the closing bracket (e.g. ";" and the rest of the script)
  return { html: html.slice(0, open) + JSON.stringify(repos, null, 0) + html.slice(close + 1), updated: true };
}

export function enrichSummaryCache(cache, slug, parsed) {
  if (!cache || Array.isArray(cache) || typeof cache !== "object") throw new Error("summary cache must be an object");
  const existing = Object.keys(cache).find(key => key.toLowerCase() === slug.toLowerCase());
  const key = existing ?? slug;
  return {
    ...cache,
    [key]: toFirestoreSummary(parsed),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
