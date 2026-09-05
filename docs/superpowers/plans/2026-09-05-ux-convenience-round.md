# UX and Convenience Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the thirteen usability, accessibility and convenience findings from the two 2026-09-05 review reports on the static GITHUB INSIGHT page — mobile above-the-fold, a sticky filter result count, discoverable Atom feeds, a keyboard-help dialog with a WCAG 2.1.4 opt-out, one navigation system per viewport, six accessibility defects, mobile tap targets and History empty states, head metadata, and four new convenience features (new-since-last-visit, compact list, filter presets, favourites export hint).

**Architecture:** The page stays one self-contained `index.html` (CSS block, markup, one classic inline script) plus sibling IIFE modules loaded with plain `<script src>`. Two new pure modules are added — `visit-tracker.js` and `filter-presets.js` — each following the exact `favorites.js` / `hidden-repos.js` shape (UMD-ish IIFE, slug regex, hard caps, every storage read wrapped in `try/catch`), each with its own unit-test file. Every other change edits the existing CSS block, the existing markup, the existing inline script, and the existing `site-i18n.js` message bundle. No framework, no build step, no new dependency, no new network request.

**Tech Stack:** Vanilla ES2022 in `index.html` + IIFE modules (`site-i18n.js`, `repo-filters.js`, `favorites.js`, `hidden-repos.js`, `ui-motion.js`, `current-view-export.js`, `star-history.js`, and the two new modules), Node 24 `node:test`, `python -m unittest`. No dependencies added.

**Spec:** the two review reports this plan argues from —
`C:\Users\nasca\AppData\Local\Temp\claude\D--\09e793fc-4e9c-42aa-a773-3c6e26f46ccd\scratchpad\ux-review\assessment-a.md` (design review: Nielsen scoring, Krug trunk test, cognitive load, eight priority issues, convenience-feature candidates) and
`...\ux-review\assessment-b.md` (deterministic detector + WCAG 2.2 AA audit + Lighthouse + computed contrast ratios).
Executors read both alongside this plan.

## Global Constraints

- **Branch:** `feat/ux-round-20260905`, already created from `origin/main` by the orchestrating agent. Task implementers **do not** run `git checkout`, `git switch`, `git push`, `git merge`, or `git rebase`. Each task ends with `git add` + `git commit` only.
- **Shell:** run every command in **PowerShell**, not Git Bash. Git Bash makes two `tests/pages-publication.test.mjs` cases fail spuriously.
- **Full regression after every task:** `npm test` (which is `node --test && python -m unittest discover -s tests -p "test_*.py"`). Baseline on `origin/main` at commit `f6189e6`: node reports `ℹ tests 696 / ℹ pass 684 / ℹ fail 0 / ℹ skipped 12`; Python reports `Ran 165 tests` / `OK`. Counts grow as tasks add tests; `fail` must stay `0`.
- **CSP is frozen.** The `<meta http-equiv="Content-Security-Policy">` at `index.html:6` must not be loosened, reordered, or moved. No inline `on*=` handlers, no `javascript:` URLs, no `eval`.
- **No new external requests.** No fonts, no CDN, no image host, no analytics, no `og:image` pointing at a third party. Everything ships from this origin or is drawn in CSS/Unicode.
- **i18n:** every new user-visible string is a message key added to **all five locales** in `site-i18n.js` — `en`, `ko`, `zh-CN`, `es`, `ja` — using the existing dotted key naming (`group.name`). `tests/site-i18n.test.mjs` compares the five key sets exactly, so a key missing from one locale fails the suite.
- **Storage keys are namespaced `gi.`** for everything this plan adds: `gi.shortcuts.disabled`, `gi.visit.lastAt`, `gi.visit.seen`, `gi.view.compact`, `gi.presets`. Pre-existing keys (`gh-theme`, `gh-favs`, `gh-favs-guest`, `gh-hidden-repos-v1`, `github-trending-site-locale-v1`) are **not** renamed.
- **Every storage read and every storage write is wrapped in `try/catch`.** A browser with storage disabled must still render the list. Follow the `Favorites.readFavs` pattern: `try { … } catch { return <safe default> }`.
- **Never hand-edit generated regions:** `index.html` between `<!-- GENERATED:TRENDING-DATE:START -->` and `:END`, and between `// GENERATED:TRENDING-REPOS:START` and `:END`. Also never edit `feed.xml`, `changes.xml`, `star-history.json`, `data/**`.
- **`index.html` stays self-contained** — one `<style>` block in `<head>`, one classic inline `<script>` plus the existing `type="module"` tail; no external stylesheet, no bundler.
- **CRLF line endings** everywhere (`.gitattributes` pins LF only for the listed workflow/data files). Do not normalise `index.html` or the `.js` files to LF.
- **Commit message style:** English, `feat:` for new capability, `fix:` for corrected behaviour, `a11y:` for accessibility corrections, `docs:` for documentation. One commit per task.
- **Screenshots are out of scope.** `docs/screenshots/*.png` are captured from production after deploy and must not be regenerated or edited by this plan.
- **Design tokens that must survive every task:** `--sidebar-open-duration:260ms`, `--sidebar-close-duration:210ms`, `--sidebar-width:min(360px,calc(100vw - 44px))`, focus ring `outline:3px solid var(--accent);outline-offset:2px`, 44px minimum touch target on every control.
- **Mobile breakpoint** for this plan is `@media(max-width:560px)` — the block at `index.html:400-412` that already re-lays `.signal-guide`. Do not invent a new breakpoint.
- **RED first.** Write the failing test, run it, see the stated failure message, then implement, then re-run to GREEN, then run `npm test`, then commit.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `index.html` | `<head>` gains description/OG/theme-color metadata. CSS gains the `<details>` badge-guide rules, the mobile toggle-scroll row, sticky `#resultSection`, the shortcut-help dialog, `.skip-link`, `.list-heading`, `.visit-new`, `body.compact`, `.preset-*`, `.noscript-note`, and the 76px rail; it retargets four light-theme `--accent` text uses to `--accent-selected`. Markup gains the skip link, `<details>` around the badge guide, two footer feed links, the rail help button, the shortcut dialog, the list heading, the compact toggle, the preset section, the favourites-export row, and `<noscript>`. Runtime gains the shortcut dialog + opt-out, group-switcher visibility, the visit diff, compact persistence, and preset handlers. |
| `site-i18n.js` | Gains 39 message keys × 5 locales; changes 3 existing keys (`nav.ariaAccount`, `repo.favoriteAdd`, `repo.favoriteRemove`). |
| `visit-tracker.js` | **New.** Pure module: last-visit timestamp + seen-slug set in `localStorage`, capped at 1000 slugs, and the new-since-last-visit diff. No DOM. |
| `filter-presets.js` | **New.** Pure module: named presets (`{name, query}`) in `localStorage`, max 20, name ≤ 40 chars, query = the string `RepoFilters.serializeState` returns. No DOM. |
| `tests/page-runtime.test.mjs` | Extends the fake-DOM harnesses (`sidebarHarness`, `hiddenSectionsGroupHarness`) and adds structural tests for every `index.html` change. |
| `tests/site-i18n.test.mjs` | Gains assertions for the new keys and the Label-in-Name rule. |
| `tests/visit-tracker.test.mjs` | **New.** Unit tests for `visit-tracker.js`. |
| `tests/filter-presets.test.mjs` | **New.** Unit tests for `filter-presets.js`. |
| `README.md`, `README.ko.md` | **Task 13 only.** Four feature bullets each. |

**Model recommendation per task** (the orchestrating agent dispatches accordingly):

| Task | Model | Why |
|---|---|---|
| 1 Mobile above-the-fold | sonnet | Two CSS blocks and one markup wrap |
| 2 Sticky result section | sonnet | One CSS rule plus one custom property |
| 3 Footer feed links | sonnet | Two anchors, three message keys |
| 4 Keyboard help dialog | **opus** | Dialog focus/inert state machine + shortcut suppression |
| 5 Group-switcher visibility | **opus** | Touches focus-trap membership |
| 6 Accessibility fixes | **opus** | Six coupled changes across markup, runtime, i18n and tests |
| 7 Tap targets, empty states, rail width | sonnet | CSS tokens plus two small render branches |
| 8 Head metadata | sonnet | Static tags |
| 9 New since last visit | **opus** | New module + render integration + locale re-render |
| 10 Compact list mode | sonnet | CSS class plus one persisted toggle |
| 11 Filter presets | **opus** | New module + a new sidebar section inside the focus trap |
| 12 Export favourites hint | sonnet | One paragraph, one button, two keys |
| 13 README feature list | sonnet | Eight bullets |

---

### Task 1: Mobile above-the-fold — collapsible badge guide and a one-row toggle scroller

**Problem (Assessment A, Priority 1, severity 3):** at 390×844 the first repository card starts at y=819. The always-expanded badge guide (`index.html:606-615`, 178px) plus the filter bar (322px) account for 500px of that. The page explains its notation before showing anything that uses it.

**Files:**
- Modify: `index.html:264-270` (`.signal-guide` rules), `index.html:400-412` (`@media(max-width:560px)` block), `index.html:606-615` (badge-guide markup), `index.html:628` (toggle row markup), and the inline script near `index.html:707` (one collapse line)
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the markup class `filter-toggle-row` on the third filter-bar row (`<div class="filter-bar-row filter-bar-row-3 filter-toggle-row">`), and the element id `badgeGuide` on the new `<details>`. Task 10 adds a fourth button to that same row and renames `filter-bar-row-3` → `filter-bar-row-4`; the `filter-toggle-row` class it styles must stay.

- [ ] **Step 1: Write the failing test**

Add to `tests/page-runtime.test.mjs`:

```js
test("the badge guide is a disclosure that starts open on desktop and closed on mobile", () => {
  const guide = page.match(/<aside class="signal-guide"[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.match(guide, /aria-label="Badge guide"/);
  assert.match(guide, /data-i18n-aria-label="badges\.aria"/);
  assert.match(guide, /<details class="signal-guide-details" id="badgeGuide" open>/);
  assert.match(guide, /<summary data-i18n="badges\.title">Badge guide<\/summary>/);
  assert.doesNotMatch(guide, /<strong data-i18n="badges\.title">/);
  for (const key of ["badges.streak", "badges.change", "badges.hot", "badges.newLabel", "badges.new", "badges.reenteredLabel", "badges.reentered"]) {
    assert.ok(guide.includes(`data-i18n="${key}"`), `${key} must survive the disclosure wrap`);
  }
  assert.match(page, /\.signal-guide summary\{[^}]*cursor:pointer/);
  assert.match(page, /const badgeGuideMedia=matchMedia\("\(max-width:560px\)"\);/);
  assert.match(page, /if\(badgeGuideMedia\.matches\)document\.getElementById\("badgeGuide"\)\.open=false;/);
});

test("the mobile filter toggles sit on one horizontally scrollable row", () => {
  assert.match(page, /<div class="filter-bar-row filter-bar-row-3 filter-toggle-row">/);
  const mobile = page.match(/@media\(max-width:560px\)\{[\s\S]*?\r?\n\}/)?.[0] ?? "";
  assert.match(mobile, /\.filter-toggle-row\{[^}]*flex-wrap:nowrap[^}]*overflow-x:auto/);
  assert.match(mobile, /\.filter-toggle-row>\*\{flex:0 0 auto;max-width:none\}/);
  assert.match(mobile, /\.signal-guide-details\[open\] dl\{margin-top:8px\}/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-runtime.test.mjs`
Expected: FAIL — `the badge guide is a disclosure…` fails at `assert.match(guide, /<details class="signal-guide-details" id="badgeGuide" open>/)` because the guide still contains `<strong data-i18n="badges.title">`.

- [ ] **Step 3: Write the implementation**

Replace `index.html:606-615` with:

```html
<aside class="signal-guide" aria-label="Badge guide" data-i18n-aria-label="badges.aria">
  <details class="signal-guide-details" id="badgeGuide" open>
    <summary data-i18n="badges.title">Badge guide</summary>
    <dl>
      <div><dt><span class="badge">🔥 N</span></dt><dd data-i18n="badges.streak">Observed on Trending on consecutive dates</dd></div>
      <div><dt><span class="rankchg">↑/↓ N</span></dt><dd data-i18n="badges.change">Change in total stars since the previous observation date</dd></div>
      <div><dt><span class="badge">HOT</span></dt><dd data-i18n="badges.hot">At least 1,000 stars gained in the selected period</dd></div>
      <div><dt><span class="badge membership-new" data-i18n="badges.newLabel">New</span></dt><dd data-i18n="badges.new">First observed after the baseline</dd></div>
      <div><dt><span class="badge membership-reentered" data-i18n="badges.reenteredLabel">Re-entered</span></dt><dd data-i18n="badges.reentered">Returned after leaving the previous list</dd></div>
    </dl>
  </details>
</aside>
```

Replace `index.html:266` (`.signal-guide>strong{…}`) with:

```css
.signal-guide-details{flex:1;min-width:0}
.signal-guide summary{display:inline-flex;align-items:center;gap:6px;min-height:32px;color:var(--text);font-size:12.5px;font-weight:650;cursor:pointer;list-style:none}
.signal-guide summary::-webkit-details-marker{display:none}
.signal-guide summary::after{content:"▾";font-size:10px;color:var(--text-3);transition:transform .16s ease}
.signal-guide-details[open]>summary::after{transform:rotate(180deg)}
.signal-guide summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:6px}
.signal-guide-details[open] dl{margin-top:8px}
```

Change `index.html:628` to:

```html
  <div class="filter-bar-row filter-bar-row-3 filter-toggle-row">
```

Inside the `@media(max-width:560px)` block at `index.html:400-412`, replace the line `.signal-guide>strong{display:block;margin-bottom:7px}` with the two toggle-row rules and keep the rest of the block unchanged:

```css
  .signal-guide{display:block;padding-top:8px}
  .signal-guide dl{display:grid;gap:7px}
  .filter-toggle-row{flex-wrap:nowrap;overflow-x:auto;overscroll-behavior-x:contain;gap:8px;padding-bottom:4px;scrollbar-width:none}
  .filter-toggle-row::-webkit-scrollbar{display:none}
  .filter-toggle-row>*{flex:0 0 auto;max-width:none}
```

In the inline script, immediately after the `const storage=localStorage;` line (`index.html:707`), add:

```js
/* The badge guide is notation for cards the phone viewport cannot show yet, so it ships open for
   desktop and no-JS readers and collapses once on load under the mobile breakpoint. The reader
   stays in control afterwards — no resize listener re-opens or re-closes it. */
const badgeGuideMedia=matchMedia("(max-width:560px)");
if(badgeGuideMedia.matches)document.getElementById("badgeGuide").open=false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-runtime.test.mjs`
Expected: PASS for both new tests, and the pre-existing `landmarks, form controls, and hidden panels retain accessible boundaries` test still passes (it matches the `<aside class="signal-guide"` opening tag, which is unchanged).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/page-runtime.test.mjs
git commit -m "feat: collapse the badge guide on mobile and scroll the filter toggles in one row"
```

---

### Task 2: Sticky result section in the Explore panel

**Problem (Assessment A, Priority 2, severity 3):** the Explore panel is 1.84 screens tall; `#filterSummary` — the only place the match count appears — sits at 1462px inside it and was measured off-screen while the reader works the field and form filters above.

**Files:**
- Modify: `index.html:11-13` (`:root` custom properties), `index.html:135-142` (`.filter-sidebar` padding), `index.html:213` (after `.filter-summary`, add the `#resultSection` rule)
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the custom property `--sidebar-pad-bottom:calc(20px + env(safe-area-inset-bottom))` on `:root`, used by `.filter-sidebar` and `#resultSection`. Task 11 inserts `#presetSection` **before** `#resultSection` so the sticky section stays last in the Explore group.

- [ ] **Step 1: Write the failing test**

Add to `tests/page-runtime.test.mjs`:

```js
test("the Explore result count and Clear button stay pinned to the bottom of the panel", () => {
  assert.match(page, /--sidebar-pad-bottom:calc\(20px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(page, /\.filter-sidebar\{[\s\S]*?padding:calc\(20px \+ env\(safe-area-inset-top\)\) 20px var\(--sidebar-pad-bottom\)/);
  const sticky = page.match(/#resultSection\{[^}]*\}/)?.[0] ?? "";
  assert.match(sticky, /position:sticky/);
  assert.match(sticky, /bottom:calc\(-1 \* var\(--sidebar-pad-bottom\)\)/);
  assert.match(sticky, /background:var\(--control-solid\)/);
  assert.match(sticky, /border-top:1px solid var\(--surface-border\)/);
  assert.match(sticky, /padding-bottom:var\(--sidebar-pad-bottom\)/);
  assert.match(sticky, /margin-bottom:calc\(-1 \* var\(--sidebar-pad-bottom\)\)/);
  // #filterSummary already carries role="status" aria-live="polite"; this fix is visual only.
  assert.match(page, /id="filterSummary" role="status" aria-live="polite"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-runtime.test.mjs`
Expected: FAIL at `assert.match(page, /--sidebar-pad-bottom:calc\(20px \+ env\(safe-area-inset-bottom\)\);/)` — the property does not exist.

- [ ] **Step 3: Write the implementation**

In `:root` (`index.html:11-13`), add the property right after the `--sidebar-width` line:

```css
  --sidebar-pad-bottom:calc(20px + env(safe-area-inset-bottom));
```

In `.filter-sidebar` (`index.html:137`), change the padding declaration from
`padding:calc(20px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom));`
to:

```css
  padding:calc(20px + env(safe-area-inset-top)) 20px var(--sidebar-pad-bottom);
```

Immediately after `.filter-summary{…}` (`index.html:213`), add:

```css
/* The match count is the memory bridge between a 10-option field list at the top of the panel and
   the decision the reader is making; it must stay on screen while they work above it. The negative
   bottom/margin pair reaches past the panel's own bottom padding so scrolled content cannot appear
   underneath. --control-solid, not --tip-bg: the panel background is translucent and would let the
   scrolling filter list read through the pinned strip. */
#resultSection{position:sticky;bottom:calc(-1 * var(--sidebar-pad-bottom));z-index:2;background:var(--control-solid);border-top:1px solid var(--surface-border);padding-bottom:var(--sidebar-pad-bottom);margin-bottom:calc(-1 * var(--sidebar-pad-bottom))}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-runtime.test.mjs`
Expected: PASS. The pre-existing `fine pointers expose the selected 64px compact Explore rail` test still passes — its `.filter-sidebar` regex spans the padding line with `[\s\S]*?`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/page-runtime.test.mjs
git commit -m "feat: pin the Explore result summary to the bottom of the panel"
```

---

### Task 3: Footer feed links

**Problem (Assessment A, Priority 3, severity 3):** `feed.xml` and `changes.xml` are generated and declared at `index.html:8-9`, but browsers removed feed autodiscovery years ago. The only visible non-card link on the whole page is `source ↗` (`index.html:653`).

**Files:**
- Modify: `index.html:648-654` (footer markup), `site-i18n.js` (three keys × five locales)
- Test: `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: message keys `footer.subscribe`, `footer.feedCurrent`, `footer.feedChanges`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/page-runtime.test.mjs`:

```js
test("the footer links both Atom feeds beside the source link", () => {
  const footer = page.match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? "";
  assert.match(footer, /<a href="feed\.xml" data-i18n="footer\.feedCurrent">Current repositories \(Atom\)<\/a>/);
  assert.match(footer, /<a href="changes\.xml" data-i18n="footer\.feedChanges">New and re-entered \(Atom\)<\/a>/);
  assert.match(footer, /<span data-i18n="footer\.subscribe">Subscribe<\/span>/);
  assert.ok(footer.indexOf("source ↗") < footer.indexOf('href="feed.xml"'), "the feeds follow the source link");
  // The <link rel="alternate"> declarations stay: they are what the titles were taken from.
  assert.match(page, /<link rel="alternate" type="application\/atom\+xml" title="GITHUB INSIGHT — Current repositories" href="https:\/\/nowwcastle-sudo\.github\.io\/github-trending-daily\/feed\.xml">/);
  assert.match(page, /<link rel="alternate" type="application\/atom\+xml" title="GITHUB INSIGHT — New and re-entered repositories" href="https:\/\/nowwcastle-sudo\.github\.io\/github-trending-daily\/changes\.xml">/);
});
```

Add to `tests/site-i18n.test.mjs`, inside the existing `every rail group, shortcut hint, and held-retry message exists in all five locales` test, extend the `required` array with:

```js
    "footer.subscribe", "footer.feedCurrent", "footer.feedChanges",
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL — page-runtime fails at the `feed.xml` anchor match; site-i18n fails with `en is missing footer.subscribe`.

- [ ] **Step 3: Write the implementation**

Replace `index.html:648-654` with:

```html
<footer>
  <span data-i18n="footer.note">Based on GitHub Trending · summaries are AI analyses grounded in repository README files</span><br>
  <!-- GENERATED:TRENDING-DATE:START -->
<time id="lastUpdated" datetime="2026-09-05">2026-09-05 (Asia/Seoul)</time>
<!-- GENERATED:TRENDING-DATE:END --><br>
  <a href="https://github.com/nowwcastle-sudo/github-trending-daily" target="_blank" rel="noopener">source ↗</a>
  · <span data-i18n="footer.subscribe">Subscribe</span>:
  <a href="feed.xml" data-i18n="footer.feedCurrent">Current repositories (Atom)</a>
  · <a href="changes.xml" data-i18n="footer.feedChanges">New and re-entered (Atom)</a>
</footer>
```

The `<!-- GENERATED:TRENDING-DATE:START -->` … `:END` block is copied verbatim; do not retype the `<time>` element by hand — cut and paste the existing three lines.

In `site-i18n.js`, add to `EN` next to `"footer.note"`:

```js
  "footer.subscribe":"Subscribe",
  "footer.feedCurrent":"Current repositories (Atom)",
  "footer.feedChanges":"New and re-entered (Atom)",
```

and the matching entries in the other four locale objects:

```js
// KO
  "footer.subscribe":"구독","footer.feedCurrent":"현재 목록 (Atom)","footer.feedChanges":"신규·재진입 (Atom)",
// ZH
  "footer.subscribe":"订阅","footer.feedCurrent":"当前仓库 (Atom)","footer.feedChanges":"新增与再次进入 (Atom)",
// ES
  "footer.subscribe":"Suscribirse","footer.feedCurrent":"Repositorios actuales (Atom)","footer.feedChanges":"Nuevos y reincorporados (Atom)",
// JA
  "footer.subscribe":"購読","footer.feedCurrent":"現在のリポジトリ (Atom)","footer.feedChanges":"新規・再登場 (Atom)",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html site-i18n.js tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "feat: link both Atom feeds from the footer"
```

---

### Task 4: Keyboard help dialog with a single-key opt-out

**Problem (Assessment A, Priority 4, severity 2; Assessment B, WCAG 2.1.4 Fail):** six shortcuts exist (`/ e a h x Delete`) and are documented only in hover `title` attributes; pressing `?` on the live page opened nothing. Separately, `SIDEBAR_SHORTCUT_GROUPS` (`index.html:942`) binds four unmodified letter keys globally with no way to turn them off, remap them, or scope them to a container — WCAG 2.1.4 Character Key Shortcuts requires at least one of the three.

**Files:**
- Modify: `index.html:114-116` (rail CSS, add `.nav-help`), `index.html:365` region (add the `.shortcut-help` block after `.scroll-top` rules), `index.html:578` (rail markup, add the help button after `.nav-rail-spacer`), `index.html:666` region (add the dialog markup before `<div id="tipLayer" …>`), `index.html:942-962` (shortcut suppression and the keydown listener), `site-i18n.js`
- Test: `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: `trapFocus(container, event)` and `focusableIn(container)` from `index.html:757-767`; the Escape/focus-restore pattern from `closeReadme()` (`index.html:1438-1450`); `shortcutSuppressed(event)` and `SIDEBAR_SHORTCUT_GROUPS` at `index.html:942-962`.
- Produces:
  - element ids `navHelpToggle`, `shortcutHelp`, `shortcutHelpScrim`, `shortcutHelpTitle`, `shortcutHelpClose`, `shortcutDisableToggle`
  - runtime functions `openShortcutHelp(trigger)` and `closeShortcutHelp(restoreFocus = true)`
  - module-scope `let shortcutsDisabled` (boolean) and `const SHORTCUTS_DISABLED_KEY="gi.shortcuts.disabled"`
  - `shortcutSuppressed(event)` now also returns `true` when the help dialog is open, and when `shortcutsDisabled` is true **and** `event.key` is one of the four `SIDEBAR_SHORTCUT_GROUPS` letters. `/`, `?` and `Escape` are never suppressed by the opt-out.
  - the help button is `class="nav-help"`, **not** `class="nav-toggle"`, so the existing rail-order test regex `/<button class="nav-toggle" id="(\w+)" type="button"([^>]*)>/g` keeps matching exactly the four group buttons.

- [ ] **Step 1: Write the failing tests**

Add to `tests/page-runtime.test.mjs`:

```js
test("a persistent rail button and the ? key both open the shortcut dialog", () => {
  const rail = page.match(/<nav class="nav-rail"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.ok(rail.indexOf('class="nav-rail-spacer"') < rail.indexOf('id="navHelpToggle"'), "the help button sits below the spacer");
  assert.match(rail, /<button class="nav-help" id="navHelpToggle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="shortcutHelp" aria-label="Help — keyboard shortcuts \(\?\)" data-i18n-aria-label="shortcuts\.open" title="Help — keyboard shortcuts \(\?\)" data-i18n-title="shortcuts\.open">/);
  assert.match(rail, /<span class="nav-label" data-i18n="shortcuts\.label">Help<\/span>/);
  // The four group buttons are still exactly four.
  const groupButtons = [...rail.matchAll(/<button class="nav-toggle" id="(\w+)" type="button"/g)].map(match => match[1]);
  assert.deepEqual(groupButtons, ["navAccountToggle", "navToggle", "navHistoryToggle", "navExportToggle"]);

  const dialog = page.match(/<div id="shortcutHelp"[\s\S]*?<\/div>\s*<div id="tipLayer"/)?.[0] ?? "";
  assert.match(dialog, /role="dialog" aria-modal="true" aria-labelledby="shortcutHelpTitle" aria-hidden="true" inert/);
  for (const [key, messageKey] of [["/", "shortcuts.search"], ["e", "shortcuts.explore"], ["a", "shortcuts.account"], ["h", "shortcuts.history"], ["x", "shortcuts.export"], ["Delete", "shortcuts.delete"], ["Esc", "shortcuts.escape"], ["?", "shortcuts.help"]]) {
    assert.ok(dialog.includes(`<kbd>${key}</kbd>`), `${key} must be listed`);
    assert.ok(dialog.includes(`data-i18n="${messageKey}"`), `${messageKey} must be listed`);
  }
  assert.match(dialog, /<input type="checkbox" id="shortcutDisableToggle">/);
  assert.match(dialog, /data-i18n="shortcuts\.disable"/);
  assert.match(dialog, /data-i18n="shortcuts\.disableNote"/);

  assert.match(page, /const SHORTCUTS_DISABLED_KEY="gi\.shortcuts\.disabled";/);
  assert.match(page, /function openShortcutHelp\(trigger\)\{/);
  assert.match(page, /function closeShortcutHelp\(restoreFocus=true\)\{/);
  assert.match(page, /shortcutHelp\.addEventListener\("keydown",event=>trapFocus\(shortcutHelp,event\)\);/);
});

test("the single-key opt-out suppresses the four letters and never / ? or Escape", () => {
  const start = page.indexOf("const SIDEBAR_SHORTCUT_GROUPS=");
  const end = page.indexOf("const sidebarGestureInteractive=", start);
  assert.ok(start >= 0 && end > start, "the shortcut runtime must be isolated");
  const source = page.slice(start, end);

  const pressed = [];
  const context = {
    shortcutsDisabled: true,
    document: {
      getElementById(id) {
        if (id === "readmePanel") return { classList: { contains() { return false; } } };
        if (id === "shortcutHelp") return { classList: { contains() { return false; } } };
        if (id === "q") return { focus() { pressed.push("search"); } };
        return null;
      },
      addEventListener(type, listener) { if (type === "keydown") context.__keydown = listener; },
    },
    sidebar: { dataset: {} },
    railToggles: [],
    mobileNavToggle: {},
    sidebarMobileAccessMedia: { matches: false },
    UiMotion: { resolveSidebarGroup: value => value },
    setSidebarGroup(group) { pressed.push(`group:${group}`); },
    openSidebar(mode, trigger, group) { pressed.push(`open:${group}`); },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "shortcut-optout-fixture.js" });

  const press = key => context.__keydown({ key, repeat: false, isComposing: false, target: { tagName: "BODY" }, preventDefault() {} });
  press("e"); press("h"); press("a"); press("x");
  assert.deepEqual(pressed, [], "no letter shortcut fires while the opt-out is on");
  press("/");
  assert.deepEqual(pressed, ["search"], "slash keeps working while the opt-out is on");

  context.shortcutsDisabled = false;
  press("e");
  assert.deepEqual(pressed, ["search", "open:explore"], "turning the opt-out off restores the letters");
});
```

Add to `tests/site-i18n.test.mjs`, extending the `required` array:

```js
    "shortcuts.label", "shortcuts.open", "shortcuts.title", "shortcuts.close",
    "shortcuts.search", "shortcuts.explore", "shortcuts.account", "shortcuts.history",
    "shortcuts.export", "shortcuts.delete", "shortcuts.escape", "shortcuts.help",
    "shortcuts.disable", "shortcuts.disableNote",
```

and add a new test:

```js
test("the help button's accessible name contains its visible label in every locale", () => {
  const i18n = load();
  for (const locale of i18n.SUPPORTED_LOCALES) {
    const label = i18n.MESSAGES[locale]["shortcuts.label"];
    const name = i18n.MESSAGES[locale]["shortcuts.open"];
    assert.ok(name.startsWith(label), `${locale}: "${name}" must start with the visible label "${label}"`);
    assert.ok(name.endsWith("(?)"), `${locale} shortcuts.open must end with the (?) hint`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL — page-runtime fails at `assert.ok(rail.indexOf('class="nav-rail-spacer"') < rail.indexOf('id="navHelpToggle"'))` because `navHelpToggle` is absent (`indexOf` returns `-1`); site-i18n fails with `en is missing shortcuts.label`.

- [ ] **Step 3: Write the implementation**

**3a. CSS.** After `.nav-rail-spacer{flex:1}` (`index.html:115`) add:

```css
.nav-help{width:48px;min-height:44px;border:0;border-radius:14px;padding:6px 4px;background:transparent;color:var(--text-2);cursor:pointer;display:grid;place-items:center;align-content:center;gap:4px;font:inherit;font-size:10px;font-weight:650;transition:background-color .16s ease,color .16s ease}
.nav-help::before{content:"?";font-size:16px;font-weight:700;line-height:1}
.nav-help:hover,.nav-help:focus-visible{background:var(--accent-soft);color:var(--accent-selected)}
.nav-help:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
```

After the `.scroll-top[hidden]{display:none}` rule (`index.html:371`) add:

```css
/* Shortcut help: the same modal contract as #readmePanel — scrim, inert page, focus trap, Escape,
   focus restore to the opener. */
#shortcutHelpScrim{position:fixed;inset:0;z-index:340;background:rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s ease-out}
#shortcutHelpScrim.on{opacity:1;pointer-events:auto}
.shortcut-help{position:fixed;z-index:350;left:50%;top:50%;transform:translate3d(-50%,-46%,0);width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow-y:auto;display:grid;gap:14px;padding:20px;background:var(--tip-bg);backdrop-filter:blur(28px) saturate(180%);border:1px solid var(--tip-border);border-radius:18px;box-shadow:var(--shadow-pop);color:var(--text);opacity:0;pointer-events:none;transition:opacity .2s ease-out,transform .2s cubic-bezier(.16,1,.3,1)}
.shortcut-help.open{opacity:1;transform:translate3d(-50%,-50%,0);pointer-events:auto}
.shortcut-help[inert]{display:none}
.sh-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.sh-head h2{font-size:19px;letter-spacing:-.015em}
.shortcut-list{display:grid;gap:9px}
.shortcut-list>div{display:grid;grid-template-columns:84px minmax(0,1fr);align-items:center;gap:12px}
.shortcut-list dt kbd{display:inline-block;min-width:32px;padding:3px 8px;border:1px solid var(--surface-border);border-bottom-width:2px;border-radius:7px;background:var(--control-solid);color:var(--text);font:inherit;font-size:12px;font-weight:650;text-align:center}
.shortcut-list dd{margin:0;color:var(--text-2);font-size:13px;line-height:1.45;overflow-wrap:anywhere}
.shortcut-optout{display:flex;align-items:center;gap:9px;min-height:44px;padding-top:12px;border-top:1px solid var(--hairline);font-size:13px}
.shortcut-optout label{display:flex;align-items:center;gap:9px;min-height:44px;cursor:pointer}
.shortcut-optout input{width:18px;height:18px;accent-color:var(--accent);cursor:pointer}
.shortcut-optout input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.shortcut-help{transition:none!important}}
```

**3b. Rail markup.** Replace `index.html:578` (`<span class="nav-rail-spacer" aria-hidden="true"></span>`) with:

```html
  <span class="nav-rail-spacer" aria-hidden="true"></span>
  <button class="nav-help" id="navHelpToggle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="shortcutHelp" aria-label="Help — keyboard shortcuts (?)" data-i18n-aria-label="shortcuts.open" title="Help — keyboard shortcuts (?)" data-i18n-title="shortcuts.open">
    <span class="nav-label" data-i18n="shortcuts.label">Help</span>
  </button>
```

**3c. Dialog markup.** Immediately before `<div id="tipLayer" …>` (`index.html:667`) add:

```html
<div id="shortcutHelpScrim"></div>
<div id="shortcutHelp" class="shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcutHelpTitle" aria-hidden="true" inert>
  <div class="sh-head">
    <h2 id="shortcutHelpTitle" data-i18n="shortcuts.title">Keyboard shortcuts</h2>
    <button class="sidebar-close" id="shortcutHelpClose" type="button" aria-label="Close keyboard shortcuts" data-i18n-aria-label="shortcuts.close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>
  <dl class="shortcut-list">
    <div><dt><kbd>/</kbd></dt><dd data-i18n="shortcuts.search">Focus the search box</dd></div>
    <div><dt><kbd>e</kbd></dt><dd data-i18n="shortcuts.explore">Open the Explore panel</dd></div>
    <div><dt><kbd>a</kbd></dt><dd data-i18n="shortcuts.account">Open the Login panel</dd></div>
    <div><dt><kbd>h</kbd></dt><dd data-i18n="shortcuts.history">Open the History panel</dd></div>
    <div><dt><kbd>x</kbd></dt><dd data-i18n="shortcuts.export">Open the Export panel</dd></div>
    <div><dt><kbd>Delete</kbd></dt><dd data-i18n="shortcuts.delete">Hide the focused repository</dd></div>
    <div><dt><kbd>Esc</kbd></dt><dd data-i18n="shortcuts.escape">Close the open panel or dialog</dd></div>
    <div><dt><kbd>?</kbd></dt><dd data-i18n="shortcuts.help">Show this list</dd></div>
  </dl>
  <p class="shortcut-optout">
    <label><input type="checkbox" id="shortcutDisableToggle"><span data-i18n="shortcuts.disable">Disable single-key shortcuts</span></label>
  </p>
  <p class="sidebar-note" data-i18n="shortcuts.disableNote">Slash, question mark and Escape keep working.</p>
</div>
```

**3d. Runtime.** Replace `index.html:942-962` (from `const SIDEBAR_SHORTCUT_GROUPS=` through the closing `});` of the keydown listener) with:

```js
const SIDEBAR_SHORTCUT_GROUPS={e:"explore",a:"account",h:"history",x:"export"};
// WCAG 2.1.4: the four letters are unmodified character-key shortcuts, so they need a way to be
// turned off. The flag lives in localStorage and is read once at load; "/" (focus search), "?"
// (this help) and Escape are navigation of last resort and stay live regardless.
const SHORTCUTS_DISABLED_KEY="gi.shortcuts.disabled";
let shortcutsDisabled=false;
try{shortcutsDisabled=localStorage.getItem(SHORTCUTS_DISABLED_KEY)==="1"}catch{}
function shortcutSuppressed(event){
  if(event.repeat||event.isComposing||event.key==="Process")return true;
  if(event.altKey||event.ctrlKey||event.metaKey)return true;
  if(document.getElementById("readmePanel").classList.contains("open"))return true;
  if(document.getElementById("shortcutHelp").classList.contains("open"))return true;
  if(shortcutsDisabled&&event.key.length===1&&Object.hasOwn(SIDEBAR_SHORTCUT_GROUPS,event.key.toLowerCase()))return true;
  const target=event.target;
  const tag=String(target?.tagName||"").toLowerCase();
  return tag==="input"||tag==="select"||tag==="textarea"||target?.isContentEditable===true;
}
document.addEventListener("keydown",event=>{
  if(shortcutSuppressed(event))return;
  const modalOpen=sidebar.dataset.openMode==="modal";
  if(event.key==="/"){if(modalOpen)return;event.preventDefault();document.getElementById("q").focus();return}
  if(event.key==="?"){event.preventDefault();openShortcutHelp(document.getElementById("navHelpToggle"));return}
  // Only single-character keys are lowercased, so the "Process" / named-key guards above keep
  // matching their exact spellings; this makes CapsLock irrelevant to the accelerators (RED1-M4).
  const group=event.key.length===1?SIDEBAR_SHORTCUT_GROUPS[event.key.toLowerCase()]:undefined;
  if(!group)return;
  event.preventDefault();
  if(modalOpen){setSidebarGroup(group);return}
  const trigger=sidebarMobileAccessMedia.matches?mobileNavToggle:railToggles.find(toggle=>toggle.dataset.group===group);
  openSidebar("modal",trigger,group);
});
```

Then, immediately after that listener, add the dialog runtime:

```js
const shortcutHelp=document.getElementById("shortcutHelp"),shortcutHelpScrim=document.getElementById("shortcutHelpScrim");
const shortcutHelpClose=document.getElementById("shortcutHelpClose"),navHelpToggle=document.getElementById("navHelpToggle");
const shortcutDisableToggle=document.getElementById("shortcutDisableToggle");
let shortcutHelpTrigger=null;
shortcutDisableToggle.checked=shortcutsDisabled;
function openShortcutHelp(trigger){
  if(shortcutHelp.classList.contains("open"))return;
  closeSidebar(false);
  shortcutHelpTrigger=trigger instanceof HTMLElement?trigger:document.activeElement;
  shortcutHelp.inert=false;shortcutHelp.classList.add("open");shortcutHelp.setAttribute("aria-hidden","false");
  shortcutHelpScrim.classList.add("on");pageMain.inert=true;document.body.classList.add("overlay-open");
  navHelpToggle.setAttribute("aria-expanded","true");
  shortcutHelpClose.focus();
}
function closeShortcutHelp(restoreFocus=true){
  if(!shortcutHelp.classList.contains("open"))return;
  shortcutHelp.classList.remove("open");shortcutHelp.setAttribute("aria-hidden","true");shortcutHelp.inert=true;
  shortcutHelpScrim.classList.remove("on");pageMain.inert=false;
  navHelpToggle.setAttribute("aria-expanded","false");
  if(!sidebar.classList.contains("open")&&!document.getElementById("readmePanel").classList.contains("open"))document.body.classList.remove("overlay-open");
  if(restoreFocus&&shortcutHelpTrigger instanceof HTMLElement)shortcutHelpTrigger.focus();
}
navHelpToggle.addEventListener("click",event=>openShortcutHelp(event.currentTarget));
shortcutHelpClose.addEventListener("click",()=>closeShortcutHelp());
shortcutHelpScrim.addEventListener("click",()=>closeShortcutHelp());
shortcutHelp.addEventListener("keydown",event=>trapFocus(shortcutHelp,event));
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeShortcutHelp()});
shortcutDisableToggle.addEventListener("change",event=>{
  shortcutsDisabled=event.currentTarget.checked;
  try{localStorage.setItem(SHORTCUTS_DISABLED_KEY,shortcutsDisabled?"1":"0")}catch{}
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS, including the pre-existing `the rail exposes four group buttons in the approved order…` and `slash focuses search and the four letters open their group modally` tests.

- [ ] **Step 5: Add the five locales**

In `site-i18n.js`, add to `EN`:

```js
  "shortcuts.label":"Help",
  "shortcuts.open":"Help — keyboard shortcuts (?)",
  "shortcuts.title":"Keyboard shortcuts",
  "shortcuts.close":"Close keyboard shortcuts",
  "shortcuts.search":"Focus the search box",
  "shortcuts.explore":"Open the Explore panel",
  "shortcuts.account":"Open the Login panel",
  "shortcuts.history":"Open the History panel",
  "shortcuts.export":"Open the Export panel",
  "shortcuts.delete":"Hide the focused repository",
  "shortcuts.escape":"Close the open panel or dialog",
  "shortcuts.help":"Show this list",
  "shortcuts.disable":"Disable single-key shortcuts",
  "shortcuts.disableNote":"Slash, question mark and Escape keep working.",
```

```js
// KO
  "shortcuts.label":"도움말","shortcuts.open":"도움말 — 단축키 (?)","shortcuts.title":"단축키","shortcuts.close":"단축키 닫기","shortcuts.search":"검색창으로 이동","shortcuts.explore":"탐색 패널 열기","shortcuts.account":"로그인 패널 열기","shortcuts.history":"이력 패널 열기","shortcuts.export":"내보내기 패널 열기","shortcuts.delete":"선택한 저장소 숨기기","shortcuts.escape":"열린 패널·대화상자 닫기","shortcuts.help":"이 목록 보기","shortcuts.disable":"한 글자 단축키 사용 안 함","shortcuts.disableNote":"슬래시(/), 물음표(?), Esc는 계속 동작합니다.",
// ZH
  "shortcuts.label":"帮助","shortcuts.open":"帮助 — 键盘快捷键 (?)","shortcuts.title":"键盘快捷键","shortcuts.close":"关闭键盘快捷键","shortcuts.search":"聚焦搜索框","shortcuts.explore":"打开探索面板","shortcuts.account":"打开登录面板","shortcuts.history":"打开历史面板","shortcuts.export":"打开导出面板","shortcuts.delete":"隐藏选中的仓库","shortcuts.escape":"关闭打开的面板或对话框","shortcuts.help":"显示此列表","shortcuts.disable":"停用单键快捷键","shortcuts.disableNote":"斜杠、问号和 Esc 仍然有效。",
// ES
  "shortcuts.label":"Ayuda","shortcuts.open":"Ayuda — atajos de teclado (?)","shortcuts.title":"Atajos de teclado","shortcuts.close":"Cerrar atajos de teclado","shortcuts.search":"Enfocar el cuadro de búsqueda","shortcuts.explore":"Abrir el panel de exploración","shortcuts.account":"Abrir el panel de inicio de sesión","shortcuts.history":"Abrir el panel de historial","shortcuts.export":"Abrir el panel de exportación","shortcuts.delete":"Ocultar el repositorio enfocado","shortcuts.escape":"Cerrar el panel o diálogo abierto","shortcuts.help":"Mostrar esta lista","shortcuts.disable":"Desactivar los atajos de una sola tecla","shortcuts.disableNote":"La barra, el signo de interrogación y Escape siguen funcionando.",
// JA
  "shortcuts.label":"ヘルプ","shortcuts.open":"ヘルプ — キーボードショートカット (?)","shortcuts.title":"キーボードショートカット","shortcuts.close":"キーボードショートカットを閉じる","shortcuts.search":"検索ボックスにフォーカス","shortcuts.explore":"探索パネルを開く","shortcuts.account":"ログインパネルを開く","shortcuts.history":"履歴パネルを開く","shortcuts.export":"エクスポートパネルを開く","shortcuts.delete":"選択中のリポジトリを非表示","shortcuts.escape":"開いているパネル・ダイアログを閉じる","shortcuts.help":"この一覧を表示","shortcuts.disable":"1キーのショートカットを無効にする","shortcuts.disableNote":"スラッシュ、疑問符、Esc は引き続き使えます。",
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 7: Commit**

```bash
git add index.html site-i18n.js tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "feat: add a keyboard shortcut dialog with a single-key opt-out"
```

---

### Task 5: Show the panel group switcher only where the nav rail is hidden

**Problem (Assessment A, Priority 5, severity 2):** on a hover-capable desktop with the panel open modally, the 64px rail (`로그인 / 탐색 / 이력 / 내보내기`) and `#sidebarGroupSeg` (the same four labels) render at once, roughly 100px apart, both carrying "you are here" state. It also pushes the panel's real content 60px further down, worsening Task 2's problem.

**Files:**
- Modify: `index.html:800-860` region — the `sidebarGroupSeg.hidden` assignments in `closeSidebar()` (`index.html:826`) and `openSidebar()` (`index.html:847`), plus a new media-query constant near `index.html:938`
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: `sidebarGroupSeg`, `sidebarGroupSegButtons`, `openSidebar(mode, trigger, group)`, `closeSidebar(restoreFocus)` from `index.html:736-860`.
- Produces: `const sidebarRailVisibleMedia = matchMedia("(hover:hover) and (pointer:fine) and (min-width:721px)")` and `function sidebarGroupSegVisible()`. Later tasks do not depend on these.

**Why the `hidden` attribute and not a CSS media query:** the rail is `display:flex` under `@media(hover:hover) and (pointer:fine)` (`index.html:145`) and `display:none!important` under `@media(max-width:720px)` (`index.html:396`), so "rail visible" is exactly `(hover:hover) and (pointer:fine) and (min-width:721px)`. Hiding the switcher with CSS alone would leave its four buttons inside `focusableIn(sidebar)` — that helper filters on `!el.hidden && !el.closest("[hidden]")`, not on computed style — and the modal focus trap would then compute a wrong first/last pair. Setting `hidden` keeps the trap correct and reuses the existing `.sidebar-group-seg[hidden]{display:none}` rule at `index.html:372`.

- [ ] **Step 1: Write the failing test**

Add to `tests/page-runtime.test.mjs`:

```js
test("the in-panel group switcher is hidden wherever the nav rail is on screen", () => {
  assert.match(page, /const sidebarRailVisibleMedia=matchMedia\("\(hover:hover\) and \(pointer:fine\) and \(min-width:721px\)"\);/);
  assert.match(page, /function sidebarGroupSegVisible\(mode\)\{return mode==="modal"&&!sidebarRailVisibleMedia\.matches\}/);
  assert.match(page, /sidebarGroupSeg\.hidden=!sidebarGroupSegVisible\(mode\);/);
  assert.match(page, /sidebarRailVisibleMedia\.addEventListener\?\.\("change",\(\)=>\{sidebarGroupSeg\.hidden=!sidebarGroupSegVisible\(sidebar\.dataset\.openMode\)\}\);/);

  // Desktop (rail visible): opening modally must NOT reveal the switcher.
  const desktop = sidebarHarness({ hoverCapable: true });
  desktop.railToggles[1].dispatch("click", { detail: 0 });
  assert.equal(desktop.sidebar.dataset.openMode, "modal");
  assert.equal(desktop.groupSeg.hidden, true, "the rail already names the four groups");

  // Coarse pointer (rail hidden): the switcher is the only group navigation, so it must show.
  const mobile = sidebarHarness({ hoverCapable: false });
  mobile.railToggles[1].dispatch("click", { detail: 0 });
  assert.equal(mobile.sidebar.dataset.openMode, "modal");
  assert.equal(mobile.groupSeg.hidden, false, "without the rail the switcher is the only group navigation");
});
```

In `sidebarHarness` (`tests/page-runtime.test.mjs:35`), the fake `matchMedia` must answer the new query. Find the `matchMedia` implementation inside that harness and make it return `{ matches: hoverCapable, addEventListener() {} }` for both `"(hover:hover) and (pointer:fine)"` and `"(hover:hover) and (pointer:fine) and (min-width:721px)"`, keeping every other query's existing answer unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-runtime.test.mjs`
Expected: FAIL at `assert.match(page, /const sidebarRailVisibleMedia=matchMedia\(…\)/)` — the constant does not exist.

- [ ] **Step 3: Write the implementation**

Immediately after `const sidebarHoverMedia=matchMedia("(hover:hover) and (pointer:fine)");` (`index.html:754`), add:

```js
// The rail is display:flex under (hover:hover) and (pointer:fine) (index.html:145) and
// display:none!important under (max-width:720px) (index.html:396) — so "the rail is on screen" is
// exactly this query. Where it is true the rail already labels and states the four groups, and a
// second copy inside the panel is two "you are here" indicators for one location.
const sidebarRailVisibleMedia=matchMedia("(hover:hover) and (pointer:fine) and (min-width:721px)");
function sidebarGroupSegVisible(mode){return mode==="modal"&&!sidebarRailVisibleMedia.matches}
```

In `closeSidebar()` change `sidebarGroupSeg.hidden=true;` to:

```js
  sidebarGroupSeg.hidden=!sidebarGroupSegVisible(undefined);
```

In `openSidebar()` change `sidebarGroupSeg.hidden=mode!=="modal";` to:

```js
  sidebarGroupSeg.hidden=!sidebarGroupSegVisible(mode);
```

After the `sidebarMobileAccessMedia.addEventListener?.("change",updateMobileNavAccess);` line (`index.html:941`), add:

```js
sidebarRailVisibleMedia.addEventListener?.("change",()=>{sidebarGroupSeg.hidden=!sidebarGroupSegVisible(sidebar.dataset.openMode)});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-runtime.test.mjs`
Expected: PASS. The pre-existing `the modal group switcher selects a group and stays out of the hover tab order` test (`tests/page-runtime.test.mjs:1410`) runs under a coarse-pointer harness, so its expectation that the switcher shows in modal mode still holds; if it was written with `hoverCapable: true`, switch that call to `sidebarHarness({ hoverCapable: false })` and note the reason in a comment above it.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/page-runtime.test.mjs
git commit -m "fix: show the panel group switcher only where the nav rail is hidden"
```

---

### Task 6: Six accessibility corrections

**Problems (Assessment B):** 2.4.1 Bypass Blocks — no skip link, four rail buttons precede `<main>` in tab order. 2.5.3 Label in Name — `#navAccountToggle` renders "Login" but is named "Account and sync panel" (confirmed by a live axe run, impact "serious"). 4.1.2 duplicate names — every card's favourite button is named identically. 1.4.3 — light-theme `--accent` `#0071e3` on `#f5f5f7` computes **4.31:1**, below the 4.5:1 requirement, at four normal-size text sites. And the `sr-only` Delete hint is the `aria-describedby` of all 52 cards, so a screen-reader user hears it 52 times.

**Contrast decision, computed:** replace light-theme `--accent` text with the existing `--accent-selected`. `#005fc7` on `#f5f5f7` → relative luminances 0.12308 and 0.91433 → **(0.91433 + 0.05) / (0.12308 + 0.05) = 5.57:1**, which clears 4.5:1. In dark theme `--accent-selected` is `#a7c7bd` on `#282828` → luminances 0.52739 and 0.02125 → **8.10:1**, an improvement on the current 5.48:1. Both themes pass, so this is a token swap, not a per-theme fork.

**Files:**
- Modify: `index.html:342` (`.tlabel`), `index.html:443` (`#readmeBody a`), `index.html:1503` and `index.html:1514` (inline `style="color:var(--accent)"`), a new `.skip-link` rule near `index.html:53`, `index.html:482` (skip link markup, first child of `<body>`), `index.html:582` (`<main class="wrap">`), `index.html:562` (static `aria-label`), `index.html:809-818` (`restoreSidebarFocus`), `index.html:1273-1274` (card template), `site-i18n.js`
- Test: `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `<main class="wrap" id="mainContent" tabindex="-1">`; message key `skip.main`; `repo.favoriteAdd` / `repo.favoriteRemove` now take a `{name}` parameter; `nav.ariaAccount` now starts with the visible `nav.account` label in all five locales.

- [ ] **Step 1: Write the failing tests**

Add to `tests/page-runtime.test.mjs`:

```js
test("a skip link is the first focusable element and targets the main region", () => {
  const body = page.slice(page.indexOf("<body>"));
  const skipIndex = body.indexOf('class="skip-link"');
  assert.ok(skipIndex >= 0, "the skip link must exist");
  const firstFocusable = body.search(/<(?:a href|button|input|select|textarea)\b/);
  assert.equal(skipIndex - body.slice(0, skipIndex).lastIndexOf("<a href"), skipIndex - firstFocusable, "no focusable element may precede the skip link");
  assert.match(body, /<a class="skip-link" href="#mainContent" data-i18n="skip\.main">Skip to content<\/a>/);
  assert.match(page, /<main class="wrap" id="mainContent" tabindex="-1">/);
  assert.match(page, /\.skip-link\{[^}]*position:absolute[^}]*left:-9999px/);
  assert.match(page, /\.skip-link:focus\{[^}]*left:12px[^}]*top:12px/);
  // <main> now carries the tabindex statically, so the focus-restore rung no longer adds and
  // removes it (removing it would break the skip link after one sidebar close).
  assert.match(page, /pageMain\.focus\(\{preventScroll:true\}\);/);
  assert.doesNotMatch(page, /pageMain\.removeAttribute\("tabindex"\)/);
  assert.match(page, /\.wrap\[tabindex="-1"\]:focus\{outline:none\}/);
});

test("the account rail button's accessible name contains its visible label", () => {
  const button = page.match(/<button class="nav-toggle" id="navAccountToggle"[^>]*>/)?.[0] ?? "";
  assert.match(button, /aria-label="Login — account and sync panel"/);
  assert.match(button, /data-i18n-aria-label="nav\.ariaAccount"/);
});

test("each favourite button names the repository it belongs to", () => {
  assert.match(page, /aria-label="\$\{esc\(tr\(faved\?"repo\.favoriteRemove":"repo\.favoriteAdd",\{name:r\.name\}\)\)\}"/);
});

test("light-theme accent text uses the 4.5:1 token instead of the 4.31:1 one", () => {
  assert.match(page, /\.tlabel\{[^}]*color:var\(--accent-selected\)/);
  assert.match(page, /#readmeBody a\{color:var\(--accent-selected\)\}/);
  const inlineAccent = [...page.matchAll(/style="color:var\(--accent\)"/g)];
  assert.equal(inlineAccent.length, 0, "no inline style may paint normal-size text with --accent");
  assert.equal([...page.matchAll(/style="color:var\(--accent-selected\)"/g)].length, 2, "both README fallback links use the accessible token");
});

test("the Delete-key hint is announced once, not once per card", () => {
  assert.match(page, /id="cardKeyboardHint" class="sr-only"/);
  assert.doesNotMatch(page, /aria-describedby="cardKeyboardHint"/);
  assert.match(page, /aria-keyshortcuts="Delete"/);
  const hintIndex = page.indexOf('id="cardKeyboardHint"');
  const listIndex = page.indexOf('class="list-stage" id="listStage"');
  assert.ok(hintIndex >= 0 && hintIndex < listIndex, "the hint precedes the list in reading order");
});
```

Add to `tests/site-i18n.test.mjs`:

```js
test("the account rail button satisfies Label in Name in every locale", () => {
  const i18n = load();
  for (const locale of i18n.SUPPORTED_LOCALES) {
    const visible = i18n.MESSAGES[locale]["nav.account"];
    const accessible = i18n.MESSAGES[locale]["nav.ariaAccount"];
    assert.ok(accessible.startsWith(visible), `${locale}: "${accessible}" must start with the visible label "${visible}"`);
  }
});

test("favourite button labels carry the repository name in every locale", () => {
  const i18n = load();
  for (const locale of i18n.SUPPORTED_LOCALES) {
    for (const key of ["repo.favoriteAdd", "repo.favoriteRemove"]) {
      assert.ok(i18n.MESSAGES[locale][key].includes("{name}"), `${locale} ${key} must interpolate {name}`);
    }
    assert.equal(typeof i18n.MESSAGES[locale]["skip.main"], "string");
    assert.ok(i18n.MESSAGES[locale]["skip.main"].trim().length > 0);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL — page-runtime fails at `assert.ok(skipIndex >= 0, "the skip link must exist")`; site-i18n fails at `en: "Account and sync panel" must start with the visible label "Login"`.

- [ ] **Step 3: Write the implementation**

**3a. Skip link.** After `.wrap[tabindex="-1"]:focus{outline:none}` (`index.html:53`) add:

```css
.skip-link{position:absolute;left:-9999px;top:auto;z-index:400;min-height:44px;display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:11px;background:var(--control-solid);color:var(--text);padding:10px 14px;font:inherit;font-size:13px;font-weight:650;text-decoration:none}
.skip-link:focus{left:12px;top:12px;outline:3px solid var(--accent);outline-offset:2px}
```

Make the skip link the first child of `<body>` — insert it at `index.html:483`, immediately before `<div class="filter-sidebar" id="filterSidebar" …>`:

```html
<a class="skip-link" href="#mainContent" data-i18n="skip.main">Skip to content</a>
```

Change `index.html:582` from `<main class="wrap">` to:

```html
<main class="wrap" id="mainContent" tabindex="-1">
```

Simplify `restoreSidebarFocus`'s last rung (`index.html:815-817`) from the three-line set/focus/remove sequence to:

```js
  pageMain.focus({preventScroll:true});
```

(`<main>` now carries `tabindex="-1"` statically, so adding and then removing the attribute would leave the skip link inoperable after the first sidebar close. `.wrap[tabindex="-1"]:focus{outline:none}` still suppresses the UA ring.)

Then update the five test assertions that hard-code the old `<main class="wrap">` opening tag — `tests/page-runtime.test.mjs:927`, `:1046`, `:1047`, `:1982`, `:1984` — to `<main class="wrap" id="mainContent" tabindex="-1">`, and `tests/page-runtime.test.mjs:1994` (the `pageMain.setAttribute("tabindex","-1")…` sequence) to the single-line `pageMain.focus({preventScroll:true});` assertion already written in Step 1.

**3b. Label in Name.** Change `index.html:562`'s `aria-label="Account and sync panel"` to `aria-label="Login — account and sync panel"` (the `data-i18n-aria-label="nav.ariaAccount"` hook is unchanged). In `site-i18n.js` change `nav.ariaAccount` in all five locales:

```js
// EN
  "nav.ariaAccount":"Login — account and sync panel",
// KO
  "nav.ariaAccount":"로그인 — 계정·동기화 패널",
// ZH
  "nav.ariaAccount":"登录 — 账户与同步面板",
// ES
  "nav.ariaAccount":"Iniciar sesión — Panel de cuenta y sincronización",
// JA
  "nav.ariaAccount":"ログイン — アカウント・同期パネル",
```

**3c. Favourite button name.** In the card template (`index.html:1274`) change

`aria-label="${tr(faved?"repo.favoriteRemove":"repo.favoriteAdd")}"`

to

```js
aria-label="${esc(tr(faved?"repo.favoriteRemove":"repo.favoriteAdd",{name:r.name}))}"
```

(the `esc()` is required now that a repository name is interpolated into an attribute — the same pattern `.hidden-restore` already uses at `index.html:1139`). In `site-i18n.js`:

```js
// EN
  "repo.favoriteAdd":"Add {name} to favorites",
  "repo.favoriteRemove":"Remove {name} from favorites",
// KO
  "repo.favoriteAdd":"{name} 즐겨찾기 추가","repo.favoriteRemove":"{name} 즐겨찾기 해제",
// ZH
  "repo.favoriteAdd":"将 {name} 添加到收藏","repo.favoriteRemove":"从收藏中移除 {name}",
// ES
  "repo.favoriteAdd":"Añadir {name} a favoritos","repo.favoriteRemove":"Quitar {name} de favoritos",
// JA
  "repo.favoriteAdd":"{name} をお気に入りに追加","repo.favoriteRemove":"{name} をお気に入りから削除",
```

**3d. Contrast.** Four edits, all `--accent` → `--accent-selected`:
- `index.html:342`: `.tlabel{…color:var(--accent);…}` → `color:var(--accent-selected)`
- `index.html:443`: `#readmeBody a{color:var(--accent)}` → `#readmeBody a{color:var(--accent-selected)}`
- `index.html:1503`: `style="color:var(--accent)"` → `style="color:var(--accent-selected)"`
- `index.html:1514`: `style="color:var(--accent)"` → `style="color:var(--accent-selected)"`

Leave every other `--accent` use alone — those are `:hover` / `:focus` / `[aria-pressed="true"]` transient states or border colours, not resting body text.

**3e. Card description.** In the card template (`index.html:1273`) remove ` aria-describedby="cardKeyboardHint"` from the `<article>` opening tag, keeping `aria-keyshortcuts="Delete"`. The `<p id="cardKeyboardHint" class="sr-only">` at `index.html:636` stays exactly where it is — it precedes the list, so a screen reader reads it once in document order instead of once per card.

**3f. skip.main key.** In `site-i18n.js` add:

```js
// EN
  "skip.main":"Skip to content",
// KO
  "skip.main":"본문으로 건너뛰기",
// ZH
  "skip.main":"跳到主要内容",
// ES
  "skip.main":"Saltar al contenido",
// JA
  "skip.main":"本文へスキップ",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS, including the pre-existing `keyboard users can hide the focused card without a permanent card icon` test after its `aria-describedby="cardKeyboardHint" aria-keyshortcuts="Delete"` assertion (`tests/page-runtime.test.mjs:1956`) is changed to `assert.match(page, /aria-keyshortcuts="Delete"/)` plus `assert.doesNotMatch(page, /aria-describedby="cardKeyboardHint"/)`, and the `selected discovery controls use an accessible semantic accent text token` test at `:2489`, which is unaffected.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html site-i18n.js tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "a11y: add a skip link, name controls fully, and fix light-theme accent contrast"
```

---

### Task 7: Mobile tap targets, History empty states, and Korean word breaking

**Problems (Assessment A, Priorities 6, 7, 8):** the repository link — the card's terminal action — measures 26px tall at 390px wide and `#resetBtn` 31px, both under the 44px minimum, and a near-miss triggers the summary instead of navigating. With zero hidden repositories `#restoreAllHiddenBtn` renders fully enabled and `#recentExitsList` renders nothing at all, so a working feature reads as broken. And `내보내기` wraps as `내보내` / `기` in a 64px rail while the header subtitle splits `가리키거나` mid-word.

**Files:**
- Modify: `index.html:62` (`.sub`), `index.html:90-91` (`.nav-rail` width), `index.html:96` (`.nav-toggle` width), `index.html:114` (`.nav-label`), `index.html:146` (`.filter-sidebar` under fine pointers), `index.html:194` (add `.clear-filters:disabled`), `index.html:400-412` (mobile block), `index.html:413` (`.wrap` padding-left), `index.html:1134-1146` (`updateHiddenManager`, `renderRecentExits`), `site-i18n.js`
- Test: `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: `updateHiddenManager()` and `renderRecentExits(exited)` from `index.html:1134-1146`.
- Produces: message key `exits.empty`; the rail token changes from 64px to **76px** and `.nav-toggle` from 48px to **60px**; the `.wrap` desktop offset changes from 80px to **92px** (76 + 16).

- [ ] **Step 1: Write the failing tests**

Add to `tests/page-runtime.test.mjs`:

```js
test("the card link and the title reset clear 44px on a phone", () => {
  const mobile = page.match(/@media\(max-width:560px\)\{[\s\S]*?\r?\n\}/)?.[0] ?? "";
  assert.match(mobile, /\.repo-link\{display:inline-block;padding:9px 0\}/);
  assert.match(mobile, /#resetBtn\{display:inline-block;padding:7px 0\}/);
});

test("the History group states its empty conditions instead of rendering dead controls", () => {
  assert.match(page, /document\.getElementById\("restoreAllHiddenBtn"\)\.disabled=!slugs\.length;/);
  assert.match(page, /section\.hidden=sidebar\.dataset\.group!=="history";/);
  assert.match(page, /recentExitsList\.innerHTML=exited\.length\?[\s\S]*?:`<p class="sidebar-note">\$\{esc\(tr\("exits\.empty"\)\)\}<\/p>`;/);
  assert.match(page, /\.clear-filters:disabled\{opacity:\.5;cursor:not-allowed\}/);

  const harness = hiddenSectionsGroupHarness();
  harness.setGroup("history");
  harness.render();
  assert.equal(harness.restoreAllHiddenBtn.disabled, true, "Restore all is dead at zero hidden repositories");
  harness.renderRecentExits([]);
  assert.match(harness.recentExitsList.innerHTML, /exits\.empty/, "an empty exits list says so");

  harness.hideRepo("octocat/hidden");
  harness.render();
  assert.equal(harness.restoreAllHiddenBtn.disabled, false, "Restore all works once something is hidden");
});

test("Korean rail labels and the subtitle break between words, not inside them", () => {
  assert.match(page, /\.nav-label\{line-height:1;word-break:keep-all;overflow-wrap:normal\}/);
  assert.match(page, /\.sub\{[^}]*word-break:keep-all;overflow-wrap:normal\}/);
  assert.match(page, /\.nav-rail\{[^}]*width:76px/);
  assert.match(page, /\.nav-toggle\{[^}]*width:60px;min-height:60px/);
  const finePointer = page.match(/@media\(hover:hover\) and \(pointer:fine\)\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(finePointer, /\.filter-sidebar\{[^}]*left:76px[^}]*width:min\(336px,calc\(100vw - 76px\)\)/);
  assert.match(page, /@media\(hover:hover\) and \(pointer:fine\) and \(min-width:721px\) and \(max-width:1147px\)\{\.wrap\{padding-left:calc\(env\(safe-area-inset-left\) \+ 92px\)\}\}/);
  assert.doesNotMatch(page, /\.nav-rail\{[^}]*width:64px/);
});
```

Extend `tests/site-i18n.test.mjs`'s `required` array with `"exits.empty",`.

In `hiddenSectionsGroupHarness` (`tests/page-runtime.test.mjs:347-379`), add two entries to the `nodes` map and expose them on the returned object:

```js
    ["restoreAllHiddenBtn", new FakeElement("restoreAllHiddenBtn")],
```

```js
    restoreAllHiddenBtn: nodes.get("restoreAllHiddenBtn"),
    recentExitsList: nodes.get("recentExitsList"),
```

Also give that harness's `FakeElement` an `innerHTML` field defaulting to `""` if it does not already have one, and a `disabled` field defaulting to `false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL — the first new test fails at `assert.match(mobile, /\.repo-link\{display:inline-block;padding:9px 0\}/)`; the History test fails with `TypeError: Cannot read properties of undefined (reading 'disabled')` from `updateHiddenManager` because the harness now expects the button node; site-i18n fails with `en is missing exits.empty`.

- [ ] **Step 3: Write the implementation**

**3a. Tap targets.** Inside the `@media(max-width:560px)` block (`index.html:400-412`) add:

```css
  .repo-link{display:inline-block;padding:9px 0}
  #resetBtn{display:inline-block;padding:7px 0}
```

(26px + 18px = 44px for the link; 31px + 14px = 45px for the reset button. Neither changes the font size.)

**3b. History empty states.** Add after `.clear-filters{…}` (`index.html:212`):

```css
.clear-filters:disabled{opacity:.5;cursor:not-allowed}
```

In `updateHiddenManager()` (`index.html:1134-1140`) change the section-visibility line and add the disabled assignment:

```js
function updateHiddenManager(){
  const section=document.getElementById("hiddenRepoSection"),listBox=document.getElementById("hiddenRepoList");
  const slugs=[...hiddenSet];section.hidden=sidebar.dataset.group!=="history";
  document.getElementById("hiddenRepoCount").textContent=tr("hidden.count",{count:slugs.length});
  // An enabled button that provably cannot do anything teaches the reader that controls here are
  // unreliable; the count above it already says zero.
  document.getElementById("restoreAllHiddenBtn").disabled=!slugs.length;
  listBox.innerHTML=slugs.map(slug=>`<div class="hidden-repo-row"><span class="hidden-repo-name">${esc(repoLabel(slug))}</span><button class="hidden-restore" type="button" data-restore-hidden="${esc(slug)}" aria-label="${esc(tr("hidden.restoreRepo",{name:repoLabel(slug)}))}">${tr("common.restore")}</button></div>`).join("");
}
```

In `renderRecentExits()` (`index.html:1142-1147`):

```js
function renderRecentExits(exited=[]){
  currentRecentExits=exited;
  const section=document.getElementById("recentExitsSection"),recentExitsList=document.getElementById("recentExitsList");
  section.hidden=sidebar.dataset.group!=="history";
  // A blank region cannot be told apart from a region that failed to load, so say which it is.
  recentExitsList.innerHTML=exited.length
    ?exited.map(item=>`<a class="recent-exit-link" href="https://github.com/${esc(item.slug)}" target="_blank" rel="noopener">${esc(repoLabel(item.slug))} ↗</a>`).join("")
    :`<p class="sidebar-note">${esc(tr("exits.empty"))}</p>`;
}
```

**3c. Korean word breaking and rail width.** Five edits:
- `index.html:62`: `.sub{color:var(--text-2);font-size:15px;margin-top:6px;letter-spacing:.01em;word-break:keep-all;overflow-wrap:normal}`
- `index.html:114`: `.nav-label{line-height:1;word-break:keep-all;overflow-wrap:normal}`
- `index.html:91`: `width:64px` → `width:76px`
- `index.html:96`: `width:48px` → `width:60px` (the rail's 8px side padding leaves 60px of content width, so the button now fills it and `내보내기` fits on one line at 10px)
- `index.html:146`: `.filter-sidebar{left:64px;width:min(336px,calc(100vw - 64px));transform:translate3d(calc(-100% - 64px),0,0)}` → all three `64px` become `76px`
- `index.html:413`: `+ 80px` → `+ 92px`

Then update the four pre-existing assertions that pin the old tokens: `tests/page-runtime.test.mjs:1061` (rename the test title from `64px` to `76px`), `:1065-1066`, `:1318`, `:1992`, `:2779`. `word-break: keep-all` is the correct CJK rule and is a no-op for the four Latin locales.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS, including the pre-existing `F1:` tests at `:1431` and `:1440` — both pass populated data and assert `hidden === true` outside History and `false` inside it, which the group-only condition still satisfies.

- [ ] **Step 5: Add the locale strings**

```js
// EN
  "exits.empty":"No repository has left the list yet.",
// KO
  "exits.empty":"아직 목록에서 이탈한 저장소가 없습니다.",
// ZH
  "exits.empty":"还没有仓库离开列表。",
// ES
  "exits.empty":"Todavía ningún repositorio ha salido de la lista.",
// JA
  "exits.empty":"リストから外れたリポジトリはまだありません。",
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 7: Commit**

```bash
git add index.html site-i18n.js tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "fix: enlarge mobile tap targets, complete History empty states, and widen the rail"
```

---

### Task 8: Head metadata and a `<noscript>` fallback

**Problems (Assessment A, "Note on share-a-view"; Assessment B §3):** the document ships exactly one meta tag — `viewport` — so a shared link previews as a bare title, and Lighthouse fails `meta-description` on both desktop and mobile. The entire list renders from an inline data blob via JS, and with scripts off the reader gets a header and nothing else, silently.

**Files:**
- Modify: `index.html:5` region (`<head>`), `index.html:353` region (add `.noscript-note`), `index.html:635` region (add `<noscript>` inside `<main>`)
- Test: `tests/page-runtime.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. Static English is deliberate here: the document is served as English (`<html lang="en">` at `index.html:2`) and these tags are read by crawlers and unfurlers before `site-i18n.js` hydrates.

- [ ] **Step 1: Write the failing test**

Add to `tests/page-runtime.test.mjs`:

```js
test("the head describes the page for crawlers and unfurlers without a new request", () => {
  const head = page.match(/<head>[\s\S]*?<\/head>/)?.[0] ?? "";
  assert.match(head, /<meta name="description" content="GITHUB INSIGHT — today’s GitHub Trending repositories with source-bound README summaries, star history, and filters for field, form, language, and period\.">/);
  assert.match(head, /<meta name="theme-color" content="#f5f5f7" media="\(prefers-color-scheme: light\)">/);
  assert.match(head, /<meta name="theme-color" content="#282828" media="\(prefers-color-scheme: dark\)">/);
  assert.match(head, /<meta property="og:type" content="website">/);
  assert.match(head, /<meta property="og:title" content="GITHUB INSIGHT">/);
  assert.match(head, /<meta property="og:description" content="Today’s GitHub Trending repositories with source-bound README summaries, star history, and filters for field, form, language, and period\.">/);
  assert.match(head, /<meta property="og:url" content="https:\/\/nowwcastle-sudo\.github\.io\/github-trending-daily\/">/);
  // No og:image: it would be a new external request and there is no first-party image to point at.
  assert.doesNotMatch(head, /og:image/);
  // The CSP is untouched.
  assert.match(head, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https:\/\/www\.gstatic\.com https:\/\/www\.google\.com https:\/\/apis\.google\.com;/);
});

test("a script-free visitor is told why the list is empty and where the feeds are", () => {
  const main = page.match(/<main class="wrap" id="mainContent" tabindex="-1">([\s\S]*?)<\/main>/)?.[1] ?? "";
  assert.match(main, /<noscript><p class="noscript-note">This page builds its repository list with JavaScript\. Turn JavaScript on, or subscribe to the Atom feeds: <a href="feed\.xml">feed\.xml<\/a> · <a href="changes\.xml">changes\.xml<\/a>\.<\/p><\/noscript>/);
  assert.match(page, /\.noscript-note\{[^}]*border:1px solid var\(--surface-border\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/page-runtime.test.mjs`
Expected: FAIL at the `<meta name="description"…>` match — the head has only `charset`, `viewport`, the CSP, `<title>` and the two `<link rel="alternate">` tags.

- [ ] **Step 3: Write the implementation**

Insert immediately after `index.html:5` (`<meta name="viewport" …>`) and before the CSP meta:

```html
<meta name="description" content="GITHUB INSIGHT — today’s GitHub Trending repositories with source-bound README summaries, star history, and filters for field, form, language, and period.">
<meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#282828" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:title" content="GITHUB INSIGHT">
<meta property="og:description" content="Today’s GitHub Trending repositories with source-bound README summaries, star history, and filters for field, form, language, and period.">
<meta property="og:url" content="https://nowwcastle-sudo.github.io/github-trending-daily/">
```

The two `theme-color` values are the `--bg` tokens already in `:root` (`#f5f5f7`) and `html[data-theme="dark"]` (`#282828`) — do not invent new colours.

Add after `footer a{color:var(--text-2)}` (`index.html:374`):

```css
.noscript-note{margin:18px 0;padding:12px 14px;border:1px solid var(--surface-border);border-radius:12px;background:var(--card);color:var(--text-2);font-size:13.5px;line-height:1.5}
.noscript-note a{color:var(--accent-selected)}
```

Add inside `<main>`, immediately before `<p id="cardKeyboardHint" …>` (`index.html:636`):

```html
<noscript><p class="noscript-note">This page builds its repository list with JavaScript. Turn JavaScript on, or subscribe to the Atom feeds: <a href="feed.xml">feed.xml</a> · <a href="changes.xml">changes.xml</a>.</p></noscript>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/page-runtime.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/page-runtime.test.mjs
git commit -m "feat: add page description, Open Graph, theme-color, and a noscript note"
```

---

### Task 9: "New since your last visit"

**Problem (Assessment A, convenience candidate 3, M):** the daily or weekly returner has to remember which of 52 repositories they already saw. This is **not** the existing `membership_status: "new"` badge — that is baseline-relative and identical for every reader, whereas this is relative to *this* person's last visit, which is the question a returner actually has. The heading it needs also answers the Krug trunk-test finding that the repository list is an unlabelled region with no heading of its own.

**Files:**
- Create: `visit-tracker.js`
- Create: `tests/visit-tracker.test.mjs`
- Modify: `index.html:679` region (script tag), `index.html:302` region (add `.list-heading` and `.visit-new`), `index.html:636` region (heading markup), `index.html:695-700` (locale-change listener), `index.html:709` region (record the visit), `index.html:1273` region (card badge), `site-i18n.js`
- Test: `tests/visit-tracker.test.mjs`, `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: `Favorites`-style storage conventions; `tr(key, parameters)`; the `site-locale-change` listener at `index.html:695`.
- Produces `globalThis.VisitTracker` with exactly:
  - `LAST_VISIT_KEY` — `"gi.visit.lastAt"`
  - `SEEN_KEY` — `"gi.visit.seen"`
  - `SEEN_LIMIT` — `1000`
  - `isValidSlug(value) -> boolean`
  - `normalizeSlugs(value) -> string[]` — de-duplicated, valid slugs only, keeping the **last** `SEEN_LIMIT`
  - `readLastVisit(storage) -> string|null` — a strict `YYYY-MM-DDTHH:MM:SS.mmmZ` round-trip, else `null`
  - `readSeen(storage) -> string[]`
  - `newSlugs({slugs, seen}) -> string[]`
  - `recordVisit(storage, {slugs, now}) -> {previousVisitAt: string|null, newSlugs: string[], seen: string[]}`
- Produces in the page: element id `listHeading`, the constant `visitSummary`, the set `newSinceLastVisit`, the function `updateVisitHeading()`, and message keys `visit.heading`, `visit.newSince`, `visit.noneSince`, `visit.badge`, `visit.badgeTitle`.
- **Does not touch** `MEMBERSHIP_STATUS`, `membership-new`, `membership-reentered`, or `badges.new*`.

- [ ] **Step 1: Write the failing module test**

Create `tests/visit-tracker.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

async function loadVisitTracker() {
  await import("../visit-tracker.js");
  return globalThis.VisitTracker;
}

test("the first visit marks nothing new and records what was on the page", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();

  const summary = VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two"], now: "2026-09-05T00:00:00.000Z" });

  assert.equal(summary.previousVisitAt, null);
  assert.deepEqual(summary.newSlugs, []);
  assert.deepEqual(VisitTracker.readSeen(storage), ["owner/one", "owner/two"]);
  assert.equal(VisitTracker.readLastVisit(storage), "2026-09-05T00:00:00.000Z");
});

test("a return visit reports only the repositories that were not there before", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();
  VisitTracker.recordVisit(storage, { slugs: ["owner/one"], now: "2026-09-03T00:00:00.000Z" });

  const summary = VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two", "owner/three"], now: "2026-09-05T00:00:00.000Z" });

  assert.equal(summary.previousVisitAt, "2026-09-03T00:00:00.000Z");
  assert.deepEqual(summary.newSlugs, ["owner/two", "owner/three"]);
  assert.equal(VisitTracker.readLastVisit(storage), "2026-09-05T00:00:00.000Z");
});

test("a repository seen once never becomes new again", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();
  VisitTracker.recordVisit(storage, { slugs: ["owner/one"], now: "2026-09-03T00:00:00.000Z" });
  VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two"], now: "2026-09-04T00:00:00.000Z" });

  const summary = VisitTracker.recordVisit(storage, { slugs: ["owner/one", "owner/two"], now: "2026-09-05T00:00:00.000Z" });

  assert.deepEqual(summary.newSlugs, []);
});

test("the seen set is capped at 1000 slugs, keeping the most recent", async () => {
  const VisitTracker = await loadVisitTracker();
  const storage = memoryStorage();
  const first = Array.from({ length: 1000 }, (_, index) => `owner/old${index}`);
  VisitTracker.recordVisit(storage, { slugs: first, now: "2026-09-03T00:00:00.000Z" });

  VisitTracker.recordVisit(storage, { slugs: ["owner/fresh"], now: "2026-09-05T00:00:00.000Z" });
  const seen = VisitTracker.readSeen(storage);

  assert.equal(seen.length, VisitTracker.SEEN_LIMIT);
  assert.equal(seen.at(-1), "owner/fresh");
  assert.equal(seen.includes("owner/old0"), false, "the oldest entry is dropped, not the newest");
});

test("malformed slugs, malformed timestamps and unreadable storage never throw", async () => {
  const VisitTracker = await loadVisitTracker();

  const corrupt = memoryStorage({ "gi.visit.seen": "{not json", "gi.visit.lastAt": "yesterday" });
  assert.deepEqual(VisitTracker.readSeen(corrupt), []);
  assert.equal(VisitTracker.readLastVisit(corrupt), null);

  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const summary = VisitTracker.recordVisit(blocked, { slugs: ["owner/one"], now: "2026-09-05T00:00:00.000Z" });
  assert.equal(summary.previousVisitAt, null);
  assert.deepEqual(summary.newSlugs, []);

  const storage = memoryStorage();
  VisitTracker.recordVisit(storage, { slugs: ["owner/one", "not a slug", 7, "owner//two"], now: "not-a-time" });
  assert.deepEqual(VisitTracker.readSeen(storage), ["owner/one"]);
  assert.equal(VisitTracker.readLastVisit(storage), null, "an invalid timestamp is not written");
});
```

- [ ] **Step 2: Run the module test to verify it fails**

Run: `node --test tests/visit-tracker.test.mjs`
Expected: FAIL with `Cannot find module '.../visit-tracker.js'`.

- [ ] **Step 3: Write the module**

Create `visit-tracker.js`:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VisitTracker = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LAST_VISIT_KEY = "gi.visit.lastAt";
  const SEEN_KEY = "gi.visit.seen";
  const SEEN_LIMIT = 1000;
  const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function isValidSlug(value) {
    return typeof value === "string" && value.length <= 201 && SLUG_RE.test(value);
  }

  function normalizeSlugs(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(isValidSlug))].slice(-SEEN_LIMIT);
  }

  function checkedTime(value) {
    if (typeof value !== "string" || !TIME_RE.test(value)) return null;
    return new Date(value).toISOString() === value ? value : null;
  }

  function readSeen(storage) {
    try { return normalizeSlugs(JSON.parse(storage.getItem(SEEN_KEY) || "[]")); }
    catch { return []; }
  }

  function readLastVisit(storage) {
    try { return checkedTime(storage.getItem(LAST_VISIT_KEY)); }
    catch { return null; }
  }

  function newSlugs({ slugs, seen }) {
    const known = new Set(normalizeSlugs(seen));
    return normalizeSlugs(slugs).filter(slug => !known.has(slug));
  }

  // A reader who has never been here has no "new to you" set — everything is new, which is the
  // same as nothing being marked. previousVisitAt === null is what the page renders the plain
  // heading from.
  function recordVisit(storage, { slugs, now }) {
    const current = normalizeSlugs(slugs);
    const previousVisitAt = readLastVisit(storage);
    const seen = readSeen(storage);
    const fresh = previousVisitAt === null ? [] : newSlugs({ slugs: current, seen });
    const merged = normalizeSlugs([...seen, ...current]);
    const stamp = checkedTime(now);
    try {
      storage.setItem(SEEN_KEY, JSON.stringify(merged));
      if (stamp) storage.setItem(LAST_VISIT_KEY, stamp);
    } catch { /* a browser with storage off still renders the list */ }
    return { previousVisitAt, newSlugs: fresh, seen: merged };
  }

  return { LAST_VISIT_KEY, SEEN_KEY, SEEN_LIMIT, isValidSlug, normalizeSlugs, readSeen, readLastVisit, newSlugs, recordVisit };
});
```

- [ ] **Step 4: Run the module test to verify it passes**

Run: `node --test tests/visit-tracker.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing page test**

Add to `tests/page-runtime.test.mjs`:

```js
test("the list carries a heading that reports what is new since the reader's last visit", () => {
  assert.match(page, /<script src="visit-tracker\.js"><\/script>/);
  assert.match(page, /<h2 class="list-heading" id="listHeading" data-i18n="visit\.heading">Trending repositories<\/h2>/);
  const hintIndex = page.indexOf('id="cardKeyboardHint"');
  const headingIndex = page.indexOf('id="listHeading"');
  const stageIndex = page.indexOf('class="list-stage" id="listStage"');
  assert.ok(hintIndex < headingIndex && headingIndex < stageIndex, "the heading sits directly above the list");

  assert.match(page, /const visitSummary=VisitTracker\.recordVisit\(storage,\{slugs:REPOS\.map\(repo=>repo\.slug\),now:new Date\(\)\.toISOString\(\)\}\);/);
  assert.match(page, /const newSinceLastVisit=new Set\(visitSummary\.newSlugs\);/);
  assert.match(page, /function updateVisitHeading\(\)\{/);
  assert.match(page, /tr\("visit\.newSince",\{count:visitSummary\.newSlugs\.length,date\}\)/);
  assert.match(page, /tr\("visit\.noneSince",\{date\}\)/);
  assert.match(page, /updateRefreshStatus\(\);renderRecentExits\(currentRecentExits\);renderHist\(\);updateVisitHeading\(\);/);

  // The badge is additive: the baseline-relative membership badge is untouched.
  assert.match(page, /const visitBadge=newSinceLastVisit\.has\(r\.slug\)\?`<span class="badge visit-new" title="\$\{tr\("visit\.badgeTitle"\)\}">\$\{tr\("visit\.badge"\)\}<\/span>`:"";/);
  assert.match(page, /\$\{membershipBadge\}\$\{visitBadge\}/);
  assert.match(page, /membership==="new"\?`<span class="badge membership-new"/);
  assert.match(page, /\.visit-new\{color:var\(--text\);background:var\(--seg-bg\)\}/);
  assert.match(page, /\.list-heading\{[^}]*color:var\(--text-2\)/);
});
```

Extend `tests/site-i18n.test.mjs`'s `required` array with:

```js
    "visit.heading", "visit.newSince", "visit.noneSince", "visit.badge", "visit.badgeTitle",
```

and add:

```js
test("the new-since-last-visit heading interpolates its count and date in every locale", () => {
  const i18n = load();
  for (const locale of i18n.SUPPORTED_LOCALES) {
    assert.ok(i18n.MESSAGES[locale]["visit.newSince"].includes("{count}"), `${locale} visit.newSince needs {count}`);
    assert.ok(i18n.MESSAGES[locale]["visit.newSince"].includes("{date}"), `${locale} visit.newSince needs {date}`);
    assert.ok(i18n.MESSAGES[locale]["visit.noneSince"].includes("{date}"), `${locale} visit.noneSince needs {date}`);
    assert.equal(i18n.MESSAGES[locale]["visit.noneSince"].includes("{count}"), false, `${locale} visit.noneSince must not need {count}`);
  }
});
```

- [ ] **Step 6: Run the page test to verify it fails**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL at `assert.match(page, /<script src="visit-tracker\.js"><\/script>/)`.

- [ ] **Step 7: Wire it into the page**

Add the script tag after `<script src="current-view-export.js"></script>` (`index.html:679`):

```html
<script src="visit-tracker.js"></script>
```

Add CSS after `.membership-reentered{…}` (`index.html:300`):

```css
.list-heading{margin-top:18px;color:var(--text-2);font-size:15px;font-weight:650;letter-spacing:-.005em;line-height:1.4}
/* Deliberately not the membership palette: "new to you" is a different claim from "new to the
   list", and the two must be distinguishable when a card carries both. */
.visit-new{color:var(--text);background:var(--seg-bg)}
```

Add the heading markup between `#cardKeyboardHint` (`index.html:636`) and `<div class="list-stage" …>`:

```html
<h2 class="list-heading" id="listHeading" data-i18n="visit.heading">Trending repositories</h2>
```

After `let hiddenSet=new Set(HiddenRepos.read(storage)),lastHiddenSlug=null;` (`index.html:709`) add:

```js
// Recorded once per page load, before the first render, so every render this session sees the same
// answer. REPOS is the generated data above; the diff is against what this browser last saw.
const visitSummary=VisitTracker.recordVisit(storage,{slugs:REPOS.map(repo=>repo.slug),now:new Date().toISOString()});
const newSinceLastVisit=new Set(visitSummary.newSlugs);
function updateVisitHeading(){
  const heading=document.getElementById("listHeading");
  if(!visitSummary.previousVisitAt){heading.textContent=tr("visit.heading");return}
  const date=visitSummary.previousVisitAt.slice(0,10);
  heading.textContent=visitSummary.newSlugs.length
    ?tr("visit.newSince",{count:visitSummary.newSlugs.length,date})
    :tr("visit.noneSince",{date});
}
updateVisitHeading();
```

In the `site-locale-change` listener (`index.html:695-700`), append `updateVisitHeading();` to the last line so it reads:

```js
  updateRefreshStatus();renderRecentExits(currentRecentExits);renderHist();updateVisitHeading();
```

(`SiteI18n.apply()` rewrites `[data-i18n]` text before it dispatches the event, so the plain heading lands first and this call replaces it with the right one.)

In the card template (`index.html:1270-1273`), immediately after the `const membershipBadge=…` line add:

```js
    const visitBadge=newSinceLastVisit.has(r.slug)?`<span class="badge visit-new" title="${tr("visit.badgeTitle")}">${tr("visit.badge")}</span>`:"";
```

and in the `.cname` line change `${membershipBadge}` to `${membershipBadge}${visitBadge}`.

- [ ] **Step 8: Add the five locales**

```js
// EN
  "visit.heading":"Trending repositories",
  "visit.newSince":"Trending repositories · {count} new since {date}",
  "visit.noneSince":"Trending repositories · nothing new since {date}",
  "visit.badge":"New to you",
  "visit.badgeTitle":"Not in the list the last time you visited",
// KO
  "visit.heading":"트렌딩 저장소","visit.newSince":"트렌딩 저장소 · {date} 이후 새로 {count}개","visit.noneSince":"트렌딩 저장소 · {date} 이후 새로운 저장소 없음","visit.badge":"처음 봄","visit.badgeTitle":"지난 방문 때 목록에 없던 저장소",
// ZH
  "visit.heading":"趋势仓库","visit.newSince":"趋势仓库 · 自 {date} 起新增 {count} 个","visit.noneSince":"趋势仓库 · 自 {date} 起没有新增","visit.badge":"你的新发现","visit.badgeTitle":"上次访问时不在列表中",
// ES
  "visit.heading":"Repositorios en tendencia","visit.newSince":"Repositorios en tendencia · {count} nuevos desde el {date}","visit.noneSince":"Repositorios en tendencia · nada nuevo desde el {date}","visit.badge":"Nuevo para ti","visit.badgeTitle":"No estaba en la lista en tu última visita",
// JA
  "visit.heading":"トレンドのリポジトリ","visit.newSince":"トレンドのリポジトリ · {date} 以降の新着 {count} 件","visit.noneSince":"トレンドのリポジトリ · {date} 以降の新着なし","visit.badge":"あなたに新着","visit.badgeTitle":"前回の訪問時には一覧になかったリポジトリ",
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/visit-tracker.test.mjs tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS. The pre-existing `the filter bar sits under the badge guide and owns period, language, quick filters and copy link` test (`:2040`) still passes — its `asideEnd < barIndex < hintIndex` chain is unaffected by an element added after the hint.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 11: Commit**

```bash
git add visit-tracker.js index.html site-i18n.js tests/visit-tracker.test.mjs tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "feat: mark repositories that are new since the visitor's last visit"
```

---

### Task 10: Compact list mode

**Problem (Assessment A, convenience candidate 4, M):** 52 cards at 428px each is roughly 22,000px of scrolling. The reader who already knows the badge vocabulary wants throughput, not explanation.

**Files:**
- Modify: `index.html:253` and `:257` (rename `filter-bar-row-3` → `filter-bar-row-4`), `index.html:302` region (add the `body.compact` rules), `index.html:628-632` (add the toggle), `index.html:709` region (read the preference), `index.html:1349` region (add the handler)
- Test: `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: the `filter-toggle-row` class and the mobile scroll rules from Task 1; `setFilterBarStatus` is **not** used here (the toggle is instant and self-evident).
- Produces: element id `compactToggle`; storage key `gi.view.compact`; message key `filter.compact`; the CSS class `filter-bar-row-4` replaces `filter-bar-row-3` on the toggle row.

- [ ] **Step 1: Write the failing tests**

Add to `tests/page-runtime.test.mjs`:

```js
test("a compact list mode is a fourth filter-bar toggle persisted per browser", () => {
  const bar = page.match(/<section class="filter-bar" id="filterBar"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(bar, /<div class="filter-bar-row filter-bar-row-4 filter-toggle-row">/);
  assert.match(bar, /<button type="button" id="compactToggle" class="filter-toggle" aria-pressed="false" data-i18n="filter\.compact">Compact list<\/button>/);
  const order = ["excludeAi", "newOnly", "copyLinkBtn", "compactToggle", "filterBarStatus"];
  let previous = -1;
  for (const id of order) {
    const position = bar.indexOf(`id="${id}"`);
    assert.ok(position > previous, `${id} must appear in the approved filter-bar order`);
    previous = position;
  }

  assert.match(page, /\.filter-bar-row-4>\*\{flex:1 1 calc\(\(100% - 48px\)\/4\);max-width:calc\(\(100% - 48px\)\/4\)\}/);
  assert.match(page, /@media\(max-width:600px\)\{\.filter-bar-row>\*,\.filter-bar-row-4>\*\{flex:1 1 100%;max-width:100%\}\}/);
  assert.doesNotMatch(page, /filter-bar-row-3/);

  assert.match(page, /const COMPACT_VIEW_KEY="gi\.view\.compact";/);
  assert.match(page, /try\{compactView=storage\.getItem\(COMPACT_VIEW_KEY\)==="1"\}catch\{\}/);
  assert.match(page, /function applyCompactView\(\)\{/);
  assert.match(page, /document\.body\.classList\.toggle\("compact",compactView\);/);
  assert.match(page, /document\.getElementById\("compactToggle"\)\.setAttribute\("aria-pressed",String\(compactView\)\);/);

  assert.match(page, /body\.compact \.card\{padding:11px 14px;margin-bottom:7px\}/);
  assert.match(page, /body\.compact \.cdesc\{-webkit-line-clamp:1;margin:4px 0 6px\}/);
  assert.match(page, /body\.compact \.category-badges,body\.compact \.spark,body\.compact \.sparkhist\{display:none\}/);
});
```

Extend `tests/site-i18n.test.mjs`'s `required` array with `"filter.compact",`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL at `assert.match(bar, /<div class="filter-bar-row filter-bar-row-4 filter-toggle-row">/)`; site-i18n fails with `en is missing filter.compact`.

- [ ] **Step 3: Write the implementation**

Rename the three-up row class to a four-up one. `index.html:253`:

```css
.filter-bar-row-4>*{flex:1 1 calc((100% - 48px)/4);max-width:calc((100% - 48px)/4)}
```

`index.html:257`:

```css
@media(max-width:600px){.filter-bar-row>*,.filter-bar-row-4>*{flex:1 1 100%;max-width:100%}}
```

`index.html:628`:

```html
  <div class="filter-bar-row filter-bar-row-4 filter-toggle-row">
```

Add the button after `#copyLinkBtn` (`index.html:631`):

```html
    <button type="button" id="compactToggle" class="filter-toggle" aria-pressed="false" data-i18n="filter.compact">Compact list</button>
```

Update the two pre-existing assertions that pin the old class — `tests/page-runtime.test.mjs:2070` and `:2071` — to `filter-bar-row-4` and the four-up `calc` values.

Add CSS after `.membership-reentered{…}` (`index.html:300`):

```css
/* Compact mode is for the reader who already knows the badge vocabulary: it drops the explanatory
   rows (classification badges, both sparklines) and the second description line, roughly tripling
   the repositories per screen. Nothing is removed from the DOM, so Ctrl+F still finds everything. */
body.compact .card{padding:11px 14px;margin-bottom:7px}
body.compact .cdesc{-webkit-line-clamp:1;margin:4px 0 6px}
body.compact .category-badges,body.compact .spark,body.compact .sparkhist{display:none}
```

After the visit-tracker block (`index.html:709` region) add:

```js
const COMPACT_VIEW_KEY="gi.view.compact";
let compactView=false;
try{compactView=storage.getItem(COMPACT_VIEW_KEY)==="1"}catch{}
function applyCompactView(){
  document.body.classList.toggle("compact",compactView);
  document.getElementById("compactToggle").setAttribute("aria-pressed",String(compactView));
}
applyCompactView();
```

After the `#copyLinkBtn` click handler (`index.html:1394`) add:

```js
document.getElementById("compactToggle").addEventListener("click",()=>{
  compactView=!compactView;
  try{storage.setItem(COMPACT_VIEW_KEY,compactView?"1":"0")}catch{}
  applyCompactView();
});
```

Add the locale strings:

```js
// EN
  "filter.compact":"Compact list",
// KO
  "filter.compact":"간단히 보기",
// ZH
  "filter.compact":"紧凑列表",
// ES
  "filter.compact":"Lista compacta",
// JA
  "filter.compact":"コンパクト表示",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS, including the updated `the filter bar rows never sum past the card column` test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html site-i18n.js tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "feat: add a compact list mode toggle"
```

---

### Task 11: Saved filter presets

**Problem (Assessment A, convenience candidate 5, S/M):** reconstructing a multi-field filter ("Rust + CLI, weekly, sorted by gain") takes a trip through a 1.84-screen panel every time. `repo-filters.js` already has `serializeState`/`parseState`, so a preset is just a stored query string with a name — no new state model.

**Files:**
- Create: `filter-presets.js`
- Create: `tests/filter-presets.test.mjs`
- Modify: `index.html:679` region (script tag), `index.html:213` region (add `.preset-*` CSS), `index.html:534` region (new `#presetSection` before `#resultSection`), `index.html:1355` region (handlers)
- Test: `tests/filter-presets.test.mjs`, `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: `RepoFilters.serializeState(state) -> string` (returns `""` or `"?…"`), `RepoFilters.parseState(search, languages) -> state`, `applyFilterState(next)` (`index.html:1105`), `currentExportState()` (`index.html:1370`), `syncUrl()` (`index.html:1046`), `LANGUAGES` (`index.html:702`), `esc()` and `tr()`.
- Produces `globalThis.FilterPresets` with exactly:
  - `PRESETS_KEY` — `"gi.presets"`
  - `PRESET_LIMIT` — `20`
  - `NAME_LIMIT` — `40`
  - `QUERY_LIMIT` — `512`
  - `normalizeName(value) -> string` — trimmed, at most `NAME_LIMIT` characters, `""` when invalid
  - `isValidQuery(value) -> boolean` — a string, at most `QUERY_LIMIT` characters, either `""` or starting with `"?"`
  - `read(storage) -> {name: string, query: string}[]`
  - `save(storage, {name, query}) -> {name, query}[]` — replaces a same-named preset; throws `Error("preset name is required")`, `Error("invalid preset query")`, or `Error("presets cannot exceed 20")`
  - `remove(storage, name) -> {name, query}[]`
- Produces in the page: element ids `presetSection`, `presetTitle`, `presetForm`, `presetName`, `presetSaveBtn`, `presetList`, `presetStatus`; message keys `preset.title`, `preset.note`, `preset.nameLabel`, `preset.namePlaceholder`, `preset.save`, `preset.apply`, `preset.delete`, `preset.empty`, `preset.saved`, `preset.deleted`, `preset.limit`, `preset.nameRequired`, `preset.saveError`.

- [ ] **Step 1: Write the failing module test**

Create `tests/filter-presets.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

async function loadFilterPresets() {
  await import("../filter-presets.js");
  return globalThis.FilterPresets;
}

test("a preset persists across a browser reload", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();

  const saved = FilterPresets.save(storage, { name: "Rust CLI", query: "?lang=Rust&tag=cli" });

  assert.deepEqual(saved, [{ name: "Rust CLI", query: "?lang=Rust&tag=cli" }]);
  assert.deepEqual(FilterPresets.read(storage), [{ name: "Rust CLI", query: "?lang=Rust&tag=cli" }]);
});

test("saving the same name replaces that preset instead of duplicating it", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();
  FilterPresets.save(storage, { name: "Weekly", query: "?period=weekly" });

  const saved = FilterPresets.save(storage, { name: "Weekly", query: "?period=weekly&sort=gain" });

  assert.deepEqual(saved, [{ name: "Weekly", query: "?period=weekly&sort=gain" }]);
});

test("a preset can be deleted without touching the others", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();
  FilterPresets.save(storage, { name: "One", query: "?period=daily" });
  FilterPresets.save(storage, { name: "Two", query: "?period=weekly" });

  assert.deepEqual(FilterPresets.remove(storage, "One"), [{ name: "Two", query: "?period=weekly" }]);
});

test("the default view serializes to an empty query and is still a valid preset", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();

  assert.equal(FilterPresets.isValidQuery(""), true);
  assert.deepEqual(FilterPresets.save(storage, { name: "Everything", query: "" }), [{ name: "Everything", query: "" }]);
});

test("names are trimmed to 40 characters and blank names are refused", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();

  assert.equal(FilterPresets.normalizeName(`  ${"n".repeat(60)}  `).length, FilterPresets.NAME_LIMIT);
  assert.throws(() => FilterPresets.save(storage, { name: "   ", query: "" }), /preset name is required/);
  assert.throws(() => FilterPresets.save(storage, { name: "Bad", query: "lang=Rust" }), /invalid preset query/);
});

test("the twenty-first preset is refused rather than silently dropping an older one", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();
  for (let index = 0; index < FilterPresets.PRESET_LIMIT; index += 1) {
    FilterPresets.save(storage, { name: `Preset ${index}`, query: `?q=${index}` });
  }

  assert.throws(() => FilterPresets.save(storage, { name: "One too many", query: "?q=x" }), /presets cannot exceed 20/);
  assert.equal(FilterPresets.read(storage).length, FilterPresets.PRESET_LIMIT);
});

test("corrupt or unreadable storage reads as an empty list", async () => {
  const FilterPresets = await loadFilterPresets();

  assert.deepEqual(FilterPresets.read(memoryStorage({ "gi.presets": "{not json" })), []);
  assert.deepEqual(FilterPresets.read(memoryStorage({ "gi.presets": '[{"name":"","query":"?q=1"},{"name":"Ok","query":7}]' })), []);
  assert.deepEqual(FilterPresets.read({ getItem() { throw new Error("blocked"); } }), []);
});
```

- [ ] **Step 2: Run the module test to verify it fails**

Run: `node --test tests/filter-presets.test.mjs`
Expected: FAIL with `Cannot find module '.../filter-presets.js'`.

- [ ] **Step 3: Write the module**

Create `filter-presets.js`:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FilterPresets = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRESETS_KEY = "gi.presets";
  const PRESET_LIMIT = 20;
  const NAME_LIMIT = 40;
  const QUERY_LIMIT = 512;

  function normalizeName(value) {
    return typeof value === "string" ? value.trim().slice(0, NAME_LIMIT) : "";
  }

  // A preset is exactly what RepoFilters.serializeState returns: "" for the default view, or a
  // query string beginning with "?". Nothing else is storable, so nothing else is applied.
  function isValidQuery(value) {
    return typeof value === "string" && value.length <= QUERY_LIMIT && (value === "" || value.startsWith("?"));
  }

  function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const presets = [];
    for (const entry of value) {
      const name = normalizeName(entry?.name);
      if (!name || seen.has(name) || !isValidQuery(entry?.query)) return [];
      seen.add(name);
      presets.push({ name, query: entry.query });
    }
    return presets.slice(0, PRESET_LIMIT);
  }

  function read(storage) {
    try { return normalizeList(JSON.parse(storage.getItem(PRESETS_KEY) || "[]")); }
    catch { return []; }
  }

  function write(storage, presets) {
    storage.setItem(PRESETS_KEY, JSON.stringify(presets));
    return presets;
  }

  function save(storage, { name, query }) {
    const cleanName = normalizeName(name);
    if (!cleanName) throw new Error("preset name is required");
    if (!isValidQuery(query)) throw new Error("invalid preset query");
    const presets = read(storage);
    const index = presets.findIndex(preset => preset.name === cleanName);
    if (index >= 0) return write(storage, presets.map((preset, position) => position === index ? { name: cleanName, query } : preset));
    if (presets.length >= PRESET_LIMIT) throw new Error("presets cannot exceed 20");
    return write(storage, [...presets, { name: cleanName, query }]);
  }

  function remove(storage, name) {
    const cleanName = normalizeName(name);
    return write(storage, read(storage).filter(preset => preset.name !== cleanName));
  }

  return { PRESETS_KEY, PRESET_LIMIT, NAME_LIMIT, QUERY_LIMIT, normalizeName, isValidQuery, read, save, remove };
});
```

- [ ] **Step 4: Run the module test to verify it passes**

Run: `node --test tests/filter-presets.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing page test**

Add to `tests/page-runtime.test.mjs`:

```js
test("the Explore panel saves, lists, applies and deletes named filter presets", () => {
  assert.match(page, /<script src="filter-presets\.js"><\/script>/);
  const sidebar = page.match(/<div[^>]*id="filterSidebar"[\s\S]*?<\/div>\s*<nav class="nav-rail"/)?.[0] ?? "";
  assert.ok(sidebar.indexOf('id="sortSection"') < sidebar.indexOf('id="presetSection"'), "presets follow Sort");
  assert.ok(sidebar.indexOf('id="presetSection"') < sidebar.indexOf('id="resultSection"'), "the sticky result strip stays last");
  assert.match(sidebar, /<section class="sidebar-section" id="presetSection" aria-labelledby="presetTitle" data-group="explore">/);
  assert.match(sidebar, /<form id="presetForm">/);
  assert.match(sidebar, /<input class="search preset-name" id="presetName" type="text" maxlength="40" autocomplete="off"/);
  assert.match(sidebar, /<button class="clear-filters" id="presetSaveBtn" type="submit" data-i18n="preset\.save">Save current filters as preset<\/button>/);
  assert.match(sidebar, /<div class="preset-list" id="presetList"><\/div>/);
  assert.match(sidebar, /<p class="sidebar-note" id="presetStatus" role="status" aria-live="polite"><\/p>/);
  // No window.prompt anywhere: the name is collected by this inline form.
  assert.doesNotMatch(page, /window\.prompt|[^.\w]prompt\(/);

  assert.match(page, /function renderPresets\(\)\{/);
  assert.match(page, /FilterPresets\.save\(storage,\{name:document\.getElementById\("presetName"\)\.value,query:RepoFilters\.serializeState\(currentExportState\(\)\)\}\)/);
  assert.match(page, /applyFilterState\(RepoFilters\.parseState\(preset\.query,LANGUAGES\)\);syncUrl\(\);/);
  assert.match(page, /FilterPresets\.remove\(storage,button\.dataset\.deletePreset\)/);
  assert.match(page, /catch\(error\)\{setPresetStatus\(error\.message==="presets cannot exceed 20"\?tr\("preset\.limit"\):error\.message==="preset name is required"\?tr\("preset\.nameRequired"\):tr\("preset\.saveError"\)\)\}/);
});
```

The pre-existing `sidebar sections follow the approved priority and keyboard order` test (`:932`) enumerates section ids and a focus order. Insert `"presetSection",` between `"sortSection"` and `"resultSection"` in its `sectionIds` array, and `"presetName", "presetSaveBtn", "presetList",` between `"sortSelect"` and `"clearFiltersBtn"` in its `focusOrder` array. Add `["presetSection", "explore"],` to the `SIDEBAR_SECTION_GROUPS` constant at `tests/page-runtime.test.mjs:29-33`, to `sidebarHarness`'s `sidebarSections` list (`:148-152`), and to `hiddenSectionsGroupHarness`'s `sidebarSections` list (`:347-352`).

Extend `tests/site-i18n.test.mjs`'s `required` array with the thirteen `preset.*` keys.

- [ ] **Step 6: Run the page test to verify it fails**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL at `assert.match(page, /<script src="filter-presets\.js"><\/script>/)`.

- [ ] **Step 7: Wire it into the page**

Add the script tag after `<script src="visit-tracker.js"></script>`:

```html
<script src="filter-presets.js"></script>
```

Add CSS after the `#resultSection{…}` rule from Task 2:

```css
.preset-list{display:grid;gap:7px}
.preset-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px}
.preset-apply{min-width:0;min-height:44px;border:1px solid var(--border);border-radius:9px;background:var(--control-solid);color:var(--text);padding:8px 11px;text-align:left;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;overflow-wrap:anywhere}
.preset-apply:hover{border-color:var(--accent);color:var(--accent)}
.preset-apply:focus-visible,.preset-delete:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.preset-delete{min-width:44px;min-height:44px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--text-2);font:inherit;font-size:14px;cursor:pointer}
.preset-delete:hover{border-color:var(--hot);color:var(--hot)}
.preset-name{min-height:44px;padding-left:12px;background-image:none}
#presetForm{display:grid;gap:7px}
```

Add the section between `#sortSection` and `#resultSection` (`index.html:534`):

```html
  <section class="sidebar-section" id="presetSection" aria-labelledby="presetTitle" data-group="explore">
    <h3 id="presetTitle" data-i18n="preset.title">Saved filters</h3>
    <p class="sidebar-note" data-i18n="preset.note">Save the current Explore filters under a name and apply them again in one click.</p>
    <form id="presetForm">
      <label class="sr-only" for="presetName" data-i18n="preset.nameLabel">Preset name</label>
      <input class="search preset-name" id="presetName" type="text" maxlength="40" autocomplete="off" aria-label="Preset name" data-i18n-aria-label="preset.nameLabel" placeholder="Rust CLI, weekly" data-i18n-placeholder="preset.namePlaceholder">
      <button class="clear-filters" id="presetSaveBtn" type="submit" data-i18n="preset.save">Save current filters as preset</button>
    </form>
    <div class="preset-list" id="presetList"></div>
    <p class="sidebar-note" id="presetStatus" role="status" aria-live="polite"></p>
  </section>
```

Add the runtime after the `#clearFiltersBtn` handler (`index.html:1355`):

```js
/* A preset is a name plus the string RepoFilters.serializeState already produces, so applying one
   is exactly the popstate path: parseState -> applyFilterState -> syncUrl. No new state model. */
function setPresetStatus(message){document.getElementById("presetStatus").textContent=message}
function renderPresets(){
  const listBox=document.getElementById("presetList"),presets=FilterPresets.read(storage);
  listBox.innerHTML=presets.length
    ?presets.map(preset=>`<div class="preset-row"><button class="preset-apply" type="button" data-apply-preset="${esc(preset.name)}" aria-label="${esc(tr("preset.apply",{name:preset.name}))}">${esc(preset.name)}</button><button class="preset-delete" type="button" data-delete-preset="${esc(preset.name)}" aria-label="${esc(tr("preset.delete",{name:preset.name}))}">✕</button></div>`).join("")
    :`<p class="sidebar-note">${esc(tr("preset.empty"))}</p>`;
}
document.getElementById("presetForm").addEventListener("submit",event=>{
  event.preventDefault();
  const field=document.getElementById("presetName");
  try{
    FilterPresets.save(storage,{name:field.value,query:RepoFilters.serializeState(currentExportState())});
    const name=FilterPresets.normalizeName(field.value);
    field.value="";renderPresets();setPresetStatus(tr("preset.saved",{name}));
  }catch(error){setPresetStatus(error.message==="presets cannot exceed 20"?tr("preset.limit"):error.message==="preset name is required"?tr("preset.nameRequired"):tr("preset.saveError"))}
});
document.getElementById("presetList").addEventListener("click",event=>{
  const applyButton=event.target.closest("[data-apply-preset]");
  if(applyButton){
    const preset=FilterPresets.read(storage).find(value=>value.name===applyButton.dataset.applyPreset);
    if(!preset)return;
    applyFilterState(RepoFilters.parseState(preset.query,LANGUAGES));syncUrl();
    setPresetStatus("");
    return;
  }
  const button=event.target.closest("[data-delete-preset]");
  if(!button)return;
  const name=button.dataset.deletePreset;
  try{FilterPresets.remove(storage,name);renderPresets();setPresetStatus(tr("preset.deleted",{name}))}
  catch{setPresetStatus(tr("preset.saveError"))}
});
renderPresets();
```

Add `renderPresets();` to the `site-locale-change` listener so the empty-state line and the per-row `aria-label`s follow the locale.

- [ ] **Step 8: Add the five locales**

```js
// EN
  "preset.title":"Saved filters",
  "preset.note":"Save the current Explore filters under a name and apply them again in one click.",
  "preset.nameLabel":"Preset name",
  "preset.namePlaceholder":"Rust CLI, weekly",
  "preset.save":"Save current filters as preset",
  "preset.apply":"Apply {name}",
  "preset.delete":"Delete {name}",
  "preset.empty":"No saved filters yet.",
  "preset.saved":"Saved {name}.",
  "preset.deleted":"Deleted {name}.",
  "preset.limit":"Up to 20 presets can be saved.",
  "preset.nameRequired":"Enter a name for the preset.",
  "preset.saveError":"The preset could not be saved in this browser.",
// KO
  "preset.title":"저장한 필터","preset.note":"지금의 탐색 필터를 이름으로 저장해 두고 한 번에 다시 적용합니다.","preset.nameLabel":"프리셋 이름","preset.namePlaceholder":"Rust CLI, 주간","preset.save":"현재 필터를 프리셋으로 저장","preset.apply":"{name} 적용","preset.delete":"{name} 삭제","preset.empty":"저장한 필터가 없습니다.","preset.saved":"{name}을(를) 저장했습니다.","preset.deleted":"{name}을(를) 삭제했습니다.","preset.limit":"프리셋은 최대 20개까지 저장할 수 있습니다.","preset.nameRequired":"프리셋 이름을 입력하세요.","preset.saveError":"이 브라우저에 프리셋을 저장하지 못했습니다.",
// ZH
  "preset.title":"已保存的筛选","preset.note":"把当前的探索筛选条件命名保存，一键再次应用。","preset.nameLabel":"预设名称","preset.namePlaceholder":"Rust CLI，每周","preset.save":"将当前筛选保存为预设","preset.apply":"应用 {name}","preset.delete":"删除 {name}","preset.empty":"还没有已保存的筛选。","preset.saved":"已保存 {name}。","preset.deleted":"已删除 {name}。","preset.limit":"最多可保存 20 个预设。","preset.nameRequired":"请输入预设名称。","preset.saveError":"无法在此浏览器中保存预设。",
// ES
  "preset.title":"Filtros guardados","preset.note":"Guarda los filtros de exploración actuales con un nombre y vuelve a aplicarlos con un clic.","preset.nameLabel":"Nombre del ajuste","preset.namePlaceholder":"Rust CLI, semanal","preset.save":"Guardar los filtros actuales como ajuste","preset.apply":"Aplicar {name}","preset.delete":"Eliminar {name}","preset.empty":"Todavía no hay filtros guardados.","preset.saved":"Se guardó {name}.","preset.deleted":"Se eliminó {name}.","preset.limit":"Se pueden guardar hasta 20 ajustes.","preset.nameRequired":"Escribe un nombre para el ajuste.","preset.saveError":"No se pudo guardar el ajuste en este navegador.",
// JA
  "preset.title":"保存した絞り込み","preset.note":"現在の探索フィルターに名前を付けて保存し、ワンクリックで再適用します。","preset.nameLabel":"プリセット名","preset.namePlaceholder":"Rust CLI・週間","preset.save":"現在のフィルターをプリセットとして保存","preset.apply":"{name} を適用","preset.delete":"{name} を削除","preset.empty":"保存した絞り込みはまだありません。","preset.saved":"{name} を保存しました。","preset.deleted":"{name} を削除しました。","preset.limit":"プリセットは最大 20 件まで保存できます。","preset.nameRequired":"プリセット名を入力してください。","preset.saveError":"このブラウザーにプリセットを保存できませんでした。",
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/filter-presets.test.mjs tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS, including `every panel section belongs to exactly one of the four groups and no group is empty` after `presetSection` is added to the three section lists.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 11: Commit**

```bash
git add filter-presets.js index.html site-i18n.js tests/filter-presets.test.mjs tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "feat: save and apply named Explore filter presets"
```

---

### Task 12: Export-favourites hint

**Problem (Assessment A, convenience candidate 6, S):** exporting only saved repositories already works — Favorites is a filter (`?view=favorites`) and `current-view-export.js` exports the current view — but nothing on the page says so, so a capability that already ships reads as missing.

**Files:**
- Modify: `index.html:551-559` (`#exportSection`), `index.html:1405` region (handler), `site-i18n.js`
- Test: `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: `setFavoriteView(enabled)` (`index.html:1331`), `setExportStatus(message, tone)` (`index.html:1384`), `#exportCsvBtn`.
- Produces: element id `exportFavoritesBtn`; message keys `export.favoritesHint`, `export.favoritesSwitch`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/page-runtime.test.mjs`:

```js
test("the Export panel says how to export only saved repositories, and does it", () => {
  const section = page.match(/<section class="sidebar-section" id="exportSection"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(section, /<p class="sidebar-note" data-i18n="export\.favoritesHint">Switch to Favorites first to export only the repositories you saved\.<\/p>/);
  assert.match(section, /<button class="clear-filters" id="exportFavoritesBtn" type="button" data-i18n="export\.favoritesSwitch">Switch to Favorites and export<\/button>/);
  assert.ok(section.indexOf('id="copyViewUrlBtn"') < section.indexOf('id="exportFavoritesBtn"'), "the switch button follows the three export actions");

  assert.match(page, /document\.getElementById\("exportFavoritesBtn"\)\.addEventListener\("click",\(\)=>\{\s*setFavoriteView\(true\);setExportStatus\(""\);\s*requestAnimationFrame\(\(\)=>document\.getElementById\("exportCsvBtn"\)\.focus\(\)\);\s*\}\);/);
});
```

Extend `tests/site-i18n.test.mjs`'s `required` array with `"export.favoritesHint", "export.favoritesSwitch",`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: FAIL at the `export.favoritesHint` paragraph match; site-i18n fails with `en is missing export.favoritesHint`.

- [ ] **Step 3: Write the implementation**

In `#exportSection`, after the `</div>` closing `.export-actions` and before `<p class="export-status" …>` (`index.html:558`), add:

```html
    <p class="sidebar-note" data-i18n="export.favoritesHint">Switch to Favorites first to export only the repositories you saved.</p>
    <button class="clear-filters" id="exportFavoritesBtn" type="button" data-i18n="export.favoritesSwitch">Switch to Favorites and export</button>
```

After the `#copyViewUrlBtn` handler (`index.html:1410`) add:

```js
document.getElementById("exportFavoritesBtn").addEventListener("click",()=>{
  setFavoriteView(true);setExportStatus("");
  requestAnimationFrame(()=>document.getElementById("exportCsvBtn").focus());
});
```

(`setFavoriteView(true)` sets `filterState.favOnly`, re-renders, and writes `?view=favorites` to the URL through `syncUrl()`; the three export buttons then act on the favourites-only view they already read from `currentVisibleRepos`. Moving focus to `#exportCsvBtn` is the scroll: the button is inside the scrollable panel, so focusing it brings the export controls into view without a manual `scrollIntoView` that would fight the sticky `#resultSection`.)

Add the locale strings:

```js
// EN
  "export.favoritesHint":"Switch to Favorites first to export only the repositories you saved.",
  "export.favoritesSwitch":"Switch to Favorites and export",
// KO
  "export.favoritesHint":"저장한 저장소만 내보내려면 먼저 즐겨찾기 보기로 전환하세요.","export.favoritesSwitch":"즐겨찾기로 전환하고 내보내기",
// ZH
  "export.favoritesHint":"若只想导出已收藏的仓库，请先切换到收藏视图。","export.favoritesSwitch":"切换到收藏并导出",
// ES
  "export.favoritesHint":"Cambia primero a Favoritos para exportar solo los repositorios que guardaste.","export.favoritesSwitch":"Cambiar a Favoritos y exportar",
// JA
  "export.favoritesHint":"保存したリポジトリだけを書き出すには、まずお気に入り表示に切り替えてください。","export.favoritesSwitch":"お気に入りに切り替えて書き出す",
```

Then add `"exportFavoritesBtn",` to the end of the `focusOrder` array in the pre-existing `sidebar sections follow the approved priority and keyboard order` test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/page-runtime.test.mjs tests/site-i18n.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html site-i18n.js tests/page-runtime.test.mjs tests/site-i18n.test.mjs
git commit -m "feat: point the Export panel at the Favorites view"
```

---

### Task 13: Document the four new capabilities

**Scope note:** `docs/screenshots/*.png` are **not** in scope. They are captured from production after this branch deploys, so do not regenerate, crop, or edit them, and do not change the two `docs/screenshots/…png` references that `tests/site-i18n.test.mjs:104-105` already asserts.

**Files:**
- Modify: `README.md` (the `## ✨ Features` list, `README.md:66-79`), `README.ko.md` (its matching feature list)
- Test: `tests/site-i18n.test.mjs`

**Interfaces:**
- Consumes: the four capabilities shipped by Tasks 4, 9, 10 and 11.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `tests/site-i18n.test.mjs`:

```js
test("both READMEs list the shortcut help, presets, compact mode, and new-since-last-visit", () => {
  for (const [document, tokens] of [
    [readme, ["`?` opens a keyboard-shortcut", "saved filter presets", "compact list mode", "new since your last visit"]],
    [koreanReadme, ["`?` 키로 단축키", "저장한 필터 프리셋", "간단히 보기", "지난 방문 이후 새로 올라온"]],
  ]) {
    for (const token of tokens) assert.ok(document.includes(token), `${token} must be documented`);
  }
  // Screenshots stay as-is: they are captured from production after deploy.
  assert.match(readme, /desktop-1440\.png/);
  assert.match(readme, /mobile-sidebar-390\.png/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/site-i18n.test.mjs`
Expected: FAIL with `` `?` opens a keyboard-shortcut must be documented ``.

- [ ] **Step 3: Write the implementation**

Append these four bullets to `README.md`'s `## ✨ Features` list, after the light/dark-theme bullet at `README.md:79`:

```markdown
- `?` opens a keyboard-shortcut dialog listing `/`, `e`, `a`, `h`, `x`, `Delete`, `Esc`, and `?`, with a checkbox that disables the single-key letter shortcuts for anyone who needs it (WCAG 2.1.4). `/`, `?`, and `Escape` keep working either way.
- Named, saved filter presets: store the current Explore filters under a name in this browser and re-apply them in one click, up to 20 presets.
- A compact list mode that collapses card padding and hides the classification badges and sparklines, roughly tripling the repositories on screen; the choice is remembered in this browser.
- A "new since your last visit" heading and per-card badge, computed in this browser against the repositories it saw last time — separate from the baseline-relative **New** membership badge, which is the same for every visitor.
```

Append the matching four bullets to `README.ko.md`'s feature list, in the same position:

```markdown
- `?` 키로 단축키 안내 대화상자를 엽니다. `/`, `e`, `a`, `h`, `x`, `Delete`, `Esc`, `?`를 모두 보여주고, 한 글자 단축키를 끄는 체크박스를 함께 제공합니다(WCAG 2.1.4). `/`, `?`, `Escape`는 어느 경우에도 동작합니다.
- 저장한 필터 프리셋: 지금의 탐색 필터를 이름으로 이 브라우저에 저장해 두고 한 번에 다시 적용합니다. 최대 20개까지 저장할 수 있습니다.
- 간단히 보기 모드: 카드 여백을 줄이고 분류 배지와 스파크라인을 감춰 한 화면에 보이는 저장소를 약 3배로 늘립니다. 선택은 이 브라우저에 기억됩니다.
- 지난 방문 이후 새로 올라온 저장소를 목록 제목과 카드 배지로 표시합니다. 이 브라우저가 지난번에 본 목록과 비교한 결과이며, 모든 방문자에게 동일한 기준선 기반 **New** 배지와는 별개입니다.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/site-i18n.test.mjs`
Expected: PASS, including the pre-existing `repository documentation is English-first with a complete Korean counterpart` test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `ℹ fail 0` and `OK`.

- [ ] **Step 6: Commit**

```bash
git add README.md README.ko.md tests/site-i18n.test.mjs
git commit -m "docs: document the help dialog, presets, compact mode, and new-since-last-visit"
```

---

## Self-Review

### 1. Spec coverage

Every item in the round's scope maps to a task:

| Scope item | Task | Source finding |
|---|---|---|
| Mobile above-the-fold: `<details>` badge guide + one-row toggle scroller | 1 | Assessment A Priority 1 (severity 3) |
| Sticky `#resultSection` | 2 | Assessment A Priority 2 (severity 3) |
| Footer feed links | 3 | Assessment A Priority 3 (severity 3) |
| `?` help dialog + rail button + WCAG 2.1.4 opt-out | 4 | Assessment A Priority 4; Assessment B "Keyboard shortcut conflicts (2.1.4) — Fail" |
| Hide `#sidebarGroupSeg` where the rail shows | 5 | Assessment A Priority 5 |
| Skip link (2.4.1), Label in Name (2.5.3), favourite-button names (4.1.2), light `--accent` contrast (1.4.3), single Delete-hint announcement | 6 | Assessment B rows 2.4.1, 2.5.3, 4.1.2 duplicate names, contrast table, "The `sr-only` card hint is announced on every card" |
| `.repo-link` / `#resetBtn` 44px, History empty states, Korean word breaking, 64→76px rail | 7 | Assessment A Priorities 6, 7, 8 |
| description / OG / theme-color / `<noscript>` | 8 | Assessment A "Note on share-a-view" and "No `<noscript>`"; Assessment B Lighthouse `meta-description` |
| New since last visit | 9 | Assessment A convenience candidate 3; also answers the Krug trunk-test "the list has no heading" finding |
| Compact list mode | 10 | Assessment A convenience candidate 4 |
| Saved filter presets | 11 | Assessment A convenience candidate 5 |
| Export favourites hint | 12 | Assessment A convenience candidate 6 |
| README feature list (screenshots explicitly out of scope) | 13 | Round requirement |

Findings deliberately **not** addressed, and why: PWA/offline (Assessment A candidate 7 — the site's value is 6-hourly freshness); per-language RSS (candidate 8 — recommended against); compare-two-repos (rejected — collides with the summary rail); the Firebase App Check 403 and the CSP-as-meta-tag Lighthouse note (both outside a UX round — the first is a Firebase console matter, the second is a GitHub Pages hosting constraint with no server-header control); the sparkline's missing numeric alternative (low priority, already mitigated by the adjacent total-stars text).

### 2. Placeholder scan

No `TBD`, no "implement later", no "add appropriate error handling", no "similar to Task N". Every code step carries the literal CSS, HTML, JS or test code to paste. Every one of the 39 new message keys is written out in all five locales. The two contrast ratios (5.57:1 light, 8.10:1 dark) are computed, not asserted. The baseline test counts (696/684/0/12 and 165) are measured on `f6189e6`, not estimated.

### 3. Type and name consistency

- `VisitTracker.recordVisit(storage, {slugs, now})` returns `{previousVisitAt, newSlugs, seen}` — the page reads `visitSummary.previousVisitAt` and `visitSummary.newSlugs` in Task 9 and nowhere else. `newSlugs` is both an exported function and a returned field; that mirrors `Favorites.normalizeFavs` / `favorites` and is intentional, but implementers must not rename one and not the other.
- `FilterPresets.save/read/remove` all return `{name, query}[]`; `query` is exactly what `RepoFilters.serializeState` returns (`""` or `"?…"`), which is exactly what `RepoFilters.parseState` accepts. Task 11's `isValidQuery` enforces that contract in both directions.
- `shortcutSuppressed(event)` keeps its existing signature; Task 4 only adds two early returns. `SIDEBAR_SHORTCUT_GROUPS` keeps its `{e,a,h,x}` shape.
- `sidebarGroupSegVisible(mode)` takes the open mode (`"modal"`, `"hover"`, or `undefined`) and is called with `mode`, `undefined`, and `sidebar.dataset.openMode` — all three are handled by the single `mode==="modal" && !railVisible` expression.
- `filter-bar-row-3` exists in Tasks 1–9 and becomes `filter-bar-row-4` in Task 10; `filter-toggle-row` (introduced in Task 1) is the stable hook the mobile scroll rules target, so Task 10's rename does not touch them.
- `updateVisitHeading()` (Task 9) and `renderPresets()` (Task 11) are both appended to the `site-locale-change` listener; Task 11's implementer must append rather than replace the line Task 9 already extended.

### 4. `index.html` regions each task touches, and why the order is what it is

Tasks are executed **sequentially by fresh implementers who only see their own task**. None of them can see another task's diff, so the ordering below exists to keep two tasks from editing the same few lines, and where they must, to put the later one on top of a region the earlier one has already settled.

| Task | CSS block (1–479) | Markup (480–668) | Script (669–1715) | Other files |
|---|---|---|---|---|
| 1 | 264–270, 400–412 | 606–615, 628 | ~707 (one `matchMedia` line) | — |
| 2 | 11–13, 137, after 213 | — | — | — |
| 3 | — | 648–654 | — | `site-i18n.js` |
| 4 | after 115, after 371 | 578, before 667 | 942–962, new block after it | `site-i18n.js` |
| 5 | — | — | 754, 826, 847, after 941 | — |
| 6 | after 53, 342, 443 | 483, 562, 582, 636 | 815–817, 1273, 1274, 1503, 1514 | `site-i18n.js` |
| 7 | 62, 91, 96, 114, 146, after 212, 400–412, 413 | — | 1134–1147 | `site-i18n.js` |
| 8 | after 374 | after 5 (head), before 636 | — | — |
| 9 | after 300 | 636 (after the hint), 679 | 695–700, ~709, 1270–1273 | new `visit-tracker.js`, `site-i18n.js` |
| 10 | 253, 257, after 300 | 628–632, 679 | ~709, after 1394 | `site-i18n.js` |
| 11 | after the Task 2 `#resultSection` rule | 534, 679 | after 1355, 695–700 | new `filter-presets.js`, `site-i18n.js` |
| 12 | — | 558 | after 1410 | `site-i18n.js` |
| 13 | — | — | — | `README.md`, `README.ko.md` |

**Overlaps and how the order resolves them:**

- **CSS block — Tasks 1, 4, 5, 7 (and 2, 6, 8, 9, 10, 11).** Only Tasks 1 and 7 both write inside the `@media(max-width:560px)` block at 400–412, and they are the only real collision. Task 1 goes first and *replaces* the `.signal-guide>strong` line inside it with the two `.filter-toggle-row` rules; Task 7 then only *appends* `.repo-link` and `#resetBtn` rules to the same block. Task 7 also edits `.nav-rail`/`.nav-toggle`/`.filter-sidebar` at 91/96/146, which Task 5 reads about but never edits (Task 5 is entirely script-side by design — see its "Why the `hidden` attribute" note). Everything else in the CSS block lands in a different rule: Task 2 at `:root` and after `.filter-summary`; Task 4 after `.nav-rail-spacer` and after `.scroll-top[hidden]`; Task 6 after `.wrap[tabindex]` and at `.tlabel`/`#readmeBody a`; Task 8 after `footer a`; Tasks 9 and 10 after `.membership-reentered`; Task 11 after Task 2's `#resultSection` rule. Tasks 9 and 10 append to the same anchor — 9 runs first, 10 appends below it.
- **Script — Tasks 4, 9, 10, 11 (and 5, 6, 7, 12).** Task 4 owns 942–962 exclusively; Task 5 edits 754/826/847 and appends after 941, one line above Task 4's block, so ordering 4 before 5 means Task 5's implementer sees a settled shortcut block and appends beneath it. Tasks 9, 10 and 11 all append near the storage-setup region (~709) and near the filter handlers — they run 9 → 10 → 11 so each appends below the previous. Tasks 9 and 11 both extend the `site-locale-change` listener at 695–700: Task 9 appends `updateVisitHeading();` to the existing last line, Task 11 appends `renderPresets();` after it. Task 6 edits 1273–1274 (the card `<article>` and `.favbtn`) and Task 9 edits 1270–1273 (the badge consts and the `.cname` line) — Task 6 first, so Task 9's implementer inserts a `const` line above an `<article>` tag Task 6 has already finished changing.
- **`<head>` — Task 8 alone.** No other task touches lines 1–10.
- **Markup line 679 (the script-tag list) — Tasks 9, 10, 11.** Task 9 adds `visit-tracker.js`, Task 11 adds `filter-presets.js` after it, Task 10 only reads that region. Strict ordering keeps the list append-only.
- **Sidebar section list — Tasks 2, 11.** Task 2 makes `#resultSection` sticky; Task 11 inserts `#presetSection` *before* it, so the sticky strip stays the last Explore section and the two never edit the same line.
- **Test-file collisions.** `tests/page-runtime.test.mjs`'s three section lists (`SIDEBAR_SECTION_GROUPS` at 29–33, `sidebarHarness` at 148–152, `hiddenSectionsGroupHarness` at 347–352) are edited by Task 11 only. The `sidebarHarness` fake `matchMedia` is edited by Task 5 only; the `hiddenSectionsGroupHarness` node map by Task 7 only. The `<main class="wrap">` literal appears at five test sites and is retargeted by Task 6 only. The `filter-bar-row-3` assertions at 2070–2071 are retargeted by Task 10 only. The 64px assertions at 1061/1065/1066/1318/1992/2779 are retargeted by Task 7 only. `tests/site-i18n.test.mjs`'s `required` array is appended to by Tasks 3, 4, 7, 9, 10, 11 and 12 in that order — each appends, none reorders.

Because every implementer sees only their own task, each task's Steps carry the full literal text of what to write and, where a pre-existing assertion must move with the change, name it by file and line so the implementer does not have to discover it by watching a test go red.
