"""Canonical v1 SQLite ledger schema for repository observations.

Task 1 deliberately contains schema creation and verification only.  The
candidate writer and transaction-wide semantic validators are introduced by
later Plan 2 tasks; this module must not silently create or rewrite rows.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path


SCHEMA_VERSION = 1
CREATION_POLICY = "append_only"
EMPTY_RELEASE_INVENTORY_SHA256 = hashlib.sha256(b"[]").hexdigest()

_SHA1 = "length({0}) = 40 AND {0} = lower({0}) AND {0} NOT GLOB '*[^0-9a-f]*'"
_SHA256 = "length({0}) = 64 AND {0} = lower({0}) AND {0} NOT GLOB '*[^0-9a-f]*'"
_SLUG = "instr({0}, '/') > 1 AND instr(substr({0}, instr({0}, '/') + 1), '/') = 0 AND substr({0}, instr({0}, '/') + 1) <> '' AND {0} NOT GLOB '*[^a-z0-9_.-/]*' AND {0} = lower({0})"
_DISPLAY_SLUG = "instr({0}, '/') > 1 AND instr(substr({0}, instr({0}, '/') + 1), '/') = 0 AND substr({0}, instr({0}, '/') + 1) <> '' AND {0} NOT GLOB '*[^A-Za-z0-9_.-/]*'"
_COLOR = "{0} GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'"
_UTC = "{0} GLOB '????-??-??T??:??:??.???Z'"
_KST = "{0} GLOB '????-??-??T??:??:??.???+09:00'"
_DATE = "{0} GLOB '????-??-??'"
FIELD_TAGS = ("ai-ml", "web-app", "dev-tools", "data", "devops", "security", "productivity", "systems", "learning")
FORM_TAGS = ("agent", "mcp", "plugin-skill", "ide", "library", "framework", "cli")
PAGES_BASE_ARTIFACT_PATHS = (
    "changes.xml", "current-view-export.js", "data/latest.json", "data/membership-status.json",
    "favorite-sync.js", "favorites.js", "feed.xml", "firebase-client.js", "firebase-config.json",
    "hidden-repos.js", "index.html", "membership-history.js", "readme-markdown.js",
    "refresh-schedule.js", "repo-filters.js", "star-history.js", "star-history.json", "ui-motion.js",
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
    runs = connection.execute(
        "SELECT snapshot_seq, snapshot_id, observed_at_utc, observed_at_kst, stats_date_kst, parent_snapshot_seq, parent_snapshot_id FROM snapshot_runs ORDER BY snapshot_seq"
    ).fetchall()
    for seq, snapshot_id, utc, kst, stats_date, parent_seq, parent_id in runs:
        utc_value = _parse_utc(utc)
        kst_value = _parse_kst(kst)
        if utc_value.astimezone(kst_value.tzinfo) != kst_value or kst_value.date().isoformat() != stats_date:
            raise ValueError("snapshot UTC, KST, and stats date must name one instant")
        if seq > 1 and parent_seq is not None and parent_seq != seq - 1:
            raise ValueError("refresh snapshot sequence must immediately follow its parent")
        if parent_seq is not None:
            parent = connection.execute("SELECT snapshot_id FROM snapshot_runs WHERE snapshot_seq = ?", (parent_seq,)).fetchone()
            if parent != (parent_id,):
                raise ValueError("snapshot parent identity is invalid")

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
    artifacts_by_snapshot = {}
    for row in connection.execute("SELECT snapshot_seq, artifact_path FROM artifact_hashes"):
        artifacts_by_snapshot.setdefault(row[0], set()).add(row[1])
    for item in item_rows:
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
        if item["translation_status"] == "applicable" and f"translations/{item['slug'].replace('/', '--')}.json" not in artifacts_by_snapshot.get(item["snapshot_seq"], set()):
            raise ValueError("applicable translation is absent from artifacts")

    for slug, commit_sha, parents in connection.execute("SELECT slug, commit_sha, parent_shas_json FROM commit_events"):
        parsed = _canonical_string_array(parents, "parent_shas_json")
        if any(not re.fullmatch(r"[0-9a-f]{40}", parent) for parent in parsed):
            raise ValueError(f"commit {slug}/{commit_sha} has invalid parent SHA")

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
        actual = (prior[4] - current[4], prior[0] - current[0])
        if gap != actual_gap or stars_delta != -actual[0] or display_delta != actual[1]:
            raise ValueError("insight gap or primary deltas are invalid")

    for snapshot_seq, paths in artifacts_by_snapshot.items():
        expected = set(PAGES_BASE_ARTIFACT_PATHS) | {
            f"translations/{item['slug'].replace('/', '--')}.json"
            for item in item_rows if item["snapshot_seq"] == snapshot_seq and item["translation_status"] == "applicable"
        }
        if paths != expected:
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
