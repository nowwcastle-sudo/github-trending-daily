# Daily GitHub Trending Refresh Implementation Plan

> **Execution:** Use Subagent-Driven Development, `ponytail full` for every implementation task, a fresh task reviewer after each implementation, and the engineering code-review skill for the final review.

**Goal:** Refresh the Trending repository list, metadata, Korean summaries, and star history every day while preserving the last known-good site on failure.

**Architecture:** A dependency-free Node updater fetches three Trending pages, enriches the stable union through GitHub REST, reuses a Korean summary cache, creates deterministic Korean fallbacks, and atomically rewrites marked regions of `index.html`. One GitHub Actions workflow runs Trending generation followed by star-history generation and commits only a validated complete snapshot.

**Tech stack:** Node.js built-ins, Node test runner, GitHub REST API, GitHub Actions, existing static HTML/CSS/JavaScript.

---

## Task 1: Seed summaries and define the Trending parser

**Files:** `scripts/update-trending.mjs`, `data/repo-summaries.json`, `tests/fixtures/trending-*.html`, `tests/update-trending.test.mjs`, `package.json`.

**Acceptance:** The 46 current Korean summaries are preserved; parser output contains normalized slugs and period gains; union order is daily then unseen weekly then unseen monthly; malformed/empty input, duplicates, invalid gains, and size violations fail closed; tests require no network.

**Steps:** Write failing contracts; prove intended failure; implement the minimum parser and seeded cache; run focused/full tests; run `ponytail full`; secret-scan and commit.

## Task 2: Add REST enrichment, retries, and deterministic Korean fallback

**Files:** `scripts/update-trending.mjs`, `tests/update-trending.test.mjs`.

**Acceptance:** Authorization is never logged; retries are bounded; cached summaries are reused; every new published repository gets a fact-based Korean fallback; known metadata may be retained after terminal failure while unresolved new entries are omitted; final coverage and request-count gates prevent partial publication.

**Steps:** Add mocked-fetch failing tests for success/retry/rate-limit/fallback/omission/bounds; implement injectable fetch/sleep and enrichment; run mutation plus full tests; run `ponytail full`; secret-scan and commit.

## Task 3: Generate an atomic page snapshot and freshness marker

**Files:** `index.html`, `scripts/update-trending.mjs`, `tests/update-trending.test.mjs`.

**Acceptance:** Explicit markers bound `REPOS` and the Asia/Seoul update date; only marked regions change; every published slug has a complete summary; temporary output is installed only after validation; `--check` performs a no-write live validation; failure leaves tracked files byte-identical.

**Steps:** Add failing bounded-replacement/atomicity/completeness/date tests; add markers and generator; run fixture generation, full tests, and live `--check`; inspect diff; run `ponytail full`; secret-scan and commit.

## Task 4: Integrate the finalized set with star history

**Dependency:** Complete star-history plan Tasks 1 through 3 first.

**Files:** `scripts/update-trending.mjs`, `scripts/update-star-history.mjs`, both focused test files.

**Acceptance:** Both generators use the same final slugs; combined generation creates no orphan star entries; unavailable star history is explicit and non-blocking; failed Trending generation cannot install a new star cache.

**Steps:** Add a failing cross-generator test; make the smallest shared-interface change; run both focused/full suites; run `ponytail full`; secret-scan and commit.

## Task 5: Build the daily cron and recovery environment

**Files:** `.github/workflows/daily-refresh.yml`, `.github/workflows/update-star-history.yml`, `tests/daily-refresh-workflow.test.mjs`, `README.md`, `README.en.md`.

**Acceptance:** Primary cron is `17 18 * * *` UTC with 03:17 Seoul documented; manual dispatch, non-cancelling concurrency, pinned Node, and `contents: write` exist; tests run before generation, Trending before star history, validation after both, and commit/push only on a real diff; core uses only `secrets.GITHUB_TOKEN`; no force-push/rebase/unbounded retry exists; star-only workflow is later recovery/manual; both READMEs retain only meaning, usage, and site-address sections.

**Steps:** Add a failing workflow contract; add the minimal primary/recovery workflows; run contract/full tests; run `ponytail full`; secret-scan and commit.

## Task 6: Final independent review and live workflow proof

**Scope:** All changes from this and the star-history plans.

**Acceptance:** Engineering code review has no unresolved P0/P1 or actionable P2 correctness/security issue; a fresh clone passes all tests and generation validation; a parser mutation is caught then reverted; Actions accepts workflow syntax; after push, manual dispatch completes and the public page exposes the new Seoul update date; unverified Copilot availability is reported separately and does not invalidate core refresh.

**Steps:** Build a full review package; run engineering code review and fix/re-review; run the complete local matrix and staged secret scan; push the feature branch and dispatch only after local gates; verify workflow status and public page without exposing tokens.
