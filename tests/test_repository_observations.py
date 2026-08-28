import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from scripts.record_repository_observations import (
    EMPTY_RELEASE_INVENTORY_SHA256,
    PAGES_BASE_ARTIFACT_PATHS,
    SCHEMA_VERSION,
    create_database,
    parent_database_evidence,
    measure_legacy_baseline_receipt,
    prepare_candidate_database,
    record_core_snapshot,
    verify_core_snapshot,
    schema_fingerprint,
    validate_schema,
)
from scripts.record_repository_observations import _validate_populated_rows
import scripts.record_repository_observations as ledger


EXPECTED_TABLES = {
    "schema_meta",
    "baseline_sources",
    "baseline_membership_slugs",
    "snapshot_runs",
    "repository_profiles",
    "snapshot_items",
    "release_versions",
    "snapshot_release_items",
    "historical_star_estimates",
    "historical_star_observations",
    "commit_events",
    "readme_change_events",
    "repository_insights",
    "artifact_hashes",
}
PINNED_SCHEMA_FINGERPRINT = "eeca4901db9b5f0940cf3379baa59397c589a8d6bac4f415b2b0ad728f91767d"


def sha256(value="a"):
    return value * 64


def sha1(value="a"):
    return value * 40


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def baseline_run(connection, *, snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00"):
    core = sha256("b")
    chain = canonical_hash({"schema_fingerprint_sha256": PINNED_SCHEMA_FINGERPRINT, "parent_chain_sha256": None, "core_payload_sha256": core, "snapshot_id": snapshot_id, "snapshot_seq": 1})
    connection.execute(
        """INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (1, snapshot_id, "migration_baseline", utc, kst, "2026-08-28", None, None,
         sha1(), sha256(), core, None, chain, 1),
    )


def profile(connection, *, profile_id=1, slug="owner/repo", display_slug="owner/repo", topics="[]", fields='["unclassified"]', forms="[]"):
    digest = hashlib.sha256(json.dumps({
        "slug": slug, "display_slug": display_slug, "description": None,
        "primary_language": None, "topics": json.loads(topics), "license_spdx": None,
        "archived": False, "is_fork": False, "default_branch": "main",
        "created_at": "2026-08-28T01:01:01.001Z", "field_tags": json.loads(fields),
        "form_tags": json.loads(forms), "tag_rule_version": 1,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    connection.execute(
        """INSERT INTO repository_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (profile_id, slug, display_slug, 1, None, None, topics, None, 0, 0, "main",
         "2026-08-28T01:01:01.001Z", fields, forms, 1, digest),
    )


def refresh_run(connection, *, seq, snapshot_id, parent_seq, parent_id, parent_chain, utc):
    core = sha256(chr(97 + seq))
    chain = canonical_hash({"schema_fingerprint_sha256": PINNED_SCHEMA_FINGERPRINT, "parent_chain_sha256": parent_chain, "core_payload_sha256": core, "snapshot_id": snapshot_id, "snapshot_seq": seq})
    kst = f"2026-08-28T10:01:01.{seq:03d}+09:00"
    connection.execute("INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (seq, snapshot_id, "refresh", utc, kst, "2026-08-28", parent_seq, parent_id, sha1(chr(97 + seq)), sha256(chr(97 + seq)), core, parent_chain, chain, 1))
    return chain


def copy_item(connection, snapshot_seq, slug="owner/repo", **changes):
    columns = [row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")]
    source = dict(zip(columns, connection.execute("SELECT * FROM snapshot_items WHERE snapshot_seq = 1 AND slug = ?", (slug,)).fetchone()))
    source["snapshot_seq"] = snapshot_seq
    source.update(changes)
    connection.execute(f"INSERT INTO snapshot_items VALUES ({','.join('?' for _ in columns)})", [source[name] for name in columns])


def complete_fixture(connection, *, display_slug="owner/repo", applicable=False):
    baseline_run(connection)
    profile(connection, display_slug=display_slug)
    readme_path, readme_blob, readme_content = ("README.md", sha1("b"), sha256("c")) if applicable else (None, None, None)
    translation_status = "applicable" if applicable else "not_applicable:no_readme"
    translation_source, translation_envelope = (sha256("d"), sha256("e")) if applicable else (None, None)
    connection.execute(
        """INSERT INTO snapshot_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (1, "owner/repo", 1, 1, 1, None, None, 0, None, None, "#112233", None, None,
         "#112233", "daily", 1, 0, 0, 0, 0, 0, "2026-08-28T01:01:01.001Z", None,
         sha1(), None, "baseline", "present" if applicable else "absent", readme_path, readme_blob, readme_content, "baseline_present", 0,
         EMPTY_RELEASE_INVENTORY_SHA256, None, "complete_empty", sha256("e"), 0, sha256("f"),
         sha256("a"), sha256("b"), translation_status, translation_source, translation_envelope),
    )
    connection.execute(
        "INSERT INTO historical_star_estimates VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("legacy_star_history_cache", "owner/repo", "2026-08-28", 1, 1, canonical_hash({"slug": "owner/repo", "date": "2026-08-28", "is_present": True, "stars": 1}), sha256("d"), 1),
    )
    connection.execute(
        "INSERT INTO historical_star_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("legacy_public_star_history", None, "owner/repo", "2026-08-28", 1, None, None, canonical_hash({"source": "legacy_public_star_history", "slug": "owner/repo", "observation_date": "2026-08-28", "stars": 1}), 1),
    )
    connection.execute(
        "INSERT INTO commit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("owner/repo", sha1(), 1, 0, "main", "2026-08-28T01:01:01.001Z", "2026-08-28T01:01:01.001Z", None, "[]", "https://github.com/owner/repo/commit/" + sha1()),
    )
    connection.execute(
        "INSERT INTO readme_change_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (1, "owner/repo", None, readme_path, None, readme_blob, None, readme_content, "baseline"),
    )
    connection.execute(
        "INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (1, "owner/repo", None, None, None, None, None, None, None, "repository-insight-v1", canonical_hash({"snapshot_seq": 1, "slug": "owner/repo", "previous_observed_snapshot_seq": None, "observation_gap_milliseconds": None, "stars_delta_since_previous_observation": None, "display_rank_delta": None, "rank_daily_delta": None, "rank_weekly_delta": None, "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1"})),
    )
    for artifact_path in PAGES_BASE_ARTIFACT_PATHS:
        connection.execute("INSERT INTO artifact_hashes VALUES (?, ?, ?, ?)", (1, artifact_path, sha256("a"), 1))
    if applicable:
        connection.execute("INSERT INTO artifact_hashes VALUES (?, ?, ?, ?)", (1, f"translations/{display_slug.replace('/', '__')}.json", sha256("b"), 1))


def recompute_snapshot_chain(connection, snapshot_seq):
    snapshot_id, parent_chain, core = connection.execute(
        "SELECT snapshot_id, parent_chain_sha256, core_payload_sha256 FROM snapshot_runs WHERE snapshot_seq = ?",
        (snapshot_seq,),
    ).fetchone()
    connection.execute(
        "UPDATE snapshot_runs SET chain_sha256 = ? WHERE snapshot_seq = ?",
        (canonical_hash({
            "schema_fingerprint_sha256": PINNED_SCHEMA_FINGERPRINT,
            "parent_chain_sha256": parent_chain,
            "core_payload_sha256": core,
            "snapshot_id": snapshot_id,
            "snapshot_seq": snapshot_seq,
        }), snapshot_seq),
    )


def recompute_profile_hash(connection, profile_id=1):
    row = connection.execute(
        """SELECT slug, display_slug, description, primary_language, topics_json, license_spdx,
                  archived, is_fork, default_branch, created_at, field_tags_json, form_tags_json,
                  tag_rule_version
           FROM repository_profiles WHERE profile_id = ?""",
        (profile_id,),
    ).fetchone()
    slug, display_slug, description, language, topics, license_spdx, archived, is_fork, branch, created, fields, forms, version = row
    connection.execute(
        "UPDATE repository_profiles SET profile_sha256 = ? WHERE profile_id = ?",
        (canonical_hash({
            "slug": slug,
            "display_slug": display_slug,
            "description": description,
            "primary_language": language,
            "topics": json.loads(topics),
            "license_spdx": license_spdx,
            "archived": bool(archived),
            "is_fork": bool(is_fork),
            "default_branch": branch,
            "created_at": created,
            "field_tags": json.loads(fields),
            "form_tags": json.loads(forms),
            "tag_rule_version": version,
        }), profile_id),
    )


def recompute_release_hash(connection, release_id):
    row = connection.execute(
        """SELECT slug, release_id, tag_name, name, target_commitish, draft, prerelease,
                  created_at, published_at, html_url
           FROM release_versions WHERE release_id = ?""",
        (release_id,),
    ).fetchone()
    slug, identifier, tag, name, target, draft, prerelease, created, published, url = row
    connection.execute(
        "UPDATE release_versions SET metadata_sha256 = ? WHERE release_id = ?",
        (canonical_hash({
            "slug": slug,
            "release_id": identifier,
            "tag_name": tag,
            "name": name,
            "target_commitish": target,
            "draft": bool(draft),
            "prerelease": bool(prerelease),
            "created_at": created,
            "published_at": published,
            "html_url": url,
        }), release_id),
    )


def recompute_estimate_hash(connection):
    source, slug, date, present, stars = connection.execute(
        "SELECT source, slug, estimate_date, is_present, stars FROM historical_star_estimates"
    ).fetchone()
    connection.execute(
        "UPDATE historical_star_estimates SET point_sha256 = ?",
        (canonical_hash({"slug": slug, "date": date, "is_present": bool(present), "stars": stars}),),
    )


def recompute_legacy_observation_hash(connection):
    source, row_id, slug, date, stars, delta, legacy = connection.execute(
        """SELECT source, legacy_row_id, slug, observation_date, stars, stars_delta,
                  legacy_source FROM historical_star_observations"""
    ).fetchone()
    value = ({"source": source, "slug": slug, "observation_date": date, "stars": stars}
             if source == "legacy_public_star_history" else
             {"source": source, "legacy_row_id": row_id, "slug": slug,
              "observation_date": date, "stars": stars, "stars_delta": delta,
              "legacy_source": legacy})
    connection.execute(
        "UPDATE historical_star_observations SET source_row_sha256 = ?",
        (canonical_hash(value),),
    )


def recompute_insight_hash(connection, snapshot_seq):
    columns = (
        "snapshot_seq", "slug", "previous_observed_snapshot_seq",
        "observation_gap_milliseconds", "stars_delta_since_previous_observation",
        "display_rank_delta", "rank_daily_delta", "rank_weekly_delta",
        "rank_monthly_delta", "insight_rule_version",
    )
    row = connection.execute(
        f"SELECT {', '.join(columns)} FROM repository_insights WHERE snapshot_seq = ?",
        (snapshot_seq,),
    ).fetchone()
    connection.execute(
        "UPDATE repository_insights SET insight_sha256 = ? WHERE snapshot_seq = ?",
        (canonical_hash(dict(zip(columns, row))), snapshot_seq),
    )


def three_snapshot_fixture(connection):
    complete_fixture(connection)
    connection.execute("DROP TRIGGER snapshot_items_reject_update")
    connection.execute(
        "UPDATE snapshot_items SET rank_weekly = 1, gain_weekly = 0, rank_monthly = 1, gain_monthly = 0"
    )
    first_id, first_chain = connection.execute(
        "SELECT snapshot_id, chain_sha256 FROM snapshot_runs WHERE snapshot_seq = 1"
    ).fetchone()
    second_id = "20260828010102-bbbbbbbbbbbbbbbb"
    second_chain = refresh_run(
        connection, seq=2, snapshot_id=second_id, parent_seq=1, parent_id=first_id,
        parent_chain=first_chain, utc="2026-08-28T01:01:01.002Z",
    )
    refresh_run(
        connection, seq=3, snapshot_id="20260828010103-cccccccccccccccc", parent_seq=2,
        parent_id=second_id, parent_chain=second_chain, utc="2026-08-28T01:01:01.003Z",
    )
    copy_item(
        connection, 2, stars=3, display_rank=1, rank_daily=1, gain_daily=0,
        rank_weekly=1, gain_weekly=0, rank_monthly=1, gain_monthly=0,
        updated_at="2026-08-28T01:01:01.002Z",
    )
    copy_item(
        connection, 3, stars=7, display_rank=1, rank_daily=1, gain_daily=0,
        rank_weekly=1, gain_weekly=0, rank_monthly=1, gain_monthly=0,
        updated_at="2026-08-28T01:01:01.003Z",
    )
    for snapshot_seq, previous in ((2, 1), (3, 2)):
        current = connection.execute(
            "SELECT display_rank, rank_daily, rank_weekly, rank_monthly, stars FROM snapshot_items WHERE snapshot_seq = ? AND slug = 'owner/repo'",
            (snapshot_seq,),
        ).fetchone()
        prior = connection.execute(
            "SELECT display_rank, rank_daily, rank_weekly, rank_monthly, stars FROM snapshot_items WHERE snapshot_seq = ? AND slug = 'owner/repo'",
            (previous,),
        ).fetchone()
        current_utc = connection.execute(
            "SELECT observed_at_utc FROM snapshot_runs WHERE snapshot_seq = ?", (snapshot_seq,)
        ).fetchone()[0]
        prior_utc = connection.execute(
            "SELECT observed_at_utc FROM snapshot_runs WHERE snapshot_seq = ?", (previous,)
        ).fetchone()[0]
        gap = int((datetime.strptime(current_utc, "%Y-%m-%dT%H:%M:%S.%fZ") - datetime.strptime(prior_utc, "%Y-%m-%dT%H:%M:%S.%fZ")).total_seconds() * 1000)
        insight = {
            "snapshot_seq": snapshot_seq,
            "slug": "owner/repo",
            "previous_observed_snapshot_seq": previous,
            "observation_gap_milliseconds": gap,
            "stars_delta_since_previous_observation": current[4] - prior[4],
            "display_rank_delta": prior[0] - current[0],
            "rank_daily_delta": prior[1] - current[1] if prior[1] is not None and current[1] is not None else None,
            "rank_weekly_delta": prior[2] - current[2] if prior[2] is not None and current[2] is not None else None,
            "rank_monthly_delta": prior[3] - current[3] if prior[3] is not None and current[3] is not None else None,
            "insight_rule_version": "repository-insight-v1",
        }
        connection.execute(
            "INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*insight.values(), canonical_hash(insight)),
        )


def calendar_fixture(connection):
    complete_fixture(connection)
    connection.execute("DROP TRIGGER snapshot_items_reject_update")
    connection.execute(
        "UPDATE snapshot_items SET pushed_at = '2026-08-28T01:01:01.001Z'"
    )
    release = {
        "slug": "owner/repo", "release_id": 9, "tag_name": "v9", "name": "Calendar release",
        "target_commitish": "main", "draft": False, "prerelease": False,
        "created_at": "2026-08-28T01:01:01.001Z", "published_at": "2026-08-28T01:01:01.002Z",
        "html_url": "https://github.com/owner/repo/releases/tag/v9",
    }
    connection.execute(
        "INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (release["slug"], release["release_id"], canonical_hash(release), 1,
         release["tag_name"], release["name"], release["target_commitish"], 0, 0,
         release["created_at"], release["published_at"], release["html_url"]),
    )


def writer_payload(*, snapshot_id, utc, kst, stats_date, run_kind, parent_snapshot_id=None):
    profile_value = {
        "slug": "owner/repo", "display_slug": "owner/repo", "description": None,
        "primary_language": None, "topics": [], "license_spdx": None, "archived": False,
        "is_fork": False, "default_branch": "main", "created_at": utc,
        "field_tags": ["unclassified"], "form_tags": [], "tag_rule_version": 1,
    }
    profile_digest = canonical_hash(profile_value)
    source = {"kind": "metadata_only", "slug": "owner/repo", "profile_sha256": profile_digest,
              "model": "test-model", "schema_version": 2, "translation_applicable": False}
    return {
        "snapshotId": snapshot_id, "observedAtUtc": utc, "observedAtKst": kst,
        "statsDate": stats_date, "runKind": run_kind, "parentSnapshotId": parent_snapshot_id,
        "inputSourceSha": sha1(), "inputManifestSha256": sha256(),
        "enrichmentIndex": {"owner/repo": {"summary": {
            "content": {"goal": "g", "usage": "u", "pros": "p", "cons": "c", "fit": "f"},
            "source": source,
        }}},
        "repositories": [{
            "slug": "owner/repo", "displaySlug": "owner/repo", "topics": [],
            "fieldTags": ["unclassified"], "formTags": [], "tagRuleVersion": 1,
            "defaultBranch": "main", "createdAt": utc, "displayRank": 1,
            "rankDaily": 1, "gainDaily": 0, "rankWeekly": None, "gainWeekly": None,
            "rankMonthly": None, "gainMonthly": None, "languageColorDaily": "#112233",
            "languageColorWeekly": None, "languageColorMonthly": None,
            "selectedLanguageColor": "#112233", "selectedLanguageColorSourcePeriod": "daily",
            "stars": 1, "forks": 0, "watchersCount": 2, "subscribers": 3,
            "openIssuesAndPullRequests": 4, "contributors": 5, "updatedAt": utc,
            "pushedAt": None, "translationStatus": "not_applicable:no_readme",
        }],
    }


def writer_events(*, head, transition, estimate_rows=None):
    rows = estimate_rows or []
    return {
        "heads": [{"slug": "owner/repo", "branch": "main", "headSha": head, "transition": transition}],
        "releases": [], "latestReleaseIds": {"owner/repo": None}, "commits": [],
        "estimates": [{"slug": "owner/repo", "rows": rows, "sourcePayloadSha256": sha256("b"), "publicRows": rows[-500:]}],
    }


def bind_writer_inputs(payload, events):
    repositories = payload["repositories"]
    snapshot_id = payload["snapshotId"]
    source_sha = payload["inputSourceSha"]
    active_set_sha = canonical_hash(sorted(repository["slug"].lower() for repository in repositories))
    facts_sha = canonical_hash({
        "snapshot_id": snapshot_id,
        "input_source_sha": source_sha,
        "repositories": repositories,
    })
    for key in ("version", "snapshotId", "activeSetSha256", "factsSha256", "completeSetSha256"):
        events.pop(key, None)
    events_sha = canonical_hash(events)
    events.update({
        "version": 1, "snapshotId": snapshot_id, "activeSetSha256": active_set_sha,
        "factsSha256": facts_sha, "completeSetSha256": events_sha,
    })
    entries = payload["enrichmentIndex"].get("repositories", payload["enrichmentIndex"])
    payload["enrichmentIndex"] = {
        "version": 1, "snapshotId": snapshot_id, "activeSetSha256": active_set_sha,
        "factsSha256": facts_sha, "eventsSha256": events_sha, "repositories": entries,
    }
    enrichment_sha = canonical_hash(payload["enrichmentIndex"])
    payload.update({
        "activeSetSha256": active_set_sha, "factsSha256": facts_sha,
        "eventsSha256": events_sha, "enrichmentIndexSha256": enrichment_sha,
    })
    payload["inputManifestSha256"] = canonical_hash({
        "snapshot_id": snapshot_id, "input_source_sha": source_sha,
        "active_set_sha256": active_set_sha, "facts_sha256": facts_sha,
        "events_sha256": events_sha, "enrichment_index_sha256": enrichment_sha,
    })
    return events


def record_writer_snapshot(candidate, payload, events, state):
    return record_core_snapshot(candidate, payload, bind_writer_inputs(payload, events), state)


def writer_legacy_baselines(directory):
    star = Path(directory) / "legacy-star.sqlite"
    membership = Path(directory) / "legacy-membership.sqlite"
    public = Path(directory) / "legacy-public.json"
    with closing(sqlite3.connect(star)) as connection:
        connection.execute("CREATE TABLE star_observations(id INTEGER PRIMARY KEY, slug TEXT, observed_date TEXT, stars_total INTEGER, stars_delta INTEGER, source TEXT)")
    with closing(sqlite3.connect(membership)) as connection:
        connection.execute("CREATE TABLE snapshot_members(snapshot_id INTEGER, ordinal INTEGER, slug TEXT)")
    public.write_text(json.dumps({"repositories": []}), encoding="utf-8")
    paths = {"legacy_star_observations": str(star), "legacy_trending_membership": str(membership), "legacy_public_star_history": str(public)}
    return paths, measure_legacy_baseline_receipt(paths)


class RepositoryObservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary.name) / "repository-observations.sqlite"

    def tearDown(self):
        self.temporary.cleanup()

    def test_schema_has_exact_tables_and_rejects_update_delete(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")},
                EXPECTED_TABLES,
            )
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(
                connection.execute("SELECT schema_version, creation_policy FROM schema_meta").fetchall(),
                [(1, "append_only")],
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE schema_meta SET creation_policy='mutable'")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM schema_meta")

    def test_strict_schema_fingerprint_rejects_trigger_mutation(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            original = schema_fingerprint(connection)
            connection.execute("DROP TRIGGER schema_meta_reject_update")
            self.assertNotEqual(schema_fingerprint(connection), original)
            with self.assertRaisesRegex(ValueError, "canonical"):
                validate_schema(connection)

    def test_fingerprint_is_independently_pinned_and_preserves_sql_literal_case(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(schema_fingerprint(connection), PINNED_SCHEMA_FINGERPRINT)
            connection.execute("PRAGMA writable_schema = ON")
            connection.execute(
                "UPDATE sqlite_schema SET sql = replace(sql, '''refresh''', '''REFRESH''') "
                "WHERE type = 'table' AND name = 'snapshot_runs'"
            )
            connection.execute("PRAGMA writable_schema = OFF")
            with self.assertRaisesRegex(ValueError, "canonical"):
                validate_schema(connection)

    def test_pinned_fingerprint_rejects_trigger_fk_index_and_check_text_mutations(self):
        mutations = (
            ("trigger", "schema_meta_reject_update", "append-only", "append-only!"),
            ("table", "snapshot_runs", "ON DELETE RESTRICT", "ON DELETE CASCADE"),
            ("index", "idx_snapshot_items_slug_seq", "slug, snapshot_seq", "snapshot_seq, slug"),
            ("table", "snapshot_items", "stars >= 0", "stars >= 1"),
        )
        for object_type, name, before, after in mutations:
            with self.subTest(name=name):
                path = Path(self.temporary.name) / f"{name}.sqlite"
                create_database(path)
                with closing(sqlite3.connect(path)) as connection:
                    connection.execute("PRAGMA writable_schema = ON")
                    connection.execute(
                        "UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE type = ? AND name = ?",
                        (before, after, object_type, name),
                    )
                    connection.execute("PRAGMA writable_schema = OFF")
                    with self.assertRaisesRegex(ValueError, "canonical"):
                        validate_schema(connection)

    def test_profile_rejects_noncanonical_slugs_display_mismatch_and_noncanonical_tags(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            baseline_run(connection)
            for kwargs in (
                {"slug": "owner/"},
                {"slug": "owner/repo/extra"},
                {"slug": "owner/repo", "display_slug": "other/repo"},
                {"topics": "{}"},
                {"fields": "{}"},
                {"forms": "null"},
            ):
                with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                    connection.execute("SAVEPOINT profile_probe")
                    profile(connection, **kwargs)
                    validate_schema(connection)
                connection.execute("ROLLBACK TO profile_probe")
                connection.execute("RELEASE profile_probe")

    def test_snapshot_run_requires_real_matching_utc_kst_calendar_values_and_unique_utc(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for utc, kst in (
                ("2026-99-99T99:99:99.999Z", "2026-99-99T99:99:99.999+09:00"),
                ("2026-08-28T01:01:01.001Z", "2026-08-28T09:01:01.001+09:00"),
            ):
                with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                    connection.execute("SAVEPOINT time_probe")
                    baseline_run(connection, utc=utc, kst=kst)
                    validate_schema(connection)
                connection.execute("ROLLBACK TO time_probe")
                connection.execute("RELEASE time_probe")
            baseline_run(connection)
            with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                connection.execute(
                    "INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (2, "20260828010102-bbbbbbbbbbbbbbbb", "refresh", "2026-08-28T01:01:01.001Z",
                     "2026-08-28T10:01:01.001+09:00", "2026-08-28", 1,
                     "20260828010101-aaaaaaaaaaaaaaaa", sha1("b"), sha256("c"), sha256("d"),
                     sha256("c"), sha256("e"), 1),
                )

    def test_snapshot_id_and_chain_hash_are_exact(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for bad_id in ("20260828010101-aaaaaaaaaaaaaaa-", "20260828010101-aaaaaaaaaaaaaaaA", "20260828010101aaaaaaaaaaaaaaaa"):
                connection.execute("SAVEPOINT snapshot_probe")
                with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                    baseline_run(connection, snapshot_id=bad_id)
                    validate_schema(connection)
                connection.execute("ROLLBACK TO snapshot_probe")
                connection.execute("RELEASE snapshot_probe")
            complete_fixture(connection)
            connection.execute("SAVEPOINT chain_probe")
            connection.execute("DROP TRIGGER snapshot_runs_reject_update")
            connection.execute("UPDATE snapshot_runs SET chain_sha256 = ?", (sha256("f"),))
            with self.assertRaisesRegex(ValueError, "chain hash"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO chain_probe")
            connection.execute("RELEASE chain_probe")

    def test_db_only_hash_preimages_reject_mutation(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            for table, column, label in (
                ("historical_star_estimates", "point_sha256", "estimate point"),
                ("historical_star_observations", "source_row_sha256", "legacy observation"),
                ("repository_insights", "insight_sha256", "insight hash"),
            ):
                connection.execute("SAVEPOINT hash_probe")
                connection.execute(f"DROP TRIGGER {table}_reject_update")
                connection.execute(f"UPDATE {table} SET {column} = ?", (sha256("f"),))
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO hash_probe")
                connection.execute("RELEASE hash_probe")

    def test_release_hash_and_api_merge_parent_order_are_recomputed(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            release = {"slug": "owner/repo", "release_id": 1, "tag_name": "v1", "name": None, "target_commitish": "main", "draft": False, "prerelease": False, "created_at": "2026-08-28T01:01:01.001Z", "published_at": None, "html_url": "https://github.com/owner/repo/releases/tag/v1"}
            connection.execute("INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (release["slug"], release["release_id"], canonical_hash(release), 1, release["tag_name"], release["name"], release["target_commitish"], 0, 0, release["created_at"], release["published_at"], release["html_url"]))
            connection.execute("INSERT INTO commit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ("owner/merge", sha1("b"), 1, 1, "main", "2026-08-28T01:01:01.001Z", "2026-08-28T01:01:01.001Z", None, json.dumps([sha1("f"), sha1("a")], separators=(",", ":")), "https://github.com/owner/merge/commit/" + sha1("b")))
            validate_schema(connection)
            connection.execute("SAVEPOINT release_hash_probe")
            connection.execute("DROP TRIGGER release_versions_reject_update")
            connection.execute("UPDATE release_versions SET metadata_sha256 = ?", (sha256("e"),))
            with self.assertRaisesRegex(ValueError, "release metadata"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO release_hash_probe")
            connection.execute("RELEASE release_hash_probe")

    def test_multi_repo_rank_gaps_and_two_release_ordinals_are_permanent(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            profile(connection, profile_id=2, slug="owner/two", display_slug="Owner/Two")
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET rank_weekly = 1, gain_weekly = 1, rank_monthly = 1, gain_monthly = 1 WHERE slug = 'owner/repo'")
            original = dict(zip([row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")], connection.execute("SELECT * FROM snapshot_items").fetchone()))
            original.update({"slug": "owner/two", "profile_id": 2, "display_rank": 2, "rank_daily": 2, "gain_daily": 1, "rank_weekly": 2, "gain_weekly": 1, "rank_monthly": 2, "gain_monthly": 1})
            connection.execute(f"INSERT INTO snapshot_items VALUES ({','.join('?' for _ in original)})", list(original.values()))
            releases = []
            for release_id in (1, 2):
                value = {"slug": "owner/repo", "release_id": release_id, "tag_name": f"v{release_id}", "name": None, "target_commitish": "main", "draft": False, "prerelease": False, "created_at": "2026-08-28T01:01:01.001Z", "published_at": None, "html_url": f"https://github.com/owner/repo/releases/tag/v{release_id}"}
                digest = canonical_hash(value)
                releases.append((release_id, digest))
                connection.execute("INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (value["slug"], release_id, digest, 1, value["tag_name"], None, "main", 0, 0, value["created_at"], None, value["html_url"]))
                connection.execute("INSERT INTO snapshot_release_items VALUES (?, ?, ?, ?, ?)", (1, "owner/repo", release_id, digest, release_id - 1))
            connection.execute("UPDATE snapshot_items SET release_count = 2, release_inventory_sha256 = ?, latest_release_id = 2 WHERE slug = 'owner/repo'", (canonical_hash([{"release_id": release_id, "metadata_sha256": digest} for release_id, digest in releases]),))
            _validate_populated_rows(connection)
            for statement, label in (("UPDATE snapshot_items SET display_rank = 3 WHERE slug = 'owner/two'", "display ranks"), ("UPDATE snapshot_items SET rank_daily = 3 WHERE slug = 'owner/two'", "rank_daily"), ("UPDATE snapshot_release_items SET release_ordinal = 2 WHERE release_id = 2", "release ordinals")):
                connection.execute("SAVEPOINT multi_probe")
                if "snapshot_items" not in statement:
                    connection.execute("DROP TRIGGER snapshot_release_items_reject_update")
                connection.execute(statement)
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO multi_probe")
                connection.execute("RELEASE multi_probe")

    def test_three_snapshot_chain_and_insight_deltas_are_permanent(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            first = connection.execute("SELECT snapshot_id, chain_sha256 FROM snapshot_runs WHERE snapshot_seq = 1").fetchone()
            second_id = "20260828010102-bbbbbbbbbbbbbbbb"
            second_chain = refresh_run(connection, seq=2, snapshot_id=second_id, parent_seq=1, parent_id=first[0], parent_chain=first[1], utc="2026-08-28T01:01:01.002Z")
            third_id = "20260828010103-cccccccccccccccc"
            refresh_run(connection, seq=3, snapshot_id=third_id, parent_seq=2, parent_id=second_id, parent_chain=second_chain, utc="2026-08-28T01:01:01.003Z")
            copy_item(connection, 2, stars=2, display_rank=1, rank_daily=1, gain_daily=1, updated_at="2026-08-28T01:01:01.002Z")
            copy_item(connection, 3, stars=5, display_rank=1, rank_daily=None, gain_daily=None, rank_weekly=1, gain_weekly=1, updated_at="2026-08-28T01:01:01.003Z")
            insight = {"snapshot_seq": 2, "slug": "owner/repo", "previous_observed_snapshot_seq": 1, "observation_gap_milliseconds": 1, "stars_delta_since_previous_observation": 1, "display_rank_delta": 0, "rank_daily_delta": 0, "rank_weekly_delta": None, "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1"}
            connection.execute("INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*insight.values(), canonical_hash(insight)))
            insight3 = {"snapshot_seq": 3, "slug": "owner/repo", "previous_observed_snapshot_seq": 2, "observation_gap_milliseconds": 1, "stars_delta_since_previous_observation": 3, "display_rank_delta": 0, "rank_daily_delta": None, "rank_weekly_delta": None, "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1"}
            connection.execute("INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*insight3.values(), canonical_hash(insight3)))
            _validate_populated_rows(connection)
            connection.execute("SAVEPOINT insight_probe")
            connection.execute("DROP TRIGGER repository_insights_reject_update")
            wrong = {**insight3, "previous_observed_snapshot_seq": 1}
            connection.execute("UPDATE repository_insights SET previous_observed_snapshot_seq = 1, insight_sha256 = ? WHERE snapshot_seq = 3", (canonical_hash(wrong),))
            with self.assertRaisesRegex(ValueError, "actual prior"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO insight_probe")
            connection.execute("RELEASE insight_probe")

    def test_three_snapshot_refresh_and_insight_invariants_reject_recomputed_mutations(self):
        mutations = (
            ("refresh_sequence", "refresh snapshot sequence", lambda connection: connection.execute(
                "UPDATE snapshot_runs SET parent_snapshot_seq = 3, parent_snapshot_id = snapshot_id WHERE snapshot_seq = 3")),
            ("parent_identity", "snapshot parent identity", lambda connection: connection.execute(
                "UPDATE snapshot_runs SET parent_snapshot_id = ? WHERE snapshot_seq = 3",
                (connection.execute("SELECT snapshot_id FROM snapshot_runs WHERE snapshot_seq = 1").fetchone()[0],))),
            ("parent_chain", "snapshot parent chain", lambda connection: (
                connection.execute("UPDATE snapshot_runs SET parent_chain_sha256 = ? WHERE snapshot_seq = 3", (sha256("f"),)),
                recompute_snapshot_chain(connection, 3))),
            ("child_chain_preimage", "snapshot chain hash preimage", lambda connection: connection.execute(
                "UPDATE snapshot_runs SET chain_sha256 = ? WHERE snapshot_seq = 3", (sha256("f"),))),
            ("gap", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET observation_gap_milliseconds = 2 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("stars_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET stars_delta_since_previous_observation = 99 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("display_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET display_rank_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("daily_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET rank_daily_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("weekly_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET rank_weekly_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("monthly_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET rank_monthly_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("null_current_rank", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE snapshot_items SET rank_daily = NULL, gain_daily = NULL WHERE snapshot_seq = 3"),
                connection.execute("UPDATE repository_insights SET rank_daily_delta = 0 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("null_previous_rank", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE snapshot_items SET rank_daily = NULL, gain_daily = NULL WHERE snapshot_seq = 2"),
                connection.execute("UPDATE repository_insights SET rank_daily_delta = NULL WHERE snapshot_seq = 2"),
                recompute_insight_hash(connection, 2),
                connection.execute("UPDATE repository_insights SET rank_daily_delta = 0 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
        )
        for name, error, mutate in mutations:
            with self.subTest(mutation=name):
                path = Path(self.temporary.name) / f"three-snapshot-{name}.sqlite"
                create_database(path)
                with closing(sqlite3.connect(path)) as connection:
                    three_snapshot_fixture(connection)
                    _validate_populated_rows(connection)
                    connection.execute("DROP TRIGGER snapshot_runs_reject_update")
                    connection.execute("DROP TRIGGER repository_insights_reject_update")
                    mutate(connection)
                    with self.assertRaisesRegex(ValueError, error):
                        _validate_populated_rows(connection)

    def test_calendar_matrix_rejects_impossible_values_after_recomputing_bound_hashes(self):
        probes = (
            ("observed_utc", "snapshot_runs", "observed_at_utc", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: recompute_snapshot_chain(connection, 1)),
            ("observed_kst", "snapshot_runs", "observed_at_kst", "2026-02-30T10:01:01.001+09:00", "KST timestamp is not an exact calendar millisecond", lambda connection: recompute_snapshot_chain(connection, 1)),
            ("stats_date", "snapshot_runs", "stats_date_kst", "2026-02-30", "snapshot UTC, KST, and stats date must name one instant", lambda connection: recompute_snapshot_chain(connection, 1)),
            ("profile_created", "repository_profiles", "created_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", recompute_profile_hash),
            ("item_updated", "snapshot_items", "updated_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
            ("item_pushed", "snapshot_items", "pushed_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
            ("release_created", "release_versions", "created_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: recompute_release_hash(connection, 9)),
            ("release_published", "release_versions", "published_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: recompute_release_hash(connection, 9)),
            ("estimate_date", "historical_star_estimates", "estimate_date", "2026-02-30", "day 30 must be in range", recompute_estimate_hash),
            ("legacy_observation_date", "historical_star_observations", "observation_date", "2026-02-30", "day 30 must be in range", recompute_legacy_observation_hash),
            ("commit_authored", "commit_events", "authored_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
            ("commit_committed", "commit_events", "committed_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
        )
        for name, table, column, invalid, error, recompute in probes:
            with self.subTest(calendar_field=name):
                path = Path(self.temporary.name) / f"calendar-{name}.sqlite"
                create_database(path)
                with closing(sqlite3.connect(path)) as connection:
                    calendar_fixture(connection)
                    _validate_populated_rows(connection)
                    connection.execute(f"DROP TRIGGER IF EXISTS {table}_reject_update")
                    if table != "snapshot_runs":
                        connection.execute("DROP TRIGGER snapshot_runs_reject_update")
                    connection.execute(f"UPDATE {table} SET {column} = ?", (invalid,))
                    recompute(connection)
                    with self.assertRaisesRegex(ValueError, error):
                        _validate_populated_rows(connection)

    def test_hash_bound_calendar_probe_fails_if_timestamp_parser_is_bypassed(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            calendar_fixture(connection)
            connection.execute("DROP TRIGGER repository_profiles_reject_update")
            connection.execute(
                "UPDATE repository_profiles SET created_at = '2026-02-30T01:01:01.001Z'"
            )
            recompute_profile_hash(connection)
            original = ledger._parse_utc
            try:
                ledger._parse_utc = lambda value: original("2026-08-28T01:01:01.001Z") if value.startswith("2026-02-30") else original(value)
                with self.assertRaisesRegex(AssertionError, "ValueError not raised"):
                    with self.assertRaisesRegex(ValueError, "UTC timestamp is not an exact calendar millisecond"):
                        _validate_populated_rows(connection)
            finally:
                ledger._parse_utc = original

    def test_all_persisted_calendar_fields_reject_impossible_values(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            release = {"slug": "owner/repo", "release_id": 8, "tag_name": "v8", "name": None, "target_commitish": "main", "draft": False, "prerelease": False, "created_at": "2026-08-28T01:01:01.001Z", "published_at": None, "html_url": "https://github.com/owner/repo/releases/tag/v8"}
            connection.execute("INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (release["slug"], 8, canonical_hash(release), 1, "v8", None, "main", 0, 0, release["created_at"], None, release["html_url"]))
            for table, column in (("snapshot_items", "updated_at"), ("snapshot_items", "pushed_at"), ("release_versions", "created_at"), ("historical_star_estimates", "estimate_date"), ("historical_star_observations", "observation_date"), ("commit_events", "authored_at"), ("commit_events", "committed_at")):
                connection.execute("SAVEPOINT calendar_probe")
                connection.execute(f"DROP TRIGGER {table}_reject_update")
                value = "9999-99-99" if column in ("estimate_date", "observation_date") else "9999-99-99T99:99:99.999Z"
                connection.execute(f"UPDATE {table} SET {column} = ?", (value,))
                with self.assertRaises(ValueError):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO calendar_probe")
                connection.execute("RELEASE calendar_probe")

    def test_each_rank_dimension_has_an_isolated_gap_mutation(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            profile(connection, profile_id=2, slug="owner/two", display_slug="Owner/Two")
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET rank_weekly = 1, gain_weekly = 1, rank_monthly = 1, gain_monthly = 1 WHERE slug = 'owner/repo'")
            source = dict(zip([row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")], connection.execute("SELECT * FROM snapshot_items").fetchone()))
            source.update({"slug": "owner/two", "profile_id": 2, "display_rank": 2, "rank_daily": 2, "gain_daily": 1, "rank_weekly": 2, "gain_weekly": 1, "rank_monthly": 2, "gain_monthly": 1})
            connection.execute(f"INSERT INTO snapshot_items VALUES ({','.join('?' for _ in source)})", list(source.values()))
            _validate_populated_rows(connection)
            for field, label in (("display_rank", "display ranks"), ("rank_daily", "rank_daily"), ("rank_weekly", "rank_weekly"), ("rank_monthly", "rank_monthly")):
                connection.execute("SAVEPOINT isolated_rank")
                connection.execute(f"UPDATE snapshot_items SET {field} = 3 WHERE slug = 'owner/two'")
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO isolated_rank")
                connection.execute("RELEASE isolated_rank")

    def test_calendar_parser_mutation_proves_calendar_probe_efficacy(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            connection.execute("SAVEPOINT parser_probe")
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET updated_at = '9999-99-99T99:99:99.999Z'")
            original = ledger._parse_utc
            try:
                ledger._parse_utc = lambda value: original("2026-08-28T01:01:01.001Z") if value.startswith("9999") else original(value)
                with self.assertRaisesRegex(AssertionError, "ValueError not raised"):
                    with self.assertRaises(ValueError):
                        _validate_populated_rows(connection)
            finally:
                ledger._parse_utc = original
            connection.execute("ROLLBACK TO parser_probe")
            connection.execute("RELEASE parser_probe")

    def test_complete_cross_table_fixture_and_actual_immutable_triggers(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            validate_schema(connection)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE snapshot_items SET stars = 2")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM repository_profiles")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO snapshot_items SELECT * FROM snapshot_items")

    def test_applicable_translation_uses_display_case_and_slug_to_file_separator(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection, display_slug="Owner/Repo", applicable=True)
            validate_schema(connection)
            connection.execute("SAVEPOINT translation_path_probe")
            connection.execute("DROP TRIGGER artifact_hashes_reject_update")
            connection.execute("UPDATE artifact_hashes SET artifact_path = 'translations/owner--repo.json' WHERE artifact_path = 'translations/Owner__Repo.json'")
            with self.assertRaisesRegex(ValueError, "translation"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO translation_path_probe")
            connection.execute("RELEASE translation_path_probe")

    def test_row_validator_rejects_wrong_selected_color_latest_release_and_artifact_set(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            for artifact_path in ("docs/private.txt", "translations/owner--repo.json"):
                connection.execute("SAVEPOINT cross_table_probe")
                connection.execute("INSERT INTO artifact_hashes VALUES (?, ?, ?, ?)", (1, artifact_path, sha256("b"), 1))
                with self.assertRaisesRegex(ValueError, "artifact"):
                    validate_schema(connection)
                connection.execute("ROLLBACK TO cross_table_probe")
                connection.execute("RELEASE cross_table_probe")

    def test_row_validator_rejects_negative_gain_wrong_color_source_and_empty_inventory_latest(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            probes = (
                ("gain_daily = -1", "gains"),
                ("selected_language_color_source_period = 'weekly'", "selected color"),
                ("latest_release_id = 99", "latest release"),
            )
            for assignment, label in probes:
                connection.execute("SAVEPOINT item_probe")
                connection.execute("DROP TRIGGER snapshot_items_reject_update")
                connection.execute(f"UPDATE snapshot_items SET {assignment}")
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO item_probe")
                connection.execute("RELEASE item_probe")

    def test_all_tables_are_strict_and_all_have_immutable_guards(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            definitions = dict(
                connection.execute("SELECT name, sql FROM sqlite_schema WHERE type = 'table'")
            )
            triggers = {
                name
                for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
            }
        for table in EXPECTED_TABLES:
            self.assertIn(" STRICT", definitions[table].upper())
            self.assertIn(f"{table}_reject_update", triggers)
            self.assertIn(f"{table}_reject_delete", triggers)
            self.assertIn(f"{table}_reject_replace", triggers)

    def test_schema_rejects_uppercase_and_non_hex_hashes(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for bad in ("A" * 64, "g" * 64, "a" * 63):
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "INSERT INTO schema_meta VALUES (2, 'append_only', ?)", (bad,)
                    )

    def test_schema_meta_fingerprint_matches_its_stored_value(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT schema_fingerprint_sha256 FROM schema_meta").fetchone()[0],
                schema_fingerprint(connection),
            )
            validate_schema(connection)

    def test_schema_excludes_inferred_ai_columns(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(repository_profiles)")
            }
        self.assertFalse({"is_ai", "ai_tag", "ai_related"} & columns)

    def test_empty_release_inventory_hash_contract_is_documented_in_schema(self):
        create_database(self.database)
        empty_hash = hashlib.sha256(b"[]").hexdigest()
        with closing(sqlite3.connect(self.database)) as connection:
            definition = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE type='table' AND name='snapshot_items'"
            ).fetchone()[0]
        self.assertIn(empty_hash, definition)

    def test_candidate_copy_requires_complete_parent_evidence_and_preserves_static_rows(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            connection.commit()
        evidence = parent_database_evidence(self.database)
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(self.database, candidate, evidence)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM schema_meta").fetchone()[0], 1)
        truncated = dict(evidence)
        truncated["tables"] = dict(evidence["tables"])
        truncated["tables"]["snapshot_runs"] = dict(evidence["tables"]["snapshot_runs"])
        truncated["tables"]["snapshot_runs"]["rows"] = []
        with self.assertRaisesRegex(ValueError, "row digest"):
            prepare_candidate_database(self.database, Path(self.temporary.name) / "bad.sqlite", truncated)

    def test_candidate_copy_rejects_parent_replaced_after_evidence_was_measured(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            connection.commit()
        evidence = parent_database_evidence(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            # A normal SQLite rewrite changes file evidence without weakening
            # the schema; the old parent receipt must still be rejected.
            connection.execute("VACUUM")
        with self.assertRaisesRegex(ValueError, "parent database evidence mismatch: file_sha256"):
            prepare_candidate_database(self.database, Path(self.temporary.name) / "replaced.sqlite", evidence)

    def test_first_snapshot_is_baseline_and_identical_next_run_still_appends(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        first["legacyBaselines"], first["legacyBaselineReceipt"] = baselines, receipt
        state = {}
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        second = writer_payload(snapshot_id="20260828030101-bbbbbbbbbbbbbbbb", utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00", stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id)
        second["legacyBaselines"], second["legacyBaselineReceipt"] = baselines, receipt
        record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (2,))
            self.assertEqual(connection.execute("SELECT membership_status FROM snapshot_items WHERE snapshot_seq=1").fetchone(), ("baseline_present",))
            self.assertEqual(connection.execute("SELECT membership_status FROM snapshot_items WHERE snapshot_seq=2").fetchone(), ("stayed",))

    def test_oss_estimates_preserve_value_change_tombstone_and_reappearance(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        snapshots = [
            ("20260828010101-aaaaaaaaaaaaaaaa", "2026-08-28T01:01:01.001Z", "2026-08-28T10:01:01.001+09:00", "migration_baseline", None, "baseline", [{"date": "2026-08-20", "stars": 1}]),
            ("20260828030101-bbbbbbbbbbbbbbbb", "2026-08-28T03:01:01.001Z", "2026-08-28T12:01:01.001+09:00", "refresh", "20260828010101-aaaaaaaaaaaaaaaa", "unchanged", [{"date": "2026-08-20", "stars": 2}]),
            ("20260828050101-cccccccccccccccc", "2026-08-28T05:01:01.001Z", "2026-08-28T14:01:01.001+09:00", "refresh", "20260828030101-bbbbbbbbbbbbbbbb", "unchanged", []),
            ("20260828070101-dddddddddddddddd", "2026-08-28T07:01:01.001Z", "2026-08-28T16:01:01.001+09:00", "refresh", "20260828050101-cccccccccccccccc", "unchanged", [{"date": "2026-08-20", "stars": 1}]),
        ]
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        state = {}
        for snapshot_id, utc, kst, kind, parent, transition, estimates in snapshots:
            payload = writer_payload(snapshot_id=snapshot_id, utc=utc, kst=kst, stats_date="2026-08-28", run_kind=kind, parent_snapshot_id=parent)
            payload["legacyBaselines"] = baselines
            payload["legacyBaselineReceipt"] = receipt
            record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition=transition, estimate_rows=estimates), state)
        with closing(sqlite3.connect(candidate)) as connection:
            rows = connection.execute("SELECT is_present, stars FROM historical_star_estimates WHERE source='ossinsight_api' ORDER BY first_observed_snapshot_seq").fetchall()
        self.assertEqual(rows, [(1, 1), (1, 2), (0, None), (1, 1)])

    def test_reviewed_receipt_imports_nested_public_history_and_mismatch_rolls_back_baseline(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        Path(paths["legacy_public_star_history"]).write_text(json.dumps({"repositories": [{"slug": "owner/repo", "observed": [{"date": "2026-08-20", "stars": 3}], "estimated": [{"date": "2026-08-21", "stars": 4}]}]}), encoding="utf-8")
        receipt = measure_legacy_baseline_receipt(paths)
        candidate = Path(self.temporary.name) / "receipt.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM baseline_sources").fetchone(), (3,))
            self.assertEqual(connection.execute("SELECT source, slug, stars FROM historical_star_observations WHERE source='legacy_public_star_history'").fetchone(), ("legacy_public_star_history", "owner/repo", 3))
            self.assertEqual(connection.execute("SELECT source, slug, stars FROM historical_star_estimates WHERE source='legacy_star_history_cache'").fetchone(), ("legacy_star_history_cache", "owner/repo", 4))
        bad_candidate = Path(self.temporary.name) / "bad-receipt.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "another-missing.sqlite", bad_candidate, None)
        bad = json.loads(json.dumps(receipt)); bad["sources"]["legacy_public_star_history"]["logical_row_count"] += 1
        payload["legacyBaselineReceipt"] = bad
        with self.assertRaisesRegex(ValueError, "reviewed legacy receipt mismatch"):
            record_writer_snapshot(bad_candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(bad_candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_baseline_core_hash_pins_every_static_row_and_enrichment_summary(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        with closing(sqlite3.connect(paths["legacy_trending_membership"])) as connection:
            connection.execute("INSERT INTO snapshot_members VALUES (1, 0, 'Owner/Repo')")
            connection.commit()
        with closing(sqlite3.connect(paths["legacy_star_observations"])) as connection:
            connection.execute(
                "INSERT INTO star_observations VALUES (1, 'owner/repo', '2026-08-19', 2, 1, 'github_rest')"
            )
            connection.commit()
        Path(paths["legacy_public_star_history"]).write_text(json.dumps({
            "repositories": [{
                "slug": "owner/repo",
                "observed": [{"date": "2026-08-20", "stars": 3}],
                "estimated": [{"date": "2026-08-21", "stars": 4}],
            }],
        }), encoding="utf-8")
        receipt = measure_legacy_baseline_receipt(paths)
        candidate = Path(self.temporary.name) / "pinned-core.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        events = writer_events(
            head=sha1(), transition="baseline",
            estimate_rows=[{"date": "2026-08-22", "stars": 5}],
        )
        result = record_writer_snapshot(candidate, payload, events, {})

        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT slug FROM baseline_membership_slugs").fetchall(),
                [("owner/repo",)],
            )
            self.assertEqual(
                connection.execute("SELECT source, COUNT(*) FROM historical_star_observations GROUP BY source ORDER BY source").fetchall(),
                [("legacy_public_star_history", 1), ("legacy_star_observations_db", 1)],
            )
            entry = payload["enrichmentIndex"]["repositories"]["owner/repo"]
            source = entry["summary"]["source"]
            content = entry["summary"]["content"]
            hashes = connection.execute(
                "SELECT summary_source_sha256, summary_content_sha256, summary_envelope_sha256 FROM snapshot_items"
            ).fetchone()
            self.assertEqual(hashes, (
                canonical_hash(source), canonical_hash(content),
                canonical_hash({"content": content, "source": source}),
            ))
            self.assertEqual(verify_core_snapshot(connection, 1), result.core_payload_sha256)
        self.assertEqual(result.core_payload_sha256, "15fd4291cefd49fb7697e7bd8425e20b1abfb3c06f1b65a8f2805b69e562a482")

    def test_reused_profile_and_release_rows_are_part_of_refresh_core_hash(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        second_id = "20260828030101-bbbbbbbbbbbbbbbb"

        def snapshot(snapshot_id, utc, kind, parent=None):
            kst = f"{utc[:11]}{int(utc[11:13]) + 9:02d}{utc[13:-1]}+09:00"
            value = writer_payload(
                snapshot_id=snapshot_id, utc=utc,
                kst=kst,
                stats_date="2026-08-28", run_kind=kind,
                parent_snapshot_id=parent,
            )
            value["repositories"][0]["createdAt"] = "2026-08-28T01:01:01.001Z"
            profile_value = {
                "slug": "owner/repo", "display_slug": "owner/repo", "description": None,
                "primary_language": None, "topics": [], "license_spdx": None,
                "archived": False, "is_fork": False, "default_branch": "main",
                "created_at": "2026-08-28T01:01:01.001Z", "field_tags": ["unclassified"],
                "form_tags": [], "tag_rule_version": 1,
            }
            value["enrichmentIndex"]["owner/repo"]["summary"]["source"]["profile_sha256"] = canonical_hash(profile_value)
            value["legacyBaselines"], value["legacyBaselineReceipt"] = paths, receipt
            return value

        release = {
            "slug": "owner/repo", "releaseId": 7, "tagName": "v1", "name": "One",
            "targetCommitish": "main", "draft": False, "prerelease": False,
            "createdAt": "2026-08-28T01:01:01.001Z", "publishedAt": None,
            "htmlUrl": "https://github.com/owner/repo/releases/tag/v1",
        }
        release["metadataSha256"] = canonical_hash({
            "slug": "owner/repo", "release_id": 7, "tag_name": "v1", "name": "One",
            "target_commitish": "main", "draft": False, "prerelease": False,
            "created_at": "2026-08-28T01:01:01.001Z", "published_at": None,
            "html_url": "https://github.com/owner/repo/releases/tag/v1",
        })

        def events(transition):
            value = writer_events(head=sha1(), transition=transition)
            value["releases"] = [release]
            value["latestReleaseIds"] = {"owner/repo": 7}
            return value

        original = Path(self.temporary.name) / "reuse.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", original, None)
        state = {}
        first = snapshot(first_id, "2026-08-28T01:01:01.001Z", "migration_baseline")
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(original, first, events("baseline"), state)
        record_writer_snapshot(
            original,
            snapshot(second_id, "2026-08-28T03:01:01.001Z", "refresh", first_id),
            events("unchanged"), state,
        )

        clean = Path(self.temporary.name) / "reuse-clean.sqlite"
        mutated = Path(self.temporary.name) / "reuse-mutated.sqlite"
        shutil.copy2(original, clean)
        shutil.copy2(original, mutated)
        with closing(sqlite3.connect(mutated)) as connection:
            trigger_rows = connection.execute(
                "SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND name IN (?, ?)",
                ("repository_profiles_reject_update", "release_versions_reject_update"),
            ).fetchall()
            self.assertEqual(len(trigger_rows), 2)
            for name, _ in trigger_rows:
                connection.execute(f"DROP TRIGGER {name}")
            connection.execute("UPDATE repository_profiles SET captured_snapshot_seq=2 WHERE profile_id=1")
            connection.execute("UPDATE release_versions SET first_observed_snapshot_seq=2 WHERE release_id=7")
            for _, sql in trigger_rows:
                connection.execute(sql)
            connection.commit()

        third = snapshot(
            "20260828050101-cccccccccccccccc",
            "2026-08-28T05:01:01.001Z", "refresh", second_id,
        )
        clean_state = json.loads(json.dumps(state))
        mutated_state = json.loads(json.dumps(state))
        clean_result = record_writer_snapshot(clean, third, events("unchanged"), clean_state)
        mutated_result = record_writer_snapshot(mutated, third, events("unchanged"), mutated_state)
        self.assertNotEqual(clean_result.core_payload_sha256, mutated_result.core_payload_sha256)
        with closing(sqlite3.connect(mutated)) as connection:
            self.assertEqual(verify_core_snapshot(connection, 3), mutated_result.core_payload_sha256)

    def test_readme_state_survives_exit_and_reentry_records_real_change(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)

        def payload(snapshot_id, utc, kst, kind, parent, include_other, other_blob="b", other_content="c"):
            value = writer_payload(
                snapshot_id=snapshot_id, utc=utc, kst=kst, stats_date="2026-08-28",
                run_kind=kind, parent_snapshot_id=parent,
            )
            if include_other:
                repository = json.loads(json.dumps(value["repositories"][0]))
                repository.update({
                    "slug": "other/repo", "displaySlug": "other/repo", "displayRank": 2,
                    "rankDaily": 2, "readmePath": "README.md",
                    "readmeBlobSha": sha1(other_blob), "readmeContentSha256": sha256(other_content),
                    "translationStatus": "applicable",
                })
                value["repositories"].append(repository)
                source = {
                    "kind": "readme", "slug": "other/repo", "path": "README.md",
                    "blob_sha": sha1(other_blob), "content_sha256": sha256(other_content),
                    "model": "test-model", "schema_version": 2,
                    "translation_applicable": True,
                }
                value["enrichmentIndex"]["other/repo"] = {
                    "summary": {
                        "content": {"goal": "g", "usage": "u", "pros": "p", "cons": "c", "fit": "f"},
                        "source": source,
                    },
                    "translation": {"source": source, "markdown": "번역"},
                }
            value["legacyBaselines"], value["legacyBaselineReceipt"] = paths, receipt
            return value

        def events(active, transitions):
            return {
                "heads": [
                    {"slug": slug, "branch": "main", "headSha": sha1(), "transition": transitions[slug]}
                    for slug in active
                ],
                "releases": [], "latestReleaseIds": {slug: None for slug in active},
                "commits": [],
                "estimates": [
                    {"slug": slug, "rows": [], "sourcePayloadSha256": sha256("b"), "publicRows": []}
                    for slug in active
                ],
            }

        candidate = Path(self.temporary.name) / "readme-reentry.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = payload(first_id, "2026-08-28T01:01:01.001Z", "2026-08-28T10:01:01.001+09:00", "migration_baseline", None, True)
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, events(["owner/repo", "other/repo"], {"owner/repo": "baseline", "other/repo": "baseline"}), state)
        second_id = "20260828030101-bbbbbbbbbbbbbbbb"
        record_writer_snapshot(
            candidate,
            payload(second_id, "2026-08-28T03:01:01.001Z", "2026-08-28T12:01:01.001+09:00", "refresh", first_id, False),
            events(["owner/repo"], {"owner/repo": "unchanged"}), state,
        )
        record_writer_snapshot(
            candidate,
            payload("20260828050101-cccccccccccccccc", "2026-08-28T05:01:01.001Z", "2026-08-28T14:01:01.001+09:00", "refresh", second_id, True, "d", "e"),
            events(["owner/repo", "other/repo"], {"owner/repo": "unchanged", "other/repo": "baseline"}), state,
        )
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT snapshot_seq, membership_status FROM snapshot_items WHERE slug='other/repo' ORDER BY snapshot_seq").fetchall(),
                [(1, "baseline_present"), (3, "reentered")],
            )
            self.assertEqual(
                connection.execute("SELECT change_kind, old_blob_sha, new_blob_sha FROM readme_change_events WHERE snapshot_seq=3 AND slug='other/repo'").fetchone(),
                ("changed", sha1("b"), sha1("d")),
            )
        self.assertEqual(state["other/repo"]["previous"]["blob_sha"], sha1("b"))
        self.assertEqual(state["other/repo"]["current"]["blob_sha"], sha1("d"))

    def test_release_version_a_b_a_reuses_original_and_links_every_snapshot(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)

        def release(name):
            canonical = {
                "slug": "owner/repo", "release_id": 7, "tag_name": "v1", "name": name,
                "target_commitish": "main", "draft": False, "prerelease": False,
                "created_at": "2026-08-28T01:01:01.001Z", "published_at": None,
                "html_url": "https://github.com/owner/repo/releases/tag/v1",
            }
            return {
                "slug": canonical["slug"], "releaseId": canonical["release_id"],
                "tagName": canonical["tag_name"], "name": canonical["name"],
                "targetCommitish": canonical["target_commitish"], "draft": False,
                "prerelease": False, "createdAt": canonical["created_at"],
                "publishedAt": None, "htmlUrl": canonical["html_url"],
                "metadataSha256": canonical_hash(canonical),
            }

        def events(name, transition):
            value = writer_events(head=sha1(), transition=transition)
            value["releases"] = [release(name)]
            value["latestReleaseIds"] = {"owner/repo": 7}
            return value

        candidate = Path(self.temporary.name) / "release-aba.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        ids = [
            "20260828010101-aaaaaaaaaaaaaaaa",
            "20260828030101-bbbbbbbbbbbbbbbb",
            "20260828050101-cccccccccccccccc",
        ]
        times = [
            ("2026-08-28T01:01:01.001Z", "2026-08-28T10:01:01.001+09:00"),
            ("2026-08-28T03:01:01.001Z", "2026-08-28T12:01:01.001+09:00"),
            ("2026-08-28T05:01:01.001Z", "2026-08-28T14:01:01.001+09:00"),
        ]
        results = []
        for index, name in enumerate(("A", "B", "A")):
            payload = writer_payload(
                snapshot_id=ids[index], utc=times[index][0], kst=times[index][1],
                stats_date="2026-08-28", run_kind="migration_baseline" if index == 0 else "refresh",
                parent_snapshot_id=None if index == 0 else ids[index - 1],
            )
            if index == 0:
                payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            else:
                payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            results.append(record_writer_snapshot(candidate, payload, events(name, "baseline" if index == 0 else "unchanged"), state))
        hash_a = release("A")["metadataSha256"]
        hash_b = release("B")["metadataSha256"]
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT metadata_sha256, first_observed_snapshot_seq FROM release_versions ORDER BY first_observed_snapshot_seq").fetchall(),
                [(hash_a, 1), (hash_b, 2)],
            )
            self.assertEqual(
                connection.execute("SELECT snapshot_seq, metadata_sha256 FROM snapshot_release_items ORDER BY snapshot_seq").fetchall(),
                [(1, hash_a), (2, hash_b), (3, hash_a)],
            )
            self.assertEqual(verify_core_snapshot(connection, 3), results[2].core_payload_sha256)
        self.assertEqual(results[2].reused.get("release_versions"), 1)

    def test_cross_input_bindings_reject_event_enrichment_and_manifest_drift(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        for mutation, message in (
            (lambda payload, events: events["heads"][0].update({"headSha": sha1("c")}), "event payload does not bind"),
            (lambda payload, events: payload["enrichmentIndex"]["repositories"]["owner/repo"]["summary"]["content"].update({"goal": "drift"}), "snapshot input hash bindings"),
            (lambda payload, events: payload.update({"inputManifestSha256": sha256("d")}), "input manifest hash"),
        ):
            candidate = Path(self.temporary.name) / f"binding-{message.split()[0]}.sqlite"
            prepare_candidate_database(Path(self.temporary.name) / f"missing-{message.split()[0]}.sqlite", candidate, None)
            payload = writer_payload(
                snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
                utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
                stats_date="2026-08-28", run_kind="migration_baseline",
            )
            payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            events = writer_events(head=sha1(), transition="baseline")
            bind_writer_inputs(payload, events)
            mutation(payload, events)
            with self.assertRaisesRegex(ValueError, message):
                record_core_snapshot(candidate, payload, events, {})
            with closing(sqlite3.connect(candidate)) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_strict_event_allowlists_reject_duplicate_slug_and_hostile_release_url(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        for label, mutate, message in (
            ("duplicate", lambda events: events["heads"].append(dict(events["heads"][0])), "duplicate"),
            ("extra", lambda events: events["heads"][0].update({"message": "forbidden"}), "exact allowlist"),
            ("url", lambda events: events.update({
                "releases": [{
                    "slug": "owner/repo", "releaseId": 7, "tagName": "v1", "name": None,
                    "targetCommitish": "main", "draft": False, "prerelease": False,
                    "createdAt": "2026-08-28T01:01:01.001Z", "publishedAt": None,
                    "htmlUrl": "https://evil.example/owner/repo/releases/tag/v1",
                    "metadataSha256": sha256("a"),
                }], "latestReleaseIds": {"owner/repo": 7},
            }), "release URL"),
        ):
            candidate = Path(self.temporary.name) / f"event-{label}.sqlite"
            prepare_candidate_database(Path(self.temporary.name) / f"missing-{label}.sqlite", candidate, None)
            payload = writer_payload(
                snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
                utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
                stats_date="2026-08-28", run_kind="migration_baseline",
            )
            payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            events = writer_events(head=sha1(), transition="baseline")
            mutate(events)
            bind_writer_inputs(payload, events)
            with self.assertRaisesRegex(ValueError, message):
                record_core_snapshot(candidate, payload, events, {})

    def test_post_append_preserves_exact_rows_in_all_fourteen_tables(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "all-table-prefix.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        insight = {
            "snapshot_seq": 1, "slug": "owner/repo", "previous_observed_snapshot_seq": None,
            "observation_gap_milliseconds": None, "stars_delta_since_previous_observation": None,
            "display_rank_delta": None, "rank_daily_delta": None, "rank_weekly_delta": None,
            "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1",
        }
        with closing(sqlite3.connect(candidate)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*insight.values(), canonical_hash(insight)))
            for artifact_path in PAGES_BASE_ARTIFACT_PATHS:
                connection.execute("INSERT INTO artifact_hashes VALUES (1, ?, ?, 1)", (artifact_path, sha256("a")))
            connection.commit()
            before = {
                table: connection.execute(f"SELECT * FROM {table}").fetchall()
                for table in EXPECTED_TABLES
            }
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with closing(sqlite3.connect(candidate)) as connection:
            for table, expected_rows in before.items():
                actual = connection.execute(f"SELECT * FROM {table}").fetchall()
                for row in expected_rows:
                    self.assertIn(row, actual, table)

    def test_legacy_receipt_rejects_symlink_sidecar_and_semantic_drift(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        star = Path(paths["legacy_star_observations"])
        sidecar = Path(f"{star}-wal")
        sidecar.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "pending sidecar"):
            measure_legacy_baseline_receipt(paths)
        sidecar.unlink()
        with mock.patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaisesRegex(ValueError, "source is missing"):
                measure_legacy_baseline_receipt(paths)
        Path(paths["legacy_public_star_history"]).write_text(json.dumps({
            "repositories": [{"slug": "owner/repo", "observed": [{"date": "2026-02-30", "stars": 1}], "estimated": []}],
        }), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exact date"):
            measure_legacy_baseline_receipt(paths)

    def test_refresh_remeasures_all_frozen_baseline_logical_rows(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "refresh-baseline.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        Path(paths["legacy_public_star_history"]).write_text(json.dumps({
            "repositories": [{"slug": "owner/repo", "observed": [], "estimated": []}],
        }), encoding="utf-8")
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        with self.assertRaisesRegex(ValueError, "reviewed legacy receipt mismatch"):
            record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (1,))

    def test_fast_forward_commit_chain_must_reach_previous_head(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "commit-gap.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1("a"), transition="baseline"), state)
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        events = writer_events(head=sha1("b"), transition="fast_forward")
        events["commits"] = [{
            "slug": "owner/repo", "sha": sha1("b"), "firstObservedOrdinal": 1,
            "branch": "main", "authoredAt": "2026-08-28T02:01:01.001Z",
            "committedAt": "2026-08-28T02:01:01.001Z", "authorLogin": "owner",
            "parentShas": [sha1("c")],
            "htmlUrl": f"https://github.com/owner/repo/commit/{sha1('b')}",
        }]
        with self.assertRaisesRegex(ValueError, "does not reach previous head"):
            record_writer_snapshot(candidate, second, events, state)
        events["commits"][0]["parentShas"] = [sha1("a")]
        result = record_writer_snapshot(candidate, second, events, state)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT commit_sha, first_observed_ordinal FROM commit_events").fetchone(),
                (sha1("b"), 1),
            )
            self.assertEqual(verify_core_snapshot(connection, 2), result.core_payload_sha256)

    def test_independent_core_verifier_detects_post_write_row_mutation(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "core-verifier.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(candidate)) as connection:
            trigger = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='snapshot_items_reject_update'"
            ).fetchone()[0]
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET stars=stars+1 WHERE snapshot_seq=1")
            connection.execute(trigger)
            connection.commit()
            self.assertEqual(schema_fingerprint(connection), PINNED_SCHEMA_FINGERPRINT)
            with self.assertRaisesRegex(ValueError, "core payload hash preimage mismatch for snapshot 1"):
                verify_core_snapshot(connection, 1)

    def test_same_snapshot_id_is_exact_noop_but_changed_fact_conflicts(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "no-op.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        events = writer_events(head=sha1(), transition="baseline")
        state = {}
        first = record_writer_snapshot(candidate, payload, events, state)
        replay = record_writer_snapshot(candidate, payload, events, state)
        self.assertEqual(replay.snapshot_seq, first.snapshot_seq)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (1,))
        changed = json.loads(json.dumps(payload)); changed["repositories"][0]["stars"] = 99
        with self.assertRaisesRegex(ValueError, "conflicting core payload"):
            record_writer_snapshot(candidate, changed, events, state)

    def test_cli_requires_every_candidate_and_frozen_source_input(self):
        result = subprocess.run(
            [sys.executable, "scripts/record_repository_observations.py"],
            cwd=Path(__file__).resolve().parents[1], text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 2)
        for option in ("--parent-database", "--candidate-database", "--snapshot", "--events", "--enrichment-index", "--parent-evidence", "--legacy-star-database", "--legacy-membership-database", "--legacy-public-star-history", "--readme-state"):
            self.assertIn(option, result.stderr)


if __name__ == "__main__":
    unittest.main()
