import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from scripts.record_trending_membership import (
    DEFAULT_DATABASE,
    MembershipSnapshot,
    load_finalized_snapshot,
    main,
    record_membership,
    validate_membership_publication,
)


def snapshot(generated_at, slugs, *, stats_date="2026-08-26"):
    return MembershipSnapshot(generated_at, stats_date, tuple(slugs))


def run_snapshot_id(generated_at):
    timestamp = generated_at.replace("-", "").replace(":", "").replace(".", "").replace("T", "").replace("Z", "")
    digest = hashlib.sha256(f"{generated_at}|run-context-v1".encode()).hexdigest()[:16]
    return f"{timestamp[:14]}-{digest}"


def page_and_latest(slugs, *, generated_at="2026-08-26T10:07:00.000Z", stats_date="2026-08-26"):
    snapshot_id = run_snapshot_id(generated_at)
    repos = [{
        "slug": slug,
        "_snapshot_id": snapshot_id,
        "_generated_at": generated_at,
        "_stats_date": stats_date,
    } for slug in slugs]
    page = (
        "before\n// GENERATED:TRENDING-REPOS:START\n"
        f"const REPOS = {json.dumps(repos)};\n"
        "// GENERATED:TRENDING-REPOS:END\nafter\n"
    )
    latest = {
        "snapshotId": snapshot_id,
        "generatedAt": generated_at,
        "statsDate": stats_date,
        "count": len(slugs),
        "repos": [{"slug": slug} for slug in reversed(slugs)],
    }
    return page, latest


class MembershipHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "trending-membership.sqlite"
        self.status = self.root / "membership-status.json"
        self.slugs = [f"owner/repo-{index}" for index in range(10)]

    def tearDown(self):
        self.temporary.cleanup()

    def read_status(self):
        return json.loads(self.status.read_text(encoding="utf-8"))

    def test_legacy_writer_rejects_resolved_canonical_database_alias(self):
        canonical = self.root / "canonical" / "trending-membership.sqlite"
        alias = canonical.parent / "." / canonical.name
        with mock.patch("scripts.record_trending_membership.DEFAULT_DATABASE", canonical):
            with self.assertRaisesRegex(ValueError, "canonical legacy membership database"):
                record_membership(
                    alias,
                    self.status,
                    snapshot("2026-08-26T10:07:00.000Z", self.slugs),
                )

    def rows(self, query, parameters=()):
        with closing(sqlite3.connect(self.database)) as connection:
            return connection.execute(query, parameters).fetchall()

    def test_first_snapshot_is_a_neutral_baseline(self):
        result = record_membership(
            self.database,
            self.status,
            snapshot("2026-08-26T10:07:00.000Z", self.slugs),
        )

        self.assertTrue(result.changed)
        self.assertTrue(result.baseline)
        status = self.read_status()
        self.assertTrue(status["baseline"])
        self.assertEqual([item["slug"] for item in status["current"]], self.slugs)
        self.assertEqual({item["status"] for item in status["current"]}, {"baseline"})
        self.assertEqual(status["exited"], [])

    def test_new_stayed_exited_and_reentered_follow_finalized_snapshots(self):
        record_membership(self.database, self.status, snapshot("2026-08-26T10:07:00.000Z", self.slugs))
        second = self.slugs[1:] + ["new/project"]
        record_membership(self.database, self.status, snapshot("2026-08-26T12:07:00.000Z", second))
        status = self.read_status()

        self.assertEqual(status["current"][-1], {"slug": "new/project", "status": "new"})
        self.assertEqual({item["status"] for item in status["current"][:-1]}, {"stayed"})
        self.assertEqual(status["exited"], [{
            "slug": "owner/repo-0",
            "lastSeenAt": "2026-08-26T10:07:00.000Z",
            "exitedAt": "2026-08-26T12:07:00.000Z",
        }])

        third = self.slugs
        record_membership(self.database, self.status, snapshot("2026-08-26T14:07:00.000Z", third))
        status = self.read_status()
        by_slug = {item["slug"]: item["status"] for item in status["current"]}
        self.assertEqual(by_slug["owner/repo-0"], "reentered")
        self.assertEqual(status["exited"][0]["slug"], "new/project")

    def test_same_stats_date_accepts_distinct_ordered_generated_times_and_snapshot_gaps(self):
        record_membership(self.database, self.status, snapshot("2026-08-26T10:07:00.000Z", self.slugs))
        record_membership(self.database, self.status, snapshot("2026-08-26T12:07:00.000Z", self.slugs[1:] + ["a/new"]))
        record_membership(self.database, self.status, snapshot("2026-08-26T18:07:00.000Z", self.slugs))

        self.assertEqual(self.rows("SELECT generated_at FROM snapshots ORDER BY id"), [
            ("2026-08-26T10:07:00.000Z",),
            ("2026-08-26T12:07:00.000Z",),
            ("2026-08-26T18:07:00.000Z",),
        ])
        self.assertEqual(self.read_status()["current"][0]["status"], "reentered")

    def test_exact_rerun_is_byte_and_row_idempotent(self):
        current = snapshot("2026-08-26T10:07:00.000Z", self.slugs)
        record_membership(self.database, self.status, current)
        before_database = self.database.read_bytes()
        before_status = self.status.read_bytes()
        before_rows = self.rows("SELECT COUNT(*) FROM snapshots")[0][0]

        result = record_membership(self.database, self.status, current)

        self.assertFalse(result.changed)
        self.assertEqual(self.database.read_bytes(), before_database)
        self.assertEqual(self.status.read_bytes(), before_status)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM snapshots")[0][0], before_rows)

    def test_conflict_and_out_of_order_snapshot_preserve_last_good_pair(self):
        current = snapshot("2026-08-26T10:07:00.000Z", self.slugs)
        record_membership(self.database, self.status, current)
        before_database = self.database.read_bytes()
        before_status = self.status.read_bytes()

        conflicts = [
            snapshot("2026-08-26T10:07:00.000Z", self.slugs[:-1] + ["other/project"]),
            snapshot("2026-08-26T08:07:00.000Z", self.slugs),
        ]
        for conflicting in conflicts:
            with self.subTest(generated_at=conflicting.generated_at):
                with self.assertRaises(ValueError):
                    record_membership(self.database, self.status, conflicting)
                self.assertEqual(self.database.read_bytes(), before_database)
                self.assertEqual(self.status.read_bytes(), before_status)

    def test_failed_second_install_restores_the_last_good_database_and_status_pair(self):
        record_membership(
            self.database,
            self.status,
            snapshot("2026-08-26T10:07:00.000Z", self.slugs),
        )
        before_database = self.database.read_bytes()
        before_status = self.status.read_bytes()
        real_replace = os.replace

        def fail_status_install(source, target):
            source = Path(source)
            target = Path(target)
            if target == self.status and ".pending-" in source.name:
                raise OSError("injected status install failure")
            return real_replace(source, target)

        with mock.patch("scripts.record_trending_membership.os.replace", side_effect=fail_status_install):
            with self.assertRaises(OSError):
                record_membership(
                    self.database,
                    self.status,
                    snapshot("2026-08-26T12:07:00.000Z", self.slugs[1:] + ["new/project"]),
                )

        self.assertEqual(self.database.read_bytes(), before_database)
        self.assertEqual(self.status.read_bytes(), before_status)
        self.assertEqual(list(self.root.glob("*.pending-*")), [])
        self.assertEqual(list(self.root.glob("*.backup-*")), [])

    def test_invalid_snapshot_inputs_do_not_create_or_touch_outputs(self):
        invalid = [
            snapshot("2026-08-26T10:07:00.000Z", self.slugs[:9]),
            snapshot("2026-08-26T10:07:00.000Z", [f"owner/repo-{index}" for index in range(76)]),
            snapshot("2026-08-26T10:07:00.000Z", self.slugs[:-1] + ["OWNER/REPO-0"]),
            snapshot("2026-08-26T10:07:00.000Z", self.slugs[:-1] + ["invalid"]),
            snapshot("2026-08-26 10:07:00Z", self.slugs),
            snapshot("2026-08-26T10:07:00.000Z", self.slugs, stats_date="2026-02-30"),
        ]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    record_membership(self.database, self.status, value)
                self.assertFalse(self.database.exists())
                self.assertFalse(self.status.exists())

    def test_page_and_latest_use_one_exact_live_run_identity(self):
        page, latest = page_and_latest(self.slugs)
        loaded = load_finalized_snapshot(page, latest)
        self.assertEqual(loaded.generated_at, latest["generatedAt"])
        self.assertEqual(loaded.stats_date, latest["statsDate"])
        self.assertEqual(loaded.slugs, tuple(self.slugs))

    def test_invalid_page_and_latest_identity_fail_before_touching_membership_outputs(self):
        page, latest = page_and_latest(self.slugs)
        alternate_snapshot = f"{latest['snapshotId'][:15]}{'0' * 16}"
        first_snapshot = page.index(latest["snapshotId"])
        second_snapshot = page.index(latest["snapshotId"], first_snapshot + len(latest["snapshotId"]))
        mixed_page = page[:second_snapshot] + alternate_snapshot + page[second_snapshot + len(latest["snapshotId"]):]
        mismatched_snapshot_page = page.replace(latest["snapshotId"], alternate_snapshot)
        mismatched_time_page = page.replace(latest["generatedAt"], "2026-08-26T10:07:00.999Z")
        cases = [
            (page, {key: value for key, value in latest.items() if key != "snapshotId"}),
            (page, {**latest, "unexpected": True}),
            (page, {**latest, "snapshotId": "invalid"}),
            (page, {**latest, "snapshotId": run_snapshot_id("2026-08-26T12:07:00.000Z")}),
            (mixed_page, latest),
            (mismatched_snapshot_page, latest),
            (mismatched_time_page, latest),
            (page, {**latest, "count": 11}),
            (page, {**latest, "statsDate": "2026-08-25"}),
            (page, {**latest, "repos": [{"slug": slug} for slug in self.slugs[:-1]] + [{"slug": "other/project"}]}),
        ]
        self.database.write_bytes(b"last-good-database")
        self.status.write_bytes(b"last-good-status")
        page_path = self.root / "index.html"
        latest_path = self.root / "latest.json"
        for index, (bad_page, bad_latest) in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    load_finalized_snapshot(bad_page, bad_latest)
                page_path.write_text(bad_page, encoding="utf-8")
                latest_path.write_text(json.dumps(bad_latest), encoding="utf-8")
                self.assertEqual(main([
                    "--page", str(page_path),
                    "--latest", str(latest_path),
                    "--database", str(self.database),
                    "--status", str(self.status),
                ]), 1)
                self.assertEqual(self.database.read_bytes(), b"last-good-database")
                self.assertEqual(self.status.read_bytes(), b"last-good-status")

    def test_schema_and_append_only_triggers_are_verified(self):
        record_membership(self.database, self.status, snapshot("2026-08-26T10:07:00.000Z", self.slugs))
        before_status = self.status.read_bytes()
        with closing(sqlite3.connect(self.database)) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE snapshots SET stats_date = '2026-08-25'")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM snapshot_members")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT OR REPLACE INTO snapshot_members(snapshot_id, ordinal, slug) VALUES (1, 0, 'other/project')"
                )

        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("DROP TRIGGER snapshots_no_update")
            connection.execute("CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT 1; END")
            connection.commit()
        before_database = self.database.read_bytes()

        with self.assertRaises(ValueError):
            record_membership(
                self.database,
                self.status,
                snapshot("2026-08-26T12:07:00.000Z", self.slugs),
            )
        self.assertEqual(self.database.read_bytes(), before_database)
        self.assertEqual(self.status.read_bytes(), before_status)

    def test_publication_validation_checks_db_json_page_latest_and_sidecars(self):
        page, latest = page_and_latest(self.slugs)
        current = load_finalized_snapshot(page, latest)
        record_membership(self.database, self.status, current)

        validated = validate_membership_publication(
            self.database,
            self.status,
            page,
            latest,
        )
        self.assertEqual(validated["generatedAt"], latest["generatedAt"])
        for suffix in ("-journal", "-wal", "-shm"):
            self.assertFalse(Path(f"{self.database}{suffix}").exists())

        Path(f"{self.database}-wal").write_bytes(b"residue")
        with self.assertRaises(ValueError):
            validate_membership_publication(self.database, self.status, page, latest)

    def test_baseline_file_size_is_measurable_and_contains_only_public_membership_fields(self):
        record_membership(self.database, self.status, snapshot("2026-08-26T10:07:00.000Z", self.slugs))

        self.assertGreater(self.database.stat().st_size, 0)
        with closing(sqlite3.connect(self.database)) as connection:
            projected = connection.execute(
                "SELECT generated_at, stats_date, slug_set_sha256, item_count, is_baseline FROM snapshots"
            ).fetchall()
            members = connection.execute(
                "SELECT snapshot_id, ordinal, slug FROM snapshot_members ORDER BY ordinal"
            ).fetchall()
        self.assertEqual(projected[0][0:2], ("2026-08-26T10:07:00.000Z", "2026-08-26"))
        self.assertRegex(projected[0][2], r"^[0-9a-f]{64}$")
        self.assertEqual(projected[0][3:], (10, 1))
        self.assertEqual([row[2] for row in members], self.slugs)
        self.assertEqual(
            projected[0][2],
            hashlib.sha256("\n".join(sorted(self.slugs)).encode("utf-8")).hexdigest(),
        )


if __name__ == "__main__":
    unittest.main()
