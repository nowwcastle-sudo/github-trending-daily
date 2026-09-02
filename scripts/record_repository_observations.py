"""Canonical v1 SQLite ledger schema for repository observations.

Task 1 deliberately contains schema creation and verification only.  The
candidate writer and transaction-wide semantic validators are introduced by
later Plan 2 tasks; this module must not silently create or rewrite rows.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import argparse
import stat
import sys
import tempfile
from urllib.parse import unquote, urlsplit
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
CREATION_POLICY = "append_only"
EMPTY_RELEASE_INVENTORY_SHA256 = hashlib.sha256(b"[]").hexdigest()

_SHA1 = "length({0}) = 40 AND {0} = lower({0}) AND {0} NOT GLOB '*[^0-9a-f]*'"
_SHA256 = "length({0}) = 64 AND {0} = lower({0}) AND {0} NOT GLOB '*[^0-9a-f]*'"
_SLUG = "instr({0}, '/') > 1 AND instr(substr({0}, instr({0}, '/') + 1), '/') = 0 AND substr({0}, instr({0}, '/') + 1) <> '' AND {0} NOT GLOB '*[^a-z0-9_./-]*' AND {0} = lower({0})"
_DISPLAY_SLUG = "instr({0}, '/') > 1 AND instr(substr({0}, instr({0}, '/') + 1), '/') = 0 AND substr({0}, instr({0}, '/') + 1) <> '' AND {0} NOT GLOB '*[^A-Za-z0-9_./-]*'"
_COLOR = "{0} GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'"
_UTC = "{0} GLOB '????-??-??T??:??:??.???Z'"
_KST = "{0} GLOB '????-??-??T??:??:??.???+09:00'"
_DATE = "{0} GLOB '????-??-??'"
FIELD_TAGS = ("ai-ml", "web-app", "dev-tools", "data", "devops", "security", "productivity", "systems", "learning")
FORM_TAGS = ("agent", "mcp", "plugin-skill", "ide", "library", "framework", "cli")
PAGES_BASE_ARTIFACT_PATHS = (
    "auth-lifecycle.js", "changes.xml", "current-view-export.js", "data/latest.json", "data/membership-status.json",
    "favorite-sync.js", "favorites.js", "feed.xml", "firebase-client.js", "firebase-config.json",
    "hidden-repos.js", "index.html", "membership-history.js", "readme-markdown.js",
    "refresh-schedule.js", "repo-filters.js", "site-i18n.js", "star-history.js", "ui-motion.js",
)
# star-history.json is a deploy overlay written by the star-ticks workflow; it is
# published and recorded in deployment-manifest.json but is not part of the
# finalized snapshot contract (2026-09-03 design §5.2).
# Snapshots finalized before 2026-09-03 carry one extra artifact row for the
# overlay. Those rows are append-only and are tolerated (never rewritten);
# contract readers skip them.
LEGACY_OVERLAY_ARTIFACT_PATHS = ("star-history.json",)
_SUMMARY_PRODUCER_FIELDS = ("provider", "interface", "auth_method", "api_provider", "model")
_SUMMARY_PRODUCER_PROFILES = (
    ("claude-cli-oauth", "claude-p", "oauth_token", "firstParty", "claude-sonnet-5"),
    ("codex-cli", "codex-exec", "chatgpt_session", "openai_first_party", "codex-cli/gpt-5.6-sol"),
)


def _foreign_key(reference: str) -> str:
    return f"REFERENCES {reference} ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED"


def _sha1(column: str) -> str:
    return _SHA1.format(column)


def _sha256(column: str) -> str:
    return _SHA256.format(column)


def _slug(column: str) -> str:
    return _SLUG.format(column)


def _display_slug(column: str) -> str:
    return _DISPLAY_SLUG.format(column)


def _schema_statements() -> tuple[str, ...]:
    # DDL is intentionally explicit: the schema fingerprint is a security
    # boundary, so a clever schema builder would make review harder.
    return (
        f"""CREATE TABLE schema_meta (
            schema_version INTEGER PRIMARY KEY CHECK (schema_version = {SCHEMA_VERSION}),
            creation_policy TEXT NOT NULL CHECK (creation_policy = '{CREATION_POLICY}'),
            schema_fingerprint_sha256 TEXT NOT NULL CHECK ({_sha256('schema_fingerprint_sha256')})
        ) STRICT""",
        f"""CREATE TABLE snapshot_runs (
            snapshot_seq INTEGER PRIMARY KEY,
            snapshot_id TEXT NOT NULL UNIQUE CHECK (snapshot_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9a-f]*' AND length(snapshot_id) = 31 AND snapshot_id = lower(snapshot_id) AND substr(snapshot_id, 16) NOT GLOB '*[^0-9a-f-]*'),
            run_kind TEXT NOT NULL CHECK (run_kind IN ('migration_baseline', 'refresh')),
            observed_at_utc TEXT NOT NULL UNIQUE CHECK ({_UTC.format('observed_at_utc')}),
            observed_at_kst TEXT NOT NULL CHECK ({_KST.format('observed_at_kst')}),
            stats_date_kst TEXT NOT NULL CHECK ({_DATE.format('stats_date_kst')}),
            parent_snapshot_seq INTEGER,
            parent_snapshot_id TEXT,
            input_source_sha TEXT NOT NULL CHECK ({_sha1('input_source_sha')}),
            input_manifest_sha256 TEXT CHECK (input_manifest_sha256 IS NULL OR {_sha256('input_manifest_sha256')}),
            core_payload_sha256 TEXT NOT NULL CHECK ({_sha256('core_payload_sha256')}),
            parent_chain_sha256 TEXT CHECK (parent_chain_sha256 IS NULL OR {_sha256('parent_chain_sha256')}),
            chain_sha256 TEXT NOT NULL UNIQUE CHECK ({_sha256('chain_sha256')}),
            repository_count INTEGER NOT NULL CHECK (repository_count BETWEEN 1 AND 75),
            UNIQUE (snapshot_seq, snapshot_id),
            UNIQUE (parent_snapshot_seq),
            CHECK ((parent_snapshot_seq IS NULL) = (parent_snapshot_id IS NULL)),
            CHECK ((run_kind = 'migration_baseline' AND snapshot_seq = 1 AND parent_snapshot_seq IS NULL AND parent_snapshot_id IS NULL AND parent_chain_sha256 IS NULL) OR (run_kind = 'refresh' AND parent_snapshot_seq IS NOT NULL AND parent_snapshot_id IS NOT NULL AND parent_chain_sha256 IS NOT NULL)),
            FOREIGN KEY (parent_snapshot_seq, parent_snapshot_id) {_foreign_key('snapshot_runs(snapshot_seq, snapshot_id)')}
        ) STRICT""",
        f"""CREATE TABLE baseline_sources (
            source_name TEXT PRIMARY KEY CHECK (source_name IN ('legacy_star_observations', 'legacy_trending_membership', 'legacy_public_star_history')),
            repo_relative_path TEXT NOT NULL UNIQUE CHECK (repo_relative_path NOT GLOB '/*' AND instr(repo_relative_path, '..') = 0),
            byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
            file_sha256 TEXT NOT NULL CHECK ({_sha256('file_sha256')}),
            schema_fingerprint_sha256 TEXT NOT NULL CHECK ({_sha256('schema_fingerprint_sha256')}),
            logical_row_count INTEGER NOT NULL CHECK (logical_row_count >= 0),
            logical_rows_sha256 TEXT NOT NULL CHECK ({_sha256('logical_rows_sha256')}),
            last_logical_key_json TEXT,
            cutover_snapshot_seq INTEGER NOT NULL,
            UNIQUE (source_name, cutover_snapshot_seq),
            CHECK ((logical_row_count = 0) = (last_logical_key_json IS NULL)),
            FOREIGN KEY (cutover_snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        f"""CREATE TABLE baseline_membership_slugs (
            slug TEXT PRIMARY KEY CHECK ({_slug('slug')}),
            source_name TEXT NOT NULL CHECK (source_name = 'legacy_trending_membership'),
            cutover_snapshot_seq INTEGER NOT NULL,
            FOREIGN KEY (source_name, cutover_snapshot_seq) {_foreign_key('baseline_sources(source_name, cutover_snapshot_seq)')},
            FOREIGN KEY (cutover_snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        f"""CREATE TABLE repository_profiles (
            profile_id INTEGER PRIMARY KEY,
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            display_slug TEXT NOT NULL CHECK ({_display_slug('display_slug')} AND lower(display_slug) = slug),
            captured_snapshot_seq INTEGER NOT NULL,
            description TEXT,
            primary_language TEXT,
            topics_json TEXT NOT NULL CHECK (json_valid(topics_json)),
            license_spdx TEXT,
            archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
            is_fork INTEGER NOT NULL CHECK (is_fork IN (0, 1)),
            default_branch TEXT NOT NULL CHECK (length(trim(default_branch)) > 0),
            created_at TEXT NOT NULL CHECK ({_UTC.format('created_at')}),
            field_tags_json TEXT NOT NULL CHECK (json_valid(field_tags_json)),
            form_tags_json TEXT NOT NULL CHECK (json_valid(form_tags_json)),
            tag_rule_version INTEGER NOT NULL CHECK (tag_rule_version > 0),
            profile_sha256 TEXT NOT NULL CHECK ({_sha256('profile_sha256')}),
            UNIQUE (slug, profile_sha256),
            UNIQUE (profile_id, slug),
            FOREIGN KEY (captured_snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        f"""CREATE TABLE snapshot_items (
            snapshot_seq INTEGER NOT NULL,
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            profile_id INTEGER NOT NULL,
            display_rank INTEGER NOT NULL CHECK (display_rank >= 1),
            rank_daily INTEGER CHECK (rank_daily IS NULL OR rank_daily >= 1),
            rank_weekly INTEGER CHECK (rank_weekly IS NULL OR rank_weekly >= 1),
            rank_monthly INTEGER CHECK (rank_monthly IS NULL OR rank_monthly >= 1),
            gain_daily INTEGER,
            gain_weekly INTEGER,
            gain_monthly INTEGER,
            language_color_daily TEXT CHECK (language_color_daily IS NULL OR {_COLOR.format('language_color_daily')}),
            language_color_weekly TEXT CHECK (language_color_weekly IS NULL OR {_COLOR.format('language_color_weekly')}),
            language_color_monthly TEXT CHECK (language_color_monthly IS NULL OR {_COLOR.format('language_color_monthly')}),
            selected_language_color TEXT CHECK (selected_language_color IS NULL OR {_COLOR.format('selected_language_color')}),
            selected_language_color_source_period TEXT CHECK (selected_language_color_source_period IS NULL OR selected_language_color_source_period IN ('daily', 'weekly', 'monthly')),
            stars INTEGER NOT NULL CHECK (stars >= 0),
            forks INTEGER NOT NULL CHECK (forks >= 0),
            watchers_count INTEGER NOT NULL CHECK (watchers_count >= 0),
            subscribers INTEGER NOT NULL CHECK (subscribers >= 0),
            open_issues_and_pull_requests INTEGER NOT NULL CHECK (open_issues_and_pull_requests >= 0),
            contributors INTEGER NOT NULL CHECK (contributors >= 0),
            updated_at TEXT NOT NULL CHECK ({_UTC.format('updated_at')}),
            pushed_at TEXT CHECK (pushed_at IS NULL OR {_UTC.format('pushed_at')}),
            default_branch_head_sha TEXT NOT NULL CHECK ({_sha1('default_branch_head_sha')}),
            previous_default_branch_head_sha TEXT CHECK (previous_default_branch_head_sha IS NULL OR {_sha1('previous_default_branch_head_sha')}),
            head_transition TEXT NOT NULL CHECK (head_transition IN ('baseline', 'unchanged', 'fast_forward', 'branch_changed', 'history_rewritten')),
            readme_status TEXT NOT NULL CHECK (readme_status IN ('present', 'absent')),
            readme_path TEXT,
            readme_blob_sha TEXT CHECK (readme_blob_sha IS NULL OR {_sha1('readme_blob_sha')}),
            readme_content_sha256 TEXT CHECK (readme_content_sha256 IS NULL OR {_sha256('readme_content_sha256')}),
            membership_status TEXT NOT NULL CHECK (membership_status IN ('baseline_present', 'new', 'reentered', 'stayed')),
            release_count INTEGER NOT NULL CHECK (release_count >= 0),
            release_inventory_sha256 TEXT NOT NULL CHECK ({_sha256('release_inventory_sha256')} AND (release_count <> 0 OR release_inventory_sha256 = '{EMPTY_RELEASE_INVENTORY_SHA256}')),
            latest_release_id INTEGER CHECK (latest_release_id IS NULL OR latest_release_id > 0),
            estimate_collection_status TEXT NOT NULL CHECK (estimate_collection_status IN ('complete_nonempty', 'complete_empty')),
            estimate_source_payload_sha256 TEXT NOT NULL CHECK ({_sha256('estimate_source_payload_sha256')}),
            estimate_point_count INTEGER NOT NULL CHECK (estimate_point_count BETWEEN 0 AND 10000),
            summary_source_sha256 TEXT NOT NULL CHECK ({_sha256('summary_source_sha256')}),
            summary_content_sha256 TEXT NOT NULL CHECK ({_sha256('summary_content_sha256')}),
            summary_envelope_sha256 TEXT NOT NULL CHECK ({_sha256('summary_envelope_sha256')}),
            translation_status TEXT NOT NULL CHECK (translation_status IN ('applicable', 'not_applicable:no_readme', 'not_applicable:no_prose')),
            translation_source_sha256 TEXT CHECK (translation_source_sha256 IS NULL OR {_sha256('translation_source_sha256')}),
            translation_envelope_sha256 TEXT CHECK (translation_envelope_sha256 IS NULL OR {_sha256('translation_envelope_sha256')}),
            PRIMARY KEY (snapshot_seq, slug),
            UNIQUE (snapshot_seq, display_rank),
            CHECK ((rank_daily IS NULL) = (gain_daily IS NULL)),
            CHECK ((rank_weekly IS NULL) = (gain_weekly IS NULL)),
            CHECK ((rank_monthly IS NULL) = (gain_monthly IS NULL)),
            CHECK (rank_daily IS NOT NULL OR rank_weekly IS NOT NULL OR rank_monthly IS NOT NULL),
            CHECK ((selected_language_color IS NULL) = (selected_language_color_source_period IS NULL)),
            CHECK ((language_color_daily IS NULL AND language_color_weekly IS NULL AND language_color_monthly IS NULL) = (selected_language_color IS NULL)),
            CHECK ((head_transition = 'baseline' AND previous_default_branch_head_sha IS NULL) OR (head_transition <> 'baseline' AND previous_default_branch_head_sha IS NOT NULL)),
            CHECK (head_transition <> 'unchanged' OR default_branch_head_sha = previous_default_branch_head_sha),
            CHECK ((readme_status = 'present' AND readme_path IS NOT NULL AND readme_blob_sha IS NOT NULL AND readme_content_sha256 IS NOT NULL) OR (readme_status = 'absent' AND readme_path IS NULL AND readme_blob_sha IS NULL AND readme_content_sha256 IS NULL)),
            CHECK ((readme_status = 'absent' AND translation_status = 'not_applicable:no_readme' AND translation_source_sha256 IS NULL AND translation_envelope_sha256 IS NULL) OR (readme_status = 'present' AND translation_status = 'applicable' AND translation_source_sha256 IS NOT NULL AND translation_envelope_sha256 IS NOT NULL) OR (readme_status = 'present' AND translation_status = 'not_applicable:no_prose' AND translation_source_sha256 IS NULL AND translation_envelope_sha256 IS NULL)),
            CHECK ((estimate_collection_status = 'complete_empty') = (estimate_point_count = 0)),
            FOREIGN KEY (snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')},
            FOREIGN KEY (profile_id, slug) {_foreign_key('repository_profiles(profile_id, slug)')}
        ) STRICT""",
        f"""CREATE TABLE release_versions (
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            release_id INTEGER NOT NULL CHECK (release_id > 0),
            metadata_sha256 TEXT NOT NULL CHECK ({_sha256('metadata_sha256')}),
            first_observed_snapshot_seq INTEGER NOT NULL,
            tag_name TEXT NOT NULL CHECK (length(trim(tag_name)) > 0),
            name TEXT,
            target_commitish TEXT NOT NULL CHECK (length(trim(target_commitish)) > 0),
            draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
            prerelease INTEGER NOT NULL CHECK (prerelease IN (0, 1)),
            created_at TEXT NOT NULL CHECK ({_UTC.format('created_at')}),
            published_at TEXT CHECK (published_at IS NULL OR {_UTC.format('published_at')}),
            html_url TEXT NOT NULL CHECK (html_url GLOB 'https://*'),
            PRIMARY KEY (slug, release_id, metadata_sha256),
            FOREIGN KEY (first_observed_snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        f"""CREATE TABLE snapshot_release_items (
            snapshot_seq INTEGER NOT NULL,
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            release_id INTEGER NOT NULL CHECK (release_id > 0),
            metadata_sha256 TEXT NOT NULL CHECK ({_sha256('metadata_sha256')}),
            release_ordinal INTEGER NOT NULL CHECK (release_ordinal >= 0),
            PRIMARY KEY (snapshot_seq, slug, release_id),
            UNIQUE (snapshot_seq, slug, release_ordinal),
            FOREIGN KEY (snapshot_seq, slug) {_foreign_key('snapshot_items(snapshot_seq, slug)')},
            FOREIGN KEY (slug, release_id, metadata_sha256) {_foreign_key('release_versions(slug, release_id, metadata_sha256)')}
        ) STRICT""",
        f"""CREATE TABLE historical_star_estimates (
            source TEXT NOT NULL CHECK (source IN ('legacy_star_history_cache', 'ossinsight_api')),
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            estimate_date TEXT NOT NULL CHECK ({_DATE.format('estimate_date')}),
            is_present INTEGER NOT NULL CHECK (is_present IN (0, 1)),
            stars INTEGER CHECK (stars IS NULL OR stars >= 0),
            point_sha256 TEXT NOT NULL CHECK ({_sha256('point_sha256')}),
            source_payload_sha256 TEXT NOT NULL CHECK ({_sha256('source_payload_sha256')}),
            first_observed_snapshot_seq INTEGER NOT NULL,
            PRIMARY KEY (source, slug, estimate_date, first_observed_snapshot_seq),
            CHECK ((is_present = 1 AND stars IS NOT NULL) OR (is_present = 0 AND stars IS NULL)),
            FOREIGN KEY (first_observed_snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        f"""CREATE TABLE historical_star_observations (
            source TEXT NOT NULL CHECK (source IN ('legacy_public_star_history', 'legacy_star_observations_db')),
            legacy_row_id INTEGER CHECK (legacy_row_id IS NULL OR legacy_row_id > 0),
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            observation_date TEXT NOT NULL CHECK ({_DATE.format('observation_date')}),
            stars INTEGER NOT NULL CHECK (stars >= 0),
            stars_delta INTEGER,
            legacy_source TEXT CHECK (legacy_source IS NULL OR legacy_source IN ('legacy_inline', 'github_rest')),
            source_row_sha256 TEXT NOT NULL CHECK ({_sha256('source_row_sha256')}),
            first_observed_snapshot_seq INTEGER NOT NULL,
            PRIMARY KEY (source, slug, observation_date, source_row_sha256),
            UNIQUE (source, legacy_row_id),
            CHECK ((source = 'legacy_public_star_history' AND legacy_row_id IS NULL AND stars_delta IS NULL AND legacy_source IS NULL) OR (source = 'legacy_star_observations_db' AND legacy_row_id IS NOT NULL AND legacy_source IS NOT NULL)),
            FOREIGN KEY (first_observed_snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        f"""CREATE TABLE commit_events (
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            commit_sha TEXT NOT NULL CHECK ({_sha1('commit_sha')}),
            first_observed_snapshot_seq INTEGER NOT NULL,
            first_observed_ordinal INTEGER NOT NULL CHECK (first_observed_ordinal >= 0),
            branch_name TEXT NOT NULL CHECK (length(trim(branch_name)) > 0),
            authored_at TEXT NOT NULL CHECK ({_UTC.format('authored_at')}),
            committed_at TEXT NOT NULL CHECK ({_UTC.format('committed_at')}),
            author_login TEXT,
            parent_shas_json TEXT NOT NULL CHECK (json_valid(parent_shas_json)),
            html_url TEXT NOT NULL CHECK (html_url GLOB 'https://*'),
            PRIMARY KEY (slug, commit_sha),
            UNIQUE (first_observed_snapshot_seq, slug, first_observed_ordinal),
            FOREIGN KEY (first_observed_snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        f"""CREATE TABLE readme_change_events (
            snapshot_seq INTEGER NOT NULL,
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            old_path TEXT,
            new_path TEXT,
            old_blob_sha TEXT CHECK (old_blob_sha IS NULL OR {_sha1('old_blob_sha')}),
            new_blob_sha TEXT CHECK (new_blob_sha IS NULL OR {_sha1('new_blob_sha')}),
            old_content_sha256 TEXT CHECK (old_content_sha256 IS NULL OR {_sha256('old_content_sha256')}),
            new_content_sha256 TEXT CHECK (new_content_sha256 IS NULL OR {_sha256('new_content_sha256')}),
            change_kind TEXT NOT NULL CHECK (change_kind IN ('baseline', 'added', 'changed', 'removed')),
            PRIMARY KEY (snapshot_seq, slug),
            CHECK ((old_path IS NULL) = (old_blob_sha IS NULL) AND (old_path IS NULL) = (old_content_sha256 IS NULL)),
            CHECK ((new_path IS NULL) = (new_blob_sha IS NULL) AND (new_path IS NULL) = (new_content_sha256 IS NULL)),
            CHECK ((change_kind = 'baseline' AND old_path IS NULL) OR (change_kind = 'added' AND old_path IS NULL AND new_path IS NOT NULL) OR (change_kind = 'removed' AND old_path IS NOT NULL AND new_path IS NULL) OR (change_kind = 'changed' AND old_path IS NOT NULL AND new_path IS NOT NULL AND (old_path <> new_path OR old_blob_sha <> new_blob_sha OR old_content_sha256 <> new_content_sha256))),
            FOREIGN KEY (snapshot_seq, slug) {_foreign_key('snapshot_items(snapshot_seq, slug)')}
        ) STRICT""",
        f"""CREATE TABLE repository_insights (
            snapshot_seq INTEGER NOT NULL,
            slug TEXT NOT NULL CHECK ({_slug('slug')}),
            previous_observed_snapshot_seq INTEGER,
            observation_gap_milliseconds INTEGER,
            stars_delta_since_previous_observation INTEGER,
            display_rank_delta INTEGER,
            rank_daily_delta INTEGER,
            rank_weekly_delta INTEGER,
            rank_monthly_delta INTEGER,
            insight_rule_version TEXT NOT NULL CHECK (insight_rule_version = 'repository-insight-v1'),
            insight_sha256 TEXT NOT NULL CHECK ({_sha256('insight_sha256')}),
            PRIMARY KEY (snapshot_seq, slug),
            CHECK ((previous_observed_snapshot_seq IS NULL AND observation_gap_milliseconds IS NULL AND stars_delta_since_previous_observation IS NULL AND display_rank_delta IS NULL AND rank_daily_delta IS NULL AND rank_weekly_delta IS NULL AND rank_monthly_delta IS NULL) OR (previous_observed_snapshot_seq IS NOT NULL AND observation_gap_milliseconds > 0)),
            FOREIGN KEY (snapshot_seq, slug) {_foreign_key('snapshot_items(snapshot_seq, slug)')},
            FOREIGN KEY (previous_observed_snapshot_seq, slug) {_foreign_key('snapshot_items(snapshot_seq, slug)')}
        ) STRICT""",
        f"""CREATE TABLE artifact_hashes (
            snapshot_seq INTEGER NOT NULL,
            artifact_path TEXT NOT NULL CHECK (artifact_path NOT GLOB '/*' AND instr(artifact_path, '..') = 0 AND artifact_path NOT IN ('data/repository-observations.sqlite', 'data/readme-state.json', 'data/legacy-observation-baseline.json', 'data/deploy-manifest.json')),
            sha256 TEXT NOT NULL CHECK ({_sha256('sha256')}),
            byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
            PRIMARY KEY (snapshot_seq, artifact_path),
            FOREIGN KEY (snapshot_seq) {_foreign_key('snapshot_runs(snapshot_seq)')}
        ) STRICT""",
        "CREATE INDEX idx_snapshot_runs_stats_date_seq ON snapshot_runs(stats_date_kst, snapshot_seq)",
        "CREATE INDEX idx_repository_profiles_slug_captured_seq ON repository_profiles(slug, captured_snapshot_seq)",
        "CREATE INDEX idx_snapshot_items_slug_seq ON snapshot_items(slug, snapshot_seq)",
        "CREATE INDEX idx_snapshot_items_seq_membership ON snapshot_items(snapshot_seq, membership_status)",
        "CREATE UNIQUE INDEX idx_snapshot_items_snapshot_rank_daily ON snapshot_items(snapshot_seq, rank_daily) WHERE rank_daily IS NOT NULL",
        "CREATE UNIQUE INDEX idx_snapshot_items_snapshot_rank_weekly ON snapshot_items(snapshot_seq, rank_weekly) WHERE rank_weekly IS NOT NULL",
        "CREATE UNIQUE INDEX idx_snapshot_items_snapshot_rank_monthly ON snapshot_items(snapshot_seq, rank_monthly) WHERE rank_monthly IS NOT NULL",
        "CREATE INDEX idx_release_versions_slug_release_first ON release_versions(slug, release_id, first_observed_snapshot_seq)",
        "CREATE INDEX idx_snapshot_release_items_slug_seq ON snapshot_release_items(slug, snapshot_seq)",
        "CREATE INDEX idx_historical_star_estimates_slug_date_first ON historical_star_estimates(slug, estimate_date, first_observed_snapshot_seq)",
        "CREATE INDEX idx_historical_star_observations_slug_date_source ON historical_star_observations(slug, observation_date, source)",
        "CREATE INDEX idx_commit_events_slug_committed_sha ON commit_events(slug, committed_at, commit_sha)",
        "CREATE INDEX idx_readme_change_events_slug_seq ON readme_change_events(slug, snapshot_seq)",
        "CREATE INDEX idx_repository_insights_slug_seq ON repository_insights(slug, snapshot_seq)",
    ) + _immutable_triggers()


_NATURAL_KEYS = {
    "schema_meta": "schema_version = NEW.schema_version",
    "snapshot_runs": "snapshot_seq = NEW.snapshot_seq OR snapshot_id = NEW.snapshot_id OR chain_sha256 = NEW.chain_sha256",
    "baseline_sources": "source_name = NEW.source_name OR repo_relative_path = NEW.repo_relative_path",
    "baseline_membership_slugs": "slug = NEW.slug",
    "repository_profiles": "(slug = NEW.slug AND profile_sha256 = NEW.profile_sha256) OR profile_id = NEW.profile_id",
    "snapshot_items": "snapshot_seq = NEW.snapshot_seq AND slug = NEW.slug",
    "release_versions": "slug = NEW.slug AND release_id = NEW.release_id AND metadata_sha256 = NEW.metadata_sha256",
    "snapshot_release_items": "snapshot_seq = NEW.snapshot_seq AND slug = NEW.slug AND release_id = NEW.release_id",
    "historical_star_estimates": "source = NEW.source AND slug = NEW.slug AND estimate_date = NEW.estimate_date AND first_observed_snapshot_seq = NEW.first_observed_snapshot_seq",
    "historical_star_observations": "source = NEW.source AND slug = NEW.slug AND observation_date = NEW.observation_date AND source_row_sha256 = NEW.source_row_sha256",
    "commit_events": "slug = NEW.slug AND commit_sha = NEW.commit_sha",
    "readme_change_events": "snapshot_seq = NEW.snapshot_seq AND slug = NEW.slug",
    "repository_insights": "snapshot_seq = NEW.snapshot_seq AND slug = NEW.slug",
    "artifact_hashes": "snapshot_seq = NEW.snapshot_seq AND artifact_path = NEW.artifact_path",
}


def _immutable_triggers() -> tuple[str, ...]:
    statements = []
    for table, key in _NATURAL_KEYS.items():
        statements.extend(
            (
                f"""CREATE TRIGGER {table}_reject_update BEFORE UPDATE ON {table}
                BEGIN SELECT RAISE(ABORT, '{table} is append-only'); END""",
                f"""CREATE TRIGGER {table}_reject_delete BEFORE DELETE ON {table}
                BEGIN SELECT RAISE(ABORT, '{table} is append-only'); END""",
                f"""CREATE TRIGGER {table}_reject_replace BEFORE INSERT ON {table}
                WHEN EXISTS (SELECT 1 FROM {table} WHERE {key})
                BEGIN SELECT RAISE(ABORT, '{table} conflicts are immutable'); END""",
            )
        )
    return tuple(statements)


SCHEMA_STATEMENTS = _schema_statements()


def _schema_rows(connection: sqlite3.Connection):
    return connection.execute(
        """SELECT type, name, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           ORDER BY type, name"""
    ).fetchall()


def _fingerprint_rows(rows) -> str:
    normalized = [
        # Only whitespace is normalized.  Lowercasing all DDL made the
        # fingerprint blind to changes in string literals such as enum values.
        (object_type, name, re.sub(r"\s+", " ", definition.strip()))
        for object_type, name, definition in rows
    ]
    return hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def schema_fingerprint(connection: sqlite3.Connection) -> str:
    """Fingerprint every v1 table, index, and trigger definition."""
    return _fingerprint_rows(_schema_rows(connection))


def _require_strict_support() -> None:
    try:
        with closing(sqlite3.connect(":memory:")) as probe:
            probe.execute("CREATE TABLE strict_probe (value INTEGER) STRICT")
    except sqlite3.DatabaseError as error:
        raise RuntimeError("SQLite STRICT tables are required for repository observations") from error


@lru_cache(maxsize=1)
def _canonical_schema() -> tuple[set[tuple[str, str]], str]:
    _require_strict_support()
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        for statement in SCHEMA_STATEMENTS:
            connection.execute(statement)
        rows = _schema_rows(connection)
    return {(kind, name) for kind, name, _ in rows}, _fingerprint_rows(rows)


def _canonical_json(value, label: str):
    if not isinstance(value, str):
        raise ValueError(f"{label} must be JSON text")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is not valid JSON") from error
    if json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":")) != value:
        raise ValueError(f"{label} is not canonical JSON")
    return parsed


def _canonical_string_array(value, label: str, *, allowed=(), allow_empty=True):
    parsed = _canonical_json(value, label)
    if not isinstance(parsed, list) or (not allow_empty and not parsed) or any(not isinstance(item, str) for item in parsed):
        raise ValueError(f"{label} must be a string array")
    if len(set(parsed)) != len(parsed) or parsed != sorted(parsed):
        raise ValueError(f"{label} must be unique code-point lexical order")
    if allowed and any(item not in allowed for item in parsed):
        raise ValueError(f"{label} contains an unknown id")
    return parsed


def _canonical_api_sha_array(value, label: str):
    parsed = _canonical_json(value, label)
    if not isinstance(parsed, list) or len(set(parsed)) != len(parsed) or any(not isinstance(item, str) or not re.fullmatch(r"[0-9a-f]{40}", item) for item in parsed):
        raise ValueError(f"{label} must preserve unique lowercase API SHA order")
    return parsed


def _ordered_tag_array(value, label: str, allowed, *, field=False):
    parsed = _canonical_json(value, label)
    if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
        raise ValueError(f"{label} must be a string array")
    if len(set(parsed)) != len(parsed):
        raise ValueError(f"{label} contains duplicates")
    if field and parsed == ["unclassified"]:
        return parsed
    if field and "unclassified" in parsed:
        raise ValueError("unclassified cannot coexist with field tags")
    if any(item not in allowed for item in parsed):
        raise ValueError(f"{label} contains an unknown id")
    ordered = [item for item in allowed if item in parsed]
    if parsed != ordered:
        raise ValueError(f"{label} must use definition order")
    if field and not parsed:
        raise ValueError("field_tags_json cannot be empty")
    return parsed


def _parse_utc(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("UTC timestamp must be text")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ValueError("UTC timestamp is not an exact calendar millisecond") from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        raise ValueError("UTC timestamp is not an exact millisecond")
    return parsed


def _canonical_repository_utc(value: Any, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        try:
            parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise ValueError("repository UTC timestamp is invalid") from error
        return parsed.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    _parse_utc(value)
    return value


def _parse_kst(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("KST timestamp must be text")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise ValueError("KST timestamp is not an exact calendar millisecond") from error
    if parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 9 * 60 * 60:
        raise ValueError("KST timestamp must use +09:00")
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "+09:00" != value:
        raise ValueError("KST timestamp is not an exact millisecond")
    return parsed


def _sha256_json(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _validate_populated_rows(connection: sqlite3.Connection) -> None:
    schema_digest = connection.execute("SELECT schema_fingerprint_sha256 FROM schema_meta").fetchone()[0]
    runs = connection.execute(
        "SELECT snapshot_seq, snapshot_id, observed_at_utc, observed_at_kst, stats_date_kst, parent_snapshot_seq, parent_snapshot_id FROM snapshot_runs ORDER BY snapshot_seq"
    ).fetchall()
    for seq, snapshot_id, utc, kst, stats_date, parent_seq, parent_id in runs:
        if seq < 1 or not re.fullmatch(r"[0-9]{14}-[a-f0-9]{16}", snapshot_id):
            raise ValueError("snapshot sequence or id is invalid")
        utc_value = _parse_utc(utc)
        kst_value = _parse_kst(kst)
        if utc_value.astimezone(kst_value.tzinfo) != kst_value or kst_value.date().isoformat() != stats_date:
            raise ValueError("snapshot UTC, KST, and stats date must name one instant")
        if seq > 1 and parent_seq != seq - 1:
            raise ValueError("refresh snapshot sequence must immediately follow its parent")
        if parent_seq is not None:
            parent = connection.execute("SELECT snapshot_id, chain_sha256 FROM snapshot_runs WHERE snapshot_seq = ?", (parent_seq,)).fetchone()
            if parent is None or parent[0] != parent_id:
                raise ValueError("snapshot parent identity is invalid")
            row = connection.execute("SELECT parent_chain_sha256, core_payload_sha256, chain_sha256 FROM snapshot_runs WHERE snapshot_seq = ?", (seq,)).fetchone()
            if row[0] != parent[1]:
                raise ValueError("snapshot parent chain is invalid")
        else:
            row = connection.execute("SELECT parent_chain_sha256, core_payload_sha256, chain_sha256 FROM snapshot_runs WHERE snapshot_seq = ?", (seq,)).fetchone()
        expected_chain = _sha256_json({"schema_fingerprint_sha256": schema_digest, "parent_chain_sha256": row[0], "core_payload_sha256": row[1], "snapshot_id": snapshot_id, "snapshot_seq": seq})
        if row[2] != expected_chain:
            raise ValueError("snapshot chain hash preimage mismatch")

    profiles = connection.execute(
        "SELECT profile_id, slug, display_slug, description, primary_language, topics_json, license_spdx, archived, is_fork, default_branch, created_at, field_tags_json, form_tags_json, tag_rule_version, profile_sha256 FROM repository_profiles"
    ).fetchall()
    for row in profiles:
        profile_id, slug, display_slug, description, language, topics, license_spdx, archived, is_fork, branch, created_at, fields, forms, version, digest = row
        if not re.fullmatch(r"[a-z0-9_.-]+/[a-z0-9_.-]+", slug) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", display_slug) or display_slug.lower() != slug:
            raise ValueError("profile slug/display_slug is not canonical")
        _parse_utc(created_at)
        topics_value = _canonical_string_array(topics, "topics_json")
        field_value = _ordered_tag_array(fields, "field_tags_json", FIELD_TAGS, field=True)
        form_value = _ordered_tag_array(forms, "form_tags_json", FORM_TAGS)
        expected = _sha256_json({
            "slug": slug, "display_slug": display_slug, "description": description,
            "primary_language": language, "topics": topics_value, "license_spdx": license_spdx,
            "archived": bool(archived), "is_fork": bool(is_fork), "default_branch": branch,
            "created_at": created_at, "field_tags": field_value, "form_tags": form_value,
            "tag_rule_version": version,
        })
        if digest != expected:
            raise ValueError(f"profile {profile_id} hash preimage mismatch")

    items = connection.execute("SELECT * FROM snapshot_items ORDER BY snapshot_seq, slug").fetchall()
    item_columns = [item[1] for item in connection.execute("PRAGMA table_info(snapshot_items)")]
    item_rows = [dict(zip(item_columns, row)) for row in items]
    for snapshot_seq in {item["snapshot_seq"] for item in item_rows}:
        current_items = [item for item in item_rows if item["snapshot_seq"] == snapshot_seq]
        if sorted(item["display_rank"] for item in current_items) != list(range(1, len(current_items) + 1)):
            raise ValueError("display ranks must be gapless per snapshot")
        for rank_field in ("rank_daily", "rank_weekly", "rank_monthly"):
            ranks = sorted(item[rank_field] for item in current_items if item[rank_field] is not None)
            if ranks and ranks != list(range(1, len(ranks) + 1)):
                raise ValueError(f"{rank_field} ranks must be gapless per snapshot")
    for snapshot_seq, slug in connection.execute("SELECT DISTINCT snapshot_seq, slug FROM snapshot_release_items"):
        ordinals = [row[0] for row in connection.execute("SELECT release_ordinal FROM snapshot_release_items WHERE snapshot_seq = ? AND slug = ? ORDER BY release_ordinal", (snapshot_seq, slug))]
        if ordinals != list(range(len(ordinals))):
            raise ValueError("release ordinals must be gapless")
    artifacts_by_snapshot = {}
    for row in connection.execute("SELECT snapshot_seq, artifact_path FROM artifact_hashes"):
        artifacts_by_snapshot.setdefault(row[0], set()).add(row[1])
    for item in item_rows:
        _parse_utc(item["updated_at"])
        if item["pushed_at"] is not None:
            _parse_utc(item["pushed_at"])
        if any(item[field] is not None and item[field] < 0 for field in ("gain_daily", "gain_weekly", "gain_monthly")):
            raise ValueError("snapshot gains cannot be negative")
        colors = (("daily", item["language_color_daily"]), ("weekly", item["language_color_weekly"]), ("monthly", item["language_color_monthly"]))
        expected_color = next(((period, color) for period, color in colors if color is not None), None)
        if expected_color is None:
            if item["selected_language_color"] is not None or item["selected_language_color_source_period"] is not None:
                raise ValueError("selected color requires a source color")
        elif (item["selected_language_color_source_period"], item["selected_language_color"]) != expected_color:
            raise ValueError("selected color must be daily then weekly then monthly")
        inventory = connection.execute(
            "SELECT release_id, metadata_sha256 FROM snapshot_release_items WHERE snapshot_seq = ? AND slug = ? ORDER BY release_ordinal",
            (item["snapshot_seq"], item["slug"]),
        ).fetchall()
        expected_inventory = _sha256_json([{"release_id": release_id, "metadata_sha256": digest} for release_id, digest in inventory])
        if len(inventory) != item["release_count"] or expected_inventory != item["release_inventory_sha256"]:
            raise ValueError("release inventory count or hash mismatch")
        if item["latest_release_id"] is not None and item["latest_release_id"] not in {entry[0] for entry in inventory}:
            raise ValueError("latest release must be in its exact inventory")
        display = connection.execute("SELECT display_slug FROM repository_profiles WHERE profile_id = ? AND slug = ?", (item["profile_id"], item["slug"])).fetchone()
        # Core recording is deliberately before Task 4 derivative finalization.
        # Once an artifact set exists it must be complete; its temporary
        # absence cannot invalidate an otherwise exact enrichment join.
        if item["translation_status"] == "applicable" and artifacts_by_snapshot.get(item["snapshot_seq"]) and (display is None or f"translations/{display[0].replace('/', '__')}.json" not in artifacts_by_snapshot.get(item["snapshot_seq"], set())):
            raise ValueError("applicable translation is absent from artifacts")

    for slug, release_id, digest, _, tag, name, target, draft, prerelease, created, published, url in connection.execute("SELECT * FROM release_versions"):
        _parse_utc(created)
        if published is not None:
            _parse_utc(published)
        if digest != _sha256_json({"slug": slug, "release_id": release_id, "tag_name": tag, "name": name, "target_commitish": target, "draft": bool(draft), "prerelease": bool(prerelease), "created_at": created, "published_at": published, "html_url": url}):
            raise ValueError("release metadata hash preimage mismatch")

    for source, slug, estimate_date, present, stars, digest, _, _ in connection.execute("SELECT * FROM historical_star_estimates"):
        datetime.strptime(estimate_date, "%Y-%m-%d")
        if digest != _sha256_json({"slug": slug, "date": estimate_date, "is_present": bool(present), "stars": stars}):
            raise ValueError("estimate point hash preimage mismatch")

    for source, row_id, slug, date, stars, delta, legacy, digest, _ in connection.execute("SELECT * FROM historical_star_observations"):
        datetime.strptime(date, "%Y-%m-%d")
        preimage = {"source": source, "slug": slug, "observation_date": date, "stars": stars} if source == "legacy_public_star_history" else {"source": source, "legacy_row_id": row_id, "slug": slug, "observation_date": date, "stars": stars, "stars_delta": delta, "legacy_source": legacy}
        if digest != _sha256_json(preimage):
            raise ValueError("legacy observation hash preimage mismatch")

    for slug, commit_sha, authored_at, committed_at, parents in connection.execute("SELECT slug, commit_sha, authored_at, committed_at, parent_shas_json FROM commit_events"):
        _parse_utc(authored_at)
        _parse_utc(committed_at)
        _canonical_api_sha_array(parents, "parent_shas_json")

    for snapshot_seq, slug, old_path, new_path, old_blob, new_blob, old_content, new_content, kind in connection.execute("SELECT * FROM readme_change_events"):
        item = connection.execute("SELECT readme_status, readme_path, readme_blob_sha, readme_content_sha256 FROM snapshot_items WHERE snapshot_seq = ? AND slug = ?", (snapshot_seq, slug)).fetchone()
        if item is None:
            raise ValueError("README event has no snapshot item")
        old_tuple = (old_path, old_blob, old_content)
        new_tuple = (new_path, new_blob, new_content)
        if kind == "baseline" and (old_tuple != (None, None, None) or new_tuple != item[1:]):
            raise ValueError("baseline README event must match current item")
        if kind == "added" and not (old_tuple == (None, None, None) and all(new_tuple)):
            raise ValueError("README added event is invalid")
        if kind == "removed" and not (all(old_tuple) and new_tuple == (None, None, None)):
            raise ValueError("README removed event is invalid")
        if kind == "changed" and not (all(old_tuple) and all(new_tuple) and old_tuple != new_tuple):
            raise ValueError("README changed event is invalid")

    for snapshot_seq, slug, previous, gap, stars_delta, display_delta, daily_delta, weekly_delta, monthly_delta, rule, digest in connection.execute("SELECT * FROM repository_insights"):
        current = connection.execute("SELECT display_rank, rank_daily, rank_weekly, rank_monthly, stars FROM snapshot_items WHERE snapshot_seq = ? AND slug = ?", (snapshot_seq, slug)).fetchone()
        if current is None:
            raise ValueError("insight has no current snapshot item")
        preimage = {"snapshot_seq": snapshot_seq, "slug": slug, "previous_observed_snapshot_seq": previous, "observation_gap_milliseconds": gap, "stars_delta_since_previous_observation": stars_delta, "display_rank_delta": display_delta, "rank_daily_delta": daily_delta, "rank_weekly_delta": weekly_delta, "rank_monthly_delta": monthly_delta, "insight_rule_version": rule}
        if digest != _sha256_json(preimage):
            raise ValueError("insight hash preimage mismatch")
        actual_previous = connection.execute("SELECT MAX(snapshot_seq) FROM snapshot_items WHERE slug = ? AND snapshot_seq < ?", (slug, snapshot_seq)).fetchone()[0]
        if actual_previous != previous:
            raise ValueError("insight must reference the actual prior observation")
        if previous is None:
            if any(value is not None for value in (gap, stars_delta, display_delta, daily_delta, weekly_delta, monthly_delta)):
                raise ValueError("first insight must have null deltas")
            continue
        prior = connection.execute("SELECT display_rank, rank_daily, rank_weekly, rank_monthly, stars FROM snapshot_items WHERE snapshot_seq = ? AND slug = ?", (previous, slug)).fetchone()
        prior_time = connection.execute("SELECT observed_at_utc FROM snapshot_runs WHERE snapshot_seq = ?", (previous,)).fetchone()
        current_time = connection.execute("SELECT observed_at_utc FROM snapshot_runs WHERE snapshot_seq = ?", (snapshot_seq,)).fetchone()
        if prior is None or prior_time is None or current_time is None:
            raise ValueError("insight prior reference is invalid")
        actual_gap = int((_parse_utc(current_time[0]) - _parse_utc(prior_time[0])).total_seconds() * 1000)
        rank_deltas = tuple((prior[index] - current[index]) if prior[index] is not None and current[index] is not None else None for index in (1, 2, 3))
        if gap != actual_gap or stars_delta != current[4] - prior[4] or display_delta != prior[0] - current[0] or (daily_delta, weekly_delta, monthly_delta) != rank_deltas:
            raise ValueError("insight gap or primary deltas are invalid")

    for snapshot_seq, paths in artifacts_by_snapshot.items():
        expected = set(PAGES_BASE_ARTIFACT_PATHS) | {f"translations/{connection.execute('SELECT display_slug FROM repository_profiles WHERE profile_id = ? AND slug = ?', (item['profile_id'], item['slug'])).fetchone()[0].replace('/', '__')}.json" for item in item_rows if item["snapshot_seq"] == snapshot_seq and item["translation_status"] == "applicable"}
        if paths != expected and paths != expected | set(LEGACY_OVERLAY_ARTIFACT_PATHS):
            raise ValueError("artifact paths must equal the exact Pages allowlist")


def validate_schema(connection: sqlite3.Connection) -> None:
    """Reject a database which is not exactly the v1 canonical ledger schema."""
    _require_strict_support()
    if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        raise ValueError(f"Unsupported repository-observations schema version: {connection.execute('PRAGMA user_version').fetchone()[0]}")
    expected_objects, expected_fingerprint = _canonical_schema()
    rows = _schema_rows(connection)
    if {(kind, name) for kind, name, _ in rows} != expected_objects or _fingerprint_rows(rows) != expected_fingerprint:
        raise ValueError("Existing repository-observations schema v1 is not canonical")
    metadata = connection.execute(
        "SELECT schema_version, creation_policy, schema_fingerprint_sha256 FROM schema_meta"
    ).fetchall()
    if metadata != [(SCHEMA_VERSION, CREATION_POLICY, expected_fingerprint)]:
        raise ValueError("Repository-observations schema metadata is invalid")
    _validate_populated_rows(connection)


def create_database(path: str | Path) -> None:
    """Create a new v1 ledger; never overwrite an existing database."""
    _require_strict_support()
    database = Path(path)
    if database.exists():
        raise FileExistsError(f"Refusing to replace existing repository observation database: {database}")
    database.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("BEGIN IMMEDIATE")
            for statement in SCHEMA_STATEMENTS:
                connection.execute(statement)
            fingerprint = schema_fingerprint(connection)
            connection.execute(
                "INSERT INTO schema_meta(schema_version, creation_policy, schema_fingerprint_sha256) VALUES (?, ?, ?)",
                (SCHEMA_VERSION, CREATION_POLICY, fingerprint),
            )
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            connection.execute("PRAGMA foreign_key_check")
            connection.commit()
        created = True
    finally:
        if not created:
            for sidecar in (database, Path(f"{database}-journal"), Path(f"{database}-wal"), Path(f"{database}-shm")):
                sidecar.unlink(missing_ok=True)


# A candidate is a logical continuation of the last-good database. SQLite
# pages are not an invariant: page layout may change after normal recovery.
# Every natural key and canonical row digest is therefore retained instead.
CORE_TABLES = (
    "schema_meta", "baseline_sources", "baseline_membership_slugs", "snapshot_runs",
    "repository_profiles", "snapshot_items", "release_versions", "snapshot_release_items",
    "historical_star_estimates", "historical_star_observations", "commit_events",
    "readme_change_events",
)

CORE_PREIMAGE_TABLES = (
    "snapshot_runs",
    "baseline_sources",
    "baseline_membership_slugs",
    "repository_profiles",
    "snapshot_items",
    "release_versions",
    "snapshot_release_items",
    "historical_star_estimates",
    "historical_star_observations",
    "commit_events",
    "readme_change_events",
)

LEGACY_BASELINE_PATHS = {
    "legacy_star_observations": "data/star-observations.sqlite",
    "legacy_trending_membership": "data/trending-membership.sqlite",
    "legacy_public_star_history": "data/legacy-public-star-history.json",
}

LEGACY_PUBLIC_STAR_HISTORY_SCHEMA = {
    "format": "legacy-public-star-history-v1",
    "top_level": {
        "keys": ["version", "generatedAt", "repositories"],
        "version": {"type": "integer", "const": 1},
        "generatedAt": {"type": "string", "format": "YYYY-MM-DD"},
        "repositories": {"type": "array", "maxItems": 75, "source_order": "preserved"},
    },
    "repository": {
        "keys": ["slug", "estimated", "observed"],
        "slug": {
            "type": "string",
            "format": "ASCII owner/name display casing",
            "identity": "casefold unique",
        },
        "estimated": {"type": "array", "maxItems": 500, "items": "point_series"},
        "observed": {"type": "array", "maxItems": 730, "items": "point_series"},
        "logical_receipt_order": "casefold slug ascending",
    },
    "point_series": {
        "keys": ["date", "stars"],
        "date": {"type": "string", "format": "YYYY-MM-DD", "order": "ascending unique"},
        "stars": {"type": "integer", "minimum": 0, "maximum": 9_007_199_254_740_991},
    },
}


@dataclass(frozen=True)
class CoreRecordResult:
    inserted: dict[str, int]
    reused: dict[str, int]
    core_payload_sha256: str
    snapshot_seq: int


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _connect_candidate(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    if connection.execute("PRAGMA journal_mode = DELETE").fetchone()[0].lower() != "delete":
        connection.close()
        raise ValueError("candidate database could not use DELETE journal mode")
    connection.execute("PRAGMA synchronous = FULL")
    return connection


def _columns(connection: sqlite3.Connection, table: str) -> tuple[str, ...]:
    return tuple(row[1] for row in connection.execute(f"PRAGMA table_info({table})"))


def _natural_key_columns(table: str) -> tuple[str, ...]:
    return {
        "schema_meta": ("schema_version",),
        "baseline_sources": ("source_name",),
        "baseline_membership_slugs": ("slug",),
        "snapshot_runs": ("snapshot_seq",),
        "repository_profiles": ("profile_id",),
        "snapshot_items": ("snapshot_seq", "slug"),
        "release_versions": ("slug", "release_id", "metadata_sha256"),
        "snapshot_release_items": ("snapshot_seq", "slug", "release_id"),
        "historical_star_estimates": ("source", "slug", "estimate_date", "first_observed_snapshot_seq"),
        "historical_star_observations": ("source", "slug", "observation_date", "source_row_sha256"),
        "commit_events": ("slug", "commit_sha"),
        "readme_change_events": ("snapshot_seq", "slug"),
        "repository_insights": ("snapshot_seq", "slug"),
        "artifact_hashes": ("snapshot_seq", "artifact_path"),
    }[table]


def _table_row_evidence(connection: sqlite3.Connection, table: str) -> dict[str, Any]:
    cols = _columns(connection, table)
    keys = _natural_key_columns(table)
    rows = [dict(zip(cols, row)) for row in connection.execute(f"SELECT * FROM {table} ORDER BY {', '.join(keys)}")]
    logical = [{"key": [row[key] for key in keys], "row_sha256": _digest(row)} for row in rows]
    return {"count": len(rows), "logical_rows_sha256": _digest(logical), "rows": logical}


def _read_parent_database_once(database_path: str | Path) -> bytes | None:
    """Read one stable inode once; a path replacement cannot change returned bytes."""
    path = Path(database_path)
    if path.is_symlink():
        raise ValueError("parent database path is unsafe")
    for suffix in ("-journal", "-wal", "-shm"):
        if Path(f"{path}{suffix}").exists():
            raise ValueError("parent database has a pending SQLite sidecar")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        if path.exists() or path.is_symlink():
            raise ValueError("parent database path is unsafe") from None
        return None
    except OSError:
        raise ValueError("parent database is unavailable") from None
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("parent database path is unsafe")
        try:
            linked = os.stat(path, follow_symlinks=False)
        except OSError:
            raise ValueError("parent database changed during capture") from None
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
        if identity(linked) != identity(before):
            raise ValueError("parent database changed during capture")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            raw = handle.read()
        after = os.fstat(descriptor)
        try:
            linked_after = os.stat(path, follow_symlinks=False)
        except OSError:
            raise ValueError("parent database changed during capture") from None
        if identity(before) != identity(after) or identity(after) != identity(linked_after) or len(raw) != after.st_size:
            raise ValueError("parent database changed during capture")
    finally:
        os.close(descriptor)
    for suffix in ("-journal", "-wal", "-shm"):
        if Path(f"{path}{suffix}").exists():
            raise ValueError("parent database has a pending SQLite sidecar")
    return raw


def _capture_parent_database(database_path: str | Path, expected_snapshot_seq: int | None = None) -> tuple[bytes, dict[str, Any], dict[str, Any], dict[str, dict[str, str]]] | None:
    """Measure bytes, logical tables, and historical HEADs from one immutable value."""
    raw = _read_parent_database_once(database_path)
    if raw is None:
        return None
    connection = sqlite3.connect(":memory:")
    try:
        connection.deserialize(raw)
        connection.execute("PRAGMA foreign_keys = ON")
        validate_schema(connection)
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok" or connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("parent database integrity check failed")
        latest = connection.execute("SELECT snapshot_seq, snapshot_id, chain_sha256 FROM snapshot_runs ORDER BY snapshot_seq DESC LIMIT 1").fetchone()
        if latest is None:
            raise ValueError("parent database has no successful snapshot")
        if expected_snapshot_seq is not None and latest[0] != expected_snapshot_seq:
            raise ValueError("parent historical head snapshot mismatch")
        tables = {table: _table_row_evidence(connection, table) for table in _NATURAL_KEYS}
        rows = connection.execute(
            """SELECT i.slug,p.default_branch,i.default_branch_head_sha
               FROM snapshot_items i JOIN repository_profiles p
               ON p.profile_id=i.profile_id AND p.slug=i.slug
               WHERE i.snapshot_seq=(
                   SELECT MAX(previous.snapshot_seq)
                   FROM snapshot_items previous
                   WHERE previous.slug=i.slug AND previous.snapshot_seq<=?
               )
               ORDER BY i.slug""",
            (latest[0],),
        ).fetchall()
    except (ValueError, sqlite3.Error):
        raise
    finally:
        connection.close()
    heads = {slug: {"branch": branch, "headSha": head} for slug, branch, head in rows}
    evidence = {
        "byte_size": len(raw),
        "file_sha256": hashlib.sha256(raw).hexdigest(),
        "last_snapshot_seq": latest[0],
        "last_snapshot_id": latest[1],
        "last_chain_sha256": latest[2],
        "tables": tables,
    }
    historical = {"scope": "all_historical", "head_count": len(heads), "heads_sha256": _digest(heads)}
    return raw, evidence, historical, heads


def parent_database_evidence(database_path: str | Path) -> dict[str, Any]:
    """Return content-free logical evidence for one exact last-good DB value."""
    captured = _capture_parent_database(database_path)
    if captured is None:
        raise ValueError("parent database is missing")
    return captured[1]


def measure_historical_heads(database_path: str | Path, expected_snapshot_seq: int | None = None) -> tuple[dict[str, Any], dict[str, dict[str, str]]]:
    """Measure complete historical HEADs from the same bytes used for validation."""
    captured = _capture_parent_database(database_path, expected_snapshot_seq)
    if captured is None:
        raise ValueError("parent database is missing")
    return captured[2], captured[3]


def _require_parent_evidence(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    aliases = {"size": "byte_size", "sha256": "file_sha256", "lastSnapshotSeq": "last_snapshot_seq", "lastSnapshotId": "last_snapshot_id", "lastChainSha256": "last_chain_sha256"}
    expected = {aliases.get(key, key): value for key, value in expected.items()}
    for key in ("byte_size", "file_sha256", "last_snapshot_seq", "last_snapshot_id", "last_chain_sha256"):
        if expected.get(key) != actual[key]:
            raise ValueError(f"parent database evidence mismatch: {key}")
    expected_tables = expected.get("tables") or expected.get("table_evidence")
    if not isinstance(expected_tables, dict):
        raise ValueError("parent database evidence requires table digests")
    for table in _NATURAL_KEYS:
        candidate = expected_tables.get(table)
        if not isinstance(candidate, dict):
            raise ValueError(f"parent database evidence missing table {table}")
        actual_table = actual["tables"][table]
        if candidate.get("count") != actual_table["count"] or candidate.get("logical_rows_sha256", candidate.get("sha256")) != actual_table["logical_rows_sha256"]:
            raise ValueError(f"parent database logical row evidence mismatch: {table}")
        if candidate.get("rows") is not None and candidate["rows"] != actual_table["rows"]:
            raise ValueError(f"parent database row digest mismatch: {table}")


def _parse_parent_evidence_envelope(value: Any) -> tuple[dict[str, Any] | None, dict[str, Any], dict[str, Any], str]:
    """Separate the reviewed parent identity from the legacy cutover receipt."""
    required = {"version", "parent_database", "production_source_sha", "historical_heads", "legacy_baseline_receipt"}
    if not isinstance(value, dict) or set(value) != required or value["version"] != 1:
        raise ValueError("parent evidence envelope fields are not the exact allowlist")
    parent = value["parent_database"]
    if parent == {"missing": True}:
        parent_evidence = parent
    else:
        parent_keys = {
            "byte_size", "file_sha256", "last_snapshot_seq", "last_snapshot_id",
            "last_chain_sha256", "tables",
        }
        if not isinstance(parent, dict) or set(parent) != parent_keys:
            raise ValueError("parent database evidence fields are not the exact allowlist")
        tables = parent["tables"]
        if not isinstance(tables, dict) or set(tables) != set(_NATURAL_KEYS):
            raise ValueError("parent database table evidence fields are not the exact allowlist")
        for table in _NATURAL_KEYS:
            evidence = tables[table]
            if not isinstance(evidence, dict) or set(evidence) != {"count", "logical_rows_sha256", "rows"} or not isinstance(evidence["rows"], list):
                raise ValueError(f"parent database table evidence is invalid: {table}")
            if any(not isinstance(row, dict) or set(row) != {"key", "row_sha256"} for row in evidence["rows"]):
                raise ValueError(f"parent database row evidence is invalid: {table}")
        parent_evidence = parent
    historical_heads = value["historical_heads"]
    if (not isinstance(historical_heads, dict)
            or set(historical_heads) != {"scope", "head_count", "heads_sha256"}
            or historical_heads["scope"] != "all_historical"
            or isinstance(historical_heads["head_count"], bool)
            or not isinstance(historical_heads["head_count"], int)
            or historical_heads["head_count"] < 0
            or not isinstance(historical_heads["heads_sha256"], str)
            or re.fullmatch(r"[a-f0-9]{64}", historical_heads["heads_sha256"]) is None):
        raise ValueError("historical head evidence is invalid")
    production_source_sha = value["production_source_sha"]
    if not isinstance(production_source_sha, str) or re.fullmatch(r"[a-f0-9]{40}", production_source_sha) is None:
        raise ValueError("parent evidence production source SHA is invalid")
    receipt = value["legacy_baseline_receipt"]
    if not isinstance(receipt, dict):
        raise ValueError("legacy baseline receipt must be an object")
    return parent_evidence, receipt, historical_heads, production_source_sha


def _require_historical_head_evidence(captured: tuple[bytes, dict[str, Any], dict[str, Any], dict[str, dict[str, str]]] | None, expected: dict[str, Any]) -> None:
    actual = captured[2] if captured is not None else {
        "scope": "all_historical", "head_count": 0, "heads_sha256": _digest({}),
    }
    if actual != expected:
        raise ValueError("historical head evidence mismatch")


def _assert_parent_rows_preserved(connection: sqlite3.Connection, evidence: dict[str, Any]) -> None:
    for table in _NATURAL_KEYS:
        lookup = {tuple(row["key"]): row["row_sha256"] for row in _table_row_evidence(connection, table)["rows"]}
        for expected in evidence["tables"][table]["rows"]:
            if lookup.get(tuple(expected["key"])) != expected["row_sha256"]:
                raise ValueError(f"candidate database does not preserve parent row digest: {table}")


def _prepare_candidate_database_from_capture(
    parent_database_path: str | Path,
    candidate_database_path: str | Path,
    parent_evidence: dict[str, Any] | None,
    captured: tuple[bytes, dict[str, Any], dict[str, Any], dict[str, dict[str, str]]] | None,
) -> Path:
    parent, candidate = Path(parent_database_path), Path(candidate_database_path)
    if parent.resolve(strict=False) == candidate.resolve(strict=False):
        raise ValueError("parent database and candidate database must be different paths")
    if candidate.exists():
        raise FileExistsError(f"candidate database already exists: {candidate}")
    candidate.parent.mkdir(parents=True, exist_ok=True)
    if captured is not None:
        raw, actual, _historical, _heads = captured
        if not isinstance(parent_evidence, dict):
            raise ValueError("parent database evidence is required")
        _require_parent_evidence(actual, parent_evidence)
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
            descriptor = os.open(candidate, flags, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            copied = parent_database_evidence(candidate)
            _require_parent_evidence(copied, actual)
            with closing(_connect_candidate(candidate)) as connection:
                validate_schema(connection)
                _assert_parent_rows_preserved(connection, actual)
        except Exception:
            candidate.unlink(missing_ok=True)
            raise
    else:
        if parent_evidence not in (None, {}, {"missing": True}):
            raise ValueError("missing parent database cannot carry parent evidence")
        create_database(candidate)
    return candidate


def prepare_candidate_database(parent_database_path: str | Path, candidate_database_path: str | Path, parent_evidence: dict[str, Any] | None, legacy_baselines: dict[str, Any] | None = None) -> Path:
    """Capture and prove a parent once, or create the explicit baseline candidate."""
    captured = _capture_parent_database(parent_database_path)
    return _prepare_candidate_database_from_capture(parent_database_path, candidate_database_path, parent_evidence, captured)


def _value(mapping: dict[str, Any], *names: str, default=None):
    for name in names:
        if name in mapping:
            return mapping[name]
    return default


def _exclusive_value(mapping: dict[str, Any], *names: str, label: str):
    present = [name for name in names if name in mapping]
    if len(present) != 1:
        raise ValueError(f"{label} aliases must contain exactly one field")
    return mapping[present[0]]


def _slug_value(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise ValueError("repository slug is invalid")
    return value.lower()


def _json_array(value: Any, label: str) -> str:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return _canonical_bytes(value).decode("utf-8")


def _sha_text(value: Any, length: int, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(rf"[a-f0-9]{{{length}}}", value):
        raise ValueError(f"{label} must be lowercase hexadecimal")
    return value


_REPOSITORY_FACT_SNAKE_KEYS = {
    "archived", "contributors", "created_at", "default_branch", "default_branch_head_sha",
    "description", "display_rank", "display_slug", "field_tags", "forks", "form_tags",
    "gain_daily", "gain_monthly", "gain_weekly", "is_fork", "language_color",
    "license_spdx", "open_issues_and_pull_requests", "primary_language", "provenance",
    "pushed_at", "rank_daily", "rank_monthly", "rank_weekly", "readme_blob_sha",
    "readme_content_sha256", "readme_locale", "readme_path", "readme_status", "readme_variants", "slug", "stars",
    "subscribers", "tag_rule_version", "topics", "updated_at", "watchers_count",
}
_REPOSITORY_FACT_CAMEL_NAMES = {
    "created_at": "createdAt", "default_branch": "defaultBranch",
    "default_branch_head_sha": "defaultBranchHeadSha", "display_rank": "displayRank",
    "display_slug": "displaySlug", "field_tags": "fieldTags", "form_tags": "formTags",
    "gain_daily": "gainDaily", "gain_monthly": "gainMonthly", "gain_weekly": "gainWeekly",
    "is_fork": "isFork", "language_color": "languageColor", "license_spdx": "licenseSpdx",
    "open_issues_and_pull_requests": "openIssuesAndPullRequests", "primary_language": "primaryLanguage",
    "pushed_at": "pushedAt", "rank_daily": "rankDaily", "rank_monthly": "rankMonthly",
    "rank_weekly": "rankWeekly", "readme_blob_sha": "readmeBlobSha",
    "readme_content_sha256": "readmeContentSha256", "readme_locale": "readmeLocale", "readme_path": "readmePath",
    "readme_status": "readmeStatus", "readme_variants": "readmeVariants", "tag_rule_version": "tagRuleVersion",
    "updated_at": "updatedAt", "watchers_count": "watchersCount",
}
_REPOSITORY_FACT_CAMEL_KEYS = {
    _REPOSITORY_FACT_CAMEL_NAMES.get(key, key) for key in _REPOSITORY_FACT_SNAKE_KEYS
}


def _repository_fact_colors(repository: dict[str, Any]) -> tuple[Any, Any, Any, Any, Any]:
    provenance = repository["provenance"]
    if not isinstance(provenance, dict) or set(provenance) != {
        "repository", "contributors", "default_branch_head", "readme", "trending"
    }:
        raise ValueError("repository provenance fields are not the exact allowlist")
    for name in ("repository", "contributors", "default_branch_head"):
        entry = provenance[name]
        if not isinstance(entry, dict) or set(entry) != {"api_path", "fact_sha256"}:
            raise ValueError("repository provenance fields are not the exact allowlist")
        if not isinstance(entry["api_path"], str):
            raise ValueError("repository provenance API path is invalid")
        _sha_text(entry["fact_sha256"], 64, "repository provenance fact SHA")
    readme = provenance["readme"]
    if not isinstance(readme, dict) or set(readme) != {
        "api_path", "blob_api_path", "status", "path", "blob_sha", "content_sha256",
        "locale", "variant_tree_api_path", "variants",
    }:
        raise ValueError("repository provenance fields are not the exact allowlist")
    trending = provenance["trending"]
    if not isinstance(trending, dict) or set(trending) != {
        "daily", "weekly", "monthly", "language_color_selection"
    }:
        raise ValueError("repository provenance fields are not the exact allowlist")
    colors = []
    for period in ("daily", "weekly", "monthly"):
        entry = trending[period]
        if not isinstance(entry, dict) or set(entry) != {
            "source_path", "rank", "gain", "language_color", "fact_sha256"
        }:
            raise ValueError("repository provenance fields are not the exact allowlist")
        if entry["rank"] != _value(repository, f"rank_{period}", f"rank{period.title()}") or entry["gain"] != _value(repository, f"gain_{period}", f"gain{period.title()}"):
            raise ValueError("repository provenance trending values do not match facts")
        _sha_text(entry["fact_sha256"], 64, "repository provenance fact SHA")
        colors.append(entry["language_color"])
    selection = trending["language_color_selection"]
    if not isinstance(selection, dict) or set(selection) != {"rule", "selected_period", "value"}:
        raise ValueError("repository provenance fields are not the exact allowlist")
    selected = _value(repository, "language_color", "languageColor")
    if selection["rule"] != "daily_then_weekly_then_monthly" or selection["value"] != selected:
        raise ValueError("repository provenance color selection does not match facts")
    readme_values = (
        _value(repository, "readme_status", "readmeStatus"),
        _value(repository, "readme_path", "readmePath"),
        _value(repository, "readme_blob_sha", "readmeBlobSha"),
        _value(repository, "readme_content_sha256", "readmeContentSha256"),
        _value(repository, "readme_locale", "readmeLocale"),
        _value(repository, "readme_variants", "readmeVariants"),
    )
    if (
        readme["status"], readme["path"], readme["blob_sha"], readme["content_sha256"],
        readme["locale"], readme["variants"],
    ) != readme_values:
        raise ValueError("repository provenance README values do not match facts")
    tree_api_path = readme["variant_tree_api_path"]
    if readme["status"] == "present":
        head_sha = _value(repository, "default_branch_head_sha", "defaultBranchHeadSha")
        if not isinstance(tree_api_path, str) or not tree_api_path.endswith(f"/git/trees/{head_sha}"):
            raise ValueError("repository provenance README variant tree path is invalid")
    elif tree_api_path is not None:
        raise ValueError("repository provenance README variant tree path is invalid")
    return colors[0], colors[1], colors[2], selected, selection["selected_period"]


def _validate_repository_fact(repository: Any) -> None:
    if not isinstance(repository, dict) or set(repository) not in (
        _REPOSITORY_FACT_SNAKE_KEYS, _REPOSITORY_FACT_CAMEL_KEYS
    ):
        raise ValueError("repository fact fields are not the exact allowlist")
    if type(repository["archived"]) is not bool:
        raise ValueError("repository archived must be a boolean")
    if type(_value(repository, "is_fork", "isFork")) is not bool:
        raise ValueError("repository is_fork must be a boolean")
    for field, camel in (("topics", "topics"), ("field_tags", "fieldTags"), ("form_tags", "formTags")):
        value = _value(repository, field, camel)
        if not isinstance(value, list):
            raise ValueError(f"repository {field} must be an array")
    tag_version = _value(repository, "tag_rule_version", "tagRuleVersion")
    if isinstance(tag_version, bool) or not isinstance(tag_version, int):
        raise ValueError("repository tag rule version must be an integer")
    branch = _value(repository, "default_branch", "defaultBranch")
    if not isinstance(branch, str) or not branch:
        raise ValueError("repository default branch is invalid")
    _sha_text(_value(repository, "default_branch_head_sha", "defaultBranchHeadSha"), 40, "repository default branch HEAD")
    status = _value(repository, "readme_status", "readmeStatus")
    readme_path = _value(repository, "readme_path", "readmePath")
    readme_blob = _value(repository, "readme_blob_sha", "readmeBlobSha")
    readme_content = _value(repository, "readme_content_sha256", "readmeContentSha256")
    readme_locale = _value(repository, "readme_locale", "readmeLocale")
    readme_variants = _value(repository, "readme_variants", "readmeVariants")
    if status not in ("present", "absent") or (status == "absent") != (readme_path is None and readme_blob is None and readme_content is None):
        raise ValueError("repository README identity is invalid")
    if readme_locale is not None and readme_locale not in ("en", "ko", "zh-CN", "es", "ja"):
        raise ValueError("repository README locale is invalid")
    if not isinstance(readme_variants, list):
        raise ValueError("repository README variants must be an array")
    variant_locales = []
    for variant in readme_variants:
        if not isinstance(variant, dict) or set(variant) != {"locale", "path", "blob_sha", "content_sha256"}:
            raise ValueError("repository README variant identity is invalid")
        locale = variant["locale"]
        if locale not in ("en", "ko", "zh-CN", "es", "ja") or locale in variant_locales:
            raise ValueError("repository README variant locale is invalid")
        if not isinstance(variant["path"], str) or not variant["path"] or variant["path"] == readme_path:
            raise ValueError("repository README variant path is invalid")
        _sha_text(variant["blob_sha"], 40, "repository README variant blob SHA")
        _sha_text(variant["content_sha256"], 64, "repository README variant content SHA")
        variant_locales.append(locale)
    order = {locale: index for index, locale in enumerate(("en", "ko", "zh-CN", "es", "ja"))}
    if variant_locales != sorted(variant_locales, key=order.__getitem__):
        raise ValueError("repository README variants are not canonical")
    if status == "absent" and (readme_locale is not None or readme_variants):
        raise ValueError("repository README language identity conflicts with absence")
    if status == "present":
        if not isinstance(readme_path, str) or not readme_path:
            raise ValueError("repository README identity is invalid")
        _sha_text(readme_blob, 40, "repository README blob SHA")
        _sha_text(readme_content, 64, "repository README content SHA")
    _repository_fact_colors(repository)


def _profile_row(repository: dict[str, Any], captured_seq: int, profile_id: int) -> dict[str, Any]:
    display_slug = _value(repository, "display_slug", "displaySlug", "slug")
    if isinstance(display_slug, str):
        display_slug = re.sub(r"\s*/\s*", "/", display_slug)
    slug = _slug_value(_value(repository, "slug"))
    topics = _value(repository, "topics")
    fields = _value(repository, "field_tags", "fieldTags")
    forms = _value(repository, "form_tags", "formTags")
    profile = {
        "profile_id": profile_id, "slug": slug, "display_slug": display_slug,
        "captured_snapshot_seq": captured_seq,
        "description": _value(repository, "description"),
        "primary_language": _value(repository, "primary_language", "primaryLanguage", "language"),
        "topics_json": _json_array(topics, "topics"),
        "license_spdx": _value(repository, "license_spdx", "licenseSpdx"),
        "archived": int(_value(repository, "archived")),
        "is_fork": int(_value(repository, "is_fork", "isFork")),
        "default_branch": _value(repository, "default_branch", "defaultBranch"),
        "created_at": _canonical_repository_utc(_value(repository, "created_at", "createdAt")),
        "field_tags_json": _json_array(fields, "field tags"),
        "form_tags_json": _json_array(forms, "form tags"),
        "tag_rule_version": _value(repository, "tag_rule_version", "tagRuleVersion"),
    }
    profile["profile_sha256"] = _digest({
        "slug": profile["slug"], "display_slug": profile["display_slug"], "description": profile["description"],
        "primary_language": profile["primary_language"], "topics": topics, "license_spdx": profile["license_spdx"],
        "archived": bool(profile["archived"]), "is_fork": bool(profile["is_fork"]),
        "default_branch": profile["default_branch"], "created_at": profile["created_at"],
        "field_tags": fields, "form_tags": forms, "tag_rule_version": profile["tag_rule_version"],
    })
    return profile


def _enrichment_entry(index: Any, slug: str) -> dict[str, Any]:
    if not isinstance(index, dict):
        raise ValueError("enrichment index is required")
    entries = _value(index, "repositories", "entries", default=index)
    if not isinstance(entries, dict):
        raise ValueError("enrichment index repositories is invalid")
    entry = entries.get(slug) or entries.get(slug.lower())
    if not isinstance(entry, dict):
        raise ValueError(f"enrichment index is missing {slug}")
    return entry


def _validate_production_manifest_evidence(snapshot: dict[str, Any], source_sha: Any, hydration_source_sha: Any) -> None:
    status = snapshot.get("productionManifestStatus")
    manifest_sha = _exclusive_value(
        snapshot,
        "input_manifest_sha256", "inputManifestSha256", "manifestSha256",
        label="production manifest SHA",
    )
    explicit_source_present = "explicitBootstrapSourceSha" in snapshot
    if status in {"verified_v0", "verified_v1"}:
        if explicit_source_present:
            raise ValueError("production manifest evidence is invalid")
        _sha_text(manifest_sha, 64, "production manifest SHA")
        return
    if status == "verified_404":
        if manifest_sha is not None or not explicit_source_present or snapshot["explicitBootstrapSourceSha"] != hydration_source_sha:
            raise ValueError("production manifest evidence is invalid")
        return
    raise ValueError("production manifest evidence is invalid")


def _validate_cross_input_bindings(snapshot: dict[str, Any], events: dict[str, Any], index: Any, repositories: list[dict[str, Any]]) -> None:
    if not isinstance(index, dict) or set(index) != {"version", "snapshotId", "activeSetSha256", "factsSha256", "sourceSetSha256", "runContextSha256", "eventsSha256", "heldRatio", "repositories"} or index["version"] != 2 or not isinstance(index["repositories"], dict):
        raise ValueError("enrichment index binding envelope is invalid")
    held_ratio = index["heldRatio"]
    if isinstance(held_ratio, bool) or not isinstance(held_ratio, (int, float)) or not (0 <= held_ratio <= 0.5):
        raise ValueError("enrichment index held ratio is invalid")
    entries = index["repositories"]
    held_count = sum(1 for entry in entries.values() if isinstance(entry, dict) and entry.get("status") == "held")
    if entries and (held_count * 2 > len(entries) or held_count / len(entries) != held_ratio):
        raise ValueError("enrichment index held ratio is inconsistent with its entries")
    snapshot_id = _value(snapshot, "snapshot_id", "snapshotId")
    source_sha = _value(snapshot, "input_source_sha", "inputSourceSha", "sourceSha")
    hydration_source_sha = _exclusive_value(snapshot, "hydration_source_sha", "hydrationSourceSha", label="hydration source SHA")
    _sha_text(hydration_source_sha, 40, "hydration source SHA")
    source_set_sha = _exclusive_value(snapshot, "source_set_sha256", "sourceSetSha256", label="source-set SHA")
    run_context_sha = _exclusive_value(snapshot, "run_context_sha256", "runContextSha256", label="run-context SHA")
    _sha_text(source_set_sha, 64, "source-set SHA")
    _sha_text(run_context_sha, 64, "run-context SHA")
    parent_snapshot_id = _value(snapshot, "parent_snapshot_id", "parentSnapshotId")
    expected_run_context_sha = _digest({
        "observedAtUtc": _value(snapshot, "observed_at_utc", "observedAtUtc"),
        "observedAtKst": _value(snapshot, "observed_at_kst", "observedAtKst"),
        "statsDateKst": _value(snapshot, "stats_date_kst", "statsDate"),
        "snapshotId": snapshot_id,
        "parentSnapshotId": parent_snapshot_id,
        "parentSourceSha": hydration_source_sha if parent_snapshot_id is not None else None,
    })
    if run_context_sha != expected_run_context_sha:
        raise ValueError("snapshot run context hash is invalid")
    slugs = [_slug_value(_value(repository, "slug")) for repository in repositories]
    if len(set(slugs)) != len(slugs):
        raise ValueError("snapshot has duplicate repository slug")
    active_set_sha = _digest(sorted(slugs))
    facts_sha = _digest({"snapshot_id": snapshot_id, "input_source_sha": source_sha, "repositories": repositories})
    event_binding_keys = {"version", "snapshotId", "activeSetSha256", "factsSha256", "sourceSetSha256", "runContextSha256", "completeSetSha256"}
    event_content = {key: value for key, value in events.items() if key not in event_binding_keys}
    events_sha = _digest(event_content)
    if events.get("version") != 1 or events.get("snapshotId") != snapshot_id or events.get("activeSetSha256") != active_set_sha or events.get("factsSha256") != facts_sha or events.get("sourceSetSha256") != source_set_sha or events.get("runContextSha256") != run_context_sha or events.get("completeSetSha256") != events_sha:
        raise ValueError("event payload does not bind to exact snapshot facts")
    if index["snapshotId"] != snapshot_id or index["activeSetSha256"] != active_set_sha or index["factsSha256"] != facts_sha or index["sourceSetSha256"] != source_set_sha or index["runContextSha256"] != run_context_sha or index["eventsSha256"] != events_sha or set(index["repositories"]) != set(slugs):
        raise ValueError("enrichment index does not bind to exact facts and events")
    enrichment_sha = _digest(index)
    declared = {
        "active_set_sha256": _value(snapshot, "active_set_sha256", "activeSetSha256"),
        "facts_sha256": _value(snapshot, "facts_sha256", "factsSha256"),
        "source_set_sha256": source_set_sha,
        "run_context_sha256": run_context_sha,
        "events_sha256": _value(snapshot, "events_sha256", "eventsSha256"),
        "enrichment_index_sha256": _value(snapshot, "enrichment_index_sha256", "enrichmentIndexSha256"),
    }
    expected = {
        "active_set_sha256": active_set_sha,
        "facts_sha256": facts_sha,
        "source_set_sha256": source_set_sha,
        "run_context_sha256": expected_run_context_sha,
        "events_sha256": events_sha,
        "enrichment_index_sha256": enrichment_sha,
    }
    if declared != expected:
        raise ValueError("snapshot input hash bindings are invalid")
    _validate_production_manifest_evidence(snapshot, source_sha, hydration_source_sha)


def _supported_summary_producer(source: Any) -> bool:
    version = source.get("cli_version") if isinstance(source, dict) else None
    return (isinstance(version, str)
            and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) is not None
            and tuple(source.get(field) for field in _SUMMARY_PRODUCER_FIELDS) in _SUMMARY_PRODUCER_PROFILES)


HELD_REASONS = ("quality_defects", "budget_exhausted", "deadline_exhausted", "request_failed")


def held_summary_digests(slug: str, reason: str) -> tuple[str, str, str]:
    """Schema-preserving sentinel digests for a repository whose summary is held."""
    if reason not in HELD_REASONS:
        raise ValueError("held summary reason is invalid")
    source = {"kind": "held", "slug": slug, "reason": reason, "schema_version": 3}
    content = {"status": "held"}
    return _digest(source), _digest(content), _digest({"content": content, "source": source})


def _enrichment_hashes(repository: dict[str, Any], profile: dict[str, Any], index: Any) -> tuple[str, str, str, str, str | None, str | None]:
    slug = profile["slug"]
    entry = _enrichment_entry(index, slug)
    if entry.get("status") == "held":
        if set(entry) != {"status", "held_reason", "defect_codes", "warnings"} or not isinstance(entry["defect_codes"], list) or not isinstance(entry["warnings"], list):
            raise ValueError("held enrichment entry is invalid")
        source_digest, content_digest, envelope_digest = held_summary_digests(slug, entry["held_reason"])
        status = "not_applicable:no_readme" if _value(repository, "readme_path", "readmePath") is None else "not_applicable:no_prose"
        return source_digest, content_digest, envelope_digest, status, None, None
    if entry.get("status") not in ("verified", "retained"):
        raise ValueError("enrichment entry status is invalid")
    summary = _value(entry, "summary", default=entry)
    if not isinstance(summary, dict):
        raise ValueError("summary enrichment is invalid")
    content = _value(summary, "content", "summaryContent")
    source = _value(summary, "source", "summarySource")
    if not isinstance(content, dict) or set(content) != {"goal", "usage", "pros", "cons", "fit"} or any(not isinstance(value, str) for value in content.values()):
        raise ValueError("summary content must be exact detailed summary")
    if not isinstance(source, dict):
        raise ValueError("summary source is required")
    readme_path = _value(repository, "readme_path", "readmePath")
    readme_blob = _value(repository, "readme_blob_sha", "readmeBlobSha")
    readme_content = _value(repository, "readme_content_sha256", "readmeContentSha256")
    if readme_path is None:
        expected_source = {"kind": "metadata_only", "slug": slug, "profile_sha256": profile["profile_sha256"], "model": source.get("model"), "schema_version": source.get("schema_version"), "translation_applicable": False}
    else:
        expected_source = {"kind": "readme", "slug": slug, "path": readme_path, "blob_sha": readme_blob, "content_sha256": readme_content, "provider": source.get("provider"), "interface": source.get("interface"), "cli_version": source.get("cli_version"), "auth_method": source.get("auth_method"), "api_provider": source.get("api_provider"), "model": source.get("model"), "schema_version": source.get("schema_version"), "prompt_schema_version": source.get("prompt_schema_version"), "translation_applicable": source.get("translation_applicable")}
    if source != expected_source:
        raise ValueError("summary source does not match canonical repository identity")
    if (not _supported_summary_producer(source) or source.get("schema_version") != 3
            or source.get("prompt_schema_version") != 3 or source.get("translation_applicable") is not False):
        raise ValueError("summary source model or prompt contract is invalid")
    summary_source = _digest(source)
    summary_content = _digest(content)
    summary_envelope = _digest({"content": content, "source": source})
    translation = _value(entry, "translation")
    if readme_path is None:
        status = "not_applicable:no_readme"
    elif isinstance(translation, dict):
        status = "applicable"
    elif source.get("translation_applicable") is False:
        status = "not_applicable:no_prose"
    else:
        raise ValueError("translation status is invalid")
    if status == "applicable":
        if not isinstance(translation, dict) or translation.get("source") != source or not isinstance(_value(translation, "markdown", "translated_markdown"), str):
            raise ValueError("applicable translation must bind to exact summary source")
        markdown = _value(translation, "markdown", "translated_markdown")
        return summary_source, summary_content, summary_envelope, status, _digest(source), hashlib.sha256(_canonical_bytes({"markdown": markdown, "source": source}) + b"\n").hexdigest()
    if status not in ("not_applicable:no_readme", "not_applicable:no_prose"):
        raise ValueError("translation status is invalid")
    if (status == "not_applicable:no_readme") != (readme_path is None):
        raise ValueError("translation status conflicts with README identity")
    return summary_source, summary_content, summary_envelope, status, None, None


def _insert_row(connection: sqlite3.Connection, table: str, row: dict[str, Any], inserted: dict[str, int], reused: dict[str, int]) -> None:
    columns = _columns(connection, table)
    if set(row) != set(columns):
        missing, extra = set(columns) - set(row), set(row) - set(columns)
        raise ValueError(f"{table} row does not match exact schema: missing={sorted(missing)} extra={sorted(extra)}")
    keys = _natural_key_columns(table)
    where = " AND ".join(f"{key} = ?" for key in keys)
    old = connection.execute(f"SELECT * FROM {table} WHERE {where}", tuple(row[key] for key in keys)).fetchone()
    values = tuple(row[column] for column in columns)
    if old is not None:
        if tuple(old) != values:
            raise ValueError(f"conflicting immutable natural key in {table}")
        reused[table] = reused.get(table, 0) + 1
        return
    connection.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", values)
    inserted[table] = inserted.get(table, 0) + 1


def _core_preimage(connection: sqlite3.Connection, table_rows: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Build the exact Task-3 preimage in table/natural-key order."""
    if set(table_rows) != set(CORE_PREIMAGE_TABLES):
        raise ValueError("core projection does not contain the exact table set")
    ordered: dict[str, list[dict[str, Any]]] = {}
    for table in CORE_PREIMAGE_TABLES:
        keys = _natural_key_columns(table)
        rows = table_rows[table]
        ordered[table] = sorted(rows, key=lambda row: tuple(row[key] for key in keys))
    return {"schema_fingerprint_sha256": schema_fingerprint(connection), "tables": ordered}


def verify_core_snapshot(connection: sqlite3.Connection, snapshot_seq: int) -> str:
    """Independently recompute the Task-3 nonderived snapshot preimage.

    This query path intentionally does not reuse the candidate's in-memory
    rows. It follows snapshot foreign keys in natural-key order and therefore
    catches a writer that hashed one row set but committed another.
    """
    run_columns = _columns(connection, "snapshot_runs")
    run = connection.execute("SELECT * FROM snapshot_runs WHERE snapshot_seq=?", (snapshot_seq,)).fetchone()
    if run is None:
        raise ValueError("core verifier snapshot is missing")
    run_value = {key: value for key, value in zip(run_columns, run) if key not in {"core_payload_sha256", "chain_sha256"}}
    profiles = [dict(zip(_columns(connection, "repository_profiles"), row)) for row in connection.execute("SELECT p.* FROM repository_profiles p JOIN (SELECT DISTINCT profile_id FROM snapshot_items WHERE snapshot_seq=?) i USING(profile_id) ORDER BY p.profile_id", (snapshot_seq,))]
    items = [dict(zip(_columns(connection, "snapshot_items"), row)) for row in connection.execute("SELECT * FROM snapshot_items WHERE snapshot_seq=? ORDER BY snapshot_seq,slug", (snapshot_seq,))]
    releases = [dict(zip(_columns(connection, "release_versions"), row)) for row in connection.execute("SELECT DISTINCT v.* FROM release_versions v JOIN snapshot_release_items i ON (i.slug,i.release_id,i.metadata_sha256)=(v.slug,v.release_id,v.metadata_sha256) WHERE i.snapshot_seq=? ORDER BY v.slug,v.release_id,v.metadata_sha256", (snapshot_seq,))]
    release_items = [dict(zip(_columns(connection, "snapshot_release_items"), row)) for row in connection.execute("SELECT * FROM snapshot_release_items WHERE snapshot_seq=? ORDER BY snapshot_seq,slug,release_id", (snapshot_seq,))]
    cutover = connection.execute(
        "SELECT MIN(cutover_snapshot_seq) FROM baseline_sources WHERE cutover_snapshot_seq <= ?",
        (snapshot_seq,),
    ).fetchone()[0]
    estimates = [dict(zip(_columns(connection, "historical_star_estimates"), row)) for row in connection.execute("SELECT * FROM historical_star_estimates WHERE first_observed_snapshot_seq=? OR (source='legacy_star_history_cache' AND first_observed_snapshot_seq=?) ORDER BY source,slug,estimate_date,first_observed_snapshot_seq", (snapshot_seq, cutover))]
    commits = [dict(zip(_columns(connection, "commit_events"), row)) for row in connection.execute("SELECT * FROM commit_events WHERE first_observed_snapshot_seq=? ORDER BY slug,commit_sha", (snapshot_seq,))]
    readmes = [dict(zip(_columns(connection, "readme_change_events"), row)) for row in connection.execute("SELECT * FROM readme_change_events WHERE snapshot_seq=? ORDER BY snapshot_seq,slug", (snapshot_seq,))]
    baselines = [dict(zip(_columns(connection, "baseline_sources"), row)) for row in connection.execute("SELECT * FROM baseline_sources WHERE cutover_snapshot_seq=? ORDER BY source_name", (cutover,))]
    membership = [dict(zip(_columns(connection, "baseline_membership_slugs"), row)) for row in connection.execute("SELECT * FROM baseline_membership_slugs WHERE cutover_snapshot_seq=? ORDER BY slug", (cutover,))]
    observations = [dict(zip(_columns(connection, "historical_star_observations"), row)) for row in connection.execute("SELECT * FROM historical_star_observations WHERE first_observed_snapshot_seq=? ORDER BY source,slug,observation_date,source_row_sha256", (cutover,))]
    table_rows = {
        "snapshot_runs": [run_value],
        "baseline_sources": baselines,
        "baseline_membership_slugs": membership,
        "repository_profiles": profiles,
        "snapshot_items": items,
        "release_versions": releases,
        "snapshot_release_items": release_items,
        "historical_star_estimates": estimates,
        "historical_star_observations": observations,
        "commit_events": commits,
        "readme_change_events": readmes,
    }
    digest = _digest(_core_preimage(connection, table_rows))
    stored = connection.execute("SELECT core_payload_sha256 FROM snapshot_runs WHERE snapshot_seq=?", (snapshot_seq,)).fetchone()[0]
    if digest != stored:
        raise ValueError(f"core payload hash preimage mismatch for snapshot {snapshot_seq}")
    return digest


def _event_map(events: dict[str, Any], name: str, key: str = "slug") -> dict[str, dict[str, Any]]:
    values = _value(events, name, default=[])
    if not isinstance(values, list):
        raise ValueError(f"event {name} is invalid")
    mapped: dict[str, dict[str, Any]] = {}
    for item in values:
        if not isinstance(item, dict) or key not in item:
            raise ValueError(f"event {name} is invalid")
        slug = _slug_value(item[key])
        if slug in mapped:
            raise ValueError(f"event {name} has duplicate slug")
        mapped[slug] = item
    return mapped


def _exact_alias_keys(value: dict[str, Any], snake: set[str], camel: set[str], label: str) -> None:
    if set(value) not in (snake, camel):
        raise ValueError(f"{label} fields are not the exact allowlist")


def _github_url(value: Any, expected_path_prefix: str, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} URL is invalid")
    parsed = urlsplit(value)
    path = unquote(parsed.path)
    if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.port is not None or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or not path.casefold().startswith(expected_path_prefix.casefold()):
        raise ValueError(f"{label} URL is invalid")
    return value


def _release_rows(events: dict[str, Any], slug: str, seq: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int | None]:
    all_releases = _value(events, "releases", default=[])
    if not isinstance(all_releases, list):
        raise ValueError("release event list is invalid")
    releases = []
    seen_ids: set[int] = set()
    snake = {"slug", "release_id", "tag_name", "name", "target_commitish", "draft", "prerelease", "created_at", "published_at", "html_url", "metadata_sha256"}
    camel = {"slug", "releaseId", "tagName", "name", "targetCommitish", "draft", "prerelease", "createdAt", "publishedAt", "htmlUrl", "metadataSha256"}
    for entry in all_releases:
        if not isinstance(entry, dict):
            raise ValueError("release event is invalid")
        _exact_alias_keys(entry, snake, camel, "release event")
        entry_slug = _slug_value(entry["slug"])
        if entry["slug"] != entry_slug:
            raise ValueError("release event slug is noncanonical")
        if entry_slug != slug:
            continue
        release_id = _value(entry, "release_id", "releaseId")
        if isinstance(release_id, bool) or not isinstance(release_id, int) or release_id < 1 or release_id in seen_ids:
            raise ValueError("release inventory has invalid or duplicate id")
        seen_ids.add(release_id)
        releases.append(entry)
    version_rows, item_rows = [], []
    for ordinal, release in enumerate(releases):
        release_id = _value(release, "release_id", "releaseId")
        normalized = {
            "slug": slug, "release_id": release_id, "tag_name": _value(release, "tag_name", "tagName"),
            "name": _value(release, "name"), "target_commitish": _value(release, "target_commitish", "targetCommitish"),
            "draft": int(bool(_value(release, "draft"))), "prerelease": int(bool(_value(release, "prerelease"))),
            "created_at": _value(release, "created_at", "createdAt"), "published_at": _value(release, "published_at", "publishedAt"),
            "html_url": _value(release, "html_url", "htmlUrl"),
        }
        if not isinstance(normalized["tag_name"], str) or not normalized["tag_name"].strip() or not isinstance(normalized["target_commitish"], str) or not normalized["target_commitish"].strip():
            raise ValueError("release metadata is invalid")
        if normalized["name"] is not None and not isinstance(normalized["name"], str):
            raise ValueError("release metadata is invalid")
        if type(_value(release, "draft")) is not bool or type(_value(release, "prerelease")) is not bool:
            raise ValueError("release booleans are invalid")
        _parse_utc(normalized["created_at"])
        if normalized["published_at"] is not None:
            _parse_utc(normalized["published_at"])
        _github_url(normalized["html_url"], f"/{slug}/releases/", "release")
        digest = _digest({**normalized, "draft": bool(normalized["draft"]), "prerelease": bool(normalized["prerelease"])})
        stated = _value(release, "metadata_sha256", "metadataSha256")
        if stated is not None and stated != digest:
            raise ValueError("release metadata hash does not match allowlisted fields")
        version_rows.append({"metadata_sha256": digest, "first_observed_snapshot_seq": seq, **normalized})
        item_rows.append({"snapshot_seq": seq, "slug": slug, "release_id": release_id, "metadata_sha256": digest, "release_ordinal": ordinal})
    latest_values = _value(events, "latestReleaseIds", "latest_release_ids", default={})
    if not isinstance(latest_values, dict) or set(latest_values) != set(_event_map(events, "heads")):
        raise ValueError("latest release id map does not match active repositories")
    latest = latest_values.get(slug)
    if latest is not None and latest not in seen_ids:
        raise ValueError("latest release id is absent from inventory")
    return version_rows, item_rows, latest


def _run_identity(snapshot: dict[str, Any], seq: int, parent: tuple[int, str, str] | None, core: str) -> dict[str, Any]:
    snapshot_id = _value(snapshot, "snapshot_id", "snapshotId")
    utc = _value(snapshot, "observed_at_utc", "observedAtUtc", "generated_at", "generatedAt")
    kst = _value(snapshot, "observed_at_kst", "observedAtKst")
    stats = _value(snapshot, "stats_date_kst", "statsDate", "stats_date")
    kind = _value(snapshot, "run_kind", "runKind")
    if parent is None:
        if kind != "migration_baseline":
            raise ValueError("missing parent database requires migration_baseline")
        parent_seq = parent_id = parent_chain = None
    else:
        if kind != "refresh":
            raise ValueError("existing parent database requires refresh")
        parent_seq, parent_id, parent_chain = parent
        if _value(snapshot, "parent_snapshot_id", "parentSnapshotId") != parent_id:
            raise ValueError("refresh parent snapshot id must equal last parent")
    return {"snapshot_seq": seq, "snapshot_id": snapshot_id, "run_kind": kind, "observed_at_utc": utc, "observed_at_kst": kst, "stats_date_kst": stats, "parent_snapshot_seq": parent_seq, "parent_snapshot_id": parent_id, "input_source_sha": _value(snapshot, "input_source_sha", "inputSourceSha", "sourceSha"), "input_manifest_sha256": _exclusive_value(snapshot, "input_manifest_sha256", "inputManifestSha256", "manifestSha256", label="production manifest SHA"), "core_payload_sha256": core, "parent_chain_sha256": parent_chain, "chain_sha256": "0" * 64, "repository_count": len(_value(snapshot, "repositories", "repos", default=[]))}


def _readme_identity(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"path", "blob_sha", "content_sha256", "observed_at_utc"}:
        raise ValueError(f"README state {label} must contain identity only")
    path, blob, content = value["path"], value["blob_sha"], value["content_sha256"]
    if (path is None) != (blob is None) or (path is None) != (content is None):
        raise ValueError(f"README state {label} has inconsistent null identity")
    if path is not None:
        _sha_text(blob, 40, f"README state {label} blob SHA")
        _sha_text(content, 64, f"README state {label} content SHA")
    _parse_utc(value["observed_at_utc"])
    return value


def _validated_event_maps(event_payload: dict[str, Any], active_slugs: set[str]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    required = {"heads", "releases", "latestReleaseIds", "commits", "estimates"}
    allowed = required | {"budgetReceipt", "version", "snapshotId", "activeSetSha256", "factsSha256", "sourceSetSha256", "runContextSha256", "completeSetSha256"}
    if not required.issubset(event_payload) or not set(event_payload).issubset(allowed):
        raise ValueError("event payload fields are not the exact allowlist")
    if "budgetReceipt" in event_payload:
        receipt = event_payload["budgetReceipt"]
        if not isinstance(receipt, dict) or set(receipt) != {"logicalRequests", "httpAttempts", "originEpochMs", "eventDeadlineEpochMs"} or any(isinstance(receipt[key], bool) or not isinstance(receipt[key], int) or receipt[key] < 0 for key in receipt) or receipt["logicalRequests"] > 3600 or receipt["httpAttempts"] > 4500 or receipt["eventDeadlineEpochMs"] != receipt["originEpochMs"] + 15 * 60 * 1000:
            raise ValueError("event budget receipt is invalid")
    heads = _event_map(event_payload, "heads")
    estimates = _event_map(event_payload, "estimates")
    if set(heads) != active_slugs or set(estimates) != active_slugs:
        raise ValueError("event payload active repository set mismatch")
    for slug, head in heads.items():
        _exact_alias_keys(
            head,
            {"slug", "branch", "head_sha", "transition"},
            {"slug", "branch", "headSha", "transition"},
            "head event",
        )
        if not isinstance(head["branch"], str) or not head["branch"].strip():
            raise ValueError("head branch is invalid")
        _sha_text(_value(head, "head_sha", "headSha"), 40, "head SHA")
        if head["transition"] not in {"baseline", "unchanged", "fast_forward", "branch_changed", "history_rewritten"}:
            raise ValueError("head transition is invalid")
    for slug, estimate in estimates.items():
        _exact_alias_keys(
            estimate,
            {"slug", "rows", "source_payload_sha256", "public_rows"},
            {"slug", "rows", "sourcePayloadSha256", "publicRows"},
            "OSS estimate event",
        )
        rows = estimate["rows"]
        public_rows = _value(estimate, "public_rows", "publicRows")
        if not isinstance(rows, list) or not isinstance(public_rows, list) or public_rows != rows[-500:]:
            raise ValueError("OSS estimate public rows do not match full series")
        _sha_text(_value(estimate, "source_payload_sha256", "sourcePayloadSha256"), 64, "OSS payload SHA")
        previous_date = ""
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"date", "stars"}:
                raise ValueError("OSS estimate row fields are invalid")
            date = _legacy_date(row["date"], "OSS estimate date")
            if date <= previous_date or isinstance(row["stars"], bool) or not isinstance(row["stars"], int) or row["stars"] < 0:
                raise ValueError("OSS estimate rows must be ascending unique nonnegative integers")
            previous_date = date
    return heads, estimates


def _project_commit_rows(
    connection: sqlite3.Connection,
    event_payload: dict[str, Any],
    seq: int,
    active_slugs: set[str],
    heads: dict[str, dict[str, Any]],
    previous: dict[str, tuple[str, str]],
) -> list[dict[str, Any]]:
    commits = event_payload["commits"]
    if not isinstance(commits, list):
        raise ValueError("commit event list is invalid")
    projected: list[dict[str, Any]] = []
    grouped: dict[str, list[dict[str, Any]]] = {slug: [] for slug in active_slugs}
    seen: set[tuple[str, str]] = set()
    snake = {"slug", "commit_sha", "first_observed_ordinal", "branch_name", "authored_at", "committed_at", "author_login", "parent_shas", "html_url"}
    camel = {"slug", "sha", "firstObservedOrdinal", "branch", "authoredAt", "committedAt", "authorLogin", "parentShas", "htmlUrl"}
    for event in commits:
        if not isinstance(event, dict):
            raise ValueError("commit event is invalid")
        _exact_alias_keys(event, snake, camel, "commit event")
        slug = _slug_value(event["slug"])
        sha = _sha_text(_value(event, "commit_sha", "sha"), 40, "commit SHA")
        # Events carry GitHub's display casing; the ledger keys them by the canonical slug.
        if slug not in active_slugs or (slug, sha) in seen:
            raise ValueError("commit event has duplicate or inactive slug")
        seen.add((slug, sha))
        ordinal = _value(event, "first_observed_ordinal", "firstObservedOrdinal")
        branch = _value(event, "branch_name", "branch")
        authored = _value(event, "authored_at", "authoredAt")
        committed = _value(event, "committed_at", "committedAt")
        author = _value(event, "author_login", "authorLogin")
        parents = _value(event, "parent_shas", "parentShas")
        html_url = _value(event, "html_url", "htmlUrl")
        if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 1 or not isinstance(branch, str) or not branch.strip() or (author is not None and not isinstance(author, str)):
            raise ValueError("commit metadata is invalid")
        _parse_utc(authored); _parse_utc(committed)
        if not isinstance(parents, list) or len(set(parents)) != len(parents):
            raise ValueError("commit parents are invalid")
        for parent_sha in parents:
            _sha_text(parent_sha, 40, "commit parent SHA")
        if _github_url(html_url, f"/{slug}/commit/", "commit").casefold() != f"https://github.com/{slug}/commit/{sha}".casefold():
            raise ValueError("commit URL does not bind to commit SHA")
        row = {
            "slug": slug, "commit_sha": sha, "first_observed_snapshot_seq": seq,
            "first_observed_ordinal": ordinal, "branch_name": branch,
            "authored_at": authored, "committed_at": committed,
            "author_login": author, "parent_shas_json": _json_array(parents, "commit parent SHAs"),
            "html_url": html_url,
        }
        existing = connection.execute("SELECT * FROM commit_events WHERE slug=? AND commit_sha=?", (slug, sha)).fetchone()
        if existing is not None:
            actual = dict(zip(_columns(connection, "commit_events"), existing))
            if actual["first_observed_snapshot_seq"] != seq or actual != row:
                raise ValueError("conflicting or previously observed commit event")
            row = actual
        grouped[slug].append(row)
        projected.append(row)
    for slug in active_slugs:
        rows = grouped[slug]
        if [row["first_observed_ordinal"] for row in rows] != list(range(1, len(rows) + 1)):
            raise ValueError("commit ordinals are not contiguous in collector order")
        head = heads[slug]
        current_head = _value(head, "head_sha", "headSha")
        current_branch = head["branch"]
        transition = head["transition"]
        prior = previous.get(slug)
        if prior is None:
            if transition != "baseline" or rows:
                raise ValueError("newly observed repository requires baseline head without commit backfill")
            continue
        prior_branch, prior_head = prior
        if transition == "unchanged":
            if current_branch != prior_branch or current_head != prior_head or rows:
                raise ValueError("unchanged head transition is contradictory")
        elif transition == "branch_changed":
            if current_branch == prior_branch or rows:
                raise ValueError("branch_changed head transition is contradictory")
        elif transition == "fast_forward":
            if current_branch != prior_branch or current_head == prior_head or not rows or rows[0]["commit_sha"] != current_head:
                raise ValueError("fast_forward head transition is contradictory")
            parents_by_sha = {row["commit_sha"]: json.loads(row["parent_shas_json"]) for row in rows}
            frontier = [current_head]
            visited: set[str] = set()
            reached_previous = False
            while frontier:
                candidate = frontier.pop()
                if candidate == prior_head:
                    reached_previous = True
                    continue
                if candidate in visited:
                    continue
                visited.add(candidate)
                frontier.extend(parents_by_sha.get(candidate, []))
            if not reached_previous:
                raise ValueError("fast_forward commit chain does not reach previous head")
            supplied = set(parents_by_sha)
            if not supplied.issubset(visited):
                raise ValueError("fast_forward commit lies outside current-to-previous graph")
            ordinals = {row["commit_sha"]: row["first_observed_ordinal"] for row in rows}
            if any(
                row["branch_name"] != current_branch
                or any(parent in ordinals and ordinals[parent] <= row["first_observed_ordinal"] for parent in json.loads(row["parent_shas_json"]))
                for row in rows
            ):
                raise ValueError("fast_forward commit graph order is invalid")
        elif transition == "history_rewritten":
            if current_branch != prior_branch or current_head == prior_head or rows:
                raise ValueError("history_rewritten head transition is contradictory")
        else:
            raise ValueError("existing repository cannot use baseline head transition")
    return projected


def _reconstruct_readme_state(connection: sqlite3.Connection, through_seq: int | None) -> dict[str, Any]:
    state: dict[str, Any] = {}
    if through_seq is None:
        return state
    for slug, path, blob, content, observed_at in connection.execute(
        """SELECT i.slug, i.readme_path, i.readme_blob_sha, i.readme_content_sha256, r.observed_at_utc
           FROM snapshot_items i JOIN snapshot_runs r USING(snapshot_seq)
           WHERE i.snapshot_seq <= ? ORDER BY i.snapshot_seq, i.slug""",
        (through_seq,),
    ):
        current = {"path": path, "blob_sha": blob, "content_sha256": content, "observed_at_utc": observed_at}
        prior = state.get(slug)
        prior_tuple = None if prior is None else (prior["current"]["path"], prior["current"]["blob_sha"], prior["current"]["content_sha256"])
        current_tuple = (path, blob, content)
        if prior is None:
            previous = {"path": None, "blob_sha": None, "content_sha256": None, "observed_at_utc": observed_at}
        elif prior_tuple != current_tuple:
            previous = prior["current"]
        else:
            previous = prior["previous"]
        state[slug] = {"current": current, "previous": previous}
    return state


def _validate_readme_state(state: dict[str, Any], connection: sqlite3.Connection, parent_seq: int | None) -> dict[str, Any]:
    copied = json.loads(json.dumps(state))
    for slug, entry in copied.items():
        canonical_slug = _slug_value(slug)
        if canonical_slug != slug or not isinstance(entry, dict) or set(entry) != {"current", "previous"}:
            raise ValueError("README state entry is not canonical rolling identity")
        current, previous = _readme_identity(entry["current"], "current"), _readme_identity(entry["previous"], "previous")
    if copied != _reconstruct_readme_state(connection, parent_seq):
        raise ValueError("README state does not exactly match ledger history")
    return copied


def _legacy_logical_rows(path: Path) -> tuple[str, int, str, str | None]:
    """Fingerprint a frozen SQLite source without trusting SQLite page order."""
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA query_only = ON")
        if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",) or connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("legacy baseline SQLite integrity check failed")
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        logical = []
        last_key = None
        for table in tables:
            table_info = connection.execute(
                "SELECT cid, name, pk FROM pragma_table_info(?) ORDER BY cid",
                (table,),
            ).fetchall()
            columns = tuple(row[1] for row in table_info)
            primary = [row[1] for row in sorted(table_info, key=lambda row: row[2]) if row[2]]
            if not columns or not primary:
                raise ValueError("legacy baseline SQLite table must have a primary key")
            quoted_table = '"' + table.replace('"', '""') + '"'
            order_by = ", ".join('"' + column.replace('"', '""') + '"' for column in primary)
            for row in connection.execute(f"SELECT * FROM {quoted_table} ORDER BY {order_by}"):
                logical.append({"table": table, "row": dict(zip(columns, row))})
                last_key = {"table": table, "key": [row[columns.index(column)] for column in primary]}
        schema = _fingerprint_rows(_schema_rows(connection))
    last = None if last_key is None else _canonical_bytes(last_key).decode("utf-8")
    return schema, len(logical), _digest(logical), last


def _legacy_date(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an exact date")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"{label} must be an exact date") from None
    if parsed.strftime("%Y-%m-%d") != value:
        raise ValueError(f"{label} must be an exact date")
    return value


def _validate_legacy_public_payload(payload: Any) -> list[dict[str, Any]]:
    if (
        not isinstance(payload, dict)
        or list(payload) != ["version", "generatedAt", "repositories"]
        or isinstance(payload["version"], bool)
        or not isinstance(payload["version"], int)
        or payload["version"] != 1
        or not isinstance(payload["repositories"], list)
    ):
        raise ValueError("legacy public star history must use the exact version 1 envelope")
    _legacy_date(payload["generatedAt"], "legacy public generatedAt")
    if len(payload["repositories"]) > 75:
        raise ValueError("legacy public repository cardinality exceeds version 1 limit")
    seen_slugs: set[str] = set()
    for repository in payload["repositories"]:
        if not isinstance(repository, dict) or list(repository) != ["slug", "estimated", "observed"]:
            raise ValueError("legacy public repository history is invalid")
        slug = _slug_value(repository["slug"])
        if slug in seen_slugs:
            raise ValueError("legacy public repository slug is duplicate by canonical identity")
        seen_slugs.add(slug)
        for series_name in ("observed", "estimated"):
            series = repository[series_name]
            if not isinstance(series, list):
                raise ValueError("legacy public repository history is invalid")
            maximum = 730 if series_name == "observed" else 500
            if len(series) > maximum:
                raise ValueError(f"legacy public {series_name} cardinality exceeds version 1 limit")
            seen_dates: set[str] = set()
            previous_date = ""
            for point in series:
                if not isinstance(point, dict) or list(point) != ["date", "stars"]:
                    raise ValueError(f"legacy {series_name} point is invalid")
                date = _legacy_date(point["date"], f"legacy {series_name} date")
                stars = point["stars"]
                if (
                    isinstance(stars, bool)
                    or not isinstance(stars, int)
                    or stars < 0
                    or stars > 9_007_199_254_740_991
                ):
                    raise ValueError(f"legacy {series_name} stars is invalid")
                if date in seen_dates or date <= previous_date:
                    raise ValueError(f"legacy {series_name} dates must be ascending unique")
                seen_dates.add(date)
                previous_date = date
    return payload["repositories"]


def _read_legacy_membership_slugs(path: Path) -> list[str]:
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as legacy:
        legacy.execute("PRAGMA query_only = ON")
        if legacy.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='snapshot_members'").fetchone() is None:
            raise ValueError("legacy membership source has no snapshot_members table")
        rows = legacy.execute("SELECT snapshot_id, ordinal, slug FROM snapshot_members ORDER BY snapshot_id, ordinal").fetchall()
    ordinals: dict[int, list[int]] = {}
    slugs: set[str] = set()
    for snapshot_id, ordinal, raw_slug in rows:
        if isinstance(snapshot_id, bool) or not isinstance(snapshot_id, int) or snapshot_id < 1:
            raise ValueError("legacy membership snapshot id is invalid")
        if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 0:
            raise ValueError("legacy membership ordinal is invalid")
        slug = _slug_value(raw_slug)
        ordinals.setdefault(snapshot_id, []).append(ordinal)
        slugs.add(slug)
    if any(values != list(range(len(values))) for values in ordinals.values()):
        raise ValueError("legacy membership ordinals are not contiguous")
    return sorted(slugs)


def _read_legacy_star_rows(path: Path) -> list[tuple[Any, ...]]:
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as legacy:
        legacy.execute("PRAGMA query_only = ON")
        if legacy.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='star_observations'").fetchone() is None:
            raise ValueError("legacy star source has no star_observations table")
        rows = legacy.execute("SELECT id, slug, observed_date, stars_total, stars_delta, source FROM star_observations ORDER BY id").fetchall()
    seen_ids: set[int] = set()
    for row_id, raw_slug, date, stars, delta, source in rows:
        if isinstance(row_id, bool) or not isinstance(row_id, int) or row_id < 1 or row_id in seen_ids:
            raise ValueError("legacy star row id is invalid")
        seen_ids.add(row_id)
        _slug_value(raw_slug)
        _legacy_date(date, "legacy star observation date")
        if isinstance(stars, bool) or not isinstance(stars, int) or stars < 0:
            raise ValueError("legacy star total is invalid")
        if delta is not None and (isinstance(delta, bool) or not isinstance(delta, int)):
            raise ValueError("legacy star delta is invalid")
        if source not in ("legacy_inline", "github_rest"):
            raise ValueError("legacy star source is invalid")
    return rows


def measure_legacy_baseline_receipt(baselines: dict[str, str | Path]) -> dict[str, Any]:
    """Measure the reviewed cutover receipt schema; do not write a candidate.

    The envelope deliberately mirrors ``baseline_sources`` one-to-one:
    ``{"version":1,"sources": {source_name: exact baseline_sources identity fields}}``.
    It is the only receipt shape the recorder accepts, so later workflow code
    can create/review it independently before invoking this writer.
    """
    names = ("legacy_star_observations", "legacy_trending_membership", "legacy_public_star_history")
    if set(baselines) != set(names):
        raise ValueError("legacy baseline receipt requires exactly three frozen sources")
    sources = {}
    for name in names:
        path = Path(baselines[name])
        if path.is_symlink() or not path.is_file():
            raise ValueError("legacy baseline source is missing")
        if name != "legacy_public_star_history":
            for suffix in ("-journal", "-wal", "-shm"):
                if Path(f"{path}{suffix}").exists():
                    raise ValueError("legacy baseline SQLite source has a pending sidecar")
        if name == "legacy_public_star_history":
            payload = _load_json_file(path, "legacy public star history")
            repositories = _validate_legacy_public_payload(payload)
            canonical_public_bytes = (
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
            try:
                public_bytes = path.read_bytes()
            except OSError:
                raise ValueError("legacy public star history bytes are unreadable") from None
            if public_bytes != canonical_public_bytes:
                raise ValueError("legacy public star history must use canonical pretty-2 LF bytes")
            logical = sorted(repositories, key=lambda repository: _slug_value(repository["slug"]))
            schema_fingerprint = _digest(LEGACY_PUBLIC_STAR_HISTORY_SCHEMA)
            count, logical_hash = len(logical), _digest(logical)
            last = None if not logical else _canonical_bytes(_slug_value(logical[-1]["slug"])).decode("utf-8")
        else:
            schema_fingerprint, count, logical_hash, last = _legacy_logical_rows(path)
            if name == "legacy_trending_membership":
                _read_legacy_membership_slugs(path)
            else:
                _read_legacy_star_rows(path)
        sources[name] = {
            "repo_relative_path": LEGACY_BASELINE_PATHS[name], "byte_size": path.stat().st_size,
            "file_sha256": _file_sha256(path), "schema_fingerprint_sha256": schema_fingerprint,
            "logical_row_count": count, "logical_rows_sha256": logical_hash,
            "last_logical_key_json": last,
        }
    return {"version": 1, "sources": sources}


def create_legacy_baseline_receipt(
    baselines: dict[str, str | Path],
    output_path: str | Path,
) -> dict[str, Any]:
    """Create and independently verify one reviewed receipt without overwrite."""
    output = Path(output_path)
    created = False
    try:
        receipt = measure_legacy_baseline_receipt(baselines)
        serialized = (json.dumps(receipt, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        reread = _load_json_file(output, "legacy baseline receipt")
        if reread != receipt or output.read_bytes() != serialized:
            raise ValueError("legacy baseline receipt canonical readback failed")
        if measure_legacy_baseline_receipt(baselines) != receipt:
            raise ValueError("legacy baseline source changed during receipt creation")
        return receipt
    except FileExistsError:
        raise ValueError("legacy baseline receipt output already exists") from None
    except Exception:
        if created:
            output.unlink(missing_ok=True)
        raise ValueError("legacy baseline receipt creation failed") from None


def project_legacy_baselines(baselines: dict[str, Any], receipt: dict[str, Any], seq: int) -> dict[str, list[dict[str, Any]]]:
    """Read and validate frozen legacy sources without writing the candidate."""
    names = ("legacy_star_observations", "legacy_trending_membership", "legacy_public_star_history")
    if set(baselines) != set(names):
        raise ValueError("migration baseline requires exactly three frozen sources")
    paths = {name: Path(baselines[name]) for name in names}
    if not isinstance(receipt, dict) or set(receipt) != {"version", "sources"} or receipt["version"] != 1 or not isinstance(receipt["sources"], dict) or set(receipt["sources"]) != set(names):
        raise ValueError("migration baseline requires reviewed external receipt")
    measured = measure_legacy_baseline_receipt(paths)
    projected = {
        "baseline_sources": [],
        "baseline_membership_slugs": [],
        "historical_star_estimates": [],
        "historical_star_observations": [],
    }
    for name, path in paths.items():
        reviewed = receipt["sources"][name]
        if set(reviewed) != {"repo_relative_path", "byte_size", "file_sha256", "schema_fingerprint_sha256", "logical_row_count", "logical_rows_sha256", "last_logical_key_json"} or reviewed != measured["sources"][name]:
            raise ValueError(f"reviewed legacy receipt mismatch: {name}")
        projected["baseline_sources"].append({"source_name": name, **reviewed, "cutover_snapshot_seq": seq})
    # Historical membership identity is imported without fabricating its old
    # snapshots.  The canonical legacy writer names this table snapshot_members.
    for slug in _read_legacy_membership_slugs(paths["legacy_trending_membership"]):
        projected["baseline_membership_slugs"].append({"slug": slug, "source_name": "legacy_trending_membership", "cutover_snapshot_seq": seq})
    public_payload = _load_json_file(paths["legacy_public_star_history"], "legacy public star history")
    public_repositories = _validate_legacy_public_payload(public_payload)
    public_sha = _file_sha256(paths["legacy_public_star_history"])
    for repository in public_repositories:
        slug = _slug_value(repository["slug"])
        for point in repository["observed"]:
            date, stars = point["date"], point["stars"]
            projected["historical_star_observations"].append({"source": "legacy_public_star_history", "legacy_row_id": None, "slug": slug, "observation_date": date, "stars": stars, "stars_delta": None, "legacy_source": None, "source_row_sha256": _digest({"source": "legacy_public_star_history", "slug": slug, "observation_date": date, "stars": stars}), "first_observed_snapshot_seq": seq})
        for point in repository["estimated"]:
            date, stars = point["date"], point["stars"]
            projected["historical_star_estimates"].append({"source": "legacy_star_history_cache", "slug": slug, "estimate_date": date, "is_present": 1, "stars": stars, "point_sha256": _digest({"slug": slug, "date": date, "is_present": True, "stars": stars}), "source_payload_sha256": public_sha, "first_observed_snapshot_seq": seq})
    for row_id, slug, date, stars, delta, source in _read_legacy_star_rows(paths["legacy_star_observations"]):
        slug = _slug_value(slug)
        projected["historical_star_observations"].append({"source": "legacy_star_observations_db", "legacy_row_id": row_id, "slug": slug, "observation_date": date, "stars": stars, "stars_delta": delta, "legacy_source": source, "source_row_sha256": _digest({"source": "legacy_star_observations_db", "legacy_row_id": row_id, "slug": slug, "observation_date": date, "stars": stars, "stars_delta": delta, "legacy_source": source}), "first_observed_snapshot_seq": seq})
    if measure_legacy_baseline_receipt(paths) != measured:
        raise ValueError("legacy baseline source changed during projection")
    return projected


def _require_unchanged_legacy_projection(connection: sqlite3.Connection, projected: dict[str, list[dict[str, Any]]]) -> None:
    queries = {
        "baseline_sources": "SELECT * FROM baseline_sources ORDER BY source_name",
        "baseline_membership_slugs": "SELECT * FROM baseline_membership_slugs ORDER BY slug",
        "historical_star_estimates": "SELECT * FROM historical_star_estimates WHERE source='legacy_star_history_cache' ORDER BY source,slug,estimate_date,first_observed_snapshot_seq",
        "historical_star_observations": "SELECT * FROM historical_star_observations ORDER BY source,slug,observation_date,source_row_sha256",
    }
    for table, query in queries.items():
        columns = _columns(connection, table)
        actual = [dict(zip(columns, row)) for row in connection.execute(query)]
        keys = _natural_key_columns(table)
        expected = sorted(projected[table], key=lambda row: tuple(row[key] for key in keys))
        if actual != expected:
            raise ValueError(f"refresh frozen baseline logical rows changed: {table}")


def record_core_snapshot(candidate_database_path: str | Path, snapshot_payload: dict[str, Any], event_payload: dict[str, Any], readme_state: dict[str, Any]) -> CoreRecordResult:
    """Append exactly one complete baseline or refresh core snapshot.

    The caller owns external source collection.  This function only admits its
    validated, body-free logical facts and recomputes every stored hash.
    """
    if not isinstance(snapshot_payload, dict) or not isinstance(event_payload, dict) or not isinstance(readme_state, dict):
        raise ValueError("snapshot, events, and README state must be objects")
    repositories = _value(snapshot_payload, "repositories", "repos")
    if not isinstance(repositories, list) or not repositories:
        raise ValueError("snapshot requires repositories")
    index = _value(snapshot_payload, "enrichment_index", "enrichmentIndex")
    _validate_cross_input_bindings(snapshot_payload, event_payload, index, repositories)
    inserted: dict[str, int] = {}
    reused: dict[str, int] = {}
    path = Path(candidate_database_path)
    next_readme_state: dict[str, Any] | None = None
    with closing(_connect_candidate(path)) as connection:
        validate_schema(connection)
        connection.execute("BEGIN IMMEDIATE")
        try:
            latest = connection.execute("SELECT snapshot_seq, snapshot_id, chain_sha256 FROM snapshot_runs ORDER BY snapshot_seq DESC LIMIT 1").fetchone()
            requested_id = _value(snapshot_payload, "snapshot_id", "snapshotId")
            replay = connection.execute("SELECT snapshot_seq, parent_snapshot_seq, parent_snapshot_id, parent_chain_sha256 FROM snapshot_runs WHERE snapshot_id=?", (requested_id,)).fetchone()
            if replay is not None:
                if latest is None or replay[0] != latest[0]:
                    raise ValueError("snapshot replay must be the current latest snapshot")
                verify_core_snapshot(connection, replay[0])
            parent_rows = None if latest is None else {"tables": {table: _table_row_evidence(connection, table) for table in _NATURAL_KEYS}}
            if replay is not None:
                seq = replay[0]
                if replay[1] is None:
                    latest_for_snapshot = None
                    parent = None
                else:
                    latest_for_snapshot = connection.execute("SELECT snapshot_seq, snapshot_id, chain_sha256 FROM snapshot_runs WHERE snapshot_seq=?", (replay[1],)).fetchone()
                    parent = (replay[1], replay[2], replay[3])
                latest = latest_for_snapshot
            else:
                seq = 1 if latest is None else latest[0] + 1
                parent = None if latest is None else (latest[0], latest[1], latest[2])
            state_validation_seq = replay[0] if replay is not None else (None if latest is None else latest[0])
            validated_readme_state = _validate_readme_state(readme_state, connection, state_validation_seq)
            next_readme_state = (
                _reconstruct_readme_state(connection, None if latest is None else latest[0])
                if replay is not None else validated_readme_state
            )
            provisional = _run_identity(snapshot_payload, seq, parent, "0" * 64)
            baselines = _value(snapshot_payload, "legacy_baselines", "legacyBaselines")
            if latest is None:
                if not isinstance(baselines, dict):
                    raise ValueError("missing parent migration_baseline requires frozen legacy baselines")
                legacy_rows = project_legacy_baselines(
                    baselines,
                    _value(snapshot_payload, "legacy_baseline_receipt", "legacyBaselineReceipt"),
                    seq,
                )
            else:
                if not isinstance(baselines, dict):
                    raise ValueError("refresh requires all frozen legacy baselines")
                cutover = connection.execute("SELECT MIN(cutover_snapshot_seq) FROM baseline_sources").fetchone()[0]
                if cutover is None:
                    raise ValueError("refresh parent is missing frozen baseline identities")
                measured_legacy_rows = project_legacy_baselines(
                    baselines,
                    _value(snapshot_payload, "legacy_baseline_receipt", "legacyBaselineReceipt"),
                    cutover,
                )
                _require_unchanged_legacy_projection(connection, measured_legacy_rows)
                legacy_rows = measured_legacy_rows
            profiles: list[dict[str, Any]] = []
            next_profile_id = (connection.execute("SELECT COALESCE(MAX(profile_id), 0) + 1 FROM repository_profiles").fetchone()[0])
            normalized: list[tuple[dict[str, Any], dict[str, Any], tuple[str, str, str, str, str | None, str | None]]] = []
            seen = set()
            for repository in repositories:
                _validate_repository_fact(repository)
                slug = _slug_value(_value(repository, "slug"))
                if slug in seen:
                    raise ValueError("snapshot has duplicate repository slug")
                seen.add(slug)
                profile = _profile_row(repository, seq, next_profile_id)
                existing = connection.execute("SELECT * FROM repository_profiles WHERE slug = ? AND profile_sha256 = ?", (slug, profile["profile_sha256"])).fetchone()
                if existing is not None:
                    profile = dict(zip(_columns(connection, "repository_profiles"), existing))
                    profiles.append(profile)
                else:
                    profiles.append(profile)
                    next_profile_id += 1
                normalized.append((repository, profile, _enrichment_hashes(repository, profile, index)))
            active_slugs = {profile["slug"] for _, profile, _ in normalized}
            heads, estimate_events = _validated_event_maps(event_payload, active_slugs)
            releases_value = event_payload["releases"]
            if not isinstance(releases_value, list) or any(not isinstance(entry, dict) or _slug_value(_value(entry, "slug")) not in active_slugs for entry in releases_value):
                raise ValueError("release inventory contains an inactive repository")
            # The preimage must include existing versions referenced by this
            # refresh; table rows below are complete logical representations.
            core_rows = {
                "snapshot_runs": [{key: value for key, value in provisional.items() if key not in {"core_payload_sha256", "chain_sha256"}}],
                "baseline_sources": legacy_rows["baseline_sources"],
                "baseline_membership_slugs": legacy_rows["baseline_membership_slugs"],
                "repository_profiles": profiles,
                "snapshot_items": [],
                "release_versions": [],
                "snapshot_release_items": [],
                "historical_star_estimates": list(legacy_rows["historical_star_estimates"]),
                "historical_star_observations": legacy_rows["historical_star_observations"],
                "commit_events": [],
                "readme_change_events": [],
            }
            previous_slugs = set() if latest is None else {row[0] for row in connection.execute("SELECT slug FROM snapshot_items WHERE snapshot_seq = ?", (latest[0],))}
            historical = {row[0] for row in connection.execute("SELECT slug FROM baseline_membership_slugs")} | {row[0] for row in connection.execute("SELECT DISTINCT slug FROM snapshot_items")}
            previous_heads: dict[str, tuple[str, str]] = {}
            if latest is not None:
                for row in connection.execute(
                    "SELECT i.slug, p.default_branch, i.default_branch_head_sha FROM snapshot_items i JOIN repository_profiles p ON p.profile_id=i.profile_id AND p.slug=i.slug WHERE i.snapshot_seq <= ? ORDER BY i.snapshot_seq",
                    (latest[0],),
                ):
                    previous_heads[row[0]] = (row[1], row[2])
            for repository, profile, hashes in normalized:
                slug = profile["slug"]
                head = heads.get(slug)
                if head is None:
                    raise ValueError(f"event heads missing {slug}")
                if head["branch"] != profile["default_branch"]:
                    raise ValueError("head branch does not match repository profile")
                if _value(repository, "default_branch_head_sha", "defaultBranchHeadSha") != _value(head, "head_sha", "headSha"):
                    raise ValueError("repository HEAD does not match event head")
                releases, release_items, latest_release = _release_rows(event_payload, slug, seq)
                for release in releases:
                    existing_release = connection.execute(
                        "SELECT first_observed_snapshot_seq FROM release_versions WHERE slug=? AND release_id=? AND metadata_sha256=?",
                        (release["slug"], release["release_id"], release["metadata_sha256"]),
                    ).fetchone()
                    if existing_release is not None:
                        # A→B→A must point to the original immutable version.
                        release["first_observed_snapshot_seq"] = existing_release[0]
                readme_path = _value(repository, "readme_path", "readmePath")
                readme_blob = _value(repository, "readme_blob_sha", "readmeBlobSha")
                readme_content = _value(repository, "readme_content_sha256", "readmeContentSha256")
                if latest is None: membership = "baseline_present"
                elif slug in previous_slugs: membership = "stayed"
                else: membership = "reentered" if slug in historical else "new"
                inventory = [{"release_id": row["release_id"], "metadata_sha256": row["metadata_sha256"]} for row in release_items]
                estimate = estimate_events.get(slug)
                if estimate is None:
                    raise ValueError(f"OSS estimate receipt missing {slug}")
                estimate_rows = _value(estimate, "rows", default=[])
                if not isinstance(estimate_rows, list):
                    raise ValueError("OSS estimate rows are invalid")
                estimate_payload = _value(estimate, "source_payload_sha256", "sourcePayloadSha256")
                colors = _repository_fact_colors(repository)
                previous_head = None if slug not in previous_heads else previous_heads[slug][1]
                stated_previous_head = _value(
                    repository,
                    "previous_default_branch_head_sha",
                    "previousDefaultBranchHeadSha",
                    default=previous_head,
                )
                if stated_previous_head != previous_head:
                    raise ValueError("previous default branch head does not match last observed head")
                item = {
                    "snapshot_seq": seq, "slug": slug, "profile_id": profile["profile_id"], "display_rank": _value(repository, "display_rank", "displayRank"),
                    "rank_daily": _value(repository, "rank_daily", "rankDaily"), "rank_weekly": _value(repository, "rank_weekly", "rankWeekly"), "rank_monthly": _value(repository, "rank_monthly", "rankMonthly"),
                    "gain_daily": _value(repository, "gain_daily", "gainDaily"), "gain_weekly": _value(repository, "gain_weekly", "gainWeekly"), "gain_monthly": _value(repository, "gain_monthly", "gainMonthly"),
                    "language_color_daily": colors[0], "language_color_weekly": colors[1], "language_color_monthly": colors[2],
                    "selected_language_color": colors[3], "selected_language_color_source_period": colors[4],
                    "stars": _value(repository, "stars"), "forks": _value(repository, "forks"), "watchers_count": _value(repository, "watchers_count", "watchersCount"), "subscribers": _value(repository, "subscribers"), "open_issues_and_pull_requests": _value(repository, "open_issues_and_pull_requests", "openIssuesAndPullRequests"), "contributors": _value(repository, "contributors"),
                    "updated_at": _canonical_repository_utc(_value(repository, "updated_at", "updatedAt")), "pushed_at": _canonical_repository_utc(_value(repository, "pushed_at", "pushedAt"), nullable=True), "default_branch_head_sha": _value(head, "head_sha", "headSha"), "previous_default_branch_head_sha": stated_previous_head, "head_transition": _value(head, "transition"),
                    "readme_status": "absent" if readme_path is None else "present", "readme_path": readme_path, "readme_blob_sha": readme_blob, "readme_content_sha256": readme_content, "membership_status": membership,
                    "release_count": len(inventory), "release_inventory_sha256": _digest(inventory), "latest_release_id": latest_release,
                    "estimate_collection_status": "complete_empty" if not estimate_rows else "complete_nonempty", "estimate_source_payload_sha256": estimate_payload, "estimate_point_count": len(estimate_rows),
                    "summary_source_sha256": hashes[0], "summary_content_sha256": hashes[1], "summary_envelope_sha256": hashes[2], "translation_status": hashes[3], "translation_source_sha256": hashes[4], "translation_envelope_sha256": hashes[5],
                }
                prior_entry = next_readme_state.get(slug)
                prior_current = None if prior_entry is None else prior_entry["current"]
                previous_tuple = (None, None, None) if prior_current is None else (
                    prior_current["path"], prior_current["blob_sha"], prior_current["content_sha256"]
                )
                current_tuple = (readme_path, readme_blob, readme_content)
                if latest is None:
                    kind = "baseline"
                elif previous_tuple == current_tuple:
                    kind = None
                elif previous_tuple == (None, None, None):
                    kind = "added"
                elif current_tuple == (None, None, None):
                    kind = "removed"
                else:
                    kind = "changed"
                core_rows["snapshot_items"].append(item); core_rows["release_versions"].extend(releases); core_rows["snapshot_release_items"].extend(release_items)
                if kind is not None:
                    core_rows["readme_change_events"].append({"snapshot_seq": seq, "slug": slug, "old_path": previous_tuple[0], "new_path": current_tuple[0], "old_blob_sha": previous_tuple[1], "new_blob_sha": current_tuple[1], "old_content_sha256": previous_tuple[2], "new_content_sha256": current_tuple[2], "change_kind": kind})
                observed_at = _value(snapshot_payload, "observed_at_utc", "observedAtUtc", "generated_at", "generatedAt")
                if prior_entry is None:
                    previous_state = {"path": None, "blob_sha": None, "content_sha256": None, "observed_at_utc": observed_at}
                elif previous_tuple != current_tuple:
                    previous_state = prior_entry["current"]
                else:
                    previous_state = prior_entry["previous"]
                next_readme_state[slug] = {
                    "current": {"path": readme_path, "blob_sha": readme_blob, "content_sha256": readme_content, "observed_at_utc": observed_at},
                    "previous": previous_state,
                }
            # Commit records are prospective: collector provided no historical
            # backfill for baseline/branch/rewrite transitions.
            core_rows["commit_events"].extend(
                _project_commit_rows(connection, event_payload, seq, active_slugs, heads, previous_heads)
            )
            for estimate in event_payload["estimates"]:
                slug = _slug_value(_value(estimate, "slug")); payload_sha = _value(estimate, "source_payload_sha256", "sourcePayloadSha256")
                current = {row["date"]: row["stars"] for row in _value(estimate, "rows", default=[])}
                prior = {date: (present, stars) for date, present, stars in connection.execute("SELECT estimate_date, is_present, stars FROM historical_star_estimates WHERE source='ossinsight_api' AND slug=? AND first_observed_snapshot_seq < ? ORDER BY first_observed_snapshot_seq", (slug, seq))}
                for date in sorted(set(current) | {date for date, (present, _) in prior.items() if present}):
                    present, stars = (1, current[date]) if date in current else (0, None)
                    if prior.get(date) != (present, stars):
                        core_rows["historical_star_estimates"].append({"source": "ossinsight_api", "slug": slug, "estimate_date": date, "is_present": present, "stars": stars, "point_sha256": _digest({"slug": slug, "date": date, "is_present": bool(present), "stars": stars}), "source_payload_sha256": payload_sha, "first_observed_snapshot_seq": seq})
            core = _digest(_core_preimage(connection, core_rows))
            requested_id = _value(snapshot_payload, "snapshot_id", "snapshotId")
            prior_same_id = connection.execute("SELECT snapshot_seq, core_payload_sha256 FROM snapshot_runs WHERE snapshot_id=?", (requested_id,)).fetchone()
            if prior_same_id is not None:
                if prior_same_id[1] != core:
                    raise ValueError("existing snapshot id has conflicting core payload")
                connection.rollback()
                return CoreRecordResult(inserted, {"snapshot_runs": 1}, core, prior_same_id[0])
            run = _run_identity(snapshot_payload, seq, parent, core)
            run["chain_sha256"] = _digest({"schema_fingerprint_sha256": schema_fingerprint(connection), "parent_chain_sha256": run["parent_chain_sha256"], "core_payload_sha256": core, "snapshot_id": run["snapshot_id"], "snapshot_seq": seq})
            _insert_row(connection, "snapshot_runs", run, inserted, reused)
            for table in ("baseline_sources", "baseline_membership_slugs", "repository_profiles", "snapshot_items", "release_versions", "snapshot_release_items", "historical_star_estimates", "historical_star_observations", "commit_events", "readme_change_events"):
                for row in core_rows[table]: _insert_row(connection, table, row, inserted, reused)
            verify_core_snapshot(connection, seq)
            validate_schema(connection)
            if parent_rows is not None:
                _assert_parent_rows_preserved(connection, parent_rows)
            if measure_legacy_baseline_receipt(baselines) != _value(
                snapshot_payload, "legacy_baseline_receipt", "legacyBaselineReceipt"
            ):
                raise ValueError("legacy baseline source changed before commit")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    readme_state.clear()
    readme_state.update(next_readme_state or {})
    return CoreRecordResult(inserted, reused, core, seq)


def _load_json_file(path: str | Path, label: str) -> Any:
    def reject_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("non-JSON numeric constant")

    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            return json.load(
                handle,
                object_pairs_hook=reject_duplicate_keys,
                parse_constant=reject_constant,
            )
    except (OSError, json.JSONDecodeError, ValueError):
        raise ValueError(f"{label} must be readable strict JSON") from None


def _validate_cli_paths(args: argparse.Namespace) -> None:
    names = (
        "parent_database", "candidate_database", "snapshot", "events",
        "enrichment_index", "parent_evidence", "legacy_star_database",
        "legacy_membership_database", "legacy_public_star_history", "readme_state",
    )
    paths = {name: Path(getattr(args, name)).resolve(strict=False) for name in names}
    tracked_state = Path(__file__).resolve().parents[1] / "data" / "readme-state.json"
    if paths["readme_state"] == tracked_state.resolve(strict=False) or (
        paths["readme_state"].exists() and tracked_state.exists()
        and os.path.samefile(paths["readme_state"], tracked_state)
    ):
        raise ValueError("CLI may not write the tracked readme state")
    seen: dict[Path, str] = {}
    for name, path in paths.items():
        if path in seen:
            raise ValueError("CLI paths must not alias")
        if path.exists() and any(other.exists() and os.path.samefile(path, other) for other in seen):
            raise ValueError("CLI paths must not alias")
        seen[path] = name
    if paths["candidate_database"].parent != paths["readme_state"].parent:
        raise ValueError("candidate database and README state must share one candidate directory")


def _write_state_atomically(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            json.dump(state, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_candidate_database(path: Path) -> None:
    for target in (path, *(Path(f"{path}{suffix}") for suffix in ("-journal", "-wal", "-shm"))):
        target.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    actual_argv = list(sys.argv[1:] if argv is None else argv)
    if actual_argv[:1] == ["create-baseline-receipt"]:
        baseline_parser = argparse.ArgumentParser(description="Create one verified immutable legacy baseline receipt")
        baseline_parser.add_argument("--legacy-star-database", required=True)
        baseline_parser.add_argument("--legacy-membership-database", required=True)
        baseline_parser.add_argument("--legacy-public-star-history", required=True)
        baseline_parser.add_argument("--output", required=True)
        baseline_args = baseline_parser.parse_args(actual_argv[1:])
        create_legacy_baseline_receipt(
            {
                "legacy_star_observations": baseline_args.legacy_star_database,
                "legacy_trending_membership": baseline_args.legacy_membership_database,
                "legacy_public_star_history": baseline_args.legacy_public_star_history,
            },
            baseline_args.output,
        )
        print(json.dumps({"created": True, "version": 1}, separators=(",", ":")))
        return 0
    parser = argparse.ArgumentParser(description="Append one exact repository-observation candidate snapshot")
    parser.add_argument("--parent-database", required=True)
    parser.add_argument("--candidate-database", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--events", required=True)
    parser.add_argument("--enrichment-index", required=True)
    parser.add_argument("--parent-evidence", required=True)
    parser.add_argument("--legacy-star-database", required=True)
    parser.add_argument("--legacy-membership-database", required=True)
    parser.add_argument("--legacy-public-star-history", required=True)
    parser.add_argument("--readme-state", required=True)
    args = parser.parse_args(actual_argv)
    _validate_cli_paths(args)
    snapshot = _load_json_file(args.snapshot, "snapshot")
    events = _load_json_file(args.events, "events")
    index = _load_json_file(args.enrichment_index, "enrichment index")
    evidence_envelope = _load_json_file(args.parent_evidence, "parent evidence")
    evidence, legacy_receipt, historical_heads, production_source_sha = _parse_parent_evidence_envelope(evidence_envelope)
    captured_parent = _capture_parent_database(args.parent_database)
    _require_historical_head_evidence(captured_parent, historical_heads)
    state_path = Path(args.readme_state)
    state = _load_json_file(state_path, "README state") if state_path.exists() else {}
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot must be an object")
    hydration_source_sha = _exclusive_value(snapshot, "hydration_source_sha", "hydrationSourceSha", label="hydration source SHA")
    if hydration_source_sha != production_source_sha:
        raise ValueError("snapshot hydration source does not match parent evidence")
    snapshot["enrichment_index"] = index
    if "legacy_baseline_receipt" in snapshot or "legacyBaselineReceipt" in snapshot:
        raise ValueError("snapshot must not duplicate the reviewed legacy baseline receipt")
    snapshot["legacy_baseline_receipt"] = legacy_receipt
    legacy = {"legacy_star_observations": args.legacy_star_database, "legacy_trending_membership": args.legacy_membership_database, "legacy_public_star_history": args.legacy_public_star_history}
    snapshot["legacy_baselines"] = legacy
    candidate = _prepare_candidate_database_from_capture(args.parent_database, args.candidate_database, evidence, captured_parent)
    try:
        result = record_core_snapshot(candidate, snapshot, events, state)
        try:
            _write_state_atomically(state_path, state)
        except Exception as error:
            raise ValueError("README state candidate write failed") from error
    except Exception:
        _remove_candidate_database(candidate)
        raise
    print(json.dumps({"snapshot_seq": result.snapshot_seq, "core_payload_sha256": result.core_payload_sha256, "inserted": result.inserted, "reused": result.reused}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
