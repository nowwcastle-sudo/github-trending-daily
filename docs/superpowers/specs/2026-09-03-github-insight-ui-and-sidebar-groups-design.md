# GITHUB INSIGHT — rail groups, filter bar, and page hardening design

- Written: 2026-09-03 (English; the site copy stays multilingual through `site-i18n.js`)
- Status: approved brief (`insight-ui-brief.md`, items 1–12) turned into a spec
- Repository: `https://github.com/nowwcastle-sudo/github-trending-daily` (working copy `C:\Users\nasca\AppData\Local\Temp\gh-trending-page`, main at `ac3e1db`)
- Prior documents: `docs/superpowers/specs/2026-09-03-per-repo-summary-admission-and-star-ticks-design.md` (repository-level `held` admission, `star-history.json` v2), `docs/superpowers/specs/2026-09-01-period-locale-sidebar-corrections-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-03-github-insight-ui-and-sidebar-groups.md`

---

## 1. Problems

**P1 — one rail button, one undifferentiated panel.** `.nav-rail` (index.html:537-544) holds a single `#navToggle`. Everything the dashboard offers — refresh status, Google account, my-list, period, language, field, form, sort, filter summary, hidden repositories, recent exits, export — is stacked in one scrolling `#filterSidebar`. Twelve sections in one column means the user scrolls past account controls to reach export, and the panel's purpose is unreadable from the rail.

**P2 — hover close is instant.** `closeHoverSidebarIfOutside` (index.html:747-750) calls `closeSidebar(false)` synchronously on `pointerleave`. Crossing the 1-pixel seam between the rail and the panel, or overshooting the panel edge while reaching for a control, closes the panel outright. There is no re-entry window.

**P3 — the two filters the user changes most are buried.** Period (`#periodSeg`) and language (`#lang`) are the highest-frequency controls and both live inside a panel that must be opened first. "Exclude AI" and "New repositories only" are checkboxes inside a `<fieldset>` in `#fieldSection`, three sections deep.

**P4 — the product name no longer matches the product.** `<title>` is "GitHub Trending — Insight Dashboard", `<h1>` is "GitHub Trending", the two `<link rel="alternate">` titles say "GitHub Trending Daily", and `scripts/generate_atom_feeds.py` emits an English feed author with Korean feed titles ("GitHub Trending Daily — 현재 전체"). Four spellings of one name.

**P5 — `held` repositories say what is wrong but not what happens next.** `tipHTML` (index.html:1008) renders `tooltip.held` ("Summary is being verified…") with no indication that a retry is scheduled. The card looks broken rather than pending.

**P6 — the star sparkline does not say when observation began.** `StarHistory.historyHtml` (star-history.js:141-147) appends a fixed explanation line but never the first observed timestamp, so a two-point curve is indistinguishable from a long-running one.

**P7 — the Atom feed hides `held`.** `_current_summary` (scripts/generate_atom_feeds.py:421-427) falls back to `description` then `name`, so a `held` entry reads exactly like a verified one. Feed subscribers cannot tell.

**P8 — the page ships with no Content-Security-Policy.** `index.html` loads a third-party ES module tree from `www.gstatic.com`, runs reCAPTCHA Enterprise, talks to four Google API hosts and `api.github.com`, and renders README HTML that can carry arbitrary image sources. There is no declared origin allowlist.

**P9 — no keyboard route to the panel groups and no search shortcut.** The only keyboard path is Tab to `#navToggle` or `#mobileNavToggle`.

**P10 — `npm test` is red on main.** Five tests fail (§9.1), so no change can be judged against a green baseline.

**P11 — no CI runs the suite.** `.github/workflows/` has `codeql.yml`, `daily-refresh.yml`, `deploy-current-pages.yml`, `star-ticks.yml`. Nothing runs `npm test` on a pull request.

**P12 — the README describes the previous product.** Title, feature list, and star-history description predate repository-level admission, star ticks, and this UI.

---

## 2. Goals and non-goals

**Goals**

1. Four rail buttons address one panel showing one of four content groups; hovering a different button switches the group without a close/open cycle.
2. Pointer-leave gets a 500 ms grace window that any re-entry cancels. Focus-based close stays instant.
3. Period, language, AI exclusion, new-only, and a copy-link action live in a permanently visible filter bar directly under the badge guide.
4. One name — `GITHUB INSIGHT` — across page title, heading, feed link titles, and generated Atom feeds.
5. `held` repositories state that a retry is scheduled; the sparkline states when observation began; the feed marks `held` entries.
6. A Content-Security-Policy meta derived from an actual origin inventory, with a test that fails when code introduces an origin the policy does not allow.
7. `/` focuses search; `e`/`a`/`h`/`x` open a group; `Escape` closes.
8. `npm test` is green before any behaviour change lands, and a CI workflow keeps it green.

**Non-goals**

- No change to the URL state contract. `RepoFilters.parseState` / `serializeState` (repo-filters.js) keep the exact serialization of `period`, `lang`, `exclude=ai`, `membership=new`, `sort`, `q`, `fav`.
- No new runtime or build dependency. `package.json` `devDependencies` unchanged.
- No change to data pipelines, the snapshot contract, `data/**` ledgers, or any script other than `scripts/generate_atom_feeds.py`.
- No repository rename and no URL change. `https://nowwcastle-sudo.github.io/github-trending-daily/` and the `feed.xml` / `changes.xml` hrefs stay byte-identical; only displayed titles change.
- No hand-editing of the checked-in `feed.xml` / `changes.xml`. The next W1 refresh regenerates them.
- No change to `readme-markdown.js` sanitisation behaviour (§8.4 records this as the reason `img-src` needs a decision).

---

## 3. Invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Every message key exists in all five locales `en, ko, zh-CN, es, ja` with identical key sets | `tests/site-i18n.test.mjs` "site shell supports the exact five approved locales" |
| I2 | Rail buttons carry `aria-controls="filterSidebar"` and `aria-expanded`; the panel is `inert` + `aria-hidden="true"` when closed | `tests/page-runtime.test.mjs` rail and sidebar tests |
| I3 | Modal mode keeps the scrim, `pageMain.inert=true`, the `trapFocus` focus trap, `Escape` close, and focus restore to the exact element that opened it | `tests/page-runtime.test.mjs` modal tests |
| I4 | Group visibility uses the `hidden` attribute so `focusableIn` (index.html:699-701) keeps excluding off-group controls from the focus trap | `tests/page-runtime.test.mjs` group tests |
| I5 | `RepoFilters.parseState` / `serializeState` output is unchanged for every state | `tests/repo-filters.test.mjs`, new filter-bar round-trip test |
| I6 | Design tokens unchanged: `--sidebar-open-duration:260ms`, `--sidebar-close-duration:210ms`, `--sidebar-width:min(360px,calc(100vw - 44px))`, `.nav-toggle` `width:48px;min-height:60px`, focus ring `outline:3px solid var(--accent);outline-offset:2px`, rail `width:64px` | `tests/page-runtime.test.mjs` CSS regex tests |
| I7 | No new dependency; `npm test` runs `node --test` + `python -m unittest discover -s tests -p "test_*.py"` unchanged | `package.json` diff is empty |
| I8 | Repository name and all site/feed URLs unchanged | `tests/page-runtime.test.mjs` alternate-link href assertions, `tests/test_atom_feeds.py` |
| I9 | The generated `REPOS` blob (index.html line 629, between `// GENERATED:TRENDING-REPOS:START` and `:END`) is never hand-edited and never used as evidence about runtime code | Task 1 rescopes the assertion that violated this |
| I10 | Code changes reach production only through the W1 `daily-refresh.yml` publish path; no direct Pages deploy from this branch | Delivery sequence §10 |

---

## 4. Item 1 — four rail buttons, one panel, four groups

### 4.1 Group vocabulary

`ui-motion.js` exports:

```js
const SIDEBAR_GROUPS = Object.freeze(["account", "explore", "history", "export"]);

function resolveSidebarGroup(value) {
  return SIDEBAR_GROUPS.includes(value) ? value : "explore";
}
```

`resolveSidebarGroup` is total: `undefined`, `null`, `""`, `"Explore"`, `"filters"`, `0`, `{}` all resolve to `"explore"`. It is the single place unknown group values are normalised; no caller re-validates.

### 4.2 Rail markup

`<nav class="nav-rail" id="navRail">` (the `id` is added so the runtime can test containment through `document.getElementById` instead of a new `querySelector` branch). It holds four `.nav-toggle` buttons in this DOM order, then `.nav-rail-spacer`, then `#filterCount`:

| Order | id | `data-group` | label key | `data-i18n-aria-label` | `data-i18n-title` | glyph |
|---|---|---|---|---|---|---|
| 1 | `navAccountToggle` | `account` | `nav.account` | `nav.ariaAccount` | `nav.titleAccount` | `.nav-glyph-user` |
| 2 | `navToggle` | `explore` | `nav.explore` | `nav.ariaExplore` | `nav.titleExplore` | `.nav-glyph` (existing) |
| 3 | `navHistoryToggle` | `history` | `nav.history` | `nav.ariaHistory` | `nav.titleHistory` | `.nav-glyph-clock` |
| 4 | `navExportToggle` | `export` | `nav.export` | `nav.ariaExport` | `nav.titleExport` | `.nav-glyph-export` |

`#navToggle` keeps its id — many tests target it. All four carry `class="nav-toggle"`, `type="button"`, `aria-controls="filterSidebar"`, `aria-expanded="false"`.

Glyphs are drawn with the same 1.5px `currentColor` stroke idiom as `.nav-glyph` (index.html:98-99), as CSS boxes and pseudo-elements — no SVG files, no icon font:

```css
.nav-glyph-user{width:20px;height:17px;position:relative}
.nav-glyph-user::before{content:"";position:absolute;left:6px;top:0;width:8px;height:8px;border:1.5px solid currentColor;border-radius:99px}
.nav-glyph-user::after{content:"";position:absolute;left:2px;bottom:0;width:16px;height:7px;border:1.5px solid currentColor;border-bottom:0;border-radius:8px 8px 0 0}
.nav-glyph-clock{width:17px;height:17px;border:1.5px solid currentColor;border-radius:99px;position:relative}
.nav-glyph-clock::before{content:"";position:absolute;left:7px;top:3px;width:1.5px;height:6px;background:currentColor}
.nav-glyph-clock::after{content:"";position:absolute;left:7px;top:7.5px;width:5px;height:1.5px;background:currentColor}
.nav-glyph-export{width:20px;height:17px;border:1.5px solid currentColor;border-radius:4px;position:relative}
.nav-glyph-export::before{content:"";position:absolute;left:8.25px;top:3px;width:1.5px;height:8px;background:currentColor}
.nav-glyph-export::after{content:"";position:absolute;left:6px;top:3px;width:6px;height:6px;border-left:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg);transform-origin:center}
```

### 4.3 Panel grouping

`#filterSidebar` gains `data-group="explore"` as its initial value. Every direct child section gains `data-group`:

| Section id | `data-group` |
|---|---|
| `refreshStatus` | `account` |
| `accountSection` | `account` |
| `viewSection` | `explore` |
| `fieldSection` | `explore` |
| `formSection` | `explore` |
| `sortSection` | `explore` |
| `resultSection` | `explore` |
| `hiddenRepoSection` | `history` |
| `recentExitsSection` | `history` |
| `exportSection` | `export` |

`#periodSection` and `#languageSection` are deleted; their controls move to the filter bar (§6).

DOM order is unchanged apart from those two deletions. In particular `hiddenRepoSection` stays before `recentExitsSection`. The brief listed the history group as "recentExitsSection and hiddenRepoSection"; that is read as enumeration, not ordering, and reordering them would be an unrequested change. Recorded here so a reviewer does not read it as an oversight.

`#refreshStatus` is `.sidebar-refresh`, not `.sidebar-section`, so the existing `[hidden]` rule (index.html:335) does not cover it. That rule becomes:

```css
.sidebar-section[hidden],.sidebar-refresh[hidden],.undo-bar[hidden],.empty button[hidden]{display:none}
```

### 4.4 Group switch

```js
function setSidebarGroup(group) {
  const next = UiMotion.resolveSidebarGroup(group);
  sidebar.dataset.group = next;
  sidebarGroups.forEach(section => { section.hidden = section.dataset.group !== next; });
  railToggles.forEach(toggle => {
    if (toggle.dataset.group === next) toggle.setAttribute("aria-current", "true");
    else toggle.removeAttribute("aria-current");
  });
  sidebarGroupSegButtons.forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.group === next));
  });
  return next;
}
```

- `sidebarGroups` = `[...sidebar.querySelectorAll("[data-group]")]` collected once at load.
- `aria-current="true"` marks which group the panel is showing. `aria-expanded` continues to convey open/closed on all five toggles. This keeps one state per attribute; the four buttons are disclosure buttons for one panel, not a tab set.
- `sidebar.dataset.group` is **sticky across closes** — closing does not clear it, so reopening by edge gesture or by `#mobileNavToggle` returns to the last group.

**Amendment (2026-09-04, Task 7, from the Task 4 review finding F3).** `setSidebarGroup` also relabels the dialog: it sets `sidebar.dataset.i18nAriaLabel` to `SIDEBAR_GROUP_ARIA_KEYS[next]` (`nav.ariaAccount` / `nav.ariaExplore` / `nav.ariaHistory` / `nav.ariaExport`) and `aria-label` to `tr(...)` of that key, so `#filterSidebar` no longer reads "Explore sidebar" for all four groups and a locale switch re-applies the label through the existing `data-i18n-aria-label` pass. The checked-in markup starts at `aria-label="Explore panel" data-i18n-aria-label="nav.ariaExplore"`.

### 4.5 `openSidebar` and trigger tracking

```js
function openSidebar(mode, trigger, group) { /* … */ setSidebarGroup(group ?? sidebar.dataset.group); /* … */ }
```

- `group` omitted → keep the current group (first ever open resolves `undefined` to `"explore"`).
- Modal mode sets `sidebarTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement` exactly as today, so `closeSidebar(true)` restores focus to the button that opened it — now correct per rail button rather than always `#navToggle`.
- `sidebarGroupSeg.hidden = mode !== "modal"` on open, and `sidebarGroupSeg.hidden = true` on close. This is done with the `hidden` attribute, not CSS, so the switcher is genuinely out of the tab order in hover mode (`focusableIn` inspects `hidden`, not computed style).

Existing internal callers:

- index.html:811 edge gesture: `openSidebar("modal", gesture.trigger)` — unchanged call shape, keeps the sticky group.
- index.html:1183 `#emptyManageHiddenBtn`: becomes `openSidebar("modal", event.currentTarget, "history")` so the hidden-repository manager is actually on screen when it focuses `.hidden-restore`.

`setSidebarTriggerState(label, expanded)` is replaced by `setSidebarExpandedState(expanded)`, which sets only `aria-expanded` on the five toggles. Each rail button's `aria-label` is static per group (`nav.ariaAccount` … `nav.ariaExport`); `#mobileNavToggle` keeps `data-i18n-aria-label="nav.open"`.

Consequence: `nav.close` and `nav.pin` become unused message keys. They are **retained** in all five locales — I1 only requires identical key sets, and deleting them is churn with no benefit. `period.title` likewise becomes unused when `#periodSection` is deleted and is retained. Recorded as accepted debt, not an oversight.

### 4.6 Hover switching

`pointerenter` on any rail button:

```js
railToggles.forEach(toggle => {
  toggle.addEventListener("pointerenter", () => {
    if (!sidebarHoverMedia.matches) return;
    cancelHoverClose();
    railPointerInside = true;
    const group = UiMotion.resolveSidebarGroup(toggle.dataset.group);
    if (sidebar.dataset.openMode === "hover") setSidebarGroup(group);
    else openSidebar(UiMotion.sidebarMode({ hoverCapable: true, trigger: "pointer" }), toggle, group);
  });
  toggle.addEventListener("pointerleave", event => { railPointerInside = false; closeHoverSidebarIfOutside(event.relatedTarget); });
  toggle.addEventListener("focusout", event => closeHoverSidebarNow(event.relatedTarget));
  toggle.addEventListener("click", activateSidebar);
});
```

Moving from button A to button B while hover-open therefore fires `setSidebarGroup(B)` with no close and no re-open animation. `openSidebar`'s existing `currentMode === mode` early return is never reached for a group switch because the hover branch bypasses `openSidebar`.

`sidebarOwnsTarget` widens to the whole rail:

```js
function sidebarOwnsTarget(target) {
  if (!target) return false;
  if (target === sidebar || sidebar.contains(target)) return true;
  if (navRail && (target === navRail || navRail.contains(target))) return true;
  return railToggles.some(toggle => target === toggle || toggle.contains(target));
}
```

### 4.7 Activation (click and keyboard)

```js
function activateSidebar(event) {
  const group = UiMotion.resolveSidebarGroup(event.currentTarget?.dataset?.group);
  if (sidebar.dataset.openMode === "modal") {
    if (sidebar.dataset.group === group) { closeSidebar(); return; }
    sidebarTrigger = event.currentTarget;
    setSidebarGroup(group);
    return;
  }
  openSidebar(
    UiMotion.sidebarMode({ hoverCapable: sidebarHoverMedia.matches, trigger: event.detail === 0 ? "keyboard" : "click" }),
    event.currentTarget,
    group,
  );
}
```

Three behaviours, stated explicitly because they are the edge cases:

- **Keyboard activation** (`event.detail === 0`) of any rail button opens **modal** mode on that button's group, per `UiMotion.sidebarMode({hoverCapable, trigger:"keyboard"}) === "modal"`. Closing restores focus to that button.
- **Group switch while modal**: clicking a *different* rail button while the panel is modal switches the group and retargets `sidebarTrigger`; it does not close and re-open, and `sidebarClose` is not re-focused.
- **Same-group activation while modal** closes, preserving today's toggle behaviour on `#navToggle`.

`#mobileNavToggle` has no `data-group`, so it resolves to `"explore"`.

### 4.8 Touch / modal group switcher

At the top of the panel, immediately after `.sidebar-head` and before `#refreshStatus`:

```html
<div class="seg sidebar-group-seg" id="sidebarGroupSeg" role="group" aria-label="Panel section" data-i18n-aria-label="nav.groups" hidden>
  <button type="button" data-group="account" aria-pressed="false" data-i18n="nav.account">Login</button>
  <button type="button" data-group="explore" aria-pressed="true" data-i18n="nav.explore">Explore</button>
  <button type="button" data-group="history" aria-pressed="false" data-i18n="nav.history">History</button>
  <button type="button" data-group="export" aria-pressed="false" data-i18n="nav.export">Export</button>
</div>
```

It reuses the `.seg` container styling already used by `#periodSeg` and the `aria-pressed` idiom already used by `#viewSection` and `#periodSeg` — a `role="group"` of pressed toggles, not a tablist. No roving `tabindex`, no arrow-key handler: every button is tabbable, which is what the focus trap expects. There is no `.seg-thumb` inside it (the sliding thumb is bound to `#periodSeg` by `moveThumb`); `.sidebar-group-seg button[aria-pressed="true"]{background:var(--seg-thumb);border-radius:8px}` gives the pressed state instead.

It is `hidden` unless `openMode === "modal"` (§4.5), so it appears both for touch users (`#mobileNavToggle`) and for keyboard users on a hover-capable device, which is where a within-trap group switch is needed. The rail is hidden on touch exactly as today (`@media(hover:none),(pointer:coarse){.nav-rail{display:none}}` and `@media(max-width:720px){.nav-rail{display:none!important}}`).

Clicking a switcher button calls `setSidebarGroup(button.dataset.group)` and nothing else — the panel stays modal and focus stays on the button.

---

## 5. Item 2 — 500 ms hover close grace

`ui-motion.js` exports `SIDEBAR_HOVER_CLOSE_DELAY_MS = 500`.

```js
let hoverCloseTimer = null;
function cancelHoverClose() { if (hoverCloseTimer !== null) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; } }
function hoverSidebarShouldStayOpen(relatedTarget) {
  return sidebar.dataset.openMode !== "hover"
    || sidebarOwnsTarget(relatedTarget)
    || railPointerInside
    || sidebarPointerInside
    || sidebar.matches(":focus-within")
    || railToggles.some(toggle => toggle.matches(":focus"));
}
function closeHoverSidebarNow(relatedTarget = null) {
  if (hoverSidebarShouldStayOpen(relatedTarget)) return;
  cancelHoverClose();
  closeSidebar(false);
}
function closeHoverSidebarIfOutside(relatedTarget = null) {
  if (hoverSidebarShouldStayOpen(relatedTarget)) return;
  cancelHoverClose();
  hoverCloseTimer = setTimeout(() => { hoverCloseTimer = null; closeHoverSidebarNow(); }, UiMotion.SIDEBAR_HOVER_CLOSE_DELAY_MS);
}
```

- **Pointer leave → deferred.** `pointerleave` on a rail button or on the panel calls `closeHoverSidebarIfOutside`. The panel stays open for 500 ms.
- **Re-entry cancels.** `pointerenter` on any rail button or on the panel calls `cancelHoverClose()` first.
- **The timer re-checks.** The scheduled callback runs `closeHoverSidebarNow()`, which re-evaluates every guard. A pointer that returned and left again inside the window, or focus that landed in the panel, keeps it open.
- **Focus leave stays immediate.** `focusout` on the panel or on a rail button calls `closeHoverSidebarNow` — unchanged synchronous behaviour.
- **`Escape`, the close button, modal mode, and the tooltip path are unchanged.** `closeSidebar` and `openSidebar` both call `cancelHoverClose()` on entry so no stale timer can close a panel the user just re-opened, or close a modal panel.

The existing test `tests/page-runtime.test.mjs` "hover close starts immediately outside the combined rail and sidebar while preserving focus" (currently lines 674-695) asserts the opposite of the new contract in its last three lines and is rewritten (§9.2). The `sidebarHarness` already provides a deterministic fake `setTimeout`/`clearTimeout` plus `advance(ms)` (tests/page-runtime.test.mjs:165-190), so the window is testable without real time.

---

## 6. Item 3 — filter bar

### 6.1 Placement and markup

A new element inside `<main class="wrap">`, between `</aside>` (index.html:579) and `<p id="cardKeyboardHint">` (index.html:581):

```html
<section class="filter-bar" id="filterBar" aria-label="Quick filters" data-i18n-aria-label="field.quick">
  <div class="filter-bar-row">
    <div class="seg" id="periodSeg" role="group" aria-label="Period filter" data-i18n-aria-label="period.aria">
      <span class="seg-thumb" id="segThumb"></span>
      <button data-period="all" aria-pressed="true" data-i18n="period.all">All</button>
      <button data-period="daily" aria-pressed="false" data-i18n="period.daily">Daily</button>
      <button data-period="weekly" aria-pressed="false" data-i18n="period.weekly">Weekly</button>
      <button data-period="monthly" aria-pressed="false" data-i18n="period.monthly">Monthly</button>
    </div>
    <select class="langsel" id="lang" aria-label="Programming language" data-i18n-aria-label="language.title"><option value="" data-i18n="language.all">All languages</option></select>
  </div>
  <div class="filter-bar-row filter-bar-row-3">
    <button type="button" id="excludeAi" class="filter-toggle" aria-pressed="false" data-i18n="field.excludeAi">Exclude AI</button>
    <button type="button" id="newOnly" class="filter-toggle" aria-pressed="false" data-i18n="field.newOnly">New repositories only</button>
    <button type="button" id="copyLinkBtn" class="filter-toggle" data-i18n="filter.copyLink">Copy link</button>
  </div>
  <p class="filter-bar-status" id="filterBarStatus" role="status" aria-live="polite" aria-atomic="true"></p>
</section>
```

`#periodSeg`, `#segThumb`, `#lang` keep their exact ids and inner markup — they are moved, not rewritten, so `moveThumb`, `setPeriod`, and the `langSel` handler are untouched. `#periodSection` and `#languageSection` wrappers and the `<fieldset class="filter-switch-row">` block in `#fieldSection` are deleted.

Moving `#periodSeg` out of the translated-off-screen panel is a side improvement: `moveThumb()` measures `offsetWidth`/`offsetLeft` on an element that is now always laid out.

### 6.2 Layout

```css
.filter-bar{display:flex;flex-direction:column;gap:16px;margin-top:18px}
.filter-bar-row{display:flex;gap:16px;flex-wrap:wrap}
.filter-bar-row>*{flex:1 1 calc(50% - 8px);max-width:calc(50% - 8px);min-width:0}
.filter-bar-row-3>*{flex:1 1 calc((100% - 32px)/3);max-width:calc((100% - 32px)/3)}
.filter-bar-status{color:var(--text-2);font-size:11.5px;line-height:1.45;min-height:1.45em}
.filter-bar-status:empty{display:none}
@media(max-width:600px){.filter-bar-row>*,.filter-bar-row-3>*{flex:1 1 100%;max-width:100%}}
```

Row 1 uses the brief's literal `calc(50% - 8px)` rule. Row 2 carries three items, so with the same 16px gap each item is `(100% - 32px)/3` — written as a division rather than `33.333% - 10.667px` so the sum is exactly `100%` with no rounding slack. `min-width:0` prevents the `<select>` and long localized button labels from forcing overflow. Total width therefore never exceeds the `.wrap` content column, which is the constraint the brief set.

#### Amendments (2026-09-04, Task 6 review)

- **F1** — `#filterBarStatus` now styles its tone: `.filter-bar-status[data-tone="success"]{color:var(--accent-selected)}` and `[data-tone="error"]{color:var(--hot)}`, mirroring `.export-status`, so a failed copy is visibly distinct from a success for sighted users, not only via the live region.
- **F2** — `.filter-bar-status:empty{display:none}` is removed; the `role="status"` live region stays mounted at page load (its `min-height` already reserved the space), so the first copy-link result is not silently dropped by screen readers that ignore a display:none region.
- **F3** — added `@media(max-width:760px){.filter-bar .seg button{padding-inline:8px;font-size:12.5px}}` to close the 601–760px band where the period segment's min-content width could exceed its 50% column before the existing 600px stacking rule engaged.
- **F4** — `#periodSeg` now also re-measures via `if(typeof ResizeObserver==="function")new ResizeObserver(()=>moveThumb()).observe(seg);` alongside the window `resize` listener, so `body.overlay-open` toggling the scrollbar no longer leaves `#segThumb` stale until the next window resize.

### 6.3 Toggle styling

```css
.filter-toggle{min-height:44px;padding:0 14px;border:1px solid var(--surface-border);border-radius:11px;background:var(--control-solid);color:var(--text);font:inherit;font-size:13px;font-weight:650;cursor:pointer;overflow-wrap:anywhere}
.filter-toggle:hover{border-color:var(--accent);color:var(--accent)}
.filter-toggle:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.filter-toggle:active{transform:scale(.98)}
.filter-toggle[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent-selected);border-color:var(--accent)}
```

`44px` minimum target matches `.account-btn` and `.export-actions button`. The pressed palette reuses the accent tokens the rail already uses (I6).

### 6.4 State wiring

The checkbox `change` handlers (index.html:1163-1168) become `click` handlers that read the button's own pressed state, so the state source stays `filterState`:

```js
document.getElementById("excludeAi").addEventListener("click", () => {
  filterState = { ...filterState, excludeAi: !filterState.excludeAi };
  updateFilterUi(); syncUrl(); render();
});
document.getElementById("newOnly").addEventListener("click", () => {
  filterState = { ...filterState, newOnly: !filterState.newOnly };
  updateFilterUi(); syncUrl(); render();
});
```

`updateFilterUi` (index.html:906-921) changes two lines:

```js
document.getElementById("excludeAi").setAttribute("aria-pressed", String(filterState.excludeAi));
document.getElementById("newOnly").setAttribute("aria-pressed", String(filterState.newOnly));
```

Everything else about `updateFilterUi`, `activeDiscoveryCount`, `applyFilterState`, `clearFiltersBtn`, and `popstate` is unchanged, so the URL round trip (I5) holds by construction: `filterState` is still the only source and `syncUrl` still serialises it through `RepoFilters.serializeState`.

### 6.5 Copy link

```js
function setFilterBarStatus(message, tone = "") {
  const status = document.getElementById("filterBarStatus");
  status.textContent = message; status.dataset.tone = tone;
}
document.getElementById("copyLinkBtn").addEventListener("click", async () => {
  try { await CurrentViewExport.copyText(currentExportUrl()); setFilterBarStatus(tr("export.linkCopied"), "success"); }
  catch { setFilterBarStatus(tr("export.copyFailed"), "error"); }
});
```

It reuses `CurrentViewExport.copyText`, `currentExportUrl()` and the existing `export.linkCopied` / `export.copyFailed` keys, exactly as `#copyViewUrlBtn` does (index.html:1216-1219). `#copyViewUrlBtn` stays in the export group — the filter-bar button is a shortcut to the same action, not a replacement, and duplicating a two-line handler is cheaper than abstracting one. The status line is its own full-width row, so it does not participate in the three-column width rule.

---

## 7. Items 4–7 — copy, feeds, and history

### 7.1 Item 4 — `GITHUB INSIGHT`

| Location | From | To |
|---|---|---|
| index.html:6 `<title>` | `GitHub Trending — Insight Dashboard` | `GITHUB INSIGHT` |
| index.html:7 alternate title | `GitHub Trending Daily — Current repositories` | `GITHUB INSIGHT — Current repositories` |
| index.html:8 alternate title | `GitHub Trending Daily — New and re-entered repositories` | `GITHUB INSIGHT — New and re-entered repositories` |
| index.html:549 `<h1><button id="resetBtn">` | `GitHub Trending` | `GITHUB INSIGHT` |
| site-i18n.js `document.title` (all 5 locales) | locale-specific | `GITHUB INSIGHT` |
| site-i18n.js `feed.current` / `feed.changes` (all 5 locales) | locale-specific | the two English strings above |
| generate_atom_feeds.py:435 feed title | `GitHub Trending Daily — 현재 전체` | `GITHUB INSIGHT — Current repositories` |
| generate_atom_feeds.py:456 changes title | `GitHub Trending Daily — 신규·재진입` | `GITHUB INSIGHT — New and re-entered repositories` |
| generate_atom_feeds.py:409 author name | `GitHub Trending Daily` | `GITHUB INSIGHT` |
| generate_atom_feeds.py:513 `_validate_header` author literal | `GitHub Trending Daily` | `GITHUB INSIGHT` |
| generate_atom_feeds.py:521-522 `_validate_documents` title literals | the two Korean strings | the two English strings |

The feed titles unify on English, resolving the current EN page / KO feed mismatch. `SITE_URL`, `feed_id`, entry ids, and all hrefs are untouched (I8). `feed.xml` and `changes.xml` in the tree are **not** hand-edited; the next W1 refresh regenerates them, and `validate_atom_publication` will then compare the new literals against the newly generated documents.

The alternate-link href values stay `https://nowwcastle-sudo.github.io/github-trending-daily/feed.xml` and `.../changes.xml`.

### 7.2 Item 5 — held retry copy

New key `tooltip.heldRetry`:

| locale | value |
|---|---|
| en | `Retried at the next refresh (about every 2 hours).` |
| ko | `다음 갱신(약 2시간마다)에 다시 시도합니다.` |
| zh-CN | `将在下次刷新（约每 2 小时）时重试。` |
| es | `Se reintentará en la próxima actualización (aproximadamente cada 2 horas).` |
| ja | `次回の更新（約2時間ごと）で再試行します。` |

`tipHTML` (index.html:1008) renders it immediately below the existing held notice:

```js
if(r.summary_status==="held")return `${heading}${readme}<p class="tip-unavailable" role="status">${tr("tooltip.held")}</p><p class="thint tip-held-retry">${tr("tooltip.heldRetry")}</p>${actions}`;
```

No time arithmetic. The refresh schedule is currently held, so a computed "next retry at HH:MM" would be a claim the site cannot back — the copy states the cadence, not an instant.

### 7.3 Item 6 — observation start on the sparkline

`star-history.js` `historyHtml` appends the earliest observed timestamp to the explanation line when observed points exist. The copy pattern follows the existing fixed-Korean `EXPLANATION` constant:

```js
const OBSERVED_SINCE_PREFIX = "관측 시작 ";

function observedStartLabel(points) {
  const first = points.find(point => point.kind === "observed");
  return first ? `${OBSERVED_SINCE_PREFIX}${first.at.slice(0, 10)} ${first.at.slice(11, 16)} UTC` : "";
}

function historyHtml(slug, entry) {
  const points = displayPoints(entry);
  const observedCount = points.filter(point => point.kind === "observed").length;
  if (points.length === 0 || (observedCount === 0 && points.length < 2)) return '<p class="histnote">📈 관측 시작 대기</p>';
  const since = observedStartLabel(points);
  const explanation = since ? `${EXPLANATION} · ${since}` : EXPLANATION;
  if (points.length === 1) return `<p class="histnote">📈 관측 1회 · ${explanation}</p>`;
  return `<p class="histnote">📈 스타 히스토리</p>${sparkline(points)}<p class="histnote">${explanation}</p>`;
}
```

- `points` from `displayPoints` are already sorted ascending by `at` and already schema-validated to `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$` (`TIME_RE`), so `slice(0,10)` and `slice(11,16)` are safe substring reads, not date parsing — the rendered value is exactly what the ledger recorded, in UTC, with no timezone conversion.
- Anchors-only entries (no observed points) keep the existing text unchanged: a 2+ anchor entry keeps the bare `EXPLANATION`, and a 0/1-point entry keeps `관측 시작 대기`.
- `observedStartLabel` is not exported; it is internal to the module. The observable contract is `historyHtml`'s output.

### 7.4 Item 7 — held marker in the Atom feed

`_current_summary` (generate_atom_feeds.py:421-427) is the single function used by **both** the generator (`_current_document`) and the validator (`_validate_documents`), so prefixing there keeps generation and validation consistent by construction — this is why the prefix goes here and not in `_current_document`:

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

Entry `title`, `id`, `updated`, and `link` are untouched — the smallest change consistent with the existing entry format. `_validate_repository` already enforces `summary_status in {"verified","retained","held"}` (line 188) and `summary is None` for `held` (line 190), so the branch is total.

---

## 8. Item 8 — Content-Security-Policy

### 8.1 Origin inventory (measured, 2026-09-03)

Every origin below was found by reading the source, not assumed.

| Directive | Value | Where it comes from |
|---|---|---|
| `default-src` | `'self'` | fallback |
| `script-src` | `'self'` | 13 local `<script src>` (index.html:614-626) |
| | `'unsafe-inline'` | inline `<script>` at index.html:627 (holds the generated `REPOS` blob) and inline `<script type="module">` at index.html:1507 |
| | `https://www.gstatic.com` | `firebase-client.js:1,5,14,25` — `https://www.gstatic.com/firebasejs/12.17.1/{firebase-app,firebase-app-check,firebase-auth,firebase-firestore}.js` |
| | `https://www.google.com` | reCAPTCHA Enterprise, loaded by `ReCaptchaEnterpriseProvider` (`firebase-client.js:4,150`) from `https://www.google.com/recaptcha/enterprise.js` |
| | `'wasm-unsafe-eval'` **[verify]** | reCAPTCHA Enterprise compiles a WebAssembly module; without this, App Check attestation fails. Confirm in the browser console at §10 step 4 and drop it if no `wasm-eval` violation is logged. |
| `style-src` | `'self' 'unsafe-inline'` | the `<style>` block (index.html:9-444) and the inline `style="color:var(--accent)"` attribute at index.html:1323 |
| `img-src` | `'self' data:` | local assets; the inline SVG data URI at index.html:216 |
| | `https://raw.githubusercontent.com` | `readme-markdown.js:27` `rawBase` for README-relative images |
| | **arbitrary https hosts** — see §8.4 | `readme-markdown.js:37-43` returns any absolute `https:` URL as `external:true`; line 84 emits it as `<img src>` |
| `connect-src` | `'self'` | `star-history.json`, `data/membership-status.json`, `firebase-config.json` (`firebase-client.js:145`) |
| | `https://api.github.com` | index.html:1303 README Contents fetch |
| | `https://firestore.googleapis.com` | Firestore (`initializeFirestore`, WebChannel over HTTPS) |
| | `https://identitytoolkit.googleapis.com` | Firebase Auth |
| | `https://securetoken.googleapis.com` | Firebase Auth token refresh |
| | `https://content-firebaseappcheck.googleapis.com` | App Check token exchange |
| | `https://www.google.com` | reCAPTCHA |
| `frame-src` | `https://github-trending-nowwcastle-sudo` … see note | `signInWithPopup` (`firebase-client.js:229`) also installs a hidden `https://<authDomain>/__/auth/iframe`. `authDomain` is pinned to `github-trending-nowwcastle.firebaseapp.com` (`firebase-client.js:98`), so the exact host — not a `*.firebaseapp.com` wildcard — is used |
| | `https://www.google.com` | reCAPTCHA challenge iframe |
| | `https://accounts.google.com` | Google sign-in |
| `font-src` | `'self'` | **no webfonts**: index.html:41 is a system font stack; grep found no `@font-face` and no `fonts.googleapis.com` / `fonts.gstatic.com` anywhere |
| `object-src` | `'none'` | no plugin content |
| `base-uri` | `'self'` | |
| `form-action` | `'self'` | no `<form>` in the page |

### 8.2 Corrections to the brief's draft policy

The draft in the brief was a placeholder and is wrong in six places. The plan uses the inventory, not the draft:

1. `https://apis.google.com` — **not used**. Firebase JS v12 modular does not load `gapi`.
2. `https://www.google.com` — **missing** from the draft's `script-src`, `connect-src`, and `frame-src`; reCAPTCHA Enterprise needs all three.
3. `https://*.googleapis.com` — replaced by the four exact hosts above.
4. `https://*.firebaseio.com` / `wss://*.firebaseio.com` — **not used**. Those are Realtime Database hosts; this project uses Firestore only.
5. `https://avatars.githubusercontent.com` and `https://github.com` in `img-src` — **not used**. The page renders no avatar or GitHub-hosted image; `github.com` appears only as `<a href>`, which `img-src` does not govern.
6. `https://*.firebaseapp.com` — replaced by the exact pinned `authDomain`.

### 8.3 Policy

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.gstatic.com https://www.google.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self';
connect-src 'self' https://api.github.com https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://content-firebaseappcheck.googleapis.com https://www.google.com;
frame-src https://github-trending-nowwcastle.firebaseapp.com https://www.google.com https://accounts.google.com;
object-src 'none';
base-uri 'self';
form-action 'self'
```

Delivered as one `<meta http-equiv="Content-Security-Policy" content="…">` on a single line, placed immediately after `<meta name="viewport">` (index.html:5) so it precedes every script and style. `frame-ancestors`, `report-uri`, and `sandbox` are omitted — browsers ignore them in a `<meta>` policy.

### 8.4 Decision gate — `img-src`

`readme-markdown.js` `resolveUrl` (lines 34-56) accepts **any** absolute `http:`/`https:` URL and marks it `external: true`; `inline` (line 84) then emits `<img src="…">` from it. README files routinely carry badges from `img.shields.io`, proxied images from `camo.githubusercontent.com`, and images from arbitrary hosts. A narrow `img-src` allowlist would break those images **silently** — no error, just missing pictures in the README panel.

Three options, with the recommendation:

- **A (recommended, written into §8.3).** `img-src 'self' data: https:`. Any HTTPS image loads; plain HTTP does not. Every other directive stays a strict allowlist. Images are a weak exfiltration channel here — the README markdown is already fetched from `api.github.com` under a pinned commit SHA with a client-side SHA-256 check (index.html:1303-1307), and the renderer escapes all text.
- **B.** Narrow allowlist (`https://raw.githubusercontent.com https://camo.githubusercontent.com https://img.shields.io`) and accept that other README images break.
- **C.** Change `readme-markdown.js` to drop non-allowlisted external image origins. This is a renderer behaviour change and is outside this brief's scope.

**Nothing here requires `*` or `'unsafe-eval'`.** Two weakenings are recorded and must be acknowledged rather than discovered later:

- `script-src 'unsafe-inline'` is **unavoidable in this repository** without a build step. The page's largest inline script embeds the regenerated `REPOS` blob, so a static hash would change on every refresh, and adding nonce/hash emission to `scripts/update-trending.mjs` is explicitly out of scope (§2). A nonce is also impossible for a statically hosted GitHub Pages file with no server.
- `'wasm-unsafe-eval'` is **narrower than `'unsafe-eval'`** and is marked `[verify]`: it is included defensively and removed at §10 step 4 if the browser logs no WebAssembly violation.

If browser verification (§10 step 4) shows a runtime path that a `*`-free policy cannot express, Task 11 stops and reports rather than widening the policy.

### 8.5 CSP test contract

`tests/page-runtime.test.mjs` gains a test that:

1. Extracts the `content` attribute of the CSP meta and parses it into `{directive: [values]}`.
2. Asserts the exact directive set and, for `script-src`/`connect-src`/`frame-src`, the exact value list.
3. Scans `index.html` (runtime script region only — outside the `GENERATED:TRENDING-REPOS` markers, per I9), `firebase-client.js`, `auth-lifecycle.js`, `favorite-sync.js`, `readme-markdown.js`, `star-history.js`, and `current-view-export.js` for `https://<host>` literals and asserts every distinct host is covered by some directive value (exact host match, or `https:` for `img-src`). This is the assertion that fails when code later introduces an unlisted origin.
4. Asserts the policy contains neither `'unsafe-eval'` nor a bare `*`.

---

## 9. Items 9–11 — shortcuts, failing tests, CI

### 9.1 Item 11 — the failing tests

`npm test` on `ac3e1db` reports `# tests 634 / # pass 617 / # fail 5`. The brief said four; there are five. Diagnoses:

| # | Test | Cause | Fix |
|---|---|---|---|
| 1 | `tests/page-runtime.test.mjs` "README tabs consume only Markdown tied to immutable repository metadata" (:571) | `assert.doesNotMatch(page, /raw\.githubusercontent\.com/)` scans the whole file. All **7** occurrences are inside the generated `REPOS` blob (character range 43780-615306), in repository summary prose (e.g. `unclebob/swarm-forge` install instructions). **Zero** occurrences outside it. | Scope the assertion to the runtime script region — the page with the `GENERATED:TRENDING-REPOS:START…END` span removed (I9) |
| 2 | `tests/repo-filters.test.mjs` "embedded snapshot exposes the exact daily weekly and monthly memberships" (:225) | Literals `45` and `[45,16,20,22]`; the snapshot now has 55 repositories. Any refresh re-breaks it. | Derive expectations from the embedded data: every repository has a valid period membership; the `all` count equals `repositories.length`; each of daily/weekly/monthly equals the count of repositories with a non-null `rank_<period>` |
| 3 | `tests/production-readme-enrichment.test.mjs` "tracked production migration gate…" (:88) | `assert.deepEqual(Object.keys(sourceRegistry.sources), repositories.map(r => r.slug))` — the registry has 53 sources, the page 55 repositories. The two extras are `summary_status === "held"` (`Imbad0202/academic-research-skills`, `donnemartin/system-design-primer`) and correctly have no source entry | Compare against non-`held` slugs, and assert positively that every `held` repository has `summary === null`, `detail === null`, and no `sources` entry |
| 4 | `tests/update-trending.test.mjs` "seeded cache preserves every detailed content record…" (:369) | `const { stars_note, ...detail } = repo.detail` throws on the `held` repositories (`detail === null`), and `cache[repo.slug]` is `undefined` for them | Skip `held` in the loop and assert instead that they have `summary === null`, `detail === null`, and no `data/repo-summaries.json` entry |
| 5 | `tests/star-ticks-workflow.test.mjs` "the tick ledgers start empty and tracked" (:94) | **Not a defect on main.** `git ls-files --eol data/star-daily.jsonl` reports `i/lf w/crlf` — the git index holds LF (per `.gitattributes` `data/star-daily.jsonl text eol=lf`, added in the merge at `7e07b70`) but this working copy still has a stale CRLF file | Working-tree repair, not a code change: delete the file and re-check it out. No commit |

Fixes 1-4 change tests only. Fix 5 changes no tracked file.

### 9.2 Existing tests that must change

| File | Test (current lines) | Why |
|---|---|---|
| `tests/page-runtime.test.mjs` | "sidebar sections follow the approved priority and keyboard order" (509-537) | `periodSection`/`languageSection` gone; `#sidebarGroupSeg` added; focus order loses `periodSeg`, `lang`, `excludeAi` |
| | "fine pointers expose the selected 64px compact Explore rail" (637-644) | Rail now holds four `.nav-toggle` buttons |
| | "hover-open sidebar stays passive…" (646-659), "README modal blocks incidental hover…" (661-672), "click and keyboard activation upgrade hover-open sidebar exactly once" (699-711), "tooltip does not inert a focused hover sidebar…" (719-736), "incidental rail hover preserves a focused tooltip…" (738-756) | Harness keyed to one toggle; extended to four |
| | "hover close starts immediately outside the combined rail and sidebar…" (674-695) | Rewritten for the 500 ms grace (§5) |
| | "hover close button restores rail focus before hiding and inerting the sidebar" (758-772) | `sidebarTrigger` now tracks the specific rail button |
| | "responsive sidebar owns account, favorites, and discovery filters" (1054-1075) | Asserts `id="lang"` and `id="excludeAi"` inside the sidebar; they move to the filter bar |
| | "the selected compact Explore rail stays reachable…" (1130-1158) | Asserts `setSidebarTriggerState(tr("nav.close"),true)`; replaced by `setSidebarExpandedState` |
| | "new-only control follows AI exclusion and owns the complete public view state" (1178-1193) | Asserts the `<fieldset>`/checkbox markup in `#fieldSection`; moves to filter-bar toggles |
| | "the page head advertises both exact Atom subscription endpoints" (1405-1411) | Pins the old alternate-link titles |
| `tests/ui-motion.test.mjs` | "sidebar mode separates passive hover from modal activation" (125-131) | Extended with `resolveSidebarGroup`, `SIDEBAR_GROUPS`, `SIDEBAR_HOVER_CLOSE_DELAY_MS` |
| `tests/star-history.test.mjs` | historyHtml assertions | Observation-start suffix |
| `tests/test_atom_feeds.py` | header literal assertions | Title and author rename, held prefix |

### 9.3 Item 9 — keyboard shortcuts

```js
const SIDEBAR_SHORTCUT_GROUPS = { e: "explore", a: "account", h: "history", x: "export" };

function shortcutSuppressed(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  const tag = String(target?.tagName || "").toLowerCase();
  return tag === "input" || tag === "select" || tag === "textarea" || target?.isContentEditable === true;
}

document.addEventListener("keydown", event => {
  if (shortcutSuppressed(event)) return;
  if (event.key === "/") { event.preventDefault(); document.getElementById("q").focus(); return; }
  const group = SIDEBAR_SHORTCUT_GROUPS[event.key];
  if (!group) return;
  if (document.getElementById("readmePanel").classList.contains("open")) return;
  event.preventDefault();
  const trigger = sidebarMobileAccessMedia.matches
    ? mobileNavToggle
    : railToggles.find(toggle => toggle.dataset.group === group);
  openSidebar("modal", trigger, group);
});
```

- **Suppression.** Alt/Ctrl/Meta and any `input`/`select`/`textarea`/`contenteditable` target. `Shift` is deliberately **not** suppressed: `event.key` already reports the produced character, so `Shift+/` arrives as `"?"` and never matches, while a layout that requires Shift to produce `/` still works.
- **Escape** is already handled by the existing listener (index.html:773) and is unchanged.
- **README modal wins.** While `#readmePanel` is open, group shortcuts are ignored so the panel keeps ownership of the viewport; its own `Escape` handler (index.html:1258) still closes it.
- **Trigger.** On touch/narrow viewports the rail is `display:none`, so focusing a rail button on close would be a no-op; the mobile toggle is used instead. This is the same media query (`sidebarMobileAccessMedia`) that already governs `#mobileNavToggle` access.
- Shortcut hints appear in each rail button's `title` via `data-i18n-title` — "Explore (e)", "Login (a)", "History (h)", "Export (x)" — and `site-i18n.js` `apply()` already handles `data-i18n-title` (site-i18n.js:279-282).

**Amendment (2026-09-04, Task 7, from the Task 6 review).** The `#readmePanel` open-check moves out of the listener body and into `shortcutSuppressed`, so it runs *before* the `"/"` branch instead of after it; as written above `/` would `preventDefault()` and focus `#q` while `.wrap` is `inert`, swallowing the keystroke. `shortcutSuppressed` therefore reads: Alt/Ctrl/Meta, then the README-modal open-check, then the `input`/`select`/`textarea`/`contenteditable` target test.

### 9.4 Item 10 — CI workflow

`.github/workflows/tests.yml`:

- `on: pull_request: branches: [main]` and `push: branches: [main]`
- `permissions: contents: read`
- One job, `runs-on: ubuntu-latest`, `timeout-minutes: 15`
- Actions pinned to the SHAs already used by `deploy-current-pages.yml`:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1)
  - `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0) with `node-version: "24"`
  - `actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97` (v7.0.0) with `python-version: "3.13"`
- Steps: `npm ci` then `npm test`
- No secrets, no `concurrency` group (it must never queue behind `daily-refresh`/`pages`)
- `npm run test:rules` is **excluded** — `tests/firestore.rules.test.mjs` needs the Firebase emulator, which `npm test` deliberately does not invoke

Structural test `tests/tests-workflow.test.mjs` follows the shape of `tests/codeql-workflow.test.mjs`: normalise CRLF, assert triggers, `permissions: contents: read`, absence of `contents: write`, the exact ordered `uses:` SHA list, that every `uses:` matches `/@[a-f0-9]{40}$/`, the two version pins, that the run steps are `npm ci` then `npm test`, and that the file contains neither `test:rules` nor `secrets.`.

---

## 10. Rollout

1. Branch `claude/github-insight-ui-20260903` (created by the orchestrating agent, not by task implementers).
2. Tasks 1-12 land on that branch. `npm test` in **PowerShell** is green at the end of every task. (Git Bash makes two `tests/pages-publication.test.mjs` cases fail spuriously; PowerShell is the reference shell.)
3. Two adversarial red-team reviews (opus, different angles) → fixes. A fable 5.1 independent review is **not** requested this round.
4. PR → CodeQL → merge approval.
5. **W1 dispatch.** Code changes publish only through `daily-refresh.yml`; there is no direct deploy from this branch (I10). The same run regenerates `feed.xml` / `changes.xml` with the new titles and the held prefix.
6. **Production browser verification.** Confirm on the deployed page: no CSP violations in the console (this is where `'wasm-unsafe-eval'` is kept or dropped, §8.1), Google sign-in completes, README images render, the four groups switch on hover and by keyboard, the 500 ms grace behaves, and the filter bar never exceeds the card column at 1440 / 768 / 390 px.
7. **README PR (item 12), separate and last** — only after production verification. Rewrites `README.md` and `README.ko.md` for the new name, repository-level `held` admission, 30-minute star ticks into the site's own ledgers (with the required wording "최초 관측 후 최소 1일이면 히스토리 확인 가능"), gain anchors, the four rail groups, the filter bar, the shortcuts, advantages over other trending sites, a "Planned features" section, and a request channel: `.github/ISSUE_TEMPLATE/feature_request.yml` plus `config.yml` with `blank_issues_enabled: false`. The en/ko parity test in `tests/site-i18n.test.mjs` must stay green.

---

## 11. Error modes

| Condition | Behaviour |
|---|---|
| `data-group` is absent, misspelled, or a non-string | `resolveSidebarGroup` returns `"explore"`. No throw, no empty panel |
| A group's sections are all `hidden` because the group has no members | Cannot occur — all four groups have at least one section, asserted by a test that reads the markup |
| Hover-close timer fires after the panel became modal | `closeHoverSidebarNow` re-checks `openMode !== "hover"` and returns. Also, `openSidebar` calls `cancelHoverClose()` |
| Hover-close timer fires after the panel already closed | Same guard; `closeSidebar` is a no-op without `dataset.openMode` anyway (index.html:713) |
| Rail button clicked while modal on another group | Group switches, `sidebarTrigger` retargets; panel stays open |
| Shortcut pressed while focus is in the search box | Suppressed — `#q` is an `input` |
| Shortcut pressed while the README panel is open | Group shortcuts ignored; `Escape` still closes the README |
| Shortcut pressed on a touch device | `sidebarMobileAccessMedia` routes the restore-focus trigger to `#mobileNavToggle` |
| `CurrentViewExport.copyText` rejects (no clipboard permission, insecure context) | `#filterBarStatus` shows `export.copyFailed` with `data-tone="error"`; no throw escapes |
| CSP blocks something at runtime | Console reports a violation; §10 step 6 catches it before the README PR. `img-src https:` (§8.4) is the deliberate relief valve for README images |
| A `held` repository has `description === ""` and `summary === null` | `_current_summary` returns `"[요약 검증 중] " + name`; `_validate_repository` guarantees those fields exist |
| A repository has anchors but no observed points | `historyHtml` keeps the existing text with no observation-start suffix |

---

## 12. Test scope

| Area | File | What is proved |
|---|---|---|
| Group resolver, delay constant | `tests/ui-motion.test.mjs` | `SIDEBAR_GROUPS` exact list; `resolveSidebarGroup` totality on 6 bad inputs; `SIDEBAR_HOVER_CLOSE_DELAY_MS === 500` |
| Rail markup, group attributes, glyphs, CSS | `tests/page-runtime.test.mjs` | Four buttons in order with exact ids/`data-group`/aria; every section carries a valid group; all four groups non-empty; `.sidebar-refresh[hidden]` rule present; tokens I6 unchanged |
| Group switching | `tests/page-runtime.test.mjs` (harness) | Hover A→B switches without close; unknown group falls back; keyboard activation opens modal on that group and restores focus to that button; modal + different button switches instead of closing; `#sidebarGroupSeg` hidden in hover, shown in modal |
| Hover grace | `tests/page-runtime.test.mjs` (harness, fake timers) | Still open at 499 ms, closed at 500 ms; re-entry inside the window cancels; focusout closes synchronously; modal upgrade during the window cancels |
| Filter bar | `tests/page-runtime.test.mjs` | Markup order; the three CSS width rules verbatim; `aria-pressed` round trip through `updateFilterUi`; the sidebar no longer contains `#lang`/`#periodSeg`/the fieldset |
| URL contract | `tests/repo-filters.test.mjs` | Unchanged `parseState`/`serializeState` for `period`, `lang`, `exclude=ai`, `membership=new` |
| Shortcuts | `tests/page-runtime.test.mjs` (harness) | `/` focuses `#q`; `e`/`a`/`h`/`x` open the right group modally; suppressed inside inputs and with Ctrl/Alt/Meta; ignored while README is open; `title` attributes carry the hint keys |
| i18n | `tests/site-i18n.test.mjs` | All five locales carry every new key (I1) |
| CSP | `tests/page-runtime.test.mjs` | Exact directives; every https host literal in the seven source files is allowed; no `'unsafe-eval'`, no bare `*` |
| Rename | `tests/page-runtime.test.mjs`, `tests/test_atom_feeds.py` | New titles; unchanged hrefs and feed ids |
| Held copy | `tests/page-runtime.test.mjs`, `tests/site-i18n.test.mjs` | `tooltip.heldRetry` rendered under the held notice, present in five locales |
| Star history | `tests/star-history.test.mjs` | Observation-start suffix format; absent when no observed points |
| Atom held marker | `tests/test_atom_feeds.py` | Prefix on held entries only; generator and validator agree |
| CI workflow | `tests/tests-workflow.test.mjs` | Triggers, permissions, pinned SHAs, `npm ci` + `npm test`, `test:rules` excluded, no secrets |
