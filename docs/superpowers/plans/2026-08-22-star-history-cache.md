# Star History Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the restricted Star History images with a daily generated, failure-safe static cache and render readable inline SVG trends for all 46 current repositories.

**Architecture:** A Node.js standard-library script extracts the current repository list from `index.html`, fetches OSS Insight sequentially, validates and merges estimated monthly points with exact daily observations, and writes one versioned JSON cache only when repository data changes. The browser loads that cache once and uses a small dependency-free renderer; GitHub Actions refreshes it daily without looping on its own commit.

**Tech Stack:** Node.js 24 built-ins (`fetch`, `node:fs`, `node:test`), vanilla JavaScript, inline SVG, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-08-22-star-history-google-auth-design.md`

## Global Constraints

- Run every code-writing task in `ponytail full`: retain the static GitHub Pages architecture, add no chart library, and use only Node.js built-ins for cache generation.
- Treat OSS Insight as untrusted input: accept only ISO `YYYY-MM-DD` dates and non-negative integer stargazer totals, at most 500 estimated rows per repository.
- Retain at most 730 exact daily observations per repository; never discard the last valid cache because one or more upstream requests fail.
- Cache schema is exactly `{ "version": 1, "generatedAt": "YYYY-MM-DD", "repositories": [{ "slug": string, "estimated": Point[], "observed": Point[] }] }`, where `Point` is `{ "date": "YYYY-MM-DD", "stars": integer }`.
- The output contains exactly the unique slugs currently in `REPOS`; the 14 stale entries present in the old inline `STAR_HISTORY` constant are removed.
- Every feature task ends with the `engineering:code-review` skill; Critical/High findings must be fixed before the task commit.
- Use test-first changes, run the focused failing test before implementation, and run the complete Star History suite before each commit.
- Do not commit OAuth secrets, service-account keys, tokens, `node_modules`, logs, or temporary mutation files.

## File Structure

- Create `scripts/update-star-history.mjs`: extraction, validation, merge, upstream fetch, no-change comparison, and CLI entry point.
- Create `tests/update-star-history.test.mjs`: pure updater, malformed input, partial-failure, pruning, and no-change tests using injected fetch and temporary directories.
- Create `star-history.js`: browser/cache normalization, point selection, SVG rendering, status copy, and CommonJS exports for Node tests.
- Create `tests/star-history.test.mjs`: browser helper tests without a DOM dependency.
- Create `star-history.json`: generated version-1 cache for the 46 current repositories.
- Create `.github/workflows/update-star-history.yml`: scheduled recovery and manual cache refresh. The primary publisher is the atomic daily workflow in `2026-08-22-daily-trending-refresh.md`.
- Modify `index.html`: remove the inline historical snapshot and remote Star History image; load `star-history.js` and render the static cache.

## Primary References

- [OSS Insight Stargazers history endpoint](https://ossinsight.io/docs/api/stargazers-history)
- [OSS Insight public API authentication and rate limits](https://ossinsight.io/docs/api)
- [OSS Insight explanation of GH Archive and star-count differences](https://ossinsight.io/docs/faq)

---

### Task 1: Validate and merge Star History data

**Files:**
- Create: `scripts/update-star-history.mjs`
- Create: `tests/update-star-history.test.mjs`

**Interfaces:**
- Consumes: the literal `const REPOS = [...]` JSON array in `index.html`; OSS Insight rows shaped as `{ date: string, stargazers: string|number }`; an optional version-1 cache.
- Produces: `extractRepos(html): Array<{slug:string,stars:number}>`, `normalizeEstimatedRows(rows): Point[]`, `mergeRepository(repo, prior, rows, date): RepositoryHistory`, and `buildCache(repos, priorCache, responses, date): Cache`.

- [ ] **Step 1: Write failing extraction and validation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRepos,
  normalizeEstimatedRows,
  mergeRepository,
} from "../scripts/update-star-history.mjs";

test("extractRepos returns unique current slugs and stars", () => {
  const html = '<script>const REPOS = [{"slug":"a/one","stars":10},{"slug":"b/two","stars":20}];\nlet period="all";</script>';
  assert.deepEqual(extractRepos(html), [
    { slug: "a/one", stars: 10 },
    { slug: "b/two", stars: 20 },
  ]);
});

test("extractRepos rejects a missing marker, invalid slug, duplicate slug, or negative stars", () => {
  assert.throws(() => extractRepos("<html></html>"), /REPOS/);
  assert.throws(() => extractRepos('const REPOS = [{"slug":"bad","stars":1}];\nlet period='), /slug/);
  assert.throws(() => extractRepos('const REPOS = [{"slug":"a/one","stars":1},{"slug":"a/one","stars":2}];\nlet period='), /duplicate/);
  assert.throws(() => extractRepos('const REPOS = [{"slug":"a/one","stars":-1}];\nlet period='), /stars/);
});

test("normalizeEstimatedRows sorts, deduplicates, and rejects malformed rows", () => {
  assert.deepEqual(normalizeEstimatedRows([
    { date: "2026-08-01", stargazers: "12" },
    { date: "2026-07-01", stargazers: "10" },
    { date: "2026-08-01", stargazers: "13" },
    { date: "not-a-date", stargazers: "99" },
    { date: "2026-09-01", stargazers: "-1" },
  ]), [
    { date: "2026-07-01", stars: 10 },
    { date: "2026-08-01", stars: 13 },
  ]);
});

test("mergeRepository preserves estimates on failure and appends today's exact observation", () => {
  const prior = {
    slug: "a/one",
    estimated: [{ date: "2026-07-01", stars: 8 }],
    observed: [{ date: "2026-08-21", stars: 9 }],
  };
  assert.deepEqual(mergeRepository({ slug: "a/one", stars: 10 }, prior, null, "2026-08-22"), {
    slug: "a/one",
    estimated: [{ date: "2026-07-01", stars: 8 }],
    observed: [
      { date: "2026-08-21", stars: 9 },
      { date: "2026-08-22", stars: 10 },
    ],
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm the intended failure**

Run from the repository root in PowerShell:

```powershell
node --test tests/update-star-history.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/update-star-history.mjs`.

- [ ] **Step 3: Implement the pure functions with hard validation limits**

```js
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ESTIMATED_POINTS = 500;
const MAX_OBSERVED_POINTS = 730;

function validPoint(value) {
  return value && DATE_RE.test(value.date) && Number.isInteger(value.stars) && value.stars >= 0;
}

export function extractRepos(html) {
  const match = html.match(/const REPOS = (\[.*?\]);\s*let period=/s);
  if (!match) throw new Error("REPOS array marker not found");
  const parsed = JSON.parse(match[1]);
  if (!Array.isArray(parsed)) throw new Error("REPOS must be an array");
  const seen = new Set();
  return parsed.map(({ slug, stars }) => {
    if (typeof slug !== "string" || !REPO_RE.test(slug)) throw new Error(`invalid slug: ${String(slug)}`);
    if (seen.has(slug)) throw new Error(`duplicate slug: ${slug}`);
    if (!Number.isInteger(stars) || stars < 0) throw new Error(`invalid stars: ${slug}`);
    seen.add(slug);
    return { slug, stars };
  });
}

export function normalizeEstimatedRows(rows) {
  if (!Array.isArray(rows)) throw new Error("OSS Insight rows must be an array");
  const byDate = new Map();
  for (const row of rows.slice(0, MAX_ESTIMATED_POINTS)) {
    const stars = Number(row?.stargazers);
    const point = { date: row?.date, stars };
    if (validPoint(point)) byDate.set(point.date, point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function mergeRepository(repo, prior, rows, date) {
  const priorEstimated = Array.isArray(prior?.estimated) ? prior.estimated.filter(validPoint) : [];
  const priorObserved = Array.isArray(prior?.observed) ? prior.observed.filter(validPoint) : [];
  const estimated = rows === null ? priorEstimated : normalizeEstimatedRows(rows);
  const observed = new Map(priorObserved.map(point => [point.date, point]));
  observed.set(date, { date, stars: repo.stars });
  return {
    slug: repo.slug,
    estimated: estimated.slice(-MAX_ESTIMATED_POINTS),
    observed: [...observed.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_OBSERVED_POINTS),
  };
}
```

Add `buildCache()` so it maps only the current `repos` array and copies no unrecognized cache fields:

```js
export function buildCache(repos, priorCache, responses, date) {
  if (!DATE_RE.test(date)) throw new Error(`invalid cache date: ${date}`);
  const priorBySlug = new Map((priorCache?.repositories || []).map(entry => [entry.slug, entry]));
  return {
    version: 1,
    generatedAt: date,
    repositories: repos.map(repo => mergeRepository(
      repo,
      priorBySlug.get(repo.slug),
      responses.get(repo.slug) ?? null,
      date,
    )),
  };
}
```

- [ ] **Step 4: Run the tests and review the data boundary**

```powershell
node --test tests/update-star-history.test.mjs
```

Expected: all tests PASS. Invoke `engineering:code-review` against the task diff with emphasis on regex boundaries, numeric coercion, row caps, duplicate dates, and preservation of prior data. Fix every Critical/High finding and rerun the command.

- [ ] **Step 5: Commit the pure cache model**

```powershell
git add scripts/update-star-history.mjs tests/update-star-history.test.mjs
git commit -m "test: define safe star history cache merging"
```

### Task 2: Add failure-safe CLI generation and initial cache

**Files:**
- Modify: `scripts/update-star-history.mjs`
- Modify: `tests/update-star-history.test.mjs`
- Create: `star-history.json`

**Interfaces:**
- Consumes: `updateCache({htmlPath, cachePath, fetchImpl, date, log}): Promise<{changed:boolean,failed:string[]}>` configuration.
- Produces: deterministic UTF-8 JSON ending in one newline; exit code 0 when partial failures retain usable entries, non-zero when `index.html` or the cache schema is unsafe to use.

- [ ] **Step 1: Write failing orchestration tests**

Add tests using `mkdtemp`, `readFile`, `writeFile`, and `tmpdir` that prove:

```js
test("updateCache keeps a failed repository, prunes stale slugs, and reports changed", async () => {
  const responses = new Map([
    ["a/one", { ok: true, json: async () => ({ data: { rows: [{ date: "2026-08-01", stargazers: "9" }] } }) }],
    ["b/two", { ok: false, status: 503 }],
  ]);
  const result = await updateCache({
    htmlPath,
    cachePath,
    date: "2026-08-22",
    fetchImpl: async url => responses.get(decodeURIComponent(url.split("/repos/")[1].split("/stargazers")[0])),
    log: () => {},
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.failed, ["b/two"]);
  const saved = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(saved.repositories.map(item => item.slug), ["a/one", "b/two"]);
});

test("updateCache does not rewrite a byte-identical repository payload", async () => {
  const before = await readFile(cachePath, "utf8");
  const result = await updateCache({ htmlPath, cachePath, date: "2026-08-22", fetchImpl, log: () => {} });
  assert.equal(result.changed, false);
  assert.equal(await readFile(cachePath, "utf8"), before);
});
```

Also assert rejection for invalid cache JSON and for a 200 response whose `data.rows` is absent. The latter is recorded as a per-repository failure and preserves that repository's prior history.

- [ ] **Step 2: Run the focused tests and confirm failure**

```powershell
node --test tests/update-star-history.test.mjs
```

Expected: FAIL because `updateCache` is not exported.

- [ ] **Step 3: Implement sequential fetch, atomic replacement, and CLI entry**

Use this orchestration shape:

```js
export async function updateCache({ htmlPath, cachePath, fetchImpl = fetch, date, log = console.warn }) {
  const repos = extractRepos(await readFile(htmlPath, "utf8"));
  const prior = await readCache(cachePath);
  const responses = new Map();
  const failed = [];
  for (const repo of repos) {
    try {
      const [owner, name] = repo.slug.split("/");
      const response = await fetchImpl(`https://api.ossinsight.io/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stargazers/history`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body?.data?.rows)) throw new Error("missing data.rows");
      responses.set(repo.slug, body.data.rows);
    } catch (error) {
      failed.push(repo.slug);
      responses.set(repo.slug, null);
      log(`${repo.slug}: ${error.message}`);
    }
  }
  const next = buildCache(repos, prior, responses, date);
  if (sameRepositories(prior, next)) return { changed: false, failed };
  await atomicWriteJson(cachePath, next);
  return { changed: true, failed };
}
```

`atomicWriteJson()` writes `<cachePath>.tmp`, then renames it over the target. The CLI obtains `date` from `new Date().toISOString().slice(0, 10)`, resolves paths from `process.cwd()`, prints only counts/slugs and never full upstream payloads, and sets `process.exitCode = 1` only for fatal top-level errors. Guard the CLI with `pathToFileURL(process.argv[1]).href === import.meta.url`.

- [ ] **Step 4: Run tests, then generate the live cache once**

```powershell
node --test tests/update-star-history.test.mjs
node scripts/update-star-history.mjs
node -e "const c=require('./star-history.json'); const slugs=c.repositories.map(x=>x.slug); if(c.version!==1||slugs.length!==46||new Set(slugs).size!==46) process.exit(1); console.log({repositories:slugs.length,observed:c.repositories.filter(x=>x.observed.length).length,estimatedTwoPlus:c.repositories.filter(x=>x.estimated.length>=2).length});"
```

Expected: 46 unique repositories, 46 with an observed point, and 44 with at least two estimated points. If the live upstream result differs, keep the generated cache but report the exact failed slugs and do not describe 44 as current fact.

- [ ] **Step 5: Mutation-check cache preservation and review**

Temporarily change the test's failed-response path to pass `[]` instead of `null`; the preservation test must fail. Restore it, rerun the suite, then invoke `engineering:code-review` with focus on partial failure, atomic writes, no-change detection, URL encoding, and output pruning.

```powershell
node --test tests/update-star-history.test.mjs
```

- [ ] **Step 6: Commit the generator and generated cache**

```powershell
git add scripts/update-star-history.mjs tests/update-star-history.test.mjs star-history.json
git commit -m "feat: generate resilient static star history cache"
```

### Task 3: Render the cache without remote Star History images

**Files:**
- Create: `star-history.js`
- Create: `tests/star-history.test.mjs`
- Modify: `index.html:185-204,250-253,359,383-408,537-539`

**Interfaces:**
- Consumes: `star-history.json` version 1 and each card's `data-slug`.
- Produces: global/CommonJS `StarHistory` with `normalizeCache(value): Map`, `displayPoints(entry): Point[]`, `sparkline(points,width,height): string`, `historyHtml(slug,entry): string`, and `load(url,fetchImpl): Promise<Map>`.

- [ ] **Step 1: Write failing renderer tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import StarHistory from "../star-history.js";

test("displayPoints combines estimates with exact observations by date", () => {
  assert.deepEqual(StarHistory.displayPoints({
    estimated: [{ date: "2026-08-01", stars: 90 }],
    observed: [{ date: "2026-08-22", stars: 100 }],
  }), [
    { date: "2026-08-01", stars: 90 },
    { date: "2026-08-22", stars: 100 },
  ]);
});

test("historyHtml distinguishes one point, a trend, and missing data", () => {
  assert.match(StarHistory.historyHtml("a/one", { estimated: [], observed: [{ date: "2026-08-22", stars: 10 }] }), /관측 데이터 1일/);
  assert.match(StarHistory.historyHtml("a/one", { estimated: [{ date: "2026-08-01", stars: 8 }], observed: [{ date: "2026-08-22", stars: 10 }] }), /<svg/);
  assert.match(StarHistory.historyHtml("a/one", null), /스타 추이 데이터가 없어요/);
});

test("normalizeCache rejects unsupported versions and malformed repository entries", () => {
  assert.throws(() => StarHistory.normalizeCache({ version: 2, repositories: [] }), /version/);
  assert.throws(() => StarHistory.normalizeCache({ version: 1, repositories: [{ slug: "bad", estimated: [], observed: [] }] }), /slug/);
});
```

- [ ] **Step 2: Run the renderer tests and confirm failure**

```powershell
node --test tests/star-history.test.mjs
```

Expected: FAIL because `star-history.js` does not exist.

- [ ] **Step 3: Implement the dependency-free browser helper**

Wrap the module so browsers receive `globalThis.StarHistory` and Node receives `module.exports`. `displayPoints()` must deduplicate by date with exact observations winning. `historyHtml()` uses the fixed explanatory copy `GH Archive 기반 과거 추정 · 현재 총 스타는 GitHub 기준`, emits an SVG only for two or more points, and never interpolates upstream HTML. `load()` requires `response.ok`, calls `normalizeCache()`, and throws concise status/schema errors.

```js
function sparkline(points, width = 220, height = 40) {
  if (points.length < 2) return "";
  const values = points.map(point => point.stars);
  const min = Math.min(...values);
  const span = Math.max(Math.max(...values) - min, 1);
  const step = width / (points.length - 1);
  const coordinates = values.map((value, index) =>
    `${(index * step).toFixed(1)},${(height - ((value - min) / span) * (height - 4) - 2).toFixed(1)}`
  ).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="스타 추이"><polyline points="${coordinates}" fill="none" stroke="var(--hot)" stroke-width="2" stroke-linejoin="round"/></svg>`;
}
```

- [ ] **Step 4: Integrate one cache load into `index.html`**

Add `<script src="star-history.js"></script>` after `favorites.js`. Remove `STAR_HISTORY`, the inline `sparkline()`, all `api.star-history.com` markup, `.starhist-img` CSS, and the delayed duplicate `renderHist()` calls. Keep a single promise:

```js
let historyBySlug=null,historyLoadError=false;
const historyReady=StarHistory.load("star-history.json",fetch)
  .then(map=>{historyBySlug=map;renderHist()})
  .catch(()=>{historyLoadError=true;renderHist()});

function renderHist(){
  document.querySelectorAll(".sparkhist[data-slug]").forEach(el=>{
    if(historyLoadError){el.innerHTML='<p class="histnote">📈 스타 추이를 불러오지 못했어요</p>';return}
    if(!historyBySlug){el.innerHTML='<p class="histnote">📈 스타 추이를 불러오는 중…</p>';return}
    el.innerHTML=StarHistory.historyHtml(el.dataset.slug,historyBySlug.get(el.dataset.slug));
  });
}
```

Leave the existing render call sites intact except for the three duplicate timeout lines at the bottom, which become one `requestAnimationFrame(()=>{moveThumb();render()})`.

- [ ] **Step 5: Run unit and static network-reference tests**

```powershell
node --test tests/star-history.test.mjs tests/update-star-history.test.mjs
if (rg -n "api\.star-history\.com|starhist-img|const STAR_HISTORY" index.html) { throw "restricted Star History reference remains" }
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');for(const s of ['star-history.js','star-history.json','GH Archive 기반 과거 추정'])if(!h.includes(s))throw Error('missing '+s);"
```

Expected: tests PASS, `rg` returns no matches, and the static assertion exits 0.

- [ ] **Step 6: Browser regression and code review**

Start the site from the repository root:

```powershell
python -m http.server 4173
```

Open `http://127.0.0.1:4173/`, scroll through all cards, and verify: 46 `.sparkhist` elements exist; 44 or the current live count show an SVG; fallback repositories show an honest one-point message; the browser makes exactly one `star-history.json` request and zero requests to `api.star-history.com`; the console has no errors. Also exercise search, each period, language, theme, README, and favorites. Invoke `engineering:code-review` on `star-history.js`, the changed `index.html` sections, and tests, then fix Critical/High findings.

- [ ] **Step 7: Commit browser rendering**

```powershell
git add star-history.js tests/star-history.test.mjs index.html
git commit -m "fix: render cached star trends without restricted API"
```

### Task 4: Automate the star-history recovery refresh

**Files:**
- Create: `.github/workflows/update-star-history.yml`
- Modify: `tests/update-star-history.test.mjs`

**Interfaces:**
- Consumes: `main`, `index.html`, and the updater CLI.
- Produces: one recovery or manual cache update commit; no commit and exit 0 when repository data is unchanged.

- [ ] **Step 1: Add a failing workflow contract test**

Add this Node test:

```js
test("workflow has the exact recovery triggers, least privilege, and no-change gate", async () => {
  const workflow = await readFile(".github/workflows/update-star-history.yml", "utf8");
  for (const fragment of [
    "schedule:",
    'cron: "47 18 * * *"',
    "workflow_dispatch:",
    "contents: write",
    "concurrency:",
    "node scripts/update-star-history.mjs",
    "git diff --quiet -- star-history.json",
    "git push",
  ]) assert.match(workflow, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(workflow, /pull-requests:\s*write|actions:\s*write/);
});
```

- [ ] **Step 2: Run the contract test and confirm failure**

```powershell
node --test tests/update-star-history.test.mjs
```

Expected: FAIL with `ENOENT` for `.github/workflows/update-star-history.yml`.

- [ ] **Step 3: Create the minimal workflow**

```yaml
name: Update star history

on:
  schedule:
    - cron: "47 18 * * *"
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: update-star-history
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: node --test tests/update-star-history.test.mjs tests/star-history.test.mjs
      - run: node scripts/update-star-history.mjs
      - name: Commit changed cache
        shell: bash
        run: |
          if git diff --quiet -- star-history.json; then exit 0; fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add star-history.json
          git commit -m "chore: update star history cache"
          git push
```

- [ ] **Step 4: Validate, review least privilege, and commit**

```powershell
node --test tests/update-star-history.test.mjs tests/star-history.test.mjs
git diff --check
```

Invoke `engineering:code-review` with focus on permissions, recursion prevention, overlapping runs, upstream failure semantics, and whether only `star-history.json` can be committed. Then commit:

```powershell
git add .github/workflows/update-star-history.yml tests/update-star-history.test.mjs
git commit -m "ci: refresh star history cache daily"
```

### Task 5: Final Star History gate and deployment verification

**Files:**
- Review only: every file changed by Tasks 1-4

**Interfaces:**
- Consumes: the complete Star History diff and live GitHub Pages deployment.
- Produces: reviewed commits with no Critical/High findings and evidence that the restricted endpoint is absent in production.

- [ ] **Step 1: Run the full deterministic gate**

```powershell
node --test tests/update-star-history.test.mjs tests/star-history.test.mjs
node scripts/update-star-history.mjs
git diff --check
if (rg -n "api\.star-history\.com|starhist-img|const STAR_HISTORY" index.html star-history.js scripts tests .github) { throw "restricted endpoint or legacy snapshot remains" }
```

Expected: all tests PASS; a same-day second updater run does not change `star-history.json`; no restricted endpoint reference exists.

- [ ] **Step 2: Perform the final code-review skill gate**

Invoke `engineering:code-review` on `git diff 63dc287..HEAD` and explicitly inspect correctness, untrusted JSON, partial upstream failure, cache corruption, rendering accessibility, network volume, Action permissions, tests, and rollback. Fix all Critical/High findings and rerun Step 1.

- [ ] **Step 3: Scan staged content, push, and verify independently**

```powershell
git status --short
git grep --cached -nE "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|client_secret|refresh_token|FIREBASE_TOKEN|ghp_[A-Za-z0-9]"
git push origin main
```

The secret scan must return no matches. After Pages reports success, load `https://nowwcastle-sudo.github.io/github-trending-daily/` in a fresh browser profile and repeat the 46-card/network/console check. Confirm the raw `star-history.json` returns HTTP 200 and contains version 1. If deployment fails, do not rewrite history; diagnose and add a normal corrective commit.
