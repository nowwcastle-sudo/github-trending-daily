# Append-only Star Observation Database Design

**Date:** 2026-08-22

**Status:** Approved by the user's explicit instruction to preserve daily star-growth data in a separate database

## Purpose and boundary

The current OSS Insight-based `star-history.json` remains the page's chart source. A separate SQLite database accumulates exact daily GitHub star totals and deltas until it has enough history to replace the estimated source in a later, explicitly approved change.

This database is collection-only for now. Browser code, chart selection, and current fallback behavior must not read it.

## Durable artifact

`data/star-observations.sqlite` is a committed SQLite database created and updated through Python's stable standard-library `sqlite3` module. No service credential, server, package dependency, or experimental Node database API is introduced.

The database is public because the repository and source GitHub data are public. It contains no account, OAuth, favorite, token, or user data.

## Preserving existing observations

The current inline `STAR_HISTORY` constant is a legacy observation source and must not be discarded. Initial database creation imports every valid historical point from that constant, including repositories no longer in the current Trending list, under source `legacy_inline`.

The finalized generated `REPOS` list supplies exact REST totals under source `github_rest`. Both sources may have a value for the same repository and date; they remain separate records so no existing value is overwritten or silently selected as the winner.

## Schema and append-only rules

Schema version 1 contains:

- `schema_meta` for explicit schema version and creation policy;
- `repositories` for case-insensitive canonical slug identity and first/last seen dates;
- `star_observations` for slug, Seoul observation date, total stars, delta from the preceding observation of the same source, and source;
- indexes for date and slug/date queries.

The observation identity is `(slug COLLATE NOCASE, observed_date, source)`. Rules:

- existing observation rows are never updated or deleted by the collector;
- a same-date/source rerun is a no-op even if the later total differs, preserving the first successful daily observation;
- a new source or new date appends a row;
- `stars_delta` may be negative because repositories can lose stars;
- repositories that leave Trending keep every row permanently;
- the daily REST delta uses only prior `github_rest` observations, never legacy estimates;
- all rows for one run are inserted in one transaction;
- invalid input or transaction failure leaves the pre-run observations unchanged.

## Daily input and order

The collector parses the same explicit generated REPOS markers and validates the full 10–75 UI schema. It also parses the legacy `STAR_HISTORY` constant for idempotent preservation.

The primary daily workflow order is:

1. generate and validate the new Trending snapshot;
2. record the finalized exact totals in SQLite;
3. generate current OSS Insight star-history cache;
4. run integrity and full tests;
5. commit the HTML, summary cache, SQLite database, and chart cache together.

If a later step fails, no commit is pushed, so the remote database remains at the last fully successful day.

## SQLite safety settings

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = DELETE` so no WAL file is committed
- `PRAGMA synchronous = FULL`
- `BEGIN IMMEDIATE` for a single-writer transaction
- `PRAGMA user_version = 1`
- `PRAGMA integrity_check` before successful exit

`.gitignore` excludes SQLite `-journal`, `-wal`, and `-shm` sidecars but does not ignore the canonical database.

## Verification and recovery

Tests cover initial legacy+REST import, idempotent reruns, immutable same-date conflicts, positive/zero/negative deltas, disappeared repositories, case-insensitive identity, transaction rollback, invalid-page no-touch behavior, schema-version refusal, and integrity check.

Git history is the recovery mechanism for the committed database. The collector never recreates an existing database and never performs destructive migrations.

## Cost and reversal conditions

At roughly 10–75 current observations per day, the database should remain small for years; the cost is an opaque binary diff in daily commits. Reconsider storage when the database exceeds 50 MB, repository cloning becomes meaningfully slower, or GitHub Actions limits are affected. Migration must export and verify every existing observation before switching; the SQLite file remains archived and untouched until that verification passes.
