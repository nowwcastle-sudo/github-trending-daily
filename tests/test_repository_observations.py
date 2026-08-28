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


def baseline_run(connection, *, snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00"):
    connection.execute(
        """INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (1, snapshot_id, "migration_baseline", utc, kst, "2026-08-28", None, None,
         sha1(), sha256(), sha256("b"), None, sha256("c"), 1),
    )


def profile(connection, *, slug="owner/repo", display_slug="owner/repo", topics="[]", fields='["unclassified"]', forms="[]"):
    digest = hashlib.sha256(json.dumps({
        "slug": slug, "display_slug": display_slug, "description": None,
        "primary_language": None, "topics": json.loads(topics), "license_spdx": None,
        "archived": False, "is_fork": False, "default_branch": "main",
        "created_at": "2026-08-28T01:01:01.001Z", "field_tags": json.loads(fields),
        "form_tags": json.loads(forms), "tag_rule_version": 1,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    connection.execute(
        """INSERT INTO repository_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (1, slug, display_slug, 1, None, None, topics, None, 0, 0, "main",
         "2026-08-28T01:01:01.001Z", fields, forms, 1, digest),
    )


def complete_fixture(connection):
    baseline_run(connection)
    profile(connection)
    connection.execute(
        """INSERT INTO snapshot_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (1, "owner/repo", 1, 1, 1, None, None, 0, None, None, "#112233", None, None,
         "#112233", "daily", 1, 0, 0, 0, 0, 0, "2026-08-28T01:01:01.001Z", None,
         sha1(), None, "baseline", "absent", None, None, None, "baseline_present", 0,
         EMPTY_RELEASE_INVENTORY_SHA256, None, "complete_empty", sha256("e"), 0, sha256("f"),
         sha256("a"), sha256("b"), "not_applicable:no_readme", None, None),
    )
    connection.execute(
        "INSERT INTO historical_star_estimates VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("legacy_star_history_cache", "owner/repo", "2026-08-28", 1, 1, sha256("c"), sha256("d"), 1),
    )
    connection.execute(
        "INSERT INTO historical_star_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("legacy_public_star_history", None, "owner/repo", "2026-08-28", 1, None, None, sha256("e"), 1),
    )
    connection.execute(
        "INSERT INTO commit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("owner/repo", sha1(), 1, 0, "main", "2026-08-28T01:01:01.001Z", "2026-08-28T01:01:01.001Z", None, "[]", "https://github.com/owner/repo/commit/" + sha1()),
    )
    connection.execute(
        "INSERT INTO readme_change_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (1, "owner/repo", None, None, None, None, None, None, "baseline"),
    )
    connection.execute(
        "INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (1, "owner/repo", None, None, None, None, None, None, None, "repository-insight-v1", sha256("f")),
    )
    for artifact_path in PAGES_BASE_ARTIFACT_PATHS:
        connection.execute("INSERT INTO artifact_hashes VALUES (?, ?, ?, ?)", (1, artifact_path, sha256("a"), 1))


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
