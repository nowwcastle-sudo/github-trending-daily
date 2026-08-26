# GitHub Trending Daily

[한국어](README.md)

> Do more than glance at star counts. See why a repository is gaining attention, how it is used, and whether it matches your interests—all from one focused page.

## Open it now

<h2 align="center"><a href="https://nowwcastle-sudo.github.io/github-trending-daily/"><strong>🚀 Open GitHub Trending Daily</strong></a></h2>

Browse immediately with no server setup or account creation. Google sign-in is optional and only needed when you want favorite synchronization.

## Production screenshots

![GitHub Trending Daily desktop production view](docs/screenshots/production-desktop.png)

<p align="center"><img src="docs/screenshots/production-mobile-sidebar.png" width="390" alt="GitHub Trending Daily mobile sidebar production view"></p>

Both images were captured from the live [production site](https://nowwcastle-sudo.github.io/github-trending-daily/) on 2026-08-26.

## Why it exists

GitHub Trending is useful for discovering projects, but comparing daily, weekly, and monthly momentum while opening every README to understand purpose and usage takes time. GitHub Trending Daily reduces that exploration cost by combining Trending data, public GitHub metadata, and README-based Korean summaries in a focused static dashboard.

It is designed to help you judge more than total popularity: how quickly a project is attracting attention now, what it actually does, and whether it fits your interests.

## Current features

- **Two-hour automatic refresh** — Collects daily, weekly, and monthly GitHub Trending samples on a Seoul-time schedule.
- **Information-dense repository cards** — Shows total stars, period gains, forks, issues, contributors, recent commits, and releases together.
- **Momentum signals** — Displays star history, consecutive Trending days, change since the previous observation, and HOT badges.
- **Atom subscriptions** — [feed.xml](https://nowwcastle-sudo.github.io/github-trending-daily/feed.xml) provides the current complete Trending list, while [changes.xml](https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml) provides the newest 100 new and reentered events after the baseline.
- **Current-view export** — Choose **CSV download**, **JSON download**, or **Copy the current link** in the sidebar. The export uses the repositories and order visible after search, filters, hidden choices, favorites, and sorting, without including account data or the complete hidden and favorite lists.
- **Period views** — Switches among all, daily, weekly, and monthly results in one control.
- **Selectable sorting** — Keeps the original Trending order by default, or sorts by selected-period star gain, total stars, latest push, or latest release. Missing values stay last and ties keep their original order.
- **Search and language filtering** — Searches repository text and narrows results by programming language.
- **Multi-select field tags** — Combines AI and machine learning, web and app development, developer tools, data and databases, DevOps and infrastructure, security and privacy, and other fields.
- **Independent form and technology tags** — Combines Agent, MCP, Plugin and Skill, IDE and coding tools, Library and SDK, Framework, and CLI and Automation independently from fields.
- **Exclude-AI toggle** — Removes AI-related repositories at once to surface projects from other fields.
- **Shareable URL state** — Preserves period, sorting, favorites view, query, language, field and form tags, and AI exclusion in the address and restores them through browser history. Browser-local hidden choices are not included in the URL.
- **Responsive summaries and README viewer** — Uses a conditional desktop tooltip and a first-tap mobile summary, with original and cached Korean README views.
- **Per-browser Not interested** — Hides a repository from the desktop tooltip or mobile summary, with immediate undo and individual or full recovery in the sidebar. Hiding a repository leaves its favorites intact.
- **Local and account favorites** — Stores signed-out favorites in the current browser and synchronizes them across devices and browsers after Google sign-in.
- **Sidebar-first discovery** — Opens the overlay sidebar from the left-edge Explore icon and shows recent and next refresh times at the top. Press it again, click outside, or press Escape to close it.
- **Accessible responsive UI** — Supports light and dark themes, keyboard focus, 44 px mobile touch targets, reduced motion, and reduced transparency.

## Roadmap

- **Improve classification precision** — Sample and review accumulated Trending repositories and GitHub Topics to keep tuning field and form tag rules.
- **Keep personalization as a later design** — Review official OAuth, terms, token scope, static-site key exposure, and billing abuse before considering a separate privacy-minimizing recommendation feature.

## How to use

1. Open the [production site](https://nowwcastle-sudo.github.io/github-trending-daily/).
2. Choose all, daily, weekly, or monthly at the top, or search repository names and descriptions.
3. Press the left-edge **탐색 (Explore) icon** to combine sorting, favorites view, programming language, field, form and technology, and AI-exclusion conditions. Choices use OR within one group and AND between different groups.
4. Hover over a card on desktop, or tap it once on mobile, to inspect the project's goal, usage, strengths, and limitations. Choose **Not interested**, or focus the card and press Delete, to hide it in the current browser; restore it from the undo notice or sidebar.
5. Use the star button to save a favorite. Signed-out favorites stay in the current browser; Google sign-in synchronizes them to the same account.
6. Copy the address after sorting or filtering to share the same discovery state. Hidden choices are not shared.
7. Use **CSV download**, **JSON download**, or **Copy the current link** in the sidebar to export the current repository order or public discovery state.
8. Add `feed.xml` to an Atom reader for every current repository, or `changes.xml` for membership changes only.

## Refresh and data

GitHub Actions runs at minute 07 of each odd-numbered hour in Asia/Seoul, refreshing the data about every two hours. The pipeline uses GitHub Trending pages and public repository metadata and Topics from the GitHub REST API. Current total stars come from GitHub, while historical star charts may include GH Archive-based estimates.

A cost gate sends a repository to the paid Korean translation queue only when it is new or its **README hash** has changed. The site is served statically through GitHub Pages and does not expose a personalization model or user API key in the current page.

CSV includes a **UTF-8 BOM** for Korean Excel compatibility and uses the fixed columns `slug, name, description, language, topics, stars, forks, issues, contributors, period_gain, pushed_at, latest_release, membership_status`. Commas, quotes, and line breaks use CSV quoting, and formula-like strings are prefixed with an apostrophe.
