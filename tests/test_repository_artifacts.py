import hashlib
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from scripts.derive_repository_artifacts import (
    derive_daily_star_series,
    derive_membership_timeline,
    derive_repository_insights,
    derive_star_history,
    finalize_snapshot_derivatives,
    hash_pages_artifacts,
)
from scripts.record_repository_observations import (
    PAGES_BASE_ARTIFACT_PATHS,
    _file_sha256,
    _legacy_logical_rows,
    create_database,
    measure_legacy_baseline_receipt,
    prepare_candidate_database,
)
from scripts.record_trending_membership import MembershipSnapshot, record_membership
from tests.test_repository_observations import (
    bind_writer_inputs,
    canonical_hash,
    record_writer_snapshot,
    sha1,
    sha256,
    writer_events,
    writer_legacy_baselines,
    writer_payload,
)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def insert_run(connection, seq, utc, stats_date, repository_count=1):
    instant = datetime.strptime(utc, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    kst = instant.astimezone(timezone(timedelta(hours=9))).isoformat(timespec="milliseconds")
    snapshot_id = f"{instant.strftime('%Y%m%d%H%M%S')}-{seq:016x}"
    parent = connection.execute("SELECT snapshot_id,chain_sha256 FROM snapshot_runs WHERE snapshot_seq=?", (seq - 1,)).fetchone() if seq > 1 else None
    core = hashlib.sha256(f"core-{seq}".encode()).hexdigest()
    chain = hashlib.sha256(f"chain-{seq}".encode()).hexdigest()
    connection.execute(
        "INSERT INTO snapshot_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (seq, snapshot_id, "migration_baseline" if seq == 1 else "refresh", utc, kst, stats_date,
         None if parent is None else seq - 1, None if parent is None else parent[0], "a" * 40,
         "b" * 64, core, None if parent is None else parent[1], chain, repository_count),
    )
    return snapshot_id


def insert_profile(connection, profile_id, slug, display_slug=None):
    display_slug = display_slug or slug
    value = {
        "slug": slug, "display_slug": display_slug, "description": None, "primary_language": None,
        "topics": [], "license_spdx": None, "archived": False, "is_fork": False,
        "default_branch": "main", "created_at": "2026-01-01T00:00:00.000Z",
        "field_tags": ["unclassified"], "form_tags": [], "tag_rule_version": 1,
    }
    connection.execute(
        "INSERT INTO repository_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (profile_id, slug, display_slug, 1, None, None, "[]", None, 0, 0, "main",
         value["created_at"], '["unclassified"]', "[]", 1, digest(value)),
    )


def insert_item(connection, seq, slug, profile_id, *, stars, display_rank=1, daily=1,
                weekly=None, monthly=None, status="stayed"):
    columns = [row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")]
    row = {
        "snapshot_seq": seq, "slug": slug, "profile_id": profile_id, "display_rank": display_rank,
        "rank_daily": daily, "rank_weekly": weekly, "rank_monthly": monthly,
        "gain_daily": 0 if daily is not None else None, "gain_weekly": 0 if weekly is not None else None,
        "gain_monthly": 0 if monthly is not None else None, "language_color_daily": "#112233",
        "language_color_weekly": None, "language_color_monthly": None, "selected_language_color": "#112233",
        "selected_language_color_source_period": "daily", "stars": stars, "forks": 0,
        "watchers_count": 0, "subscribers": 0, "open_issues_and_pull_requests": 0, "contributors": 0,
        "updated_at": connection.execute("SELECT observed_at_utc FROM snapshot_runs WHERE snapshot_seq=?", (seq,)).fetchone()[0],
        "pushed_at": None, "default_branch_head_sha": "a" * 40,
        "previous_default_branch_head_sha": None, "head_transition": "baseline", "readme_status": "absent",
        "readme_path": None, "readme_blob_sha": None, "readme_content_sha256": None,
        "membership_status": "baseline_present" if seq == 1 else status, "release_count": 0,
        "release_inventory_sha256": hashlib.sha256(b"[]").hexdigest(), "latest_release_id": None,
        "estimate_collection_status": "complete_empty", "estimate_source_payload_sha256": "c" * 64,
        "estimate_point_count": 0, "summary_source_sha256": "d" * 64,
        "summary_content_sha256": "e" * 64, "summary_envelope_sha256": "f" * 64,
        "translation_status": "not_applicable:no_readme", "translation_source_sha256": None,
        "translation_envelope_sha256": None,
    }
    connection.execute(
        f"INSERT INTO snapshot_items ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
        tuple(row[column] for column in columns),
    )


def insert_estimate(connection, seq, slug, value, *, source="ossinsight_api", point_date="2026-08-01", payload_sha="9" * 64):
    present = value is not None
    connection.execute(
        "INSERT INTO historical_star_estimates VALUES (?,?,?,?,?,?,?,?)",
        (source, slug, point_date, int(present), value,
         digest({"slug": slug, "date": point_date, "is_present": present, "stars": value}),
         payload_sha, seq),
    )


def insert_public_baseline(connection, file_sha="7" * 64):
    connection.execute("INSERT INTO baseline_sources VALUES (?,?,?,?,?,?,?,?,?)", (
        "legacy_public_star_history", "data/legacy-public-star-history.json", 1, file_sha,
        "6" * 64, 1, "5" * 64, "{}", 1,
    ))


class RepositoryArtifactDerivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_required_derivation_interfaces_exist(self):
        from scripts.derive_repository_artifacts import (
            derive_daily_star_series,
            derive_membership_timeline,
            derive_repository_insights,
            derive_star_history,
            finalize_snapshot_derivatives,
            hash_pages_artifacts,
        )

        self.assertTrue(all(callable(value) for value in (
            derive_repository_insights,
            derive_daily_star_series,
            derive_membership_timeline,
            derive_star_history,
            hash_pages_artifacts,
            finalize_snapshot_derivatives,
        )))

    def test_insights_preserve_fractional_milliseconds_gap_rank_signs_and_nulls(self):
        database = self.root / "ledger.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            insert_run(connection, 1, "2026-08-28T00:00:00.125Z", "2026-08-28")
            insert_run(connection, 2, "2026-08-28T02:00:00.125Z", "2026-08-28")
            insert_run(connection, 3, "2026-08-28T04:00:01.876Z", "2026-08-28")
            insert_profile(connection, 1, "owner/repo", "Owner/Repo")
            insert_item(connection, 1, "owner/repo", 1, stars=100, display_rank=3, daily=3, weekly=None)
            insert_item(connection, 2, "owner/repo", 1, stars=95, display_rank=1, daily=1, weekly=2)
            insert_item(connection, 3, "owner/repo", 1, stars=110, display_rank=2, daily=2, weekly=None)
            exact = derive_repository_insights(connection, 2)[0]
            non_exact = derive_repository_insights(connection, 3)[0]
        self.assertEqual(exact["observation_gap_milliseconds"], 7_200_000)
        self.assertEqual(exact["stars_delta_since_previous_observation"], -5)
        self.assertEqual(exact["display_rank_delta"], 2)
        self.assertEqual(exact["rank_daily_delta"], 2)
        self.assertIsNone(exact["rank_weekly_delta"])
        self.assertEqual(exact["insight_sha256"], digest({key: value for key, value in exact.items() if key != "insight_sha256"}))
        self.assertEqual(non_exact["observation_gap_milliseconds"], 7_201_751)
        self.assertEqual(non_exact["display_rank_delta"], -1)
        self.assertIsNone(non_exact["rank_weekly_delta"])

    def test_daily_close_is_last_not_max_and_finalization_metrics_use_exact_dates(self):
        database = self.root / "ledger.sqlite"
        create_database(database)
        rows = [
            (1, "2026-08-01T00:00:00.000Z", "2026-08-01", "owner/repo", 0),
            (2, "2026-08-08T00:00:00.000Z", "2026-08-08", "owner/repo", 70),
            (3, "2026-08-15T00:00:00.000Z", "2026-08-15", "owner/repo", 300),
            (4, "2026-08-15T02:00:00.000Z", "2026-08-15", "owner/repo", 210),
            (5, "2026-08-15T04:00:00.000Z", "2026-08-15", "other/repo", 5),
            (6, "2026-08-16T00:00:00.000Z", "2026-08-16", "other/repo", 6),
        ]
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            for seq, utc, stats_date, _, _ in rows:
                insert_run(connection, seq, utc, stats_date)
            insert_profile(connection, 1, "owner/repo", "Owner/Repo")
            insert_profile(connection, 2, "other/repo", "Other/Repo")
            for seq, _, _, slug, stars in rows:
                insert_item(connection, seq, slug, 1 if slug == "owner/repo" else 2, stars=stars)
            result = derive_daily_star_series(connection, 6)
        owner = next(repo for repo in result["repositories"] if repo["slug"] == "owner/repo")
        close = next(point for point in owner["closes"] if point["date"] == "2026-08-15")
        self.assertEqual(close["stars"], 210)
        self.assertEqual(close["snapshot_seq"], 4)
        self.assertEqual(close["close_semantics"], "last_observed_before_exit")
        self.assertEqual(close["finalization"], "finalized")
        self.assertEqual(close["velocity_7d"], 20)
        self.assertEqual(close["acceleration_7d"], 10)
        self.assertIsNone(close["velocity_30d"])
        current = next(repo for repo in result["repositories"] if repo["slug"] == "other/repo")["closes"][-1]
        self.assertEqual(current["finalization"], "provisional")

    def test_star_history_applies_as_of_tombstone_and_public_exact_precedence(self):
        database = self.root / "ledger.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            for seq, utc, stats_date, stars in (
                (1, "2026-08-20T00:00:00.000Z", "2026-08-20", 100),
                (2, "2026-08-20T02:00:00.000Z", "2026-08-20", 90),
                (3, "2026-08-21T00:00:00.000Z", "2026-08-21", 95),
                (4, "2026-08-22T00:00:00.000Z", "2026-08-22", 96),
            ):
                insert_run(connection, seq, utc, stats_date)
                if seq == 1:
                    insert_profile(connection, 1, "owner/repo", "Owner/Repo")
                insert_item(connection, seq, "owner/repo", 1, stars=stars)
            insert_public_baseline(connection)
            insert_estimate(connection, 1, "owner/repo", 10)
            insert_estimate(connection, 2, "owner/repo", 20)
            insert_estimate(connection, 3, "owner/repo", None)
            insert_estimate(connection, 4, "owner/repo", 10)
            insert_estimate(connection, 1, "owner/repo", 7, source="legacy_star_history_cache", point_date="2026-07-01", payload_sha="7" * 64)
            insert_estimate(connection, 1, "owner/repo", 5, source="legacy_star_history_cache", point_date="2026-08-01", payload_sha="7" * 64)
            connection.execute("INSERT INTO historical_star_observations VALUES (?,?,?,?,?,?,?,?,?)", (
                "legacy_public_star_history", None, "owner/repo", "2026-08-20", 110, None, None,
                digest({"source": "legacy_public_star_history", "slug": "owner/repo", "observation_date": "2026-08-20", "stars": 110}), 1,
            ))
            connection.execute("INSERT INTO historical_star_observations VALUES (?,?,?,?,?,?,?,?,?)", (
                "legacy_star_observations_db", 1, "owner/repo", "2026-08-20", 999, 0, "github_rest",
                digest({"source": "legacy_star_observations_db", "legacy_row_id": 1, "slug": "owner/repo", "observation_date": "2026-08-20", "stars": 999, "stars_delta": 0, "legacy_source": "github_rest"}), 1,
            ))
            hash_a, hash_b = "1" * 64, "2" * 64
            connection.execute("INSERT INTO release_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                "owner/repo", 9, hash_a, 1, "v1", "A", "main", 0, 0,
                "2026-08-20T00:00:00.000Z", None, "https://github.com/owner/repo/releases/tag/v1"))
            connection.execute("INSERT INTO release_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                "owner/repo", 9, hash_b, 2, "v1", "B", "main", 0, 0,
                "2026-08-20T00:00:00.000Z", None, "https://github.com/owner/repo/releases/tag/v1"))
            for seq, metadata in ((1, hash_a), (2, hash_b), (3, hash_a)):
                connection.execute("INSERT INTO snapshot_release_items VALUES (?,?,?,?,?)", (seq, "owner/repo", 9, metadata, 0))
            at_removed = derive_star_history(connection, 3)
            at_reentry = derive_star_history(connection, 4)
            internal = derive_daily_star_series(connection, 4)
        self.assertEqual(at_removed["repositories"][0]["estimated"], [{"date": "2026-07-01", "stars": 7}])
        self.assertEqual(at_reentry["repositories"][0]["estimated"], [{"date": "2026-07-01", "stars": 7}, {"date": "2026-08-01", "stars": 10}])
        self.assertIn({"date": "2026-08-20", "stars": 90}, at_reentry["repositories"][0]["observed"])
        self.assertNotIn({"date": "2026-08-20", "stars": 999}, at_reentry["repositories"][0]["observed"])
        self.assertNotIn({"date": "2026-08-01", "stars": 10}, at_reentry["repositories"][0]["observed"])
        self.assertEqual(at_reentry["repositories"][0]["slug"], "Owner/Repo")
        self.assertEqual(internal["repositories"][0]["auxiliaryExact"][0]["stars"], 999)
        self.assertEqual(
            [row["inventory"][0]["metadataSha256"] for row in internal["repositories"][0]["releaseInventories"][:3]],
            ["1" * 64, "2" * 64, "1" * 64],
        )

    def test_star_history_applies_caps_after_selection_and_rejects_per_repo_baseline_hash(self):
        database = self.root / "ledger.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28")
            insert_profile(connection, 1, "owner/repo", "Owner/Repo")
            insert_item(connection, 1, "owner/repo", 1, stars=1)
            insert_public_baseline(connection)
            start = date.fromisoformat("2020-01-01")
            for index in range(501):
                point_date = (start + timedelta(days=index)).isoformat()
                insert_estimate(connection, 1, "owner/repo", index, source="legacy_star_history_cache", point_date=point_date, payload_sha="7" * 64)
            for index in range(731):
                point_date = (start + timedelta(days=index)).isoformat()
                stars = index
                connection.execute("INSERT INTO historical_star_observations VALUES (?,?,?,?,?,?,?,?,?)", (
                    "legacy_public_star_history", None, "owner/repo", point_date, stars, None, None,
                    digest({"source": "legacy_public_star_history", "slug": "owner/repo", "observation_date": point_date, "stars": stars}), 1,
                ))
            result = derive_star_history(connection, 1)
            self.assertEqual(len(result["repositories"][0]["estimated"]), 500)
            self.assertEqual(len(result["repositories"][0]["observed"]), 730)
            connection.execute("DROP TRIGGER historical_star_estimates_reject_update")
            connection.execute(
                """UPDATE historical_star_estimates SET source_payload_sha256=?
                   WHERE source='legacy_star_history_cache' AND slug='owner/repo'
                     AND estimate_date=(SELECT MIN(estimate_date) FROM historical_star_estimates
                                        WHERE source='legacy_star_history_cache' AND slug='owner/repo')""",
                ("8" * 64,),
            )
            with self.assertRaisesRegex(ValueError, "baseline identity"):
                derive_star_history(connection, 1)

    def test_membership_verifies_frozen_receipt_and_preserves_exact_contract(self):
        legacy = self.root / "trending-membership.sqlite"
        status = self.root / "membership-status.json"
        base = [f"Owner/Repo{index}" for index in range(41)]
        for index in range(7):
            slugs = list(base)
            if index >= 1:
                slugs[-1] = f"New/Repo{index}"
            record_membership(legacy, status, MembershipSnapshot(
                f"2026-08-{20 + index:02d}T00:00:00.000Z", f"2026-08-{20 + index:02d}", tuple(slugs),
            ))
        database = self.root / "ledger.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            snapshot_id = insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28")
            insert_run(connection, 2, "2026-08-28T02:00:00.000Z", "2026-08-28")
            target_id = insert_run(connection, 3, "2026-08-28T04:00:00.000Z", "2026-08-28", repository_count=2)
            insert_profile(connection, 1, "owner/repo0", "Owner/Repo0")
            insert_profile(connection, 2, "new/repo1", "New/Repo1")
            insert_profile(connection, 3, "other/repo2", "Other/Repo2")
            insert_item(connection, 1, "owner/repo0", 1, stars=1)
            insert_item(connection, 2, "new/repo1", 2, stars=2, status="new")
            insert_item(connection, 3, "owner/repo0", 1, stars=3, display_rank=1, status="reentered")
            insert_item(connection, 3, "other/repo2", 3, stars=4, display_rank=2, daily=2, status="new")
            schema, count, logical_hash, last = _legacy_logical_rows(legacy)
            connection.execute("INSERT INTO baseline_sources VALUES (?,?,?,?,?,?,?,?,?)", (
                "legacy_trending_membership", "data/trending-membership.sqlite", legacy.stat().st_size,
                _file_sha256(legacy), schema, count, logical_hash, last, 1,
            ))
            connection.commit()
            result = derive_membership_timeline(connection, legacy, 3)
        self.assertEqual(set(result), {"version", "targetSnapshotId", "legacySnapshots", "databaseSnapshots", "current", "exited", "events"})
        self.assertEqual(result["targetSnapshotId"], target_id)
        self.assertEqual(len(result["legacySnapshots"]), 7)
        self.assertEqual(sum(len(row["members"]) for row in result["legacySnapshots"]), 287)
        self.assertEqual(result["databaseSnapshots"][0]["members"][0]["status"], "baseline_present")
        self.assertEqual(result["exited"][0]["slug"], "new/repo1")
        self.assertEqual([row["status"] for row in result["current"]], ["reentered", "new"])
        self.assertEqual([row["status"] for row in result["events"][:2]], ["reentered", "new"])
        self.assertTrue(all(event["status"] in {"new", "reentered"} for event in result["events"]))
        legacy.write_bytes(legacy.read_bytes() + b"x")
        with closing(sqlite3.connect(database)) as connection:
            with self.assertRaisesRegex(ValueError, "receipt"):
                derive_membership_timeline(connection, legacy, 3)

    def test_artifacts_and_finalizer_are_complete_atomic_idempotent_and_toctou_safe(self):
        candidate_root = self.root / "candidate"
        database = candidate_root / "data" / "repository-observations.sqlite"
        database.parent.mkdir(parents=True)
        prepare_candidate_database(self.root / "missing.sqlite", database, None)
        baselines, receipt = writer_legacy_baselines(self.root)
        snapshot_id = "20260828010101-aaaaaaaaaaaaaaaa"
        payload = writer_payload(snapshot_id=snapshot_id, utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = baselines, receipt
        record_writer_snapshot(database, payload, writer_events(head=sha1(), transition="baseline"), {})
        for relative in PAGES_BASE_ARTIFACT_PATHS:
            target = candidate_root.joinpath(*relative.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(relative.encode())
        with closing(sqlite3.connect(database)) as connection:
            insights = derive_repository_insights(connection, 1)
        hashes = hash_pages_artifacts(candidate_root, PAGES_BASE_ARTIFACT_PATHS)
        hashes[0]["sha256"] = hashes[0]["sha256"]
        result = finalize_snapshot_derivatives(database, snapshot_id, insights, hashes)
        self.assertTrue(result.changed)
        self.assertFalse(finalize_snapshot_derivatives(database, snapshot_id, insights, hashes).changed)
        with closing(sqlite3.connect(database)) as connection:
            core = connection.execute("SELECT core_payload_sha256,chain_sha256 FROM snapshot_runs").fetchone()
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM repository_insights").fetchone(), (1,))
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM artifact_hashes").fetchone(), (len(PAGES_BASE_ARTIFACT_PATHS),))
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(core, connection.execute("SELECT core_payload_sha256,chain_sha256 FROM snapshot_runs").fetchone())

        second_root = self.root / "candidate2"
        second_database = second_root / "data" / "repository-observations.sqlite"
        second_database.parent.mkdir(parents=True)
        prepare_candidate_database(self.root / "missing2.sqlite", second_database, None)
        payload2 = writer_payload(snapshot_id=snapshot_id, utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload2["legacyBaselines"], payload2["legacyBaselineReceipt"] = baselines, receipt
        record_writer_snapshot(second_database, payload2, writer_events(head=sha1(), transition="baseline"), {})
        for relative in PAGES_BASE_ARTIFACT_PATHS:
            target = second_root.joinpath(*relative.split("/")); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(relative.encode())
        with closing(sqlite3.connect(second_database)) as connection:
            second_insights = derive_repository_insights(connection, 1)
        stale_hashes = hash_pages_artifacts(second_root, PAGES_BASE_ARTIFACT_PATHS)
        second_root.joinpath(*PAGES_BASE_ARTIFACT_PATHS[0].split("/")).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "changed"):
            finalize_snapshot_derivatives(second_database, snapshot_id, second_insights, stale_hashes)
        with closing(sqlite3.connect(second_database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM repository_insights").fetchone(), (0,))
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM artifact_hashes").fetchone(), (0,))


if __name__ == "__main__":
    unittest.main()
