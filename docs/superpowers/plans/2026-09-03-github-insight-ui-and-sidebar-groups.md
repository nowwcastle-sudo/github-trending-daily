# GITHUB INSIGHT UI and Sidebar Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-button Explore rail into four rail buttons driving one panel with four content groups, lift the highest-frequency filters into an always-visible filter bar, rename the product to GITHUB INSIGHT, and harden the page with a measured CSP, keyboard shortcuts, and CI — with `npm test` green at the end of every task.

**Architecture:** `ui-motion.js` gains two pure exports (`resolveSidebarGroup`, `SIDEBAR_HOVER_CLOSE_DELAY_MS`) that the page runtime uses as its only group vocabulary and timing source. `index.html`'s sidebar runtime block grows `setSidebarGroup(group)` and a third `openSidebar(mode, trigger, group)` parameter; group visibility is the `hidden` attribute so the existing `focusableIn` focus-trap filter keeps working unchanged. Period, language, and the two quick filters move out of the panel into a new `.filter-bar` inside `<main class="wrap">`, still driven by the same `filterState` object so the URL contract is untouched. Python and feed changes are confined to `scripts/generate_atom_feeds.py`.

**Tech Stack:** Vanilla ES2022 in `index.html` + IIFE modules (`ui-motion.js`, `star-history.js`, `site-i18n.js`, `repo-filters.js`, `readme-markdown.js`, `current-view-export.js`), Python 3.13 stdlib, Node 24 `node:test`, `python -m unittest`. No dependencies added.

**Spec:** `docs/superpowers/specs/2026-09-03-github-insight-ui-and-sidebar-groups-design.md`

## Global Constraints

- **Shell:** run every test command in **PowerShell**, not Git Bash. Git Bash makes two `tests/pages-publication.test.mjs` cases fail spuriously.
- **Full regression after every task:** `npm test` (which is `node --test && python -m unittest discover -s tests -p "test_*.py"`). Baseline after Task 1 is `# tests 634 / # pass 634 / # fail 0` (count grows as tasks add tests).
- **i18n (I1):** every new message key must be added to all five locales in `site-i18n.js` — `en`, `ko`, `zh-CN`, `es`, `ja`. `tests/site-i18n.test.mjs` compares key sets exactly.
- **URL contract (I5):** `RepoFilters.parseState` / `serializeState` behaviour is unchanged. `period`, `lang`, `exclude=ai`, `membership=new`, `sort`, `q`, `fav` serialize exactly as today. `repo-filters.js` is never edited by this plan.
- **Design tokens (I6), copied verbatim, must survive every task:** `--sidebar-open-duration:260ms`, `--sidebar-close-duration:210ms`, `--sidebar-width:min(360px,calc(100vw - 44px))`, `.nav-toggle{...width:48px;min-height:60px...}`, `.nav-rail{...width:64px...}`, focus ring `outline:3px solid var(--accent);outline-offset:2px`.
- **No new dependency.** `package.json` and `package-lock.json` are never edited.
- **Scripts:** only `scripts/generate_atom_feeds.py` may change. No other script, no workflow except the new `.github/workflows/tests.yml`, no `data/**` file, no snapshot contract change.
- **Never hand-edit** `index.html` between `// GENERATED:TRENDING-REPOS:START` and `// GENERATED:TRENDING-REPOS:END` (line 629), nor `feed.xml`, `changes.xml`, `star-history.json`, `data/**`.
- **URLs and repository name are frozen.** Only displayed titles change.
- **Branch:** `claude/github-insight-ui-20260903`, created by the orchestrating agent. Task implementers **do not** run `git checkout`, `git switch`, `git push`, or `git merge`. Each task ends with `git add` + `git commit` only.
- **RED first.** Write the failing test, run it, see the stated failure, then implement. After GREEN, run the mutation check to prove the test can fail, then revert the mutation and confirm GREEN again.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `ui-motion.js` | Adds `SIDEBAR_GROUPS`, `resolveSidebarGroup(value)`, `SIDEBAR_HOVER_CLOSE_DELAY_MS`. Stays a pure, DOM-free module. |
| `site-i18n.js` | Adds 13 message keys × 5 locales; changes `document.title`, `feed.current`, `feed.changes`. |
| `index.html` | Head gains the CSP meta and the renamed titles. CSS gains rail glyphs, `.filter-bar*`, `.filter-toggle`, `.sidebar-group-seg`, and the `[hidden]` rule for `.sidebar-refresh`. Markup gains three rail buttons, `#sidebarGroupSeg`, `data-group` on ten sections, and `#filterBar`; loses `#periodSection`, `#languageSection`, the quick-filter `<fieldset>`. Runtime gains `setSidebarGroup`, the third `openSidebar` parameter, the hover-grace timer, filter-bar handlers, and the shortcut listener. |
| `star-history.js` | `historyHtml` appends the first observation timestamp. |
| `scripts/generate_atom_feeds.py` | Feed/author titles renamed; `_current_summary` prefixes `held`. |
| `.github/workflows/tests.yml` | **New.** Runs `npm ci` + `npm test` on PRs and pushes to main. |
| `tests/page-runtime.test.mjs` | Extends `sidebarHarness` to four rail buttons + group switcher + fake-timer assertions; adds group, hover-grace, filter-bar, shortcut, CSP, and rename tests; rewrites the nine listed tests. |
| `tests/ui-motion.test.mjs` | Group resolver + delay constant. |
| `tests/site-i18n.test.mjs` | Unchanged assertions; passes because new keys land in all five locales. |
| `tests/repo-filters.test.mjs` | Membership counts derived from data instead of literals. |
| `tests/production-readme-enrichment.test.mjs`, `tests/update-trending.test.mjs` | Exempt `held` repositories and assert their shape positively. |
| `tests/star-history.test.mjs` | Observation-start suffix. |
| `tests/test_atom_feeds.py` | Renamed literals + held prefix. |
| `tests/tests-workflow.test.mjs` | **New.** Structural test for the CI workflow. |
| `README.md`, `README.ko.md`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml` | **Task 12 only — separate final PR.** |

**Model recommendation per task** (the orchestrating agent dispatches accordingly):

| Task | Model | Why |
|---|---|---|
| 1 Fix the red baseline | sonnet | Mechanical test rewrites against a diagnosed cause |
| 2 UiMotion group vocabulary | sonnet | Three pure exports, one small file |
| 3 i18n keys | sonnet | Edit-heavy, five parallel locale objects |
| 4 Four-button rail and groups | **opus** | Interaction state machine, focus/ARIA/inert invariants |
| 5 Hover close grace | **opus** | Timer state machine with cancel/re-check paths |
| 6 Filter bar | **opus** | Filter state wiring; URL contract must not shift |
| 7 Keyboard shortcuts | **opus** | Event routing, suppression rules, modal interaction |
| 8 GITHUB INSIGHT rename | sonnet | Mechanical string changes across four files |
| 9 Held copy and observation start | sonnet | Two small render changes |
| 10 Atom feed held marker | sonnet | One Python function |
| 11 CSP meta and origin test | **opus** | Security decision gate; must stop rather than widen |
| 12 CI workflow | sonnet | Structural YAML mirrored from an existing workflow |
| 13 README (separate PR) | sonnet | Long-form documentation |

---

### Task 0: Working-copy preparation (no commit)

Run once, by the orchestrating agent, before Task 1.

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\AppData\Local\Temp\gh-trending-page'
git fetch --prune origin
git switch main
git pull --ff-only origin main
if ((git rev-parse HEAD) -ne (git rev-parse refs/remotes/origin/main)) { throw 'main is not exact origin/main' }
git switch -c claude/github-insight-ui-20260903
```

Then repair the stale line endings that make `tests/star-ticks-workflow.test.mjs` fail locally. `git ls-files --eol data/star-daily.jsonl` reports `i/lf w/crlf`: the index is correct, the working file is stale from before `.gitattributes` gained `data/star-daily.jsonl text eol=lf`.

```powershell
Remove-Item -LiteralPath 'data/star-daily.jsonl'
git checkout -- data/star-daily.jsonl
git ls-files --eol data/star-daily.jsonl   # expect: i/lf  w/lf
git status --short                          # expect: empty
```

This changes no tracked content and produces no commit.

---

### Task 1: Make the test baseline green

**Files:**
- Modify: `tests/page-runtime.test.mjs:558-573`
- Modify: `tests/repo-filters.test.mjs:218-230`
- Modify: `tests/production-readme-enrichment.test.mjs:80-89`
- Modify: `tests/update-trending.test.mjs:356-372`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a green `npm test`, and the convention that any assertion about *runtime code* in `index.html` first strips the generated data span. Later tasks reuse this helper name: `runtimeRegion(page)`.

Diagnosis for each failure is in the spec §9.1. All four are test defects, not code defects: the page and the data are correct, the assertions encode stale literals or ignore the `held` status introduced by the repository-level admission design.

- [ ] **Step 1: Confirm the five failures**

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\AppData\Local\Temp\gh-trending-page'
node --test --test-reporter=tap 2>&1 | Select-String -Pattern '^not ok|^# (fail|pass|tests)'
```

Expected, exactly:

```
not ok 335 - README tabs consume only Markdown tied to immutable repository metadata
not ok 408 - tracked production migration gate distinguishes the exact legacy RED from complete v3 summaries
not ok 430 - embedded snapshot exposes the exact daily weekly and monthly memberships
not ok 458 - the tick ledgers start empty and tracked
not ok 577 - seeded cache preserves every detailed content record currently published in the page
# tests 634
# pass 617
# fail 5
```

`not ok 458` must already be gone if Task 0 ran. If it is still present, redo Task 0's line-ending repair before continuing.

- [ ] **Step 2: Fix the README-tabs scope**

In `tests/page-runtime.test.mjs`, add this helper next to the other top-level helpers (after the `const repoFiltersSource = …` line near line 8):

```js
function runtimeRegion(source) {
  const start = source.indexOf("// GENERATED:TRENDING-REPOS:START");
  const end = source.indexOf("// GENERATED:TRENDING-REPOS:END");
  assert.ok(start >= 0 && end > start, "generated repository data must be delimited");
  return source.slice(0, start) + source.slice(end);
}
const pageRuntime = runtimeRegion(page);
```

Then replace the two whole-file assertions at the end of "README tabs consume only Markdown tied to immutable repository metadata" (currently lines 570-572):

```js
  assert.doesNotMatch(pageRuntime, /translations\/|translated_markdown|translation_applicable/);
  assert.doesNotMatch(pageRuntime, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(pageRuntime, /HEAD\/README\.md/);
```

All seven `raw.githubusercontent.com` occurrences in `index.html` are inside the generated blob, in repository summary prose. Zero are in runtime code, so the rescoped assertion still proves what the test claims to prove.

- [ ] **Step 3: Derive the membership counts from the data**

Replace the body of `tests/repo-filters.test.mjs` "embedded snapshot exposes the exact daily weekly and monthly memberships" (lines 225-229) with:

```js
  assert.ok(repositories.length >= 10 && repositories.length <= 75);
  const rankKey = { daily: "rank_daily", weekly: "rank_weekly", monthly: "rank_monthly" };
  const expected = ["all", "daily", "weekly", "monthly"].map(period => (
    period === "all"
      ? repositories.length
      : repositories.filter(repository => repository[rankKey[period]] !== null && repository[rankKey[period]] !== undefined).length
  ));
  assert.deepEqual(
    ["all", "daily", "weekly", "monthly"].map(period => repositories.filter(repository => RepoFilters.matchesRepo(repository, { period })).length),
    expected,
  );
  assert.ok(repositories.every(repository => ["daily", "weekly", "monthly"].some(period => (
    repository[rankKey[period]] !== null && repository[rankKey[period]] !== undefined
  ))), "every repository must hold at least one period membership");
  assert.ok(expected.slice(1).every(count => count > 0), "each period must have members");
```

This still proves `matchesRepo`'s period logic — it compares the filter's answer against an independent recomputation from the raw ranks — but no longer breaks on every refresh.

- [ ] **Step 4: Exempt `held` from the production migration gate**

In `tests/production-readme-enrichment.test.mjs`, replace line 88 and add the positive held assertions:

```js
  const heldRepositories = repositories.filter(repository => repository.summary_status === "held");
  const admittedRepositories = repositories.filter(repository => repository.summary_status !== "held");
  assert.deepEqual(Object.keys(sourceRegistry.sources), admittedRepositories.map(repository => repository.slug));
  for (const repository of heldRepositories) {
    assert.equal(repository.summary, null, `${repository.slug} held must carry no summary`);
    assert.equal(repository.detail, null, `${repository.slug} held must carry no detail`);
    assert.equal(sourceRegistry.sources[repository.slug.toLowerCase()], undefined, `${repository.slug} held must have no source entry`);
  }
```

Held repositories keep valid README provenance (`readme_path`, `readme_blob_sha`, `readme_content_sha256`, `default_branch_head_sha` are all populated), so `observed.validReadmeProvenance === observed.repository` still holds and the surrounding `deepEqual` on `observed` is unchanged.

- [ ] **Step 5: Exempt `held` from the seeded-cache check**

Replace the loop in `tests/update-trending.test.mjs` "seeded cache preserves every detailed content record currently published in the page":

```js
  assert.ok(repos.length >= 10 && repos.length <= 75);
  const admitted = repos.filter(repo => repo.summary_status !== "held");
  const held = repos.filter(repo => repo.summary_status === "held");
  assert.ok(Object.keys(cache).length >= admitted.length);
  for (const repo of admitted) {
    const { stars_note: _starsNote, ...detail } = repo.detail;
    assert.deepEqual(cache[repo.slug].content, detail);
    assert.ok(cache[repo.slug].source && typeof cache[repo.slug].source === "object");
  }
  for (const repo of held) {
    assert.equal(repo.summary, null, `${repo.slug} held must carry no summary`);
    assert.equal(repo.detail, null, `${repo.slug} held must carry no detail`);
    assert.equal(cache[repo.slug], undefined, `${repo.slug} held must not be cached`);
  }
```

- [ ] **Step 6: Run the full regression**

```powershell
npm test
```

Expected: `# tests 634 / # pass 634 / # fail 0`, then the Python suite `OK`.

- [ ] **Step 7: Mutation check**

Break each fix and confirm the corresponding test goes red, then revert:

1. In `runtimeRegion`, change `source.slice(end)` to `source.slice(start)` → "README tabs…" fails with `AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /raw\.githubusercontent\.com/`.
2. In the repo-filters fix, change `expected` to `[repositories.length, 0, 0, 0]` → "embedded snapshot…" fails on `deepEqual`.
3. In the production gate, change `admittedRepositories` back to `repositories` → the test fails on `Object.keys(sourceRegistry.sources)` length.
4. In update-trending, change `admitted` back to `repos` → the test throws `TypeError: Cannot destructure property 'stars_note' of 'repo.detail' as it is null`.

Revert all four; re-run `npm test` and confirm green.

- [ ] **Step 8: Commit**

```powershell
git add tests/page-runtime.test.mjs tests/repo-filters.test.mjs tests/production-readme-enrichment.test.mjs tests/update-trending.test.mjs
git commit -m "test: green the baseline by scoping README assertions to runtime code and exempting held repositories

- page-runtime: strip the generated REPOS span before asserting no raw.githubusercontent.com in runtime code (all 7 hits are summary prose in the data blob)
- repo-filters: derive period membership counts from the embedded ranks instead of the 45/[45,16,20,22] literals
- production-readme-enrichment, update-trending: held repositories carry summary null, detail null and no cache or source entry; assert that instead of treating them as admitted"
```

---

### Task 2: UiMotion group vocabulary and hover delay

**Files:**
- Modify: `ui-motion.js` (add before the `return { … }` block; extend that block)
- Test: `tests/ui-motion.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 4, 5 and 7:
  - `UiMotion.SIDEBAR_GROUPS: readonly ["account","explore","history","export"]`
  - `UiMotion.resolveSidebarGroup(value: unknown): "account"|"explore"|"history"|"export"` — total; anything not in `SIDEBAR_GROUPS` returns `"explore"`.
  - `UiMotion.SIDEBAR_HOVER_CLOSE_DELAY_MS: 500`

- [ ] **Step 1: Write the failing test**

Append to `tests/ui-motion.test.mjs`, after the "sidebar mode separates passive hover from modal activation" test:

```js
test("sidebar groups are a closed set and unknown values resolve to explore", async () => {
  const UiMotion = await loadUiMotion();
  assert.deepEqual([...UiMotion.SIDEBAR_GROUPS], ["account", "explore", "history", "export"]);
  assert.equal(typeof UiMotion.resolveSidebarGroup, "function");
  for (const group of UiMotion.SIDEBAR_GROUPS) assert.equal(UiMotion.resolveSidebarGroup(group), group);
  for (const bad of [undefined, null, "", "Explore", "filters", 0, {}, ["explore"]]) {
    assert.equal(UiMotion.resolveSidebarGroup(bad), "explore", `${JSON.stringify(bad)} must fall back to explore`);
  }
  assert.throws(() => { UiMotion.SIDEBAR_GROUPS.push("extra"); }, TypeError);
});

test("hover close grace is a single exported 500 ms constant", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(UiMotion.SIDEBAR_HOVER_CLOSE_DELAY_MS, 500);
});
```

- [ ] **Step 2: Run the test and see it fail**

```powershell
node --test --test-name-pattern="sidebar groups are a closed set|hover close grace is a single exported" tests/ui-motion.test.mjs
```

Expected: FAIL — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: undefined !== ...` from `assert.deepEqual([...UiMotion.SIDEBAR_GROUPS], …)` throwing `TypeError: UiMotion.SIDEBAR_GROUPS is not iterable`, and `Expected values to be strictly equal: undefined !== 500`.

- [ ] **Step 3: Write the minimal implementation**

In `ui-motion.js`, immediately after the `sidebarMode` function:

```js
  const SIDEBAR_GROUPS = Object.freeze(["account", "explore", "history", "export"]);
  const SIDEBAR_HOVER_CLOSE_DELAY_MS = 500;

  function resolveSidebarGroup(value) {
    return SIDEBAR_GROUPS.includes(value) ? value : "explore";
  }
```

Extend the module's returned object (keeping the existing entries in place):

```js
  return {
    tooltipLayout,
    periodGain,
    badgeModel,
    touchCardAction,
    sidebarMode,
    SIDEBAR_GROUPS,
    SIDEBAR_HOVER_CLOSE_DELAY_MS,
    resolveSidebarGroup,
    startEdgeGesture,
    updateEdgeGesture,
    finishEdgeGesture,
    cancelEdgeGesture,
  };
```

- [ ] **Step 4: Run the test and see it pass**

```powershell
node --test tests/ui-motion.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Full regression**

```powershell
npm test
```

Expected: 0 failures.

- [ ] **Step 6: Mutation check**

Change `resolveSidebarGroup` to `return value ?? "explore";` → "sidebar groups are a closed set…" fails on `assert.equal(UiMotion.resolveSidebarGroup("filters"), "explore")` with `'filters' !== 'explore'`. Change `SIDEBAR_HOVER_CLOSE_DELAY_MS` to `400` → the second test fails with `400 !== 500`. Revert both; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add ui-motion.js tests/ui-motion.test.mjs
git commit -m "feat: export the closed sidebar group set, a total group resolver, and the 500 ms hover close delay

resolveSidebarGroup normalizes every unknown value to explore so the page runtime never has to validate a data-group attribute itself."
```

---

### Task 3: i18n keys for groups, shortcuts, held retry, and copy link

**Files:**
- Modify: `site-i18n.js` — the `EN` object and the four locale objects (`ko` near line 153, `zh-CN` near line 171, `es`, `ja`)
- Test: `tests/site-i18n.test.mjs` (no edit needed — its parity assertion is what proves this task)

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 4, 6, 7 and 9 — thirteen keys, present in all five locales:

| Key | en | ko | zh-CN | es | ja |
|---|---|---|---|---|---|
| `nav.account` | Login | 로그인 | 登录 | Iniciar sesión | ログイン |
| `nav.history` | History | 이력 | 历史 | Historial | 履歴 |
| `nav.export` | Export | 内보내기 → **내보내기** | 导出 | Exportar | エクスポート |
| `nav.ariaAccount` | Account and sync panel | 계정·동기화 패널 | 账户与同步面板 | Panel de cuenta y sincronización | アカウント・同期パネル |
| `nav.ariaExplore` | Explore panel | 탐색 패널 | 探索面板 | Panel de exploración | 探索パネル |
| `nav.ariaHistory` | History panel | 이력 패널 | 历史面板 | Panel de historial | 履歴パネル |
| `nav.ariaExport` | Export panel | 내보내기 패널 | 导出面板 | Panel de exportación | エクスポートパネル |
| `nav.titleAccount` | Login (a) | 로그인 (a) | 登录 (a) | Iniciar sesión (a) | ログイン (a) |
| `nav.titleExplore` | Explore (e) | 탐색 (e) | 探索 (e) | Explorar (e) | 探索 (e) |
| `nav.titleHistory` | History (h) | 이력 (h) | 历史 (h) | Historial (h) | 履歴 (h) |
| `nav.titleExport` | Export (x) | 내보내기 (x) | 导出 (x) | Exportar (x) | エクスポート (x) |
| `nav.groups` | Panel section | 패널 구획 | 面板分区 | Sección del panel | パネルセクション |
| `filter.copyLink` | Copy link | 링크 복사 | 复制链接 | Copiar enlace | リンクをコピー |
| `tooltip.heldRetry` | Retried at the next refresh (about every 2 hours). | 다음 갱신(약 2시간마다)에 다시 시도합니다. | 将在下次刷新（约每 2 小时）时重试。 | Se reintentará en la próxima actualización (aproximadamente cada 2 horas). | 次回の更新（約2時間ごと）で再試行します。 |

(That is 14 rows; `nav.export`'s Korean value is `내보내기`.)

Existing keys `nav.close`, `nav.pin` and `period.title` become unused after Tasks 4 and 6. **Leave them in place** in all five locales — the parity test only requires identical key sets, and removing them is churn with no benefit.

- [ ] **Step 1: Write the failing test**

Add to `tests/site-i18n.test.mjs`, after the existing five-locale test:

```js
test("every rail group, shortcut hint, and held-retry message exists in all five locales", () => {
  const i18n = load();
  const required = [
    "nav.account", "nav.history", "nav.export",
    "nav.ariaAccount", "nav.ariaExplore", "nav.ariaHistory", "nav.ariaExport",
    "nav.titleAccount", "nav.titleExplore", "nav.titleHistory", "nav.titleExport",
    "nav.groups", "filter.copyLink", "tooltip.heldRetry",
  ];
  for (const locale of i18n.SUPPORTED_LOCALES) {
    for (const key of required) {
      const value = i18n.MESSAGES[locale][key];
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} ${key} must not be blank`);
    }
  }
  for (const [key, hint] of [["nav.titleAccount", "(a)"], ["nav.titleExplore", "(e)"], ["nav.titleHistory", "(h)"], ["nav.titleExport", "(x)"]]) {
    for (const locale of i18n.SUPPORTED_LOCALES) {
      assert.ok(i18n.MESSAGES[locale][key].endsWith(hint), `${locale} ${key} must end with the ${hint} shortcut hint`);
    }
  }
});
```

- [ ] **Step 2: Run the test and see it fail**

```powershell
node --test --test-name-pattern="every rail group, shortcut hint" tests/site-i18n.test.mjs
```

Expected: FAIL — `AssertionError [ERR_ASSERTION]: en is missing nav.account` (`undefined !== 'string'`).

- [ ] **Step 3: Add the keys**

Add all 14 keys to the `EN` object (grouping the `nav.*` ones next to `nav.explore` near line 16, `filter.copyLink` next to the `export.*` block near line 74, and `tooltip.heldRetry` immediately after `tooltip.held` near line 122). Add the same 14 keys with the values from the table above to `ko`, `zh-CN`, `es`, and `ja`, following each locale object's existing compact one-line-per-group formatting.

- [ ] **Step 4: Run the tests and see them pass**

```powershell
node --test tests/site-i18n.test.mjs
```

Expected: PASS, including the pre-existing "site shell supports the exact five approved locales with complete message keys".

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

Delete `nav.groups` from the `ja` object → both the new test (`ja is missing nav.groups`) and the pre-existing parity test (`ja must not fall back key-by-key`) fail. Restore it; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add site-i18n.js tests/site-i18n.test.mjs
git commit -m "feat: add rail-group labels, aria labels, shortcut title hints, copy-link and held-retry messages in all five locales"
```

---

### Task 4: Four-button rail driving one panel with four groups

**Files:**
- Modify: `index.html:85-108` (rail CSS), `:335` (hidden rule), `:447-535` (panel markup), `:537-544` (rail markup), `:694-796` (sidebar runtime), `:1183` (`#emptyManageHiddenBtn`)
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: `UiMotion.SIDEBAR_GROUPS`, `UiMotion.resolveSidebarGroup(value)` (Task 2); `nav.account`, `nav.history`, `nav.export`, `nav.aria*`, `nav.title*`, `nav.groups` (Task 3).
- Produces, used by Tasks 5, 6 and 7:
  - `railToggles: HTMLButtonElement[]` — the four rail buttons in DOM order.
  - `navRail: HTMLElement` — `document.getElementById("navRail")`.
  - `sidebarGroupSeg: HTMLElement`, `sidebarGroupSegButtons: HTMLButtonElement[]`.
  - `setSidebarGroup(group: unknown): string` — resolves, sets `sidebar.dataset.group`, toggles every `[data-group]` section's `hidden`, sets `aria-current` on the matching rail button, sets `aria-pressed` on the switcher buttons. Returns the resolved group.
  - `openSidebar(mode: "hover"|"modal", trigger: HTMLElement|null, group?: unknown): void` — third parameter added; omitted means "keep the current group".
  - `setSidebarExpandedState(expanded: boolean): void` — replaces `setSidebarTriggerState(label, expanded)`; sets only `aria-expanded` on the five toggles.
  - `sidebarOwnsTarget(target)` widened to the whole rail.

- [ ] **Step 1: Extend the test harness for four buttons**

In `tests/page-runtime.test.mjs`, inside `sidebarHarness`, extend the `nodes` map (currently lines 111-119) and the returned object:

```js
  const nodes = new Map([
    ["filterSidebar", new FakeHTMLElement("filterSidebar")],
    ["sidebarScrim", new FakeHTMLElement("sidebarScrim")],
    ["navRail", new FakeHTMLElement("navRail")],
    ["navAccountToggle", new FakeHTMLElement("navAccountToggle")],
    ["navToggle", new FakeHTMLElement("navToggle")],
    ["navHistoryToggle", new FakeHTMLElement("navHistoryToggle")],
    ["navExportToggle", new FakeHTMLElement("navExportToggle")],
    ["mobileNavToggle", new FakeHTMLElement("mobileNavToggle")],
    ["sidebarClose", new FakeHTMLElement("sidebarClose")],
    ["sidebarGroupSeg", new FakeHTMLElement("sidebarGroupSeg")],
    ["readmePanel", new FakeHTMLElement("readmePanel")],
    ["tipLayer", new FakeHTMLElement("tipLayer")],
  ]);
  for (const [id, group] of [["navAccountToggle", "account"], ["navToggle", "explore"], ["navHistoryToggle", "history"], ["navExportToggle", "export"]]) {
    const toggle = nodes.get(id);
    toggle.dataset.group = group;
    toggle.parentElement = nodes.get("navRail");
  }
```

Give `FakeHTMLElement` a working `querySelectorAll` for the two selectors the runtime uses, replacing the current `querySelectorAll() { return []; }` stub:

```js
    querySelectorAll(selector) {
      if (this.id === "filterSidebar" && selector === "[data-group]") return sidebarSections;
      if (this.id === "sidebarGroupSeg" && selector === "button[data-group]") return segButtons;
      return [];
    }
```

and declare, above the `nodes` map:

```js
  const sidebarSections = [
    ["refreshStatus", "account"], ["accountSection", "account"],
    ["viewSection", "explore"], ["fieldSection", "explore"], ["formSection", "explore"],
    ["sortSection", "explore"], ["resultSection", "explore"],
    ["hiddenRepoSection", "history"], ["recentExitsSection", "history"],
    ["exportSection", "export"],
  ].map(([id, group]) => { const node = new FakeHTMLElement(id); node.dataset.group = group; return node; });
  const segButtons = ["account", "explore", "history", "export"].map(group => {
    const node = new FakeHTMLElement(`seg-${group}`); node.dataset.group = group; node.tagName = "BUTTON"; return node;
  });
```

`FakeHTMLElement` already exposes `hidden` as a plain property (it is set in the constructor's sibling fields; add `this.hidden = false;` next to `this._inert = false;`). Add to the harness return value:

```js
    railToggles: ["navAccountToggle", "navToggle", "navHistoryToggle", "navExportToggle"].map(id => nodes.get(id)),
    mobileToggle: nodes.get("mobileNavToggle"),
    groupSeg: nodes.get("sidebarGroupSeg"),
    segButtons,
    sections: sidebarSections,
    sectionsFor(group) { return sidebarSections.filter(section => !section.hidden).map(section => section.id); },
```

- [ ] **Step 2: Write the failing tests**

First declare the section-to-group table once at the top of `tests/page-runtime.test.mjs`, next to `runtimeRegion` (Task 1). Task 4's version includes `periodSection` and `languageSection`; **Task 6 deletes those two rows in the same commit that deletes their markup**, so `npm test` is green at both task boundaries:

```js
const SIDEBAR_SECTION_GROUPS = [
  ["refreshStatus", "account"], ["accountSection", "account"],
  ["viewSection", "explore"], ["periodSection", "explore"], ["languageSection", "explore"],
  ["fieldSection", "explore"], ["formSection", "explore"], ["sortSection", "explore"], ["resultSection", "explore"],
  ["hiddenRepoSection", "history"], ["recentExitsSection", "history"],
  ["exportSection", "export"],
];
```

Then add to `tests/page-runtime.test.mjs`:

```js
test("the rail exposes four group buttons in the approved order with complete disclosure semantics", () => {
  const rail = page.match(/<nav class="nav-rail"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const buttons = [...rail.matchAll(/<button class="nav-toggle" id="(\w+)" type="button"([^>]*)>/g)];
  assert.deepEqual(buttons.map(match => match[1]), ["navAccountToggle", "navToggle", "navHistoryToggle", "navExportToggle"]);
  const expected = [
    ["account", "nav.ariaAccount", "nav.titleAccount", "nav.account"],
    ["explore", "nav.ariaExplore", "nav.titleExplore", "nav.explore"],
    ["history", "nav.ariaHistory", "nav.titleHistory", "nav.history"],
    ["export", "nav.ariaExport", "nav.titleExport", "nav.export"],
  ];
  buttons.forEach((match, index) => {
    const [group, ariaKey, titleKey] = expected[index];
    assert.match(match[2], new RegExp(`data-group="${group}"`));
    assert.match(match[2], /aria-controls="filterSidebar"/);
    assert.match(match[2], /aria-expanded="false"/);
    assert.match(match[2], new RegExp(`data-i18n-aria-label="${ariaKey}"`));
    assert.match(match[2], new RegExp(`data-i18n-title="${titleKey}"`));
  });
  expected.forEach(([, , , labelKey]) => assert.match(rail, new RegExp(`data-i18n="${labelKey}"`)));
  assert.match(page, /<nav class="nav-rail" id="navRail"/);
  assert.match(page, /\.nav-rail\{[^}]*width:64px/);
  assert.match(page, /\.nav-toggle\{[^}]*width:48px;min-height:60px/);
  assert.match(page, /\.nav-toggle:focus-visible\{outline:3px solid var\(--accent\);outline-offset:2px\}/);
});

test("every panel section belongs to exactly one of the four groups and no group is empty", () => {
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<\/div>\s*<nav class="nav-rail"/)?.[0] ?? "";
  const sections = [...sidebar.matchAll(/<(?:section|nav)[^>]*id="(\w+)"[^>]*data-group="(\w+)"/g)];
  assert.deepEqual(sections.map(match => [match[1], match[2]]), SIDEBAR_SECTION_GROUPS);
  for (const group of ["account", "explore", "history", "export"]) {
    assert.ok(sections.some(match => match[2] === group), `${group} must own at least one section`);
  }
  const groupless = [...sidebar.matchAll(/<(?:section|nav)[^>]*id="(\w+)"/g)]
    .map(match => match[1])
    .filter(id => !SIDEBAR_SECTION_GROUPS.some(([sectionId]) => sectionId === id));
  assert.deepEqual(groupless, [], "every panel section must declare a group");
  assert.match(page, /\.sidebar-section\[hidden\],\.sidebar-refresh\[hidden\]/);
  assert.match(page, /id="filterSidebar"[^>]*data-group="explore"/);
});

test("hovering a second rail button switches the group without closing the panel", () => {
  const harness = sidebarHarness();
  const [account, explore, history] = harness.railToggles;
  explore.dispatch("pointerenter");
  assert.equal(harness.sidebar.dataset.openMode, "hover");
  assert.equal(harness.sidebar.dataset.group, "explore");
  assert.deepEqual(harness.sectionsFor(), ["viewSection", "fieldSection", "formSection", "sortSection", "resultSection"]);

  harness.trace.length = 0;
  explore.dispatch("pointerleave", { relatedTarget: history });
  history.dispatch("pointerenter");
  assert.equal(harness.sidebar.dataset.openMode, "hover", "group switch must not close the panel");
  assert.equal(harness.sidebar.dataset.group, "history");
  assert.deepEqual(harness.sectionsFor(), ["hiddenRepoSection", "recentExitsSection"]);
  assert.equal(harness.trace.includes("filterSidebar:inert:true"), false, "no close cycle during a group switch");
  assert.equal(history.getAttribute("aria-current"), "true");
  assert.equal(explore.getAttribute("aria-current"), null);

  account.dispatch("pointerenter");
  assert.equal(harness.sidebar.dataset.group, "account");
  assert.deepEqual(harness.sectionsFor(), ["refreshStatus", "accountSection"]);
});

test("an unknown data-group on a rail button falls back to explore", () => {
  const harness = sidebarHarness();
  const rogue = harness.railToggles[2];
  rogue.dataset.group = "filters";
  rogue.dispatch("pointerenter");
  assert.equal(harness.sidebar.dataset.group, "explore");
  assert.deepEqual(harness.sectionsFor(), ["viewSection", "fieldSection", "formSection", "sortSection", "resultSection"]);
});

test("keyboard activation opens that group modally and restores focus to the button that opened it", () => {
  for (const [index, group, sections] of [
    [0, "account", ["refreshStatus", "accountSection"]],
    [2, "history", ["hiddenRepoSection", "recentExitsSection"]],
    [3, "export", ["exportSection"]],
  ]) {
    const harness = sidebarHarness();
    const toggle = harness.railToggles[index];
    toggle.focus();
    toggle.dispatch("click", { detail: 0 });
    assert.equal(harness.sidebar.dataset.openMode, "modal", `${group} keyboard activation must open modal`);
    assert.equal(harness.sidebar.dataset.group, group);
    assert.deepEqual(harness.sectionsFor(), sections);
    assert.equal(harness.groupSeg.hidden, false, "modal mode exposes the group switcher");
    assert.equal(harness.close.focusCount, 1);
    assert.equal(harness.pageMain.inert, true);
    assert.equal(harness.scrim.classList.contains("on"), true);

    harness.document.dispatch("keydown", { key: "Escape" });
    assert.equal(harness.sidebar.dataset.openMode, undefined);
    assert.equal(harness.document.activeElement, toggle, `${group} close must restore focus to its own rail button`);
    assert.equal(harness.groupSeg.hidden, true, "the switcher leaves the tab order when the panel closes");
  }
});

test("clicking a different rail button while modal switches the group instead of closing", () => {
  const harness = sidebarHarness();
  const [account, , history] = harness.railToggles;
  account.dispatch("click", { detail: 1 });
  assert.equal(harness.sidebar.dataset.openMode, "modal");
  assert.equal(harness.sidebar.dataset.group, "account");

  history.dispatch("click", { detail: 1 });
  assert.equal(harness.sidebar.dataset.openMode, "modal", "a different group must not close the panel");
  assert.equal(harness.sidebar.dataset.group, "history");

  history.dispatch("click", { detail: 1 });
  assert.equal(harness.sidebar.dataset.openMode, undefined, "the same group toggles closed");
  assert.equal(harness.document.activeElement, history);
});

test("the modal group switcher selects a group and stays out of the hover tab order", () => {
  const harness = sidebarHarness();
  harness.railToggles[1].dispatch("pointerenter");
  assert.equal(harness.groupSeg.hidden, true, "hover mode keeps the switcher hidden");

  harness.mobileToggle.dispatch("click", { detail: 1 });
  assert.equal(harness.sidebar.dataset.openMode, "modal");
  assert.equal(harness.groupSeg.hidden, false);
  assert.deepEqual(harness.segButtons.map(button => button.getAttribute("aria-pressed")), ["false", "true", "false", "false"]);

  harness.segButtons[3].dispatch("click", { detail: 1 });
  assert.equal(harness.sidebar.dataset.group, "export");
  assert.equal(harness.sidebar.dataset.openMode, "modal", "the switcher must not close the panel");
  assert.deepEqual(harness.segButtons.map(button => button.getAttribute("aria-pressed")), ["false", "false", "false", "true"]);
  const seg = page.match(/<div class="seg sidebar-group-seg" id="sidebarGroupSeg"[^>]*>/)?.[0] ?? "";
  assert.match(seg, /role="group"/);
  assert.match(seg, /data-i18n-aria-label="nav\.groups"/);
  assert.match(seg, /\bhidden\b/);
});
```

- [ ] **Step 3: Run the tests and see them fail**

```powershell
node --test --test-name-pattern="four group buttons|belongs to exactly one of the four groups|switches the group without closing|falls back to explore|opens that group modally|while modal switches the group|modal group switcher selects" tests/page-runtime.test.mjs
```

Expected: FAIL — the markup tests with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal` on `deepEqual([], ["navAccountToggle", …])`, and every harness test with `TypeError: Cannot read properties of undefined (reading 'dispatch')` because `harness.railToggles` does not exist yet.

- [ ] **Step 4: Write the markup**

Add `id="navRail"` to the `<nav class="nav-rail">` element and replace its single button with four (index.html:537-544):

```html
<nav class="nav-rail" id="navRail" aria-label="Quick navigation" data-i18n-aria-label="nav.quick">
  <button class="nav-toggle" id="navAccountToggle" type="button" data-group="account" aria-label="Account and sync panel" data-i18n-aria-label="nav.ariaAccount" title="Login (a)" data-i18n-title="nav.titleAccount" aria-controls="filterSidebar" aria-expanded="false">
    <span class="nav-glyph-user" aria-hidden="true"></span>
    <span class="nav-label" data-i18n="nav.account">Login</span>
  </button>
  <button class="nav-toggle" id="navToggle" type="button" data-group="explore" aria-label="Explore panel" data-i18n-aria-label="nav.ariaExplore" title="Explore (e)" data-i18n-title="nav.titleExplore" aria-controls="filterSidebar" aria-expanded="false">
    <span class="nav-glyph" aria-hidden="true"></span>
    <span class="nav-label" data-i18n="nav.explore">Explore</span>
  </button>
  <button class="nav-toggle" id="navHistoryToggle" type="button" data-group="history" aria-label="History panel" data-i18n-aria-label="nav.ariaHistory" title="History (h)" data-i18n-title="nav.titleHistory" aria-controls="filterSidebar" aria-expanded="false">
    <span class="nav-glyph-clock" aria-hidden="true"></span>
    <span class="nav-label" data-i18n="nav.history">History</span>
  </button>
  <button class="nav-toggle" id="navExportToggle" type="button" data-group="export" aria-label="Export panel" data-i18n-aria-label="nav.ariaExport" title="Export (x)" data-i18n-title="nav.titleExport" aria-controls="filterSidebar" aria-expanded="false">
    <span class="nav-glyph-export" aria-hidden="true"></span>
    <span class="nav-label" data-i18n="nav.export">Export</span>
  </button>
  <span class="nav-rail-spacer" aria-hidden="true"></span>
  <span class="filter-count" id="filterCount" aria-live="polite"></span>
</nav>
```

Add `data-group="explore"` to the `<div class="filter-sidebar" id="filterSidebar" …>` opening tag (index.html:447). Insert the group switcher immediately after the closing `</div>` of `.sidebar-head` (after index.html:452):

```html
  <div class="seg sidebar-group-seg" id="sidebarGroupSeg" role="group" aria-label="Panel section" data-i18n-aria-label="nav.groups" hidden>
    <button type="button" data-group="account" aria-pressed="false" data-i18n="nav.account">Login</button>
    <button type="button" data-group="explore" aria-pressed="true" data-i18n="nav.explore">Explore</button>
    <button type="button" data-group="history" aria-pressed="false" data-i18n="nav.history">History</button>
    <button type="button" data-group="export" aria-pressed="false" data-i18n="nav.export">Export</button>
  </div>
```

Add `data-group` to each section's opening tag: `refreshStatus` and `accountSection` → `account`; `viewSection`, `fieldSection`, `formSection`, `sortSection`, `resultSection` → `explore`; `hiddenRepoSection`, `recentExitsSection` → `history`; `exportSection` → `export`. Do **not** reorder any section. (`#periodSection` and `#languageSection` still exist at this point and stay in the `explore` group — carry `data-group="explore"` on them too; Task 6 deletes them.)

- [ ] **Step 5: Write the CSS**

Extend the hidden rule at index.html:335:

```css
.sidebar-section[hidden],.sidebar-refresh[hidden],.sidebar-group-seg[hidden],.undo-bar[hidden],.empty button[hidden]{display:none}
```

Add after `.nav-glyph::before` (index.html:99) the three glyph rules from spec §4.2 verbatim, and after `.seg button[aria-pressed="true"]` (index.html:211):

```css
.sidebar-group-seg{margin-bottom:4px}
.sidebar-group-seg button[aria-pressed="true"]{background:var(--seg-thumb);border-radius:8px;box-shadow:var(--shadow-card)}
.nav-toggle[aria-current="true"]{background:var(--accent-soft);color:var(--accent-selected)}
```

- [ ] **Step 6: Write the runtime**

In the sidebar runtime block (index.html:694-796):

```js
const sidebar=document.getElementById("filterSidebar"),sidebarScrim=document.getElementById("sidebarScrim"),pageMain=document.querySelector(".wrap");
const navRail=document.getElementById("navRail"),mobileNavToggle=document.getElementById("mobileNavToggle"),sidebarClose=document.getElementById("sidebarClose");
const navToggle=document.getElementById("navToggle");
const railToggles=[document.getElementById("navAccountToggle"),navToggle,document.getElementById("navHistoryToggle"),document.getElementById("navExportToggle")];
const sidebarToggles=[...railToggles,mobileNavToggle];
const sidebarGroupSeg=document.getElementById("sidebarGroupSeg");
const sidebarGroupSegButtons=[...sidebarGroupSeg.querySelectorAll("button[data-group]")];
const sidebarGroups=[...sidebar.querySelectorAll("[data-group]")];
const sidebarHoverMedia=matchMedia("(hover:hover) and (pointer:fine)");
let sidebarTrigger=null,railPointerInside=false,sidebarPointerInside=false;
```

Replace `setSidebarTriggerState` with:

```js
function setSidebarExpandedState(expanded){
  sidebarToggles.forEach(toggle=>toggle.setAttribute("aria-expanded",String(expanded)));
}
function setSidebarGroup(group){
  const next=UiMotion.resolveSidebarGroup(group);
  sidebar.dataset.group=next;
  sidebarGroups.forEach(section=>{section.hidden=section.dataset.group!==next});
  railToggles.forEach(toggle=>{
    if(toggle.dataset.group===next)toggle.setAttribute("aria-current","true");
    else toggle.removeAttribute("aria-current");
  });
  sidebarGroupSegButtons.forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.group===next)));
  return next;
}
```

Replace every `setSidebarTriggerState(tr("nav.open"),false)` with `setSidebarExpandedState(false)`, and both `setSidebarTriggerState(tr("nav.close"),true)` and `setSidebarTriggerState(tr("nav.pin"),true)` with `setSidebarExpandedState(true)`.

In `closeSidebar`, after `delete sidebar.dataset.openMode;` add `sidebarGroupSeg.hidden=true;` (leave `sidebar.dataset.group` in place — it is sticky).

In `openSidebar`, change the signature and add the group and switcher lines:

```js
function openSidebar(mode,trigger,group){
  const currentMode=sidebar.dataset.openMode;
  if(currentMode==="modal"||currentMode===mode)return;
  if(mode==="hover"&&document.getElementById("tipLayer").matches(":focus-within"))return;
  const readme=document.getElementById("readmePanel");
  if(mode==="hover"&&readme.classList.contains("open"))return;
  if(readme.classList.contains("open"))closeReadme(false);
  hideTip();
  setSidebarGroup(group??sidebar.dataset.group);
  sidebar.inert=false;sidebar.classList.add("open");sidebar.setAttribute("aria-hidden","false");
  sidebar.dataset.openMode=mode;
  sidebarGroupSeg.hidden=mode!=="modal";
  if(mode==="modal"){
    sidebarTrigger=trigger instanceof HTMLElement?trigger:document.activeElement;
    sidebar.setAttribute("aria-modal","true");sidebarScrim.classList.add("on");setSidebarExpandedState(true);pageMain.inert=true;
    document.body.classList.add("overlay-open");sidebarClose.focus();
  }else{
    sidebar.removeAttribute("aria-modal");setSidebarExpandedState(true);
  }
  if(mode==="modal"&&typeof hideScrollTopImmediately==="function")hideScrollTopImmediately();
  else if(typeof scheduleScrollTopUpdate==="function")scheduleScrollTopUpdate();
}
```

Replace `sidebarOwnsTarget`, `activateSidebar`, and the listener block:

```js
function sidebarOwnsTarget(target){
  if(!target)return false;
  if(target===sidebar||sidebar.contains(target))return true;
  if(navRail&&(target===navRail||navRail.contains(target)))return true;
  return railToggles.some(toggle=>target===toggle||toggle.contains(target));
}
function activateSidebar(event){
  const group=UiMotion.resolveSidebarGroup(event.currentTarget?.dataset?.group);
  if(sidebar.dataset.openMode==="modal"){
    if(sidebar.dataset.group===group){closeSidebar();return}
    sidebarTrigger=event.currentTarget;setSidebarGroup(group);return;
  }
  openSidebar(UiMotion.sidebarMode({hoverCapable:sidebarHoverMedia.matches,trigger:event.detail===0?"keyboard":"click"}),event.currentTarget,group);
}
railToggles.forEach(toggle=>{
  toggle.addEventListener("pointerenter",()=>{
    if(!sidebarHoverMedia.matches)return;
    railPointerInside=true;
    const group=UiMotion.resolveSidebarGroup(toggle.dataset.group);
    if(sidebar.dataset.openMode==="hover")setSidebarGroup(group);
    else openSidebar(UiMotion.sidebarMode({hoverCapable:true,trigger:"pointer"}),toggle,group);
  });
  toggle.addEventListener("pointerleave",event=>{railPointerInside=false;closeHoverSidebarIfOutside(event.relatedTarget)});
  toggle.addEventListener("focusout",event=>closeHoverSidebarIfOutside(event.relatedTarget));
  toggle.addEventListener("click",activateSidebar);
});
sidebar.addEventListener("pointerenter",()=>{if(sidebarHoverMedia.matches)sidebarPointerInside=true});
sidebar.addEventListener("pointerleave",event=>{sidebarPointerInside=false;closeHoverSidebarIfOutside(event.relatedTarget)});
sidebar.addEventListener("focusout",event=>closeHoverSidebarIfOutside(event.relatedTarget));
mobileNavToggle.addEventListener("click",activateSidebar);
sidebarGroupSeg.addEventListener("click",event=>{
  const button=event.target.closest?.("button[data-group]")??event.target;
  if(button?.dataset?.group)setSidebarGroup(button.dataset.group);
});
sidebarClose.addEventListener("click",()=>{
  if(sidebar.dataset.openMode==="hover")navToggle.focus();
  closeSidebar();
});
```

(`closeHoverSidebarIfOutside` keeps its current synchronous body in this task; Task 5 replaces it.)

Change index.html:1183 to `openSidebar("modal",event.currentTarget,"history");`.

Add `setSidebarGroup(sidebar.dataset.group);` to the page's initialisation block next to the existing `updateFilterUi();` call (index.html:1470) so the initial `hidden` state matches `data-group="explore"` before any interaction.

- [ ] **Step 7: Update the nine affected existing tests**

Rewrite the assertions listed in spec §9.2 for this task:

- "sidebar sections follow the approved priority and keyboard order": insert `sidebarGroupSeg` after `refreshStatus` in `sectionIds`? No — `sidebarGroupSeg` precedes `refreshStatus`; assert it separately with `assert.ok(sidebar.indexOf('id="sidebarGroupSeg"') < sidebar.indexOf('id="refreshStatus"'))` and keep `sectionIds` as the ten section ids (`periodSection` and `languageSection` still present in this task; Task 6 removes them from the list).
- "fine pointers expose the selected 64px compact Explore rail": keep every CSS assertion; no rail-count assertion is present, so no change is needed beyond confirming it still passes.
- "the selected compact Explore rail stays reachable and outside the inert page": replace `setSidebarTriggerState(tr("nav.close"),true)` / `setSidebarTriggerState(tr("nav.open"),false)` with `setSidebarExpandedState(true)` / `setSidebarExpandedState(false)`; replace `navToggle.addEventListener("pointerenter"` with `toggle.addEventListener("pointerenter"`; replace `navToggle.addEventListener("click",activateSidebar)` with `toggle.addEventListener("click",activateSidebar)`; keep `assert.doesNotMatch(page, /navToggle\.addEventListener\("keydown"/)` and the `trigger:event.detail===0?"keyboard":"click"` assertion.
- "hover close button restores rail focus…": unchanged (it uses `harness.toggle`; keep the harness's `toggle` alias pointing at `nodes.get("navToggle")`).
- The four other harness tests use `harness.toggle` and keep working because the alias is preserved.

- [ ] **Step 8: Run the tests and see them pass**

```powershell
node --test tests/page-runtime.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Full regression**

```powershell
npm test
```

- [ ] **Step 10: Mutation check**

1. In `setSidebarGroup`, change `section.hidden=section.dataset.group!==next` to `section.hidden=false` → "hovering a second rail button switches the group…" fails on `deepEqual` of `sectionsFor()` (all ten ids returned).
2. In `activateSidebar`, delete the `if(sidebar.dataset.group===group)` guard so every modal click closes → "clicking a different rail button while modal switches the group instead of closing" fails with `undefined !== 'modal'`.
3. In `openSidebar`, change `sidebarGroupSeg.hidden=mode!=="modal"` to `=false` → "the modal group switcher selects a group and stays out of the hover tab order" fails on `true !== false` for hover mode.

Revert all three; re-run and confirm PASS.

- [ ] **Step 11: Commit**

```powershell
git add index.html tests/page-runtime.test.mjs
git commit -m "feat: four rail buttons drive one panel with account, explore, history and export groups

Group visibility uses the hidden attribute so focusableIn keeps excluding off-group controls from the focus trap. Hovering a second rail button switches the group with no close cycle; keyboard activation opens that group modally and restores focus to the button that opened it; a hidden-until-modal segmented switcher gives touch and keyboard users the same four groups. setSidebarTriggerState is replaced by setSidebarExpandedState because each button now carries its own static aria-label."
```

---

### Task 5: 500 ms hover close grace

**Files:**
- Modify: `index.html:747-750` (`closeHoverSidebarIfOutside`), plus `cancelHoverClose()` calls in `openSidebar`, `closeSidebar`, and the rail/panel `pointerenter` handlers
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: `UiMotion.SIDEBAR_HOVER_CLOSE_DELAY_MS` (Task 2); `railToggles`, `sidebarOwnsTarget` (Task 4).
- Produces: `closeHoverSidebarNow(relatedTarget)` — synchronous close used by `focusout`; `closeHoverSidebarIfOutside(relatedTarget)` — deferred close used by `pointerleave`; `cancelHoverClose()`.

- [ ] **Step 1: Write the failing tests**

Replace the whole existing test "hover close starts immediately outside the combined rail and sidebar while preserving focus" (tests/page-runtime.test.mjs:674-695) with:

```js
test("pointer leave defers the hover close by the exported grace and re-entry cancels it", () => {
  const harness = sidebarHarness();
  const [, explore] = harness.railToggles;
  explore.dispatch("pointerenter");
  harness.sidebar.dispatch("pointerenter");
  explore.dispatch("pointerleave", { relatedTarget: harness.sidebar });
  assert.equal(harness.sidebar.dataset.openMode, "hover", "rail to sidebar movement must stay open");

  harness.sidebar.dispatch("pointerleave", { relatedTarget: harness.outside });
  harness.advance(499);
  assert.equal(harness.sidebar.dataset.openMode, "hover", "the panel must survive 499 ms of the grace window");
  harness.advance(1);
  assert.equal(harness.sidebar.dataset.openMode, undefined, "the panel must close at 500 ms");
  assert.equal(harness.sidebar.classList.contains("open"), false);
  assert.equal(harness.sidebar.inert, true);
});

test("re-entering the rail or the panel inside the grace window cancels the pending close", () => {
  for (const target of ["rail", "panel"]) {
    const harness = sidebarHarness();
    const [, explore] = harness.railToggles;
    explore.dispatch("pointerenter");
    harness.sidebar.dispatch("pointerenter");
    harness.sidebar.dispatch("pointerleave", { relatedTarget: harness.outside });
    harness.advance(300);
    if (target === "rail") explore.dispatch("pointerenter");
    else harness.sidebar.dispatch("pointerenter");
    harness.advance(5000);
    assert.equal(harness.sidebar.dataset.openMode, "hover", `${target} re-entry must cancel the pending close`);
  }
});

test("focus leaving the hover panel still closes it synchronously", () => {
  const harness = sidebarHarness();
  const [, explore] = harness.railToggles;
  explore.dispatch("pointerenter");
  harness.sidebar.focusWithin = true;
  harness.sidebar.dispatch("focusin");
  harness.sidebar.dispatch("pointerleave", { relatedTarget: harness.outside });
  assert.equal(harness.sidebar.dataset.openMode, "hover", "focus inside must keep hover mode open");

  harness.sidebar.focusWithin = false;
  harness.document.activeElement = harness.outside;
  harness.sidebar.dispatch("focusout", { relatedTarget: harness.outside });
  assert.equal(harness.sidebar.dataset.openMode, undefined, "focusout must not wait for the grace timer");
});

test("upgrading to modal inside the grace window cancels the pending hover close", () => {
  const harness = sidebarHarness();
  const [, explore] = harness.railToggles;
  explore.dispatch("pointerenter");
  harness.sidebar.dispatch("pointerleave", { relatedTarget: harness.outside });
  harness.advance(200);
  explore.dispatch("click", { detail: 1 });
  assert.equal(harness.sidebar.dataset.openMode, "modal");
  harness.advance(5000);
  assert.equal(harness.sidebar.dataset.openMode, "modal", "a stale hover timer must never close a modal panel");
});
```

The harness's `focusout` handler for rail buttons must call the synchronous path, so also change the Task 4 listener line `toggle.addEventListener("focusout",event=>closeHoverSidebarIfOutside(event.relatedTarget))` to `closeHoverSidebarNow` in Step 3 below.

- [ ] **Step 2: Run the tests and see them fail**

```powershell
node --test --test-name-pattern="pointer leave defers the hover close|re-entering the rail or the panel|focus leaving the hover panel|upgrading to modal inside the grace" tests/page-runtime.test.mjs
```

Expected: FAIL — "pointer leave defers…" fails at the 499 ms assertion with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: undefined !== 'hover'` because the current code closes synchronously.

- [ ] **Step 3: Write the implementation**

Replace `closeHoverSidebarIfOutside` (index.html:747-750) with:

```js
let hoverCloseTimer=null;
function cancelHoverClose(){if(hoverCloseTimer!==null){clearTimeout(hoverCloseTimer);hoverCloseTimer=null}}
function hoverSidebarShouldStayOpen(relatedTarget){
  return sidebar.dataset.openMode!=="hover"
    ||sidebarOwnsTarget(relatedTarget)
    ||railPointerInside
    ||sidebarPointerInside
    ||sidebar.matches(":focus-within")
    ||railToggles.some(toggle=>toggle.matches(":focus"));
}
function closeHoverSidebarNow(relatedTarget=null){
  if(hoverSidebarShouldStayOpen(relatedTarget))return;
  cancelHoverClose();closeSidebar(false);
}
function closeHoverSidebarIfOutside(relatedTarget=null){
  if(hoverSidebarShouldStayOpen(relatedTarget))return;
  cancelHoverClose();
  hoverCloseTimer=setTimeout(()=>{hoverCloseTimer=null;closeHoverSidebarNow()},UiMotion.SIDEBAR_HOVER_CLOSE_DELAY_MS);
}
```

Add `cancelHoverClose();` as the first statement of `closeSidebar` (before `const mode=sidebar.dataset.openMode`) and of `openSidebar` (before `const currentMode=…`), and as the first statement inside each rail-button `pointerenter` handler and the panel's `pointerenter` handler.

Change the two `focusout` registrations to the synchronous path:

```js
  toggle.addEventListener("focusout",event=>closeHoverSidebarNow(event.relatedTarget));
sidebar.addEventListener("focusout",event=>closeHoverSidebarNow(event.relatedTarget));
```

- [ ] **Step 4: Run the tests and see them pass**

```powershell
node --test tests/page-runtime.test.mjs
```

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

1. Change the delay to `0` → "pointer leave defers the hover close…" fails at the 499 ms assertion (`undefined !== 'hover'`).
2. Delete `cancelHoverClose()` from the rail `pointerenter` handler → "re-entering the rail or the panel inside the grace window…" fails for the `rail` case (`undefined !== 'hover'`).
3. Make `closeHoverSidebarNow` skip its guard re-check (call `closeSidebar(false)` unconditionally) → "upgrading to modal inside the grace window…" fails with `undefined !== 'modal'`.

Revert all three; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add index.html tests/page-runtime.test.mjs
git commit -m "feat: give the hover sidebar a 500 ms close grace that any re-entry cancels

pointerleave now schedules the close through UiMotion.SIDEBAR_HOVER_CLOSE_DELAY_MS and the timer re-checks every guard before firing, so a pointer that returns, focus that lands inside, or an upgrade to modal all keep the panel open. focusout still closes synchronously; Escape, the close button and modal mode are unchanged."
```

---

### Task 6: Filter bar under the badge guide

**Files:**
- Modify: `index.html:472-495` (delete `#periodSection`, `#languageSection`, and the quick-filter `<fieldset>`), `:579-581` (insert `#filterBar`), CSS after `:226`, runtime at `:906-921`, `:1163-1168`
- Test: `tests/page-runtime.test.mjs`, `tests/repo-filters.test.mjs`

**Interfaces:**
- Consumes: `filter.copyLink` (Task 3); `setSidebarGroup` (Task 4).
- Produces, used by Task 11's origin scan and Task 13's README: `#filterBar`, `#excludeAi` / `#newOnly` as `<button aria-pressed>`, `#copyLinkBtn`, `#filterBarStatus`, `setFilterBarStatus(message, tone)`.

- [ ] **Step 1: Write the failing tests**

```js
test("the filter bar sits under the badge guide and owns period, language, quick filters and copy link", () => {
  const asideEnd = page.indexOf("</aside>");
  const hintIndex = page.indexOf('id="cardKeyboardHint"');
  const barIndex = page.indexOf('id="filterBar"');
  assert.ok(asideEnd >= 0 && asideEnd < barIndex && barIndex < hintIndex, "the filter bar belongs between the badge guide and the card hint");
  const bar = page.match(/<section class="filter-bar" id="filterBar"[\s\S]*?<\/section>/)?.[0] ?? "";
  const order = ["periodSeg", "segThumb", "lang", "excludeAi", "newOnly", "copyLinkBtn", "filterBarStatus"];
  let previous = -1;
  for (const id of order) {
    const position = bar.indexOf(`id="${id}"`);
    assert.ok(position > previous, `${id} must appear in the approved filter-bar order`);
    previous = position;
  }
  assert.match(bar, /<button type="button" id="excludeAi" class="filter-toggle" aria-pressed="false" data-i18n="field\.excludeAi">/);
  assert.match(bar, /<button type="button" id="newOnly" class="filter-toggle" aria-pressed="false" data-i18n="field\.newOnly">/);
  assert.match(bar, /<button type="button" id="copyLinkBtn" class="filter-toggle" data-i18n="filter\.copyLink">/);
  assert.match(bar, /id="filterBarStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.doesNotMatch(bar, /type="checkbox"/);

  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<\/div>\s*<nav class="nav-rail"/)?.[0] ?? "";
  for (const gone of ["periodSection", "languageSection", "periodSeg", "lang", "excludeAi", "newOnly"]) {
    assert.equal(sidebar.includes(`id="${gone}"`), false, `${gone} must no longer live in the panel`);
  }
  assert.doesNotMatch(page, /<fieldset class="filter-switch-row">/);
});

test("the filter bar rows never sum past the card column", () => {
  assert.match(page, /\.filter-bar\{display:flex;flex-direction:column;gap:16px;margin-top:18px\}/);
  assert.match(page, /\.filter-bar-row\{display:flex;gap:16px;flex-wrap:wrap\}/);
  assert.match(page, /\.filter-bar-row>\*\{flex:1 1 calc\(50% - 8px\);max-width:calc\(50% - 8px\);min-width:0\}/);
  assert.match(page, /\.filter-bar-row-3>\*\{flex:1 1 calc\(\(100% - 32px\)\/3\);max-width:calc\(\(100% - 32px\)\/3\)\}/);
  assert.match(page, /@media\(max-width:600px\)\{\.filter-bar-row>\*,\.filter-bar-row-3>\*\{flex:1 1 100%;max-width:100%\}\}/);
  assert.match(page, /\.filter-toggle\{[^}]*min-height:44px/);
  assert.match(page, /\.filter-toggle:focus-visible\{outline:3px solid var\(--accent\);outline-offset:2px\}/);
  assert.match(page, /\.filter-toggle\[aria-pressed="true"\]\{background:var\(--accent-soft\);color:var\(--accent-selected\);border-color:var\(--accent\)\}/);
});

test("quick filter toggles round trip through filterState and aria-pressed without touching the URL contract", () => {
  assert.match(page, /document\.getElementById\("excludeAi"\)\.setAttribute\("aria-pressed",String\(filterState\.excludeAi\)\)/);
  assert.match(page, /document\.getElementById\("newOnly"\)\.setAttribute\("aria-pressed",String\(filterState\.newOnly\)\)/);
  assert.match(page, /document\.getElementById\("excludeAi"\)\.addEventListener\("click",\(\)=>\{[\s\S]*?excludeAi:!filterState\.excludeAi[\s\S]*?syncUrl\(\);render\(\)/);
  assert.match(page, /document\.getElementById\("newOnly"\)\.addEventListener\("click",\(\)=>\{[\s\S]*?newOnly:!filterState\.newOnly[\s\S]*?syncUrl\(\);render\(\)/);
  assert.match(page, /clearFiltersBtn[\s\S]*?newOnly:false/);
  assert.match(page, /activeDiscoveryCount\(\)[\s\S]*?\+\(filterState\.newOnly\?1:0\)/);
  assert.doesNotMatch(pageRuntime, /getElementById\("excludeAi"\)\.checked/);
  assert.doesNotMatch(pageRuntime, /getElementById\("newOnly"\)\.checked/);
});

test("the filter-bar copy link reuses the export clipboard helper and its own status region", () => {
  assert.match(page, /function setFilterBarStatus\(message,tone=""\)\{/);
  assert.match(page, /document\.getElementById\("copyLinkBtn"\)\.addEventListener\("click",async\(\)=>\{[\s\S]*?CurrentViewExport\.copyText\(currentExportUrl\(\)\)[\s\S]*?tr\("export\.linkCopied"\)[\s\S]*?tr\("export\.copyFailed"\)/);
  assert.match(page, /id="copyViewUrlBtn"/, "the export panel keeps its own copy button");
});
```

Add to `tests/repo-filters.test.mjs`:

```js
test("the moved filter controls do not change the serialized URL state", async () => {
  const RepoFilters = await loadRepoFilters();
  const cases = [
    ["?period=weekly&lang=Rust&exclude=ai&membership=new", "?period=weekly&lang=Rust&exclude=ai&membership=new"],
    ["?exclude=ai", "?exclude=ai"],
    ["?membership=new", "?membership=new"],
    ["?period=daily", "?period=daily"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    assert.equal(RepoFilters.serializeState(RepoFilters.parseState(input, ["Rust"])), expected, `${input} must round trip unchanged`);
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

```powershell
node --test --test-name-pattern="the filter bar sits under|filter bar rows never sum|quick filter toggles round trip|filter-bar copy link reuses" tests/page-runtime.test.mjs
node --test --test-name-pattern="moved filter controls do not change" tests/repo-filters.test.mjs
```

Expected: the four page-runtime tests FAIL with `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert.ok(asideEnd >= 0 && asideEnd < barIndex && …)` because `#filterBar` does not exist (`barIndex === -1`). The repo-filters test should **PASS** immediately — it is the invariant guard (I5), written now so a later mistake cannot go unnoticed.

- [ ] **Step 3: Move the markup**

Delete `#periodSection` (index.html:472-481) and `#languageSection` (:482-485) entirely, and delete the `<fieldset class="filter-switch-row">` block from `#fieldSection` (:490-494), leaving `#fieldSection`'s heading, note, and `#fieldFilters`.

Insert the `#filterBar` markup from spec §6.1 verbatim between `</aside>` (index.html:579) and `<p id="cardKeyboardHint" …>` (:581).

- [ ] **Step 4: Add the CSS**

Insert after `.langsel:focus` (index.html:226) the four `.filter-bar*` rules, the `.filter-toggle` block, and the `@media(max-width:600px)` rule, all exactly as in spec §6.2-6.3.

- [ ] **Step 5: Rewire the runtime**

In `updateFilterUi` (index.html:906-921), replace the two `.checked=` lines:

```js
  document.getElementById("excludeAi").setAttribute("aria-pressed",String(filterState.excludeAi));
  document.getElementById("newOnly").setAttribute("aria-pressed",String(filterState.newOnly));
```

Replace the two `change` handlers (index.html:1163-1168):

```js
document.getElementById("excludeAi").addEventListener("click",()=>{
  filterState={...filterState,excludeAi:!filterState.excludeAi};updateFilterUi();syncUrl();render();
});
document.getElementById("newOnly").addEventListener("click",()=>{
  filterState={...filterState,newOnly:!filterState.newOnly};updateFilterUi();syncUrl();render();
});
```

Add next to `setExportStatus` (index.html:1200-1202):

```js
function setFilterBarStatus(message,tone=""){
  const status=document.getElementById("filterBarStatus");status.textContent=message;status.dataset.tone=tone;
}
document.getElementById("copyLinkBtn").addEventListener("click",async()=>{
  try{await CurrentViewExport.copyText(currentExportUrl());setFilterBarStatus(tr("export.linkCopied"),"success")}
  catch{setFilterBarStatus(tr("export.copyFailed"),"error")}
});
```

`activeDiscoveryCount`, `applyFilterState`, `clearFiltersBtn`, `syncUrl`, `setPeriod`, `moveThumb`, and the `popstate` listener are unchanged.

- [ ] **Step 6: Update the three affected existing tests**

- "sidebar sections follow the approved priority and keyboard order": drop `periodSection` and `languageSection` from `sectionIds`; drop `periodSeg`, `lang`, `excludeAi` from `focusOrder`.
- "responsive sidebar owns account, favorites, and discovery filters": drop `assert.match(sidebar, /id="lang"/)` and `assert.match(sidebar, /id="excludeAi"/)`; keep the rest.
- "new-only control follows AI exclusion and owns the complete public view state": replace the `#fieldSection` fieldset/checkbox assertions with filter-bar assertions:

```js
  const bar = page.match(/<section class="filter-bar" id="filterBar"[\s\S]*?<\/section>/)?.[0] ?? "";
  const excludeIndex = bar.indexOf('id="excludeAi"');
  const newOnlyIndex = bar.indexOf('id="newOnly"');
  assert.ok(excludeIndex >= 0 && excludeIndex < newOnlyIndex);
  assert.equal([...page.matchAll(/id="newOnly"/g)].length, 1);
  assert.match(page, /document\.getElementById\("newOnly"\)\.setAttribute\("aria-pressed",String\(filterState\.newOnly\)\)/);
  assert.match(page, /activeDiscoveryCount\(\)[\s\S]*?\+\(filterState\.newOnly\?1:0\)/);
  assert.match(page, /clearFiltersBtn[\s\S]*?newOnly:false/);
  assert.match(page, /function currentExportState\(\)\{return \{\.\.\.filterState,period,favOnly\}\}/);
  assert.match(page, /window\.addEventListener\("popstate",\(\)=>applyFilterState\(RepoFilters\.parseState\(location\.search,LANGUAGES\)\)\)/);
```

Delete the `["periodSection", "explore"]` and `["languageSection", "explore"]` rows from the `SIDEBAR_SECTION_GROUPS` table introduced in Task 4 Step 2, leaving the final ten sections. "every panel section belongs to exactly one of the four groups and no group is empty" then re-derives its expectation from that table and its `groupless` check proves nothing was left untagged.

- [ ] **Step 7: Run the tests and see them pass**

```powershell
node --test tests/page-runtime.test.mjs tests/repo-filters.test.mjs
```

- [ ] **Step 8: Full regression**

```powershell
npm test
```

- [ ] **Step 9: Mutation check**

1. Change `.filter-bar-row-3>*` to `flex:1 1 calc(50% - 8px);max-width:calc(50% - 8px)` → "the filter bar rows never sum past the card column" fails on the row-3 regex.
2. Change the `excludeAi` handler to `excludeAi:filterState.excludeAi` (never toggles) → "quick filter toggles round trip…" fails on the handler regex.
3. Delete `updateFilterUi()` from the `newOnly` handler → the same test fails on the handler regex (the `syncUrl();render()` tail no longer follows the state assignment through `updateFilterUi`).

Revert all three; re-run and confirm PASS.

- [ ] **Step 10: Commit**

```powershell
git add index.html tests/page-runtime.test.mjs tests/repo-filters.test.mjs
git commit -m "feat: lift period, language, quick filters and copy link into an always-visible filter bar

periodSeg and lang move out of the panel with their markup and ids intact, so moveThumb, setPeriod and the language handler are untouched. The two checkboxes become aria-pressed toggles driven by the same filterState object, so RepoFilters.parseState/serializeState output is unchanged - guarded by a new round-trip test."
```

---

### Task 7: Keyboard shortcuts

**Files:**
- Modify: `index.html` — add one `document.addEventListener("keydown", …)` after the existing Escape listener (index.html:773)
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: `openSidebar(mode, trigger, group)`, `railToggles`, `mobileNavToggle`, `sidebarMobileAccessMedia` (Task 4); `nav.title*` keys (Task 3).
- Produces: `SIDEBAR_SHORTCUT_GROUPS`, `shortcutSuppressed(event)`.

- [ ] **Step 1: Write the failing tests**

The harness must reach `#q` and `sidebarMobileAccessMedia`. Add `["q", new FakeHTMLElement("q")]` to the harness `nodes` map and make the harness `matchMedia` answer the mobile-access query:

```js
    matchMedia(query) {
      if (query.includes("max-width:720px")) return { matches: !hoverCapable, addEventListener() {} };
      return { matches: query.includes("pointer:coarse") ? !hoverCapable : hoverCapable, addEventListener() {} };
    },
```

and expose `search: nodes.get("q")` on the returned harness. The shortcut listener lives inside the same runtime slice the harness already evaluates (it is added directly after the Escape listener, before `\nfunction syncUrl`), so no new slice boundary is needed.

```js
test("slash focuses search and the four letters open their group modally", () => {
  const harness = sidebarHarness();
  harness.document.dispatch("keydown", { key: "/", target: harness.body });
  assert.equal(harness.document.activeElement, harness.search);
  assert.equal(harness.search.focusCount, 1);

  for (const [key, group, index] of [["a", "account", 0], ["e", "explore", 1], ["h", "history", 2], ["x", "export", 3]]) {
    const scoped = sidebarHarness();
    scoped.document.dispatch("keydown", { key, target: scoped.body });
    assert.equal(scoped.sidebar.dataset.openMode, "modal", `${key} must open the panel modally`);
    assert.equal(scoped.sidebar.dataset.group, group);
    scoped.document.dispatch("keydown", { key: "Escape" });
    assert.equal(scoped.document.activeElement, scoped.railToggles[index], `${key} must restore focus to its own rail button`);
  }
});

test("shortcuts are suppressed while typing, under modifiers, and while the README modal owns the page", () => {
  const typing = sidebarHarness();
  const input = typing.createTarget("q", { tagName: "INPUT" });
  typing.document.dispatch("keydown", { key: "e", target: input });
  assert.equal(typing.sidebar.dataset.openMode, undefined, "typing e in an input must not open the panel");
  typing.document.dispatch("keydown", { key: "/", target: typing.createTarget("sortSelect", { tagName: "SELECT" }) });
  assert.equal(typing.search.focusCount, 0, "slash inside a select must not steal focus");
  typing.document.dispatch("keydown", { key: "e", target: typing.createTarget("note", { tagName: "TEXTAREA" }) });
  assert.equal(typing.sidebar.dataset.openMode, undefined);
  typing.document.dispatch("keydown", { key: "e", target: typing.createTarget("editor", { tagName: "DIV", isContentEditable: true }) });
  assert.equal(typing.sidebar.dataset.openMode, undefined);

  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    const scoped = sidebarHarness();
    scoped.document.dispatch("keydown", { key: "h", target: scoped.body, [modifier]: true });
    assert.equal(scoped.sidebar.dataset.openMode, undefined, `${modifier}+h must be left to the browser`);
  }

  const readme = sidebarHarness();
  readme.readme.classList.add("open");
  readme.document.dispatch("keydown", { key: "x", target: readme.body });
  assert.equal(readme.sidebar.dataset.openMode, undefined, "the README modal keeps the viewport");

  const unrelated = sidebarHarness();
  unrelated.document.dispatch("keydown", { key: "z", target: unrelated.body });
  assert.equal(unrelated.sidebar.dataset.openMode, undefined);
  assert.equal(unrelated.search.focusCount, 0);
});

test("touch viewports route shortcut focus restore to the mobile trigger", () => {
  const harness = sidebarHarness({ hoverCapable: false });
  harness.document.dispatch("keydown", { key: "h", target: harness.body });
  assert.equal(harness.sidebar.dataset.openMode, "modal");
  assert.equal(harness.sidebar.dataset.group, "history");
  harness.document.dispatch("keydown", { key: "Escape" });
  assert.equal(harness.document.activeElement, harness.mobileToggle);
});

test("each rail button advertises its shortcut in the title", () => {
  for (const [id, key] of [["navAccountToggle", "nav.titleAccount"], ["navToggle", "nav.titleExplore"], ["navHistoryToggle", "nav.titleHistory"], ["navExportToggle", "nav.titleExport"]]) {
    assert.match(page, new RegExp(`id="${id}"[^>]*data-i18n-title="${key.replace(".", "\\\\.")}"`));
  }
  assert.match(page, /const SIDEBAR_SHORTCUT_GROUPS=\{e:"explore",a:"account",h:"history",x:"export"\}/);
});
```

- [ ] **Step 2: Run the tests and see them fail**

```powershell
node --test --test-name-pattern="slash focuses search|shortcuts are suppressed while typing|touch viewports route shortcut|each rail button advertises" tests/page-runtime.test.mjs
```

Expected: FAIL — "slash focuses search…" with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: <outside> !== <q>` because no `/` handler exists.

- [ ] **Step 3: Write the implementation**

Immediately after the existing Escape listener (index.html:773) and before the `sidebarCoarseMedia` declarations, so `sidebarMobileAccessMedia` is declared just below — move the shortcut listener to sit **after** the `sidebarMobileAccessMedia` declaration (index.html:777) instead, since it reads that media query:

```js
const SIDEBAR_SHORTCUT_GROUPS={e:"explore",a:"account",h:"history",x:"export"};
function shortcutSuppressed(event){
  if(event.altKey||event.ctrlKey||event.metaKey)return true;
  const target=event.target;
  const tag=String(target?.tagName||"").toLowerCase();
  return tag==="input"||tag==="select"||tag==="textarea"||target?.isContentEditable===true;
}
document.addEventListener("keydown",event=>{
  if(shortcutSuppressed(event))return;
  if(event.key==="/"){event.preventDefault();document.getElementById("q").focus();return}
  const group=SIDEBAR_SHORTCUT_GROUPS[event.key];
  if(!group)return;
  if(document.getElementById("readmePanel").classList.contains("open"))return;
  event.preventDefault();
  const trigger=sidebarMobileAccessMedia.matches?mobileNavToggle:railToggles.find(toggle=>toggle.dataset.group===group);
  openSidebar("modal",trigger,group);
});
```

`Shift` is deliberately not suppressed: `event.key` already reports the produced character, so `Shift+/` arrives as `"?"` and never matches a shortcut, while a keyboard layout that needs Shift to produce `/` keeps working.

- [ ] **Step 4: Run the tests and see them pass**

```powershell
node --test tests/page-runtime.test.mjs
```

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

1. Delete the `tag==="input"` clause from `shortcutSuppressed` → "shortcuts are suppressed while typing…" fails with `'modal' !== undefined`.
2. Change the trigger to always `railToggles.find(...)` → "touch viewports route shortcut focus restore to the mobile trigger" fails on the restored `activeElement`.
3. Delete the README-open guard → "shortcuts are suppressed while typing, under modifiers, and while the README modal owns the page" fails on the README case.

Revert all three; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add index.html tests/page-runtime.test.mjs
git commit -m "feat: add / for search and e/a/h/x group shortcuts with modifier and typing suppression

Shortcuts are ignored inside inputs, selects, textareas and contenteditable regions, under Alt/Ctrl/Meta, and while the README modal is open. Shift is intentionally not suppressed because event.key already reports the produced character. On touch viewports focus restore targets the mobile trigger because the rail is display:none."
```

---

### Task 8: Rename the product to GITHUB INSIGHT

**Files:**
- Modify: `index.html:6-8`, `:549`
- Modify: `site-i18n.js` — `document.title`, `feed.current`, `feed.changes` in all five locales
- Modify: `scripts/generate_atom_feeds.py:409`, `:435`, `:456`, `:513`, `:521-522`
- Test: `tests/page-runtime.test.mjs`, `tests/test_atom_feeds.py`

**Interfaces:**
- Consumes: nothing.
- Produces: the exact strings `GITHUB INSIGHT`, `GITHUB INSIGHT — Current repositories`, `GITHUB INSIGHT — New and re-entered repositories` (em dash U+2014, surrounded by single spaces), used by Task 13's README.

**Do not** edit `feed.xml` or `changes.xml`. The next W1 refresh regenerates them; `validate_atom_publication` then compares the new literals against freshly generated documents.

- [ ] **Step 1: Write the failing tests**

Replace the body of `tests/page-runtime.test.mjs` "the page head advertises both exact Atom subscription endpoints":

```js
  const alternates = [...page.matchAll(/<link rel="alternate" type="application\/atom\+xml" title="([^"]+)" href="([^"]+)">/g)];
  assert.deepEqual(alternates.map(match => match.slice(1)), [
    ["GITHUB INSIGHT — Current repositories", "https://nowwcastle-sudo.github.io/github-trending-daily/feed.xml"],
    ["GITHUB INSIGHT — New and re-entered repositories", "https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml"],
  ]);
  assert.match(page, /<title>GITHUB INSIGHT<\/title>/);
  assert.match(page, /<h1><button class="title-reset" id="resetBtn"[^>]*>GITHUB INSIGHT<\/button><\/h1>/);
  assert.doesNotMatch(pageRuntime, /GitHub Trending Daily/);
```

Add to `tests/site-i18n.test.mjs`:

```js
test("the product name is GITHUB INSIGHT in every locale", () => {
  const i18n = load();
  for (const locale of i18n.SUPPORTED_LOCALES) {
    assert.equal(i18n.MESSAGES[locale]["document.title"], "GITHUB INSIGHT", locale);
    assert.equal(i18n.MESSAGES[locale]["feed.current"], "GITHUB INSIGHT — Current repositories", locale);
    assert.equal(i18n.MESSAGES[locale]["feed.changes"], "GITHUB INSIGHT — New and re-entered repositories", locale);
  }
});
```

Add to `tests/test_atom_feeds.py`:

```python
    def test_feed_documents_carry_the_github_insight_name(self):
        source = (Path(__file__).resolve().parents[1] / "scripts" / "generate_atom_feeds.py").read_text(encoding="utf-8")
        self.assertIn('"GITHUB INSIGHT — Current repositories"', source)
        self.assertIn('"GITHUB INSIGHT — New and re-entered repositories"', source)
        self.assertIn('"GITHUB INSIGHT"', source)
        self.assertNotIn("GitHub Trending Daily", source)
        self.assertNotIn("현재 전체", source)
        self.assertNotIn("신규·재진입", source)
```

Then update every existing literal assertion in `tests/test_atom_feeds.py` that names `GitHub Trending Daily`, `GitHub Trending Daily — 현재 전체`, or `GitHub Trending Daily — 신규·재진입` to the new strings. Locate them with:

```powershell
Select-String -Path tests/test_atom_feeds.py -Pattern 'GitHub Trending Daily|현재 전체|신규·재진입' | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

Enumerate the changed line numbers in the commit message.

- [ ] **Step 2: Run the tests and see them fail**

```powershell
node --test --test-name-pattern="page head advertises both exact Atom|product name is GITHUB INSIGHT" tests/page-runtime.test.mjs tests/site-i18n.test.mjs
python -m unittest tests.test_atom_feeds -v
```

Expected: the page test fails on `deepEqual` (`'GitHub Trending Daily — Current repositories' !== 'GITHUB INSIGHT — Current repositories'`); the i18n test fails with `'GitHub Trending — Insight Dashboard' !== 'GITHUB INSIGHT'`; the Python test fails with `AssertionError: '"GITHUB INSIGHT — Current repositories"' not found in ...`.

- [ ] **Step 3: Apply the renames**

Change the six string sites in `index.html` and `site-i18n.js` and the six in `scripts/generate_atom_feeds.py` per spec §7.1. In particular:

```python
FEED_TITLE_CURRENT = "GITHUB INSIGHT — Current repositories"
FEED_TITLE_CHANGES = "GITHUB INSIGHT — New and re-entered repositories"
FEED_AUTHOR_NAME = "GITHUB INSIGHT"
```

and use those constants at `_feed`'s author (`_child(author, "name", FEED_AUTHOR_NAME)`), at `_current_document` / `_changes_document`'s `_feed(...)` title argument, at `_validate_header`'s author comparison, and at both `_validate_documents` title arguments — so the generator and validator can never drift apart.

- [ ] **Step 4: Run the tests and see them pass**

```powershell
node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs
python -m unittest tests.test_atom_feeds -v
```

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

Change `FEED_TITLE_CURRENT` to `"GITHUB INSIGHT - Current repositories"` (hyphen instead of em dash) → the new Python test fails on `assertIn`. Change `<title>` back to `GitHub Trending` → the page test fails on the `<title>` regex. Revert both; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add index.html site-i18n.js scripts/generate_atom_feeds.py tests/page-runtime.test.mjs tests/site-i18n.test.mjs tests/test_atom_feeds.py
git commit -m "feat: rename the product to GITHUB INSIGHT across the page, locales and Atom feeds

Feed titles unify on English, resolving the previous EN page / KO feed mismatch, and move into three module constants shared by the generator and the validator. All URLs, feed ids and entry ids are unchanged; feed.xml and changes.xml are regenerated by the next refresh rather than hand-edited."
```

---

### Task 9: Held retry copy and star-history observation start

**Files:**
- Modify: `index.html:1008` (`tipHTML`)
- Modify: `star-history.js:141-147` (`historyHtml`)
- Test: `tests/page-runtime.test.mjs`, `tests/star-history.test.mjs`

**Interfaces:**
- Consumes: `tooltip.heldRetry` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

```js
test("a held repository tooltip states that a retry is scheduled", () => {
  const tip = page.match(/function tipHTML\(r,locale=resolveSummaryLocale\(r\)\)\{[\s\S]*?\n\}/)?.[0] ?? "";
  const held = tip.match(/if\(r\.summary_status==="held"\)return `[^`]*`/)?.[0] ?? "";
  assert.match(held, /tr\("tooltip\.held"\)/);
  assert.match(held, /tr\("tooltip\.heldRetry"\)/);
  assert.ok(held.indexOf('tr("tooltip.held")') < held.indexOf('tr("tooltip.heldRetry")'), "the retry note follows the held notice");
  assert.match(held, /class="thint tip-held-retry"/);
  assert.doesNotMatch(held, /new Date|toISOString|refreshAt/, "the retry note must not compute a time");
});
```

Add to `tests/star-history.test.mjs`:

```js
test("the explanation names the first observation time once observations exist", async () => {
  const StarHistory = await loadStarHistory();
  const entry = {
    slug: "owner/repo",
    anchors: [{ at: "2026-08-04T00:00:00Z", stars: 100, source: "github_trending_gain_monthly" }],
    observed: [
      { at: "2026-09-03T11:58:00Z", stars: 300, source: "github_rest" },
      { at: "2026-09-03T12:28:00Z", stars: 305, source: "github_rest" },
    ],
  };
  const html = StarHistory.historyHtml("owner/repo", entry);
  assert.match(html, /관측 시작 2026-09-03 11:58 UTC/);
  assert.equal([...html.matchAll(/관측 시작 2026-09-03/g)].length, 1);
  assert.match(html, /<svg/);

  const single = StarHistory.historyHtml("owner/repo", { slug: "owner/repo", anchors: [], observed: [entry.observed[0]] });
  assert.match(single, /관측 1회/);
  assert.match(single, /관측 시작 2026-09-03 11:58 UTC/);

  const anchorsOnly = StarHistory.historyHtml("owner/repo", {
    slug: "owner/repo",
    anchors: [
      { at: "2026-08-04T00:00:00Z", stars: 100, source: "github_trending_gain_monthly" },
      { at: "2026-08-27T00:00:00Z", stars: 200, source: "github_trending_gain_weekly" },
    ],
    observed: [],
  });
  assert.doesNotMatch(anchorsOnly, /관측 시작 2/, "anchors alone must not claim an observation start");

  assert.equal(StarHistory.historyHtml("owner/repo", { slug: "owner/repo", anchors: [], observed: [] }), '<p class="histnote">📈 관측 시작 대기</p>');
});
```

(`loadStarHistory` is the helper already used by the other tests in that file; reuse it verbatim.)

- [ ] **Step 2: Run the tests and see them fail**

```powershell
node --test --test-name-pattern="held repository tooltip states|explanation names the first observation time" tests/page-runtime.test.mjs tests/star-history.test.mjs
```

Expected: the tooltip test fails with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /tr\("tooltip\.heldRetry"\)/`; the star-history test fails with `The input did not match the regular expression /관측 시작 2026-09-03 11:58 UTC/`.

- [ ] **Step 3: Write the implementation**

`index.html:1008`:

```js
  if(r.summary_status==="held")return `${heading}${readme}<p class="tip-unavailable" role="status">${tr("tooltip.held")}</p><p class="thint tip-held-retry">${tr("tooltip.heldRetry")}</p>${actions}`;
```

`star-history.js`: add `const OBSERVED_SINCE_PREFIX = "관측 시작 ";` next to `EXPLANATION`, and replace `historyHtml` with the version in spec §7.3 verbatim (including the internal `observedStartLabel` helper, which is not exported).

- [ ] **Step 4: Run the tests and see them pass**

```powershell
node --test tests/page-runtime.test.mjs tests/star-history.test.mjs
```

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

1. Change `observedStartLabel` to use `points[0]` instead of the first `observed` point → the anchors-only assertion fails (`관측 시작 2026-08-04` appears).
2. Change `first.at.slice(11, 16)` to `slice(11, 19)` → the test fails on `/관측 시작 2026-09-03 11:58 UTC/` (it renders `11:58:00 UTC`).
3. Remove `tr("tooltip.heldRetry")` from `tipHTML` → the tooltip test fails.

Revert all three; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add index.html star-history.js tests/page-runtime.test.mjs tests/star-history.test.mjs
git commit -m "feat: tell held repositories a retry is scheduled and name the first observation time on the sparkline

The retry note states the cadence rather than a computed instant, because the refresh schedule is currently held. The observation start is read as a substring of the ledger timestamp, so the rendered UTC value is exactly what was recorded; anchor-only entries keep their existing copy."
```

---

### Task 10: Mark held repositories in the Atom feed

**Files:**
- Modify: `scripts/generate_atom_feeds.py:421-427` (`_current_summary`)
- Test: `tests/test_atom_feeds.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the constant `HELD_SUMMARY_PREFIX = "[요약 검증 중] "` (note the trailing space).

`_current_summary` is used by both `_current_document` (generation) and `_validate_documents` (validation), so prefixing there keeps them consistent by construction. Entry `title`, `id`, `updated`, and `link` are untouched.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_atom_feeds.py`:

```python
    def test_held_repositories_are_marked_in_the_current_feed_summary(self):
        from scripts.generate_atom_feeds import HELD_SUMMARY_PREFIX, _current_summary

        self.assertEqual(HELD_SUMMARY_PREFIX, "[요약 검증 중] ")
        held_with_description = {"summary_status": "held", "description": "  A held project  ", "name": "owner/repo", "summary": None}
        held_without_description = {"summary_status": "held", "description": "", "name": "owner/repo", "summary": None}
        verified = {"summary_status": "verified", "description": "A verified project", "name": "owner/repo", "summary": {"goal": "goal"}}
        verified_without_description = {"summary_status": "verified", "description": "", "name": "owner/repo", "summary": {"goal": "goal text"}}

        self.assertEqual(_current_summary(held_with_description), "[요약 검증 중] A held project")
        self.assertEqual(_current_summary(held_without_description), "[요약 검증 중] owner/repo")
        self.assertEqual(_current_summary(verified), "A verified project")
        self.assertEqual(_current_summary(verified_without_description), "goal text")
```

Then find the existing end-to-end feed fixture test that asserts entry summaries and add a `held` repository to its `latest["repos"]` fixture plus a matching `timeline["current"]` member, asserting that the generated `feed.xml` entry summary starts with the prefix and that `validate_atom_publication` accepts the document it just generated. Locate the fixture with:

```powershell
Select-String -Path tests/test_atom_feeds.py -Pattern 'summary_status|def test_' | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

- [ ] **Step 2: Run the test and see it fail**

```powershell
python -m unittest tests.test_atom_feeds -v
```

Expected: `ImportError: cannot import name 'HELD_SUMMARY_PREFIX' from 'scripts.generate_atom_feeds'`.

- [ ] **Step 3: Write the implementation**

```python
HELD_SUMMARY_PREFIX = "[요약 검증 중] "


def _current_summary(repository):
    prefix = HELD_SUMMARY_PREFIX if repository["summary_status"] == "held" else ""
    description = repository["description"].strip()
    if description:
        return f"{prefix}{description}"
    if repository["summary"] is None:
        return f"{prefix}{repository['name']}"
    return f"{prefix}{repository['summary']['goal']}"
```

Place `HELD_SUMMARY_PREFIX` next to the other module constants near `_SUMMARY_STATUSES` (line 51).

- [ ] **Step 4: Run the test and see it pass**

```powershell
python -m unittest tests.test_atom_feeds -v
```

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

Apply the prefix inside `_current_document` instead of `_current_summary` → the round-trip fixture test fails, because `_validate_documents` compares the generated summary against an unprefixed `_current_summary(repository)`. Then drop the trailing space from the constant → the unit test fails on `'[요약 검증 중]A held project' != '[요약 검증 중] A held project'`. Revert both; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add scripts/generate_atom_feeds.py tests/test_atom_feeds.py
git commit -m "feat: prefix held repository summaries in the current Atom feed

The prefix goes in _current_summary, the single function shared by the document generator and the header/entry validator, so generation and validation cannot drift. Entry titles, ids, updated timestamps and links are unchanged."
```

---

### Task 11: Content-Security-Policy meta and origin test

**Files:**
- Modify: `index.html` — insert one `<meta http-equiv="Content-Security-Policy">` after line 5
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: `pageRuntime` / `runtimeRegion` (Task 1).
- Produces: nothing consumed by later tasks.

**Read spec §8 in full before starting.** The inventory there was measured from source, not assumed, and it corrects six errors in the brief's draft policy. Use the inventory.

**Decision gate.** `readme-markdown.js:37-43` returns any absolute `https:` URL from a README as `external: true`, and line 84 emits it as `<img src>`. A narrow `img-src` allowlist silently breaks README badges. The policy below takes option A from spec §8.4 (`img-src 'self' data: https:`). **If browser verification later shows a runtime path that a `*`-free policy cannot express, stop and report — do not widen any other directive.** Neither `*` nor `'unsafe-eval'` appears in this policy; `'unsafe-inline'` (script) and `'wasm-unsafe-eval'` are recorded weakenings with the reasons in spec §8.4.

- [ ] **Step 1: Write the failing test**

```js
test("the page declares a Content-Security-Policy that covers every origin the code actually uses", async () => {
  const meta = page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] ?? "";
  assert.ok(meta.length > 0, "the CSP meta must exist");
  assert.ok(page.indexOf('http-equiv="Content-Security-Policy"') < page.indexOf("<style>"), "the policy must precede every style and script");

  const policy = Object.fromEntries(meta.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const [directive, ...values] = part.split(/\s+/);
    return [directive, values];
  }));
  assert.deepEqual(Object.keys(policy), [
    "default-src", "script-src", "style-src", "img-src", "font-src",
    "connect-src", "frame-src", "object-src", "base-uri", "form-action",
  ]);
  assert.deepEqual(policy["default-src"], ["'self'"]);
  assert.deepEqual(policy["script-src"], ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://www.gstatic.com", "https://www.google.com"]);
  assert.deepEqual(policy["style-src"], ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(policy["img-src"], ["'self'", "data:", "https:"]);
  assert.deepEqual(policy["font-src"], ["'self'"]);
  assert.deepEqual(policy["connect-src"], [
    "'self'", "https://api.github.com", "https://firestore.googleapis.com",
    "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com",
    "https://content-firebaseappcheck.googleapis.com", "https://www.google.com",
  ]);
  assert.deepEqual(policy["frame-src"], [
    "https://github-trending-nowwcastle.firebaseapp.com", "https://www.google.com", "https://accounts.google.com",
  ]);
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.deepEqual(policy["base-uri"], ["'self'"]);
  assert.deepEqual(policy["form-action"], ["'self'"]);
  assert.doesNotMatch(meta, /'unsafe-eval'/);
  assert.doesNotMatch(meta, /(^|\s)\*(\s|;|$)/);

  const sources = await Promise.all([
    "../firebase-client.js", "../auth-lifecycle.js", "../favorite-sync.js",
    "../readme-markdown.js", "../star-history.js", "../current-view-export.js",
  ].map(name => readFile(new URL(name, import.meta.url), "utf8")));
  const allowed = new Set(Object.values(policy).flat());
  const scanned = [pageRuntime, ...sources].join("\n");
  const hosts = new Set([...scanned.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map(match => match[1].toLowerCase()));
  const imageOnly = new Set(["raw.githubusercontent.com", "camo.githubusercontent.com"]);
  const documentOnly = new Set(["github.com", "nowwcastle-sudo.github.io", "www.w3.org"]);
  for (const host of hosts) {
    if (documentOnly.has(host) || imageOnly.has(host)) continue;
    assert.ok(allowed.has(`https://${host}`), `${host} is used by the code but no CSP directive allows it`);
  }
  assert.ok(hosts.has("www.gstatic.com"), "the scan must actually see the Firebase module host");
  assert.ok(hosts.has("api.github.com"), "the scan must actually see the GitHub API host");
});
```

`documentOnly` holds hosts that only ever appear as `<a href>` or as an XML namespace, which no fetching directive governs. `imageOnly` holds README image hosts covered by `img-src https:`. Both sets are explicit so a new host cannot slip through unnoticed — an unlisted host makes the loop fail.

- [ ] **Step 2: Run the test and see it fail**

```powershell
node --test --test-name-pattern="declares a Content-Security-Policy" tests/page-runtime.test.mjs
```

Expected: FAIL — `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert.ok(meta.length > 0, "the CSP meta must exist")`.

- [ ] **Step 3: Write the implementation**

Insert immediately after `<meta name="viewport" content="width=device-width,initial-scale=1">` (index.html:5), as **one line**:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.gstatic.com https://www.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://api.github.com https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://content-firebaseappcheck.googleapis.com https://www.google.com; frame-src https://github-trending-nowwcastle.firebaseapp.com https://www.google.com https://accounts.google.com; object-src 'none'; base-uri 'self'; form-action 'self'">
```

- [ ] **Step 4: Run the test and see it pass**

```powershell
node --test tests/page-runtime.test.mjs
```

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

1. Remove `https://www.gstatic.com` from `script-src` → the test fails with `www.gstatic.com is used by the code but no CSP directive allows it`.
2. Change `img-src 'self' data: https:` to `img-src *` → the test fails on the bare-`*` assertion.
3. Add `'unsafe-eval'` to `script-src` → the test fails on `assert.doesNotMatch(meta, /'unsafe-eval'/)`.

Revert all three; re-run and confirm PASS.

- [ ] **Step 7: Record the runtime verification obligation in the commit**

The `'wasm-unsafe-eval'` token is included defensively for reCAPTCHA Enterprise's WebAssembly module and is marked `[verify]` in spec §8.1. It is confirmed or removed at spec §10 step 6 (production browser verification), not now — the policy is untestable against a real Firebase session in `node:test`.

- [ ] **Step 8: Commit**

```powershell
git add index.html tests/page-runtime.test.mjs
git commit -m "feat: declare a Content-Security-Policy built from a measured origin inventory

Origins were read from firebase-client.js, readme-markdown.js and the runtime script region rather than assumed; the brief's draft policy listed apis.google.com, firebaseio.com wildcards and GitHub avatar hosts that this page never contacts, and omitted www.google.com which reCAPTCHA Enterprise needs in script-src, connect-src and frame-src. The test fails if code later introduces a host no directive allows.

Two recorded weakenings, neither of them '*' or 'unsafe-eval': script-src 'unsafe-inline' is unavoidable because the largest inline script embeds the regenerated REPOS blob on a statically hosted page, and img-src allows any https origin because README markdown can reference badge images from arbitrary hosts. 'wasm-unsafe-eval' is provisional pending production console verification."
```

---

### Task 12: CI workflow that runs the suite

**Files:**
- Create: `.github/workflows/tests.yml`
- Create: `tests/tests-workflow.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/tests-workflow.test.mjs`, following the shape of `tests/codeql-workflow.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the test workflow runs the full suite on pull requests and main with pinned least privilege", async () => {
  const workflow = (await readFile(".github/workflows/tests.yml", "utf8")).replace(/\r\n/g, "\n");
  assert.match(workflow, /^name: Tests$/m);
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /^permissions:\n\s+contents: read$/m);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /concurrency:/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /timeout-minutes: 15/);

  const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(match => match[1]);
  assert.deepEqual(actions, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
  ]);
  assert.ok(actions.every(action => /@[a-f0-9]{40}$/.test(action)));
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /python-version: "3\.13"/);

  const runs = [...workflow.matchAll(/run: (npm .+)/g)].map(match => match[1]);
  assert.deepEqual(runs, ["npm ci", "npm test"]);
  assert.doesNotMatch(workflow, /test:rules/, "the Firestore rules suite needs the emulator and stays out of CI");
});
```

- [ ] **Step 2: Run the test and see it fail**

```powershell
node --test tests/tests-workflow.test.mjs
```

Expected: FAIL — `Error: ENOENT: no such file or directory, open '.github/workflows/tests.yml'`.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/tests.yml` (LF line endings — `.gitattributes` already enforces `.github/workflows/*.yml text eol=lf`):

```yaml
name: Tests

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.13"
      - name: Install dependencies
        run: npm ci
      - name: Run the test suite
        run: npm test
```

No `concurrency` block: this workflow must never queue behind the `daily-refresh` or `pages` groups.

- [ ] **Step 4: Run the test and see it pass**

```powershell
node --test tests/tests-workflow.test.mjs
```

- [ ] **Step 5: Full regression**

```powershell
npm test
```

- [ ] **Step 6: Mutation check**

1. Change `node-version: "24"` to `"22"` → the test fails on the version regex.
2. Add `concurrency:\n  group: pages` → the test fails on `assert.doesNotMatch(workflow, /concurrency:/)`.
3. Change `run: npm test` to `run: npm run test:all` → the test fails on both the `runs` `deepEqual` and the `test:rules` guard (via `package.json`'s `test:all` — if that indirection hides it, the `runs` `deepEqual` still fails).

Revert all three; re-run and confirm PASS.

- [ ] **Step 7: Commit**

```powershell
git add .github/workflows/tests.yml tests/tests-workflow.test.mjs
git commit -m "ci: run npm ci and npm test on pull requests and pushes to main

Action SHAs match deploy-current-pages.yml, permissions are contents: read, no secrets are used, and there is no concurrency group so the suite never queues behind the refresh or pages deployments. npm run test:rules stays out because it needs the Firebase emulator."
```

---

### Task 13: README rewrite — SEPARATE FINAL PULL REQUEST

> **This task is the brief's item 12 and is NOT part of the branch above.** Open it only after Tasks 1-12 have merged, W1 has published, and production browser verification (spec §10 step 6) has passed. It gets its own branch and its own PR.

**Files:**
- Modify: `README.md`, `README.ko.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml`
- Test: `tests/site-i18n.test.mjs` (the "repository documentation is English-first with a complete Korean counterpart" test), plus a new issue-template structural test

**Interfaces:**
- Consumes: the exact product strings from Task 8; the group names, filter-bar controls, and shortcut keys from Tasks 4, 6 and 7.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Update `tests/site-i18n.test.mjs` "repository documentation is English-first with a complete Korean counterpart":

```js
  assert.match(readme, /^# GITHUB INSIGHT\r?\n\r?\n\[한국어\]\(README\.ko\.md\)/);
  assert.match(koreanReadme, /^# GITHUB INSIGHT\r?\n\r?\n\[English\]\(README\.md\)/);
  assert.match(readme, /candidate-desktop-1440\.png/);
  assert.match(readme, /candidate-mobile-sidebar-390\.png/);
  assert.match(readme, /README variants from upstream only/);
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
```

New `tests/issue-templates.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("feature requests have a template and blank issues are disabled", async () => {
  const config = (await readFile(".github/ISSUE_TEMPLATE/config.yml", "utf8")).replace(/\r\n/g, "\n");
  assert.match(config, /^blank_issues_enabled: false$/m);

  const template = (await readFile(".github/ISSUE_TEMPLATE/feature_request.yml", "utf8")).replace(/\r\n/g, "\n");
  assert.match(template, /^name: Feature request$/m);
  assert.match(template, /^description: .+$/m);
  assert.match(template, /^labels: \[enhancement\]$/m);
  assert.match(template, /^body:$/m);
  for (const id of ["problem", "proposal", "alternatives"]) {
    assert.match(template, new RegExp(`id: ${id}\\n`), `${id} field must exist`);
  }
  assert.match(template, /required: true/);
});
```

- [ ] **Step 2: Run the tests and see them fail**

```powershell
node --test --test-name-pattern="repository documentation is English-first" tests/site-i18n.test.mjs
node --test tests/issue-templates.test.mjs
```

Expected: the README test fails with `The input did not match the regular expression /^# GITHUB INSIGHT.../`; the template test fails with `Error: ENOENT: no such file or directory, open '.github/ISSUE_TEMPLATE/config.yml'`.

- [ ] **Step 3: Rewrite the READMEs**

Both files keep their existing structure (title, cross-language link, screenshots, sections) and gain or change:

- Title `# GITHUB INSIGHT` and the cross-language link line.
- **Repository-level admission:** a repository whose five-locale summary fails verification is published as `held` — the card shows a fixed localized "summary being verified" notice, retried at the next refresh (about every 2 hours), while every other repository publishes normally.
- **Star ticks:** exact star totals recorded by this site every 30 minutes into its own ledgers (`data/star-ticks/YYYY-MM.jsonl`, `data/star-daily.jsonl`), not third-party estimates. The Korean README must contain the exact sentence fragment `최초 관측 후 최소 1일이면 히스토리 확인 가능`.
- **Gain anchors:** dashed, hollow-marker points back-calculated from GitHub Trending period gains, drawn only where there is no observation.
- **Four rail groups:** Login, Explore, History, Export — what each contains.
- **Filter bar:** period, language, Exclude AI, New repositories only, Copy link — always visible under the badge guide.
- **Shortcuts:** `/` search, `e` Explore, `a` Login, `h` History, `x` Export, `Escape` close.
- **Advantages over other trending sites:** own measurements rather than estimates; five-locale verified summaries with README provenance; per-repository admission instead of all-or-nothing; Atom feeds; shareable URL state; CSV/JSON export.
- **`## Planned features`** (`## 예정된 기능`) listing the approved backlog.
- **`## Requesting a feature`** (`## 기능 요청`) pointing at the new issue template.

Keep every existing assertion target: `candidate-desktop-1440.png`, `candidate-mobile-sidebar-390.png`, `README variants from upstream only`, `상류 저장소 README 언어판만 표시`. Do not touch `README.en.md`.

- [ ] **Step 4: Write the issue templates**

`.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: false
```

`.github/ISSUE_TEMPLATE/feature_request.yml`:

```yaml
name: Feature request
description: Suggest a capability for GITHUB INSIGHT
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem are you hitting?
      description: What are you trying to do, and where does the current dashboard get in the way?
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: What would you like it to do instead?
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: What have you tried or considered?
    validations:
      required: false
```

- [ ] **Step 5: Run the tests and see them pass**

```powershell
node --test tests/site-i18n.test.mjs tests/issue-templates.test.mjs
```

- [ ] **Step 6: Full regression**

```powershell
npm test
```

- [ ] **Step 7: Mutation check**

Delete the `최초 관측 후 최소 1일이면 히스토리 확인 가능` sentence from `README.ko.md` → the documentation test fails on that regex. Change `blank_issues_enabled: false` to `true` → the template test fails. Revert both; re-run and confirm PASS.

- [ ] **Step 8: Commit**

```powershell
git add README.md README.ko.md .github/ISSUE_TEMPLATE/feature_request.yml .github/ISSUE_TEMPLATE/config.yml tests/site-i18n.test.mjs tests/issue-templates.test.mjs
git commit -m "docs: rewrite the READMEs for GITHUB INSIGHT and add a feature-request channel

Documents repository-level held admission, 30-minute star ticks into the site's own ledgers, gain anchors, the four rail groups, the filter bar, the keyboard shortcuts, the advantages over other trending sites, and a planned-features list. Blank issues are disabled in favour of a structured feature-request form."
```

---

## Self-Review

**1. Spec coverage.** Every brief item maps to a task:

| Brief item | Task |
|---|---|
| 1 Rail with four buttons, one panel, four groups | 2 (vocabulary), 4 (markup + runtime) |
| 2 Hover close grace of 500 ms | 2 (constant), 5 (behaviour) |
| 3 Filter bar | 6 |
| 4 Title rename to GITHUB INSIGHT | 8 |
| 5 Held repository copy | 3 (key), 9 (render) |
| 6 Star-history note | 9 |
| 7 Atom feed held status | 10 |
| 8 CSP meta | 11 |
| 9 Keyboard shortcuts | 3 (title keys), 7 (behaviour) |
| 10 CI test workflow | 12 |
| 11 Fix the tests failing on main | 1 |
| 12 README (last, separate PR) | 13 |

No brief requirement is uncovered.

**2. Deviations from the brief, and why.** Each is a deliberate correction, not an omission:

- **Five tests fail on main, not four.** The fifth (`tests/star-ticks-workflow.test.mjs` "the tick ledgers start empty and tracked") is a stale-CRLF working-copy artifact, not a repository defect — `git ls-files --eol` reports `i/lf w/crlf` against a `.gitattributes` rule already on main. It is repaired in Task 0 with no commit. Task 1 Step 1 pins the expected failure list so this cannot be silently confused with a code defect.
- **The brief's CSP draft is replaced by a measured inventory.** Six concrete errors are listed in spec §8.2. The `img-src` weakening to `https:` is surfaced as an explicit decision (spec §8.4) with two alternatives, because `readme-markdown.js` deliberately allows arbitrary external image origins. Nothing requires `*` or `'unsafe-eval'`; `'unsafe-inline'` and `'wasm-unsafe-eval'` are recorded weakenings with reasons.
- **History group DOM order is unchanged** (`hiddenRepoSection` before `recentExitsSection`). The brief listed the group members in the opposite order; that reads as enumeration, and reordering them is an unrequested change. Recorded in spec §4.3.
- **`setSidebarTriggerState(label, expanded)` becomes `setSidebarExpandedState(expanded)`.** With four buttons, one shared aria-label is wrong; each button gets a static per-group label and `aria-expanded` alone carries state. Consequence: `nav.close`, `nav.pin`, and (after Task 6) `period.title` become unused keys. They are **retained** rather than deleted, so the i18n parity invariant is untouched and the diff stays minimal. Recorded in spec §4.5.
- **The group switcher is `role="group"` with `aria-pressed`, not a tablist.** The brief allowed either; this reuses the `.seg` + `aria-pressed` idiom already used by `#periodSeg` and `#viewSection`, avoids roving `tabindex`, and keeps every button reachable inside the focus trap.
- **Filter-bar row 2 uses `calc((100% - 32px)/3)`.** The brief pinned row 1's `calc(50% - 8px)` and left row 2 to "the simplest layout that keeps the sum ≤ card width"; a division is exact where `33.333% - 10.667px` is not.
- **The filter-bar copy link writes to its own `#filterBarStatus`,** because `#exportStatus` lives in the export group and is `hidden` unless that group is showing. The i18n keys and the clipboard helper are reused exactly as the brief asked.
- **`#emptyManageHiddenBtn` now opens the `history` group explicitly** (Task 4 Step 6). Without it the button would focus `.hidden-restore` inside a `hidden` section. The brief did not name this call site; leaving it alone would have shipped a broken path.

**3. Nothing the brief forbids is changed.** No new dependency; `repo-filters.js` is never edited and a round-trip test guards `parseState`/`serializeState`; `scripts/generate_atom_feeds.py` is the only script touched; `.github/workflows/tests.yml` is the only new workflow; `feed.xml`, `changes.xml`, `star-history.json`, and `data/**` are never edited; the generated `REPOS` span is never edited; repository name and every URL, feed id, and entry id are unchanged; all six pinned design tokens are asserted intact in Task 4.

**4. Type and name consistency across tasks.** `resolveSidebarGroup` and `SIDEBAR_HOVER_CLOSE_DELAY_MS` (Task 2) are consumed under those exact names in Tasks 4, 5 and 7. `setSidebarGroup`, `openSidebar(mode, trigger, group)`, `railToggles`, `navRail`, `sidebarGroupSeg`, `mobileNavToggle`, `sidebarMobileAccessMedia` (Task 4) are consumed under those exact names in Tasks 5, 6 and 7. `runtimeRegion` / `pageRuntime` (Task 1) are consumed in Tasks 6, 8 and 11. The three product strings (Task 8) are consumed in Task 13. `closeHoverSidebarNow` and `closeHoverSidebarIfOutside` are introduced in Task 5 and the `focusout` registrations added in Task 4 are explicitly re-pointed there.

**5. Green-at-every-boundary check.** Task 1 greens the baseline first. Task 4 keeps `#periodSection` / `#languageSection` in the panel (tagged `data-group="explore"`) so the section-order test still passes; Task 6 removes them and updates that test in the same commit. Task 5 changes `focusout` registrations that Task 4 created, so the two tasks must run in order. No task leaves a test referring to markup that does not yet exist.
