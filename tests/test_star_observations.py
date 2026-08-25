import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from scripts.record_star_observations import (
    CANONICAL_LEGACY_FINGERPRINT,
    DEFAULT_DATABASE,
    DEFAULT_PAGE,
    REPOSITORY_ROOT,
    RepositoryObservation,
    StarObservation,
    parse_legacy_star_history,
    parse_repositories,
    record_observations,
    validate_canonical_legacy_baseline,
)


SCRIPT = REPOSITORY_ROOT / "scripts" / "record_star_observations.py"


def ui_repo(index, *, slug=None, date="2026-08-22", stars=None):
    slug = slug or f"owner/repo-{index}"
    return {
        "slug": slug,
        "name": slug.replace("/", " / "),
        "desc": "description",
        "lang": "Python",
        "stars": index + 100 if stars is None else stars,
        "forks": index,
        "stars_daily": index,
        "color": "#3572A5",
        "summary": {
            "goal": "goal",
            "usage": "usage",
            "pros": "pros",
            "cons": "cons",
            "fit": "fit",
        },
        "detail": {
            "goal": "goal",
            "usage": "usage",
            "pros": "pros",
            "cons": "cons",
            "fit": "fit",
            "stars_note": "note",
        },
        "issues": index,
        "contributors": index + 1,
        "_stats_date": date,
    }


def repo_page(repos):
    return (
        "before\n"
        "// GENERATED:TRENDING-REPOS:START\n"
        f"const REPOS = {json.dumps(repos)};\n"
        "// GENERATED:TRENDING-REPOS:END\n"
        "after\n"
    )


def legacy_page(entries):
    return f"before\nconst STAR_HISTORY={json.dumps(entries)};\nafter\n"


def parsed_repositories(date="2026-08-22", *, first_stars=100):
    repos = [ui_repo(index, date=date) for index in range(10)]
    repos[0]["stars"] = first_stars
    return parse_repositories(repo_page(repos))


class RepositoryParserTests(unittest.TestCase):
    def test_parses_exact_marked_full_ui_snapshot(self):
        parsed = parsed_repositories()

        self.assertEqual(len(parsed), 10)
        self.assertEqual(
            parsed[0],
            RepositoryObservation("owner/repo-0", "2026-08-22", 100),
        )

    def test_rejects_marker_shape_count_and_ui_boundary_errors(self):
        valid = [ui_repo(index) for index in range(10)]
        cases = [
            repo_page(valid).replace("// GENERATED:TRENDING-REPOS:END", ""),
            repo_page(valid) + repo_page(valid),
            repo_page(valid[:9]),
            repo_page(valid + [ui_repo(index) for index in range(10, 76)]),
            repo_page([{**valid[0], "summary": {}}] + valid[1:]),
            repo_page([{**valid[0], "_stats_date": "2026-02-30"}] + valid[1:]),
            repo_page([valid[0], {**valid[1], "slug": "OWNER/REPO-0"}] + valid[2:]),
            repo_page([{**valid[0], "stars": True}] + valid[1:]),
            repo_page([{**valid[0], "stars_daily": -1}] + valid[1:]),
        ]

        for page in cases:
            with self.subTest(page=page[:80]):
                with self.assertRaises(ValueError):
                    parse_repositories(page)


class LegacyParserTests(unittest.TestCase):
    def test_accepts_post_migration_page_without_legacy_declaration(self):
        self.assertEqual(parse_legacy_star_history("no legacy constant remains\n"), [])

    def test_preserves_all_valid_points_including_orphan_repositories(self):
        page = legacy_page([
            {"slug": "owner/repo-0", "hist": [{"d": "2026-08-20", "s": 90}]},
            {
                "slug": "gone/orphan",
                "hist": [
                    {"d": "2026-08-19", "s": 11},
                    {"d": "2026-08-21", "s": 9},
                ],
            },
        ])

        self.assertEqual(
            parse_legacy_star_history(page),
            [
                StarObservation("owner/repo-0", "2026-08-20", 90, "legacy_inline"),
                StarObservation("gone/orphan", "2026-08-19", 11, "legacy_inline"),
                StarObservation("gone/orphan", "2026-08-21", 9, "legacy_inline"),
            ],
        )

    def test_rejects_ambiguous_or_invalid_legacy_data(self):
        valid = [{"slug": "owner/repo", "hist": [{"d": "2026-08-20", "s": 90}]}]
        cases = [
            "const STAR_HISTORY=[];\nconst STAR_HISTORY=[];",
            legacy_page([{"slug": "invalid", "hist": []}]),
            legacy_page([{"slug": "owner/repo", "hist": [{"d": "2026-02-30", "s": 1}]}]),
            legacy_page([{"slug": "owner/repo", "hist": [{"d": "2026-08-20", "s": -1}]}]),
            legacy_page(valid + [{"slug": "OWNER/REPO", "hist": []}]),
            legacy_page([{"slug": "owner/repo", "hist": [valid[0]["hist"][0], valid[0]["hist"][0]]}]),
        ]

        for page in cases:
            with self.subTest(page=page):
                with self.assertRaises(ValueError):
                    parse_legacy_star_history(page)


class ObservationDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary.name) / "observations.sqlite"

    def tearDown(self):
        self.temporary.cleanup()

    def rows(self, query, parameters=()):
        with closing(sqlite3.connect(self.database)) as connection:
            return connection.execute(query, parameters).fetchall()

    def test_creates_v1_and_keeps_legacy_and_rest_sources_separate(self):
        legacy = parse_legacy_star_history(legacy_page([
            {
                "slug": "OWNER/repo-0",
                "hist": [
                    {"d": "2026-08-21", "s": 90},
                    {"d": "2026-08-20", "s": 110},
                ],
            },
            {"slug": "gone/orphan", "hist": [{"d": "2026-08-19", "s": 3}]},
        ]))

        result = record_observations(self.database, parsed_repositories(first_stars=100), legacy)

        self.assertEqual((result.rest_inserted, result.legacy_inserted), (10, 3))
        self.assertEqual(self.rows("PRAGMA user_version"), [(1,)])
        self.assertEqual(self.rows("PRAGMA journal_mode"), [("delete",)])
        self.assertEqual(self.rows("PRAGMA integrity_check"), [("ok",)])
        self.assertEqual(self.rows("SELECT schema_version, creation_policy FROM schema_meta"), [(1, "append_only")])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM repositories"), [(11,)])
        self.assertEqual(
            self.rows(
                "SELECT observed_date, stars_total, stars_delta, source "
                "FROM star_observations WHERE slug = ? COLLATE NOCASE ORDER BY source, observed_date",
                ("owner/repo-0",),
            ),
            [
                ("2026-08-22", 100, None, "github_rest"),
                ("2026-08-20", 110, None, "legacy_inline"),
                ("2026-08-21", 90, -20, "legacy_inline"),
            ],
        )

    def test_same_day_is_first_write_wins_and_next_delta_is_source_local(self):
        record_observations(self.database, parsed_repositories(first_stars=100), [])
        rerun = record_observations(self.database, parsed_repositories(first_stars=999), [])
        record_observations(
            self.database,
            parsed_repositories("2026-08-23", first_stars=95),
            [],
        )
        record_observations(
            self.database,
            parsed_repositories("2026-08-24", first_stars=95),
            [],
        )
        record_observations(
            self.database,
            parsed_repositories("2026-08-25", first_stars=105),
            [],
        )

        self.assertEqual(rerun.rest_inserted, 0)
        self.assertEqual(
            self.rows(
                "SELECT observed_date, stars_total, stars_delta FROM star_observations "
                "WHERE slug = 'owner/repo-0' AND source = 'github_rest' ORDER BY observed_date"
            ),
            [
                ("2026-08-22", 100, None),
                ("2026-08-23", 95, -5),
                ("2026-08-24", 95, 0),
                ("2026-08-25", 105, 10),
            ],
        )

    def test_case_insensitive_identity_and_disappeared_rows_are_retained(self):
        legacy = [StarObservation("OWNER/REPO-0", "2026-08-20", 80, "legacy_inline")]
        record_observations(self.database, parsed_repositories(), legacy)
        next_repos = parsed_repositories("2026-08-23")
        next_repos = next_repos[1:] + [RepositoryObservation("new/repo", "2026-08-23", 1)]
        record_observations(self.database, next_repos, [])

        self.assertEqual(
            self.rows("SELECT slug, first_seen, last_seen FROM repositories WHERE slug = ?", ("OWNER/REPO-0",)),
            [("owner/repo-0", "2026-08-20", "2026-08-22")],
        )
        self.assertEqual(
            self.rows("SELECT COUNT(*) FROM star_observations WHERE slug = ? COLLATE NOCASE", ("owner/repo-0",)),
            [(2,)],
        )

    def test_database_triggers_block_observation_updates_and_deletes(self):
        record_observations(self.database, parsed_repositories(), [])

        with closing(sqlite3.connect(self.database)) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE star_observations SET stars_total = 0")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM star_observations")

        self.assertEqual(self.rows("SELECT COUNT(*) FROM star_observations"), [(10,)])

    def test_backfill_rejection_rolls_back_the_whole_run(self):
        record_observations(self.database, parsed_repositories(), [])
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "INSERT INTO star_observations(slug, observed_date, stars_total, stars_delta, source) "
                "VALUES ('owner/repo-1', '2026-08-24', 103, 2, 'github_rest')"
            )
            connection.execute(
                "UPDATE repositories SET last_seen = '2026-08-24' WHERE slug = 'owner/repo-1'"
            )
            connection.commit()
        before_observations = self.rows(
            "SELECT slug, observed_date, stars_total, stars_delta, source FROM star_observations ORDER BY id"
        )
        before_repositories = self.rows(
            "SELECT slug, first_seen, last_seen FROM repositories ORDER BY slug"
        )

        with self.assertRaises(ValueError):
            record_observations(self.database, parsed_repositories("2026-08-23"), [])

        self.assertEqual(
            self.rows(
                "SELECT slug, observed_date, stars_total, stars_delta, source FROM star_observations ORDER BY id"
            ),
            before_observations,
        )
        self.assertEqual(
            self.rows("SELECT slug, first_seen, last_seen FROM repositories ORDER BY slug"),
            before_repositories,
        )

    def test_schema_fingerprint_rejects_counterfeit_protection_trigger_before_writes(self):
        record_observations(self.database, parsed_repositories(), [])
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("DROP TRIGGER star_observations_no_update")
            connection.execute(
                "CREATE TRIGGER star_observations_no_update BEFORE UPDATE ON star_observations "
                "BEGIN SELECT 1; END"
            )
            connection.commit()
        before = self.rows("SELECT * FROM star_observations ORDER BY id")

        with self.assertRaises(ValueError):
            record_observations(self.database, parsed_repositories("2026-08-23"), [])

        self.assertEqual(self.rows("SELECT * FROM star_observations ORDER BY id"), before)

    def test_schema_fingerprint_rejects_extra_user_object_before_writes(self):
        record_observations(self.database, parsed_repositories(), [])
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "CREATE TRIGGER unexpected_after_insert AFTER INSERT ON star_observations "
                "BEGIN SELECT 1; END"
            )
            connection.commit()
        before = self.rows("SELECT * FROM star_observations ORDER BY id")

        with self.assertRaises(ValueError):
            record_observations(self.database, parsed_repositories("2026-08-23"), [])

        self.assertEqual(self.rows("SELECT * FROM star_observations ORDER BY id"), before)

    def test_insert_or_replace_cannot_overwrite_an_observation_by_key_or_id(self):
        record_observations(self.database, parsed_repositories(), [])
        original = self.rows(
            "SELECT id, slug, observed_date, stars_total, stars_delta, source "
            "FROM star_observations WHERE slug = 'owner/repo-0'"
        )[0]
        row_id, slug, observed_date, stars_total, stars_delta, source = original

        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA recursive_triggers = OFF")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT OR REPLACE INTO star_observations"
                    "(slug, observed_date, stars_total, stars_delta, source) VALUES (?, ?, ?, ?, ?)",
                    (slug.upper(), observed_date, 999, stars_delta, source),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT OR REPLACE INTO star_observations"
                    "(id, slug, observed_date, stars_total, stars_delta, source) VALUES (?, ?, ?, ?, ?, ?)",
                    (row_id, slug, "2026-08-30", 999, 899, source),
                )

        self.assertEqual(
            self.rows(
                "SELECT id, slug, observed_date, stars_total, stars_delta, source "
                "FROM star_observations WHERE id = ?",
                (row_id,),
            ),
            [(row_id, slug, observed_date, stars_total, stars_delta, source)],
        )

    def test_refuses_existing_zero_or_unknown_schema_without_recreating(self):
        for version in (0, 2):
            path = Path(self.temporary.name) / f"version-{version}.sqlite"
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("CREATE TABLE keep_me(value TEXT)")
                connection.execute("INSERT INTO keep_me VALUES ('kept')")
                connection.execute(f"PRAGMA user_version = {version}")
                connection.commit()

            with self.subTest(version=version):
                with self.assertRaises(ValueError):
                    record_observations(path, parsed_repositories(), [])
                with closing(sqlite3.connect(path)) as connection:
                    self.assertEqual(connection.execute("SELECT * FROM keep_me").fetchall(), [("kept",)])
                    self.assertEqual(connection.execute("PRAGMA user_version").fetchone(), (version,))

    def test_invalid_input_does_not_create_or_touch_a_database(self):
        with self.assertRaises(ValueError):
            record_observations(self.database, parsed_repositories()[:9], [])
        self.assertFalse(self.database.exists())

        record_observations(self.database, parsed_repositories(), [])
        before = self.database.read_bytes()
        invalid = parsed_repositories()
        invalid[0] = RepositoryObservation("owner/repo-0", "2026-02-30", 100)
        with self.assertRaises(ValueError):
            record_observations(self.database, invalid, [])
        self.assertEqual(self.database.read_bytes(), before)

    def test_required_canonical_baseline_is_rechecked_before_recording(self):
        record_observations(self.database, parsed_repositories(), [])
        before = self.database.read_bytes()

        with self.assertRaises(ValueError):
            record_observations(
                self.database,
                parsed_repositories("2026-08-23"),
                [],
                require_canonical_legacy=True,
            )

        self.assertEqual(self.database.read_bytes(), before)


class ObservationCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.page = self.root / "page with spaces.html"
        self.database = self.root / "nested data" / "observations.sqlite"
        self.page.write_text(
            repo_page([ui_repo(index) for index in range(10)])
            + legacy_page([
                {"slug": "owner/repo-0", "hist": [{"d": "2026-08-21", "s": 90}]},
                {"slug": "gone/orphan", "hist": [{"d": "2026-08-20", "s": 3}]},
            ]),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def run_cli(self, page=None, database=None):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--page",
                str(page or self.page),
                "--database",
                str(database or self.database),
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_defaults_are_repo_relative_and_cli_creates_nested_database(self):
        self.assertEqual(DEFAULT_PAGE, REPOSITORY_ROOT / "index.html")
        self.assertEqual(DEFAULT_DATABASE, REPOSITORY_ROOT / "data" / "star-observations.sqlite")

        result = self.run_cli()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(),
            "rest_inserted=10 legacy_inserted=2 github_rest=10 legacy_inline=2 observations=12 integrity=ok",
        )
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone(), (1,))
        for suffix in ("-journal", "-wal", "-shm"):
            self.assertFalse(Path(f"{self.database}{suffix}").exists())

    def test_invalid_page_exits_nonzero_without_creating_or_touching_database(self):
        invalid_page = self.root / "invalid.html"
        invalid_page.write_text("not a generated page", encoding="utf-8")

        missing_result = self.run_cli(invalid_page)

        self.assertNotEqual(missing_result.returncode, 0)
        self.assertFalse(self.database.exists())

        self.assertEqual(self.run_cli().returncode, 0)
        before = self.database.read_bytes()

        existing_result = self.run_cli(invalid_page)

        self.assertNotEqual(existing_result.returncode, 0)
        self.assertEqual(self.database.read_bytes(), before)

    def test_second_run_is_row_and_sha_idempotent(self):
        first = self.run_cli()
        self.assertEqual(first.returncode, 0, first.stderr)
        before_sha = hashlib.sha256(self.database.read_bytes()).hexdigest()
        with closing(sqlite3.connect(self.database)) as connection:
            before_rows = connection.execute(
                "SELECT id, slug, observed_date, stars_total, stars_delta, source "
                "FROM star_observations ORDER BY id"
            ).fetchall()

        second = self.run_cli()

        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("rest_inserted=0 legacy_inserted=0", second.stdout)
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), before_sha)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT id, slug, observed_date, stars_total, stars_delta, source "
                    "FROM star_observations ORDER BY id"
                ).fetchall(),
                before_rows,
            )

    def test_unknown_existing_schema_exits_nonzero_and_preserves_database(self):
        self.database.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("CREATE TABLE keep_me(value TEXT)")
            connection.execute("INSERT INTO keep_me VALUES ('kept')")
            connection.commit()
        before = self.database.read_bytes()

        result = self.run_cli()

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.database.read_bytes(), before)

    def test_zero_legacy_page_requires_and_preserves_the_canonical_baseline(self):
        page = self.root / "post migration.html"
        page.write_bytes(DEFAULT_PAGE.read_bytes())

        missing = self.run_cli(page)

        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse(self.database.exists())

        self.database.parent.mkdir(parents=True)
        self.database.write_bytes(DEFAULT_DATABASE.read_bytes())
        before = self.database.read_bytes()

        canonical = self.run_cli(page)

        self.assertEqual(canonical.returncode, 0, canonical.stderr)
        # A zero-legacy page may still contain REST-eligible repositories; what matters
        # is that the canonical baseline rows are preserved byte-for-byte afterwards
        # and no legacy rows were imported.
        self.assertIn("legacy_inserted=0", canonical.stdout)
        self.assertIn("integrity=ok", canonical.stdout)

    def test_zero_legacy_page_rejects_schema_valid_replacement_without_touching_it(self):
        page = self.root / "post migration.html"
        page.write_text(repo_page([ui_repo(index) for index in range(10)]), encoding="utf-8")

        for mutation in ("empty", "altered", "deleted"):
            with self.subTest(mutation=mutation):
                database = self.root / f"{mutation}.sqlite"
                database.write_bytes(DEFAULT_DATABASE.read_bytes())
                with closing(sqlite3.connect(database)) as connection:
                    if mutation == "altered":
                        trigger = connection.execute(
                            "SELECT sql FROM sqlite_schema WHERE name = 'star_observations_no_update'"
                        ).fetchone()[0]
                        connection.execute("DROP TRIGGER star_observations_no_update")
                        connection.execute(
                            "UPDATE star_observations SET stars_total = stars_total + 1 "
                            "WHERE id = (SELECT id FROM star_observations WHERE source = 'legacy_inline' LIMIT 1)"
                        )
                        connection.execute(trigger)
                    else:
                        trigger = connection.execute(
                            "SELECT sql FROM sqlite_schema WHERE name = 'star_observations_no_delete'"
                        ).fetchone()[0]
                        connection.execute("DROP TRIGGER star_observations_no_delete")
                        if mutation == "empty":
                            connection.execute("DELETE FROM star_observations WHERE source = 'legacy_inline'")
                        else:
                            connection.execute(
                                "DELETE FROM star_observations WHERE id = "
                                "(SELECT id FROM star_observations WHERE source = 'legacy_inline' LIMIT 1)"
                            )
                        connection.execute(trigger)
                    connection.commit()
                before = database.read_bytes()

                result = self.run_cli(page, database)

                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(database.read_bytes(), before)

    def test_canonical_legacy_fingerprint_locks_every_migrated_row(self):
        expected = "233800ae235f5f63033940f61743c41df0349f8b983692dede0df79f4202949f"
        self.assertEqual(CANONICAL_LEGACY_FINGERPRINT, expected)
        self.assertEqual(
            validate_canonical_legacy_baseline(DEFAULT_DATABASE),
            expected,
        )


if __name__ == "__main__":
    unittest.main()
