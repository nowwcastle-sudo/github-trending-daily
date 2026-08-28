import hashlib
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from scripts.record_repository_observations import (
    EMPTY_RELEASE_INVENTORY_SHA256,
    PAGES_BASE_ARTIFACT_PATHS,
    SCHEMA_VERSION,
    create_database,
    schema_fingerprint,
    validate_schema,
)
from scripts.record_repository_observations import _validate_populated_rows


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
            original = dict(zip([row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")], connection.execute("SELECT * FROM snapshot_items").fetchone()))
            original.update({"slug": "owner/two", "profile_id": 2, "display_rank": 2, "rank_daily": 2, "gain_daily": 1})
            connection.execute(f"INSERT INTO snapshot_items VALUES ({','.join('?' for _ in original)})", list(original.values()))
            releases = []
            for release_id in (1, 2):
                value = {"slug": "owner/repo", "release_id": release_id, "tag_name": f"v{release_id}", "name": None, "target_commitish": "main", "draft": False, "prerelease": False, "created_at": "2026-08-28T01:01:01.001Z", "published_at": None, "html_url": f"https://github.com/owner/repo/releases/tag/v{release_id}"}
                digest = canonical_hash(value)
                releases.append((release_id, digest))
                connection.execute("INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (value["slug"], release_id, digest, 1, value["tag_name"], None, "main", 0, 0, value["created_at"], None, value["html_url"]))
                connection.execute("INSERT INTO snapshot_release_items VALUES (?, ?, ?, ?, ?)", (1, "owner/repo", release_id, digest, release_id - 1))
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
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


if __name__ == "__main__":
    unittest.main()
