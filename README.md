# GITHUB INSIGHT

[한국어](README.ko.md)

> A focused, static dashboard for understanding what a trending repository does, how it is used, and whether it is relevant, beyond its star count.

<h2 align="center"><a href="https://nowwcastle-sudo.github.io/github-trending-daily/"><strong>Open GITHUB INSIGHT</strong></a></h2>

No server setup or account is required. Google sign-in is optional and is used only to synchronize favorites.

## 🔭 What it does

GITHUB INSIGHT watches the repositories that appear on GitHub Trending (daily, weekly, and monthly) and, for each one, gives you two things other trending pages do not: a star count this site measured itself rather than a third-party estimate, and a verified summary generated from the repository's own README rather than a generic description. You can filter, sort, favorite, and export the current view, and subscribe to Atom feeds instead of checking back manually.

## 🖥️ Interface

The screenshots below were captured from the live site at 1440 px and 390 px, with all four rail groups (Login, Explore, History, Export) visible.

![GITHUB INSIGHT desktop at 1440 px](docs/screenshots/desktop-1440.png)

<p align="center"><img src="docs/screenshots/mobile-sidebar-390.png" width="390" alt="Mobile view with the panel open"></p>

## 🎛️ Four rail groups

The 64 px rail on the left has four buttons, each opening the same panel with a different group selected. On desktop it opens a passive sidebar on hover (with a short close grace period so the pointer can cross the gap) and a focus-trapped modal when clicked or activated from the keyboard; on mobile, right-edge swipe opens it and left swipe closes it. The native trigger button stays visually hidden on mobile unless reached by a screen reader or hardware keyboard.

- 🔑 **Login** covers Google sign-in and favorites synchronization; local favorites still work when signed out.
- 🧭 **Explore** holds period, sorting, favorites, programming language, field, form, technology, and AI-exclusion filters. Choices use OR within a group and AND between groups.
- 🕘 **History** lists hidden ("Not interested") repositories with individual or complete recovery, plus recently new or re-entered repositories.
- 📤 **Export** provides CSV/JSON export of the current public view and a copyable discovery URL.

Keyboard shortcuts open the matching group directly: `a` for Login, `e` for Explore, `h` for History, `x` for Export. `/` moves focus to search, and `Escape` closes whichever panel is open.

## 🔍 Filter bar

A compact filter bar sits directly under the badge guide, always visible without opening the rail panel: period (daily/weekly/monthly/combined), language, an **Exclude AI** toggle, a **New repositories only** toggle, and **Copy link**, which writes the current filter state to the clipboard as a shareable URL. It mirrors a subset of the Explore group's controls so the most common filters do not require opening the sidebar at all.

## 🚦 Repository admission and held summaries

Each repository is admitted to the page on its own: it either ships with a complete, verified five-language summary, or it is published as **held**. A held repository's card still shows its measured data (stars, forks, activity, rank), but in place of the AI summary it shows a fixed, localized "summary being verified" notice and is retried automatically at the next scheduled refresh (every 6 hours). No other repository on the page is affected by one repository being held. GITHUB INSIGHT never falls back to an all-or-nothing publish.

## ⭐ Star history

Star counts on this site are not estimated. Every 30 minutes, the exact total star count of each published repository is recorded straight from the GitHub API into this project's own append-only records, not a third-party service's derived numbers.

On the card, the solid line is that measured history; a dashed line with hollow markers extends it backward using anchors back-calculated from GitHub Trending's own period-gain figures (daily, weekly, monthly, and the creation date for repositories under 30 days old) wherever there is no direct observation yet. Because the chart only needs two points to draw a line, a repository can show its first line after about an hour (two 30-minute observations); a curve that meaningfully covers a full day of movement builds up over roughly the first day of observation.

## 📜 Summary quality contract

No summary is generated before the repository and its README have been collected and verified.

Each repository is produced as one atomic five-language bundle:

- `goal`, `usage`, `pros`, `cons`, and `fit` must be distinct, keep their semantic roles, and be grounded in the verified README. Installation and execution instructions belong in `usage`.
- The English bundle may contain 100–280 words. Other locales are not required to match its word count, sentence count, phrasing, or information order.
- Only commands that appear in the README may be quoted, limited to one or two central commands and retained in the same semantic field across locales.
- Generic "see the README" fallbacks are invalid. Subjective wording alone does not fail an otherwise source-backed, structurally complete summary.
- README path, blob, content hash, and default-branch head identify the shared canonical source; they are not used to require byte-for-byte or perfectly equivalent prose across locales.
- Up to three quality corrections are allowed per repository.
- One missing locale, misplaced or unbacked immutable token, insufficient source, or schema defect fails the entire repository and therefore the refresh. That repository is published `held` instead.

The interface describes these summaries accurately as AI-generated from a verified repository README; it does not claim human verification.

## ✨ Features

- Daily, weekly, monthly, and combined GitHub Trending views with exact period membership.
- Total stars everywhere; exact period gain and HOT only in daily, weekly, and monthly views, plus forks, issues and pull requests, contributors, recent commits, and releases.
- Momentum history from this site's own star observations, consecutive Trending observations, rank change, new, and re-entered signals.
- Search plus programming-language, field, form, technology, favorites, and AI-exclusion filters.
- Stable sorting by selected-period Trending rank, period gain, total stars, latest push, or latest release; Combined preserves source order.
- Shareable URL state for public discovery controls; browser-local hidden repositories are not included.
- Per-browser **Not interested** with undo and individual or complete recovery.
- Local favorites when signed out and optional Google-account synchronization when signed in.
- Current-view CSV and JSON export containing public fields only, plus a copyable discovery URL.
- README variants from upstream only. The viewer lists only README language files that actually exist in the repository, verified by path, immutable blob SHA, default-branch head SHA, and content SHA-256 before rendering. This project no longer generates or stores full README translations.
- [feed.xml](https://nowwcastle-sudo.github.io/github-trending-daily/feed.xml) for the current repository set and [changes.xml](https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml) for new and re-entered membership events. Both feeds are titled `GITHUB INSIGHT — Current repositories` and `GITHUB INSIGHT — New and re-entered repositories`.
- Light and dark themes, keyboard navigation, focus trapping, 44 px touch targets, reduced-motion handling, reduced-transparency handling, BFCache restoration, and responsive layouts.
- `?` opens a keyboard-shortcut dialog listing `/`, `e`, `a`, `h`, `x`, `Delete`, `Esc`, and `?`, with a checkbox that disables the single-key letter shortcuts for anyone who needs it (WCAG 2.1.4). `/`, `?`, and `Escape` keep working either way.
- Named, saved filter presets: store the current Explore filters under a name in this browser and re-apply them in one click, up to 20 presets.
- A compact list mode that collapses card padding and hides the classification badges and sparklines, roughly tripling the repositories on screen; the choice is remembered in this browser.
- A "new since your last visit" heading and per-card badge, computed in this browser against the repositories it saw last time — separate from the baseline-relative **New** membership badge, which is the same for every visitor.

## ⚖️ Advantages over other trending sites

- Star counts come from this site's own 30-minute observations, recorded straight from the GitHub API into its own database, rather than a third-party estimate service. GitHub Trending's period-gain figures fill in dashed, back-calculated anchors only where no direct observation exists yet.
- A repository whose summary fails verification is shown as `held` with its measured data intact, instead of a wrong or generic summary; the repository stays on the page.
- Every summary is generated from that repository's own verified README, in five locales, with the source path, blob SHA, and content hash recorded as provenance.
- Two Atom feeds cover the site: one for the current repository set, one for new and re-entered repositories, so you can subscribe to just the "what's new" signal.
- Five real interface locales share the same message keys instead of being machine-translated on every page load: English, Korean, Simplified Chinese, Spanish, and Japanese.
- `/`, `e`, `a`, `h`, `x`, and `Escape` reach every rail group and search without touching the mouse.
- Four purpose-built rail groups (Login, Explore, History, Export) replace one catch-all menu.
- CSV/JSON export and a shareable filtered URL require no account.
- The site is static. The browser sends nothing to a backend GITHUB INSIGHT operates, other than optional Google sign-in for favorites sync.

## 🚀 How to use

1. Open the [site](https://nowwcastle-sudo.github.io/github-trending-daily/).
2. Choose the site language in the header.
3. Use the always-visible filter bar for period, language, **Exclude AI**, and **New repositories only**, or open the **Explore** group (`e`) for the full filter set: period, sorting, favorites, programming language, field, form, technology, and AI-exclusion filters. Choices use OR within a group and AND between groups.
4. Hover or focus a card on desktop, or tap it on mobile, to open the complete summary in the header's selected site language. A `held` repository shows a "summary being verified" notice instead, and is retried automatically.
5. Select **View README** to see the verified canonical README and any upstream language variants that the repository actually provides.
6. Open **Login** (`a`) to save a favorite locally or sign in with Google to synchronize it. Hiding a repository does not remove its favorite.
7. Open **History** (`h`) to review or restore hidden repositories, or see recently new and re-entered repositories.
8. Open **Export** (`x`), or use **Copy link** in the filter bar, to export the current public view as CSV or JSON, copy its URL, or subscribe to an Atom feed.

## 🔄 Refresh and publication safety

The site refreshes four times a day at minute 07 of 00:00, 06:00, 12:00 and 18:00 in `Asia/Seoul` (03:07, 09:07, 15:07 and 21:07 UTC). Canonical repository and README facts are collected and frozen first. Exact five-language coverage or per-repository `held` admission, provenance validation, rendering, and artifact validation must all complete before anything is published.

The refresh is fail closed:

- No summary is generated if collection fails.
- An incomplete refresh writes no page, commit, or deployment.
- A failed refresh leaves the published site unchanged.
- Missing or stale README provenance, source mismatch, incomplete source, invalid summary output, or translation residue stop publication.
- The browser never receives any API credentials.

Star history is observed by this site itself: the exact total stars of every published repository are recorded every 30 minutes and, once a day, of every repository ever published (up to 500 repositories, kept by 7-day gain). Dashed anchors are back-calculated from GitHub Trending period gains (daily, weekly, monthly, plus the creation date for repositories under 30 days old) and are approximations. GH Archive-derived estimates were discontinued on 2026-09-02 after the upstream source declared its event-derived counts severely degraded since 2026-05-01. CSV uses a UTF-8 BOM for spreadsheet compatibility, quotes commas, quotes, and line breaks, and prefixes formula-like values with an apostrophe.

## 🗺️ Planned features

The approved backlog is kept intentionally short, and nothing currently queued changes what the site shows. Anything not already on this page starts as a feature request; the section below is the way to ask.

## 📝 Requesting a feature

If something above does not cover what you need, please [open a feature request](https://github.com/nowwcastle-sudo/github-trending-daily/issues/new/choose) using the **Feature request** issue template. It asks what problem you are hitting, what you would like instead, and what you have already tried, which is enough for a first look. Blank issues are disabled in favor of this structured form.

## 🧪 Local verification

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py"
```

Run these commands from the repository root in PowerShell. Production activation, workflow dispatch, and Pages deployment are separate controlled steps.

## 📄 License

This project is released under the [MIT License](LICENSE). Trending data shown on the site belongs to the respective repository owners and GitHub; the license covers this project's own code, workflows, and generated pages.
