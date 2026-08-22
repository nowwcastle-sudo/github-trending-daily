# Daily GitHub Trending Refresh Design

**Date:** 2026-08-22

**Status:** Approved by the user's explicit requirement to refresh the site every day
**Scope:** Trending discovery, metadata refresh, Korean summary continuity, star-history integration, scheduling, and last-good-output protection

## Purpose and non-negotiable outcome

This repository exists to present a current, Korean-language digest of GitHub Trending. A deployment that leaves the repository list stale is not valid even if authentication and charts work.

The daily pipeline succeeds only when it reads daily, weekly, and monthly GitHub Trending; resolves current repository metadata through GitHub REST; preserves or creates a Korean summary for every published repository; refreshes star history for that finalized set; validates the complete snapshot; and publishes it atomically. A required source that remains empty, malformed, or unavailable after bounded retries fails the run without replacing the last known-good page.

## Source-of-truth boundaries

- GitHub Trending has no supported public REST endpoint, so its three public HTML pages are the discovery source.
- GitHub REST is the metadata source. The workflow uses the repository-scoped `GITHUB_TOKEN`; no personal access token is required.
- `data/repo-summaries.json` is the durable Korean-summary cache. Current Korean summaries are seeded without semantic changes.
- `index.html` remains self-contained. A generator replaces only a marked `REPOS` data block and marked visible update date.
- `star-history.json` is generated only after the repository list is finalized.

## Collection and normalization

The updater fetches `https://github.com/trending?since=daily`, `weekly`, and `monthly`. It parses repository slugs and each period's visible star gain, then creates a stable union in daily, weekly, monthly order.

Safety gates:

- each Trending page must return at least five distinct repositories;
- the union must contain between ten and seventy-five repositories;
- duplicate normalized slugs and invalid numeric gains are rejected;
- HTTP failures use bounded exponential backoff;
- HTML that no longer satisfies tested structural invariants fails closed.

For each unique repository, REST supplies current metadata. README content is requested only for repositories without a cached Korean summary, keeping the request budget well below the GitHub Actions repository-token limit.

## Korean summary policy

The page must update without a paid or seat-bound AI dependency. Summary priority is:

1. reuse a cached Korean summary for the slug;
2. accept validated optional Copilot-generated Korean output for a new slug;
3. create a deterministic Korean fallback from description, language, Trending gains, and README introduction.

The fallback preserves the current structured fields and does not invent capabilities. GitHub Models is excluded because GitHub retired it on 2026-07-30. Optional Copilot enrichment is failure-isolated: a missing seat, quota failure, or invalid output cannot block deterministic daily publication.

## Atomic daily workflow

`.github/workflows/daily-refresh.yml` is the primary scheduler.

- cron: `17 18 * * *` UTC, 03:17 Asia/Seoul the next day;
- recovery: `workflow_dispatch`;
- concurrency: one non-cancelling `daily-refresh` run;
- permissions: `contents: write`, plus only a permission proven necessary for optional enrichment;
- runtime: pinned Node major, dependency-free scripts, built-in `GITHUB_TOKEN`.

The job checks out, tests, generates Trending data in a staging area, validates and installs it, updates star history, reruns all validation, scans staged content for secret-shaped values, and commits only a changed complete snapshot. The star-only workflow becomes a later recovery/manual workflow and cannot race the primary publisher.

## Failure and recovery

- Parser, validation, or required-source failure exits before staging or commit.
- A known repository may retain prior metadata after terminal REST failure; an unresolved new repository is omitted, subject to final coverage gates.
- Summary enrichment failure uses deterministic Korean fallback.
- Missing star history is recorded explicitly and does not block Trending publication.
- A non-fast-forward push fails for inspection; the workflow never force-pushes, rebases, or rewrites history.
- A same-day rerun commits only if content differs.

The page displays the latest successful Asia/Seoul update date so staleness is visible.

## Verification

- Parser fixtures cover normal HTML, whitespace/class variation, duplicates, and malformed input.
- Network tests cover retries, rate limits, cached fallback, new-repository omission, and request bounds.
- Generation tests prove only marked regions change and every published slug has a summary.
- Workflow tests prove cron, concurrency, permissions, command order, and no-change behavior.
- A live dry run fetches all three Trending pages without modifying tracked files.
- A deliberate parser mutation must make tests fail.
- The engineering code-review skill reviews the final diff; blocking findings are fixed before deployment.

## Cost and reversal conditions

- The core refresh adds no service secret or direct API charge under normal GitHub Actions allowance.
- Optional Copilot enrichment may consume the owner's allowance and is skipped unless usable.
- Remove Copilot enrichment if it adds unexpected cost or instability; deterministic refresh remains intact.
- Replace HTML scraping if GitHub offers a supported API or the tested structure changes.
- Replace GitHub Actions scheduling only if observed runs repeatedly miss a Seoul calendar date despite manual recovery.
