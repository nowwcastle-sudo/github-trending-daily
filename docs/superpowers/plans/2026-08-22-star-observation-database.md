# Append-only Star Observation Database Implementation Plan

> **Execution:** Use Subagent-Driven Development, `ponytail full` for implementation, and the engineering code-review skill for every validation review.

**Goal:** Preserve legacy and exact daily star observations in a separate append-only SQLite database without changing the current chart source.

**Architecture:** A dependency-free Python collector validates the generated page, imports legacy inline observations idempotently, appends exact REST observations transactionally, computes source-local daily deltas, and verifies SQLite integrity. The database is committed by the atomic daily workflow but remains disconnected from browser rendering.

**Tech stack:** Python standard-library `sqlite3`, `unittest`, existing Node test suite and GitHub Actions.

---

## Task 1: Define the parser, schema, and append-only transaction model

**Files:** `scripts/record_star_observations.py`, `tests/test_star_observations.py`, `package.json`, `.gitignore`.

**Acceptance:** Generated REPOS and legacy STAR_HISTORY are parsed with exact marker/shape/date/identity gates; schema v1 is created only for a new database; legacy and REST sources coexist; inserts are transactional and case-insensitive; same-date/source rows are immutable no-ops; delta uses only the previous same-source row; no delete/update path exists for observation rows; test command runs Node and Python suites.

**Steps:** Add failing Python contracts; prove RED; implement pure parsing/schema/recording functions; cover rollback and mutation; run both suites; run `ponytail full`; secret-scan and commit.

## Task 2: Seed and verify the canonical SQLite artifact

**Files:** `data/star-observations.sqlite`, `scripts/record_star_observations.py`, `tests/test_star_observations.py`.

**Acceptance:** One CLI invocation imports every current valid legacy point and the current 46 REST totals; row/source counts match independent extraction; `integrity_check` is `ok`; `user_version` is 1; no sidecar files remain; a second invocation is byte- and row-idempotent; the page and current chart behavior are unchanged.

**Steps:** Add CLI/no-touch/idempotency tests; implement minimal CLI; generate the database from the current page; independently query counts/dates/sources/deltas; rerun and compare hash; run both suites, `ponytail full`, secret-scan and commit.

## Task 3: Integrate collection into the atomic daily workflow

**Dependency:** Complete daily-refresh workflow Task 5 after star-history Tasks 1–4.

**Files:** `.github/workflows/daily-refresh.yml`, `tests/daily-refresh-workflow.test.mjs`, `README.md`, `README.en.md` only if the existing three sections need a one-sentence usage note.

**Acceptance:** Workflow sets up a pinned Python version, records SQLite after Trending generation and before star-history generation, runs integrity/tests before staging, stages the canonical database but not sidecars, and cannot push a partial run. Current chart does not read SQLite.

**Steps:** Extend the failing workflow contract; add the minimal step; run both suites and workflow review; live-dispatch with the broader final gate.

## Task 4: Final independent preservation audit

**Scope:** All database changes and their workflow integration.

**Acceptance:** Independent engineering review proves no observation update/delete path, exact legacy preservation, same-day immutability, transaction rollback, integrity, no user/secret data, and no browser dependency. Fresh clone tests and a manual workflow run pass before deployment.
