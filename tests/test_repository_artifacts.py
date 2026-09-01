import hashlib
import io
import json
import sqlite3
import tempfile
import traceback
import unittest
import xml.etree.ElementTree as ET
from contextlib import closing, redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import scripts.derive_repository_artifacts as repository_artifacts
import scripts.record_repository_observations as repository_ledger
from scripts.derive_repository_artifacts import (
    _utc_milliseconds,
    derive_daily_star_series,
    derive_candidate_artifacts,
    derive_membership_timeline,
    derive_repository_insights,
    derive_star_history,
    export_parent_inputs,
    finalize_snapshot_derivatives,
    hash_pages_artifacts,
    verify_pages_artifacts,
)
from scripts.generate_atom_feeds import ATOM_NAMESPACE, generate_atom_feeds_from_timeline
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
    schema = connection.execute("SELECT schema_fingerprint_sha256 FROM schema_meta").fetchone()[0]
    chain = digest({
        "schema_fingerprint_sha256": schema,
        "parent_chain_sha256": None if parent is None else parent[1],
        "core_payload_sha256": core,
        "snapshot_id": snapshot_id,
        "snapshot_seq": seq,
    })
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
                weekly=None, monthly=None, status="stayed", head="a" * 40,
                translation_applicable=False):
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
        "pushed_at": None, "default_branch_head_sha": head,
        "previous_default_branch_head_sha": None, "head_transition": "baseline",
        "readme_status": "present" if translation_applicable else "absent",
        "readme_path": "README.md" if translation_applicable else None,
        "readme_blob_sha": "b" * 40 if translation_applicable else None,
        "readme_content_sha256": "c" * 64 if translation_applicable else None,
        "membership_status": "baseline_present" if seq == 1 else status, "release_count": 0,
        "release_inventory_sha256": hashlib.sha256(b"[]").hexdigest(), "latest_release_id": None,
        "estimate_collection_status": "complete_empty", "estimate_source_payload_sha256": "c" * 64,
        "estimate_point_count": 0, "summary_source_sha256": "d" * 64,
        "summary_content_sha256": "e" * 64, "summary_envelope_sha256": "f" * 64,
        "translation_status": "applicable" if translation_applicable else "not_applicable:no_readme",
        "translation_source_sha256": "1" * 64 if translation_applicable else None,
        "translation_envelope_sha256": "2" * 64 if translation_applicable else None,
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
            derive_candidate_artifacts,
            derive_daily_star_series,
            derive_membership_timeline,
            derive_repository_insights,
            derive_star_history,
            export_parent_inputs,
            finalize_snapshot_derivatives,
            hash_pages_artifacts,
            verify_pages_artifacts,
        )

        self.assertTrue(all(callable(value) for value in (
            derive_repository_insights,
            derive_candidate_artifacts,
            derive_daily_star_series,
            derive_membership_timeline,
            derive_star_history,
            hash_pages_artifacts,
            export_parent_inputs,
            verify_pages_artifacts,
            finalize_snapshot_derivatives,
        )))

    def test_missing_parent_export_is_content_free_and_bound_to_baseline_receipt(self):
        receipt = {"version": 1, "sources": {}}
        evidence_path = self.root / "parent-evidence.json"
        heads_path = self.root / "prior-heads.json"
        result = export_parent_inputs(
            self.root / "missing-parent.sqlite",
            receipt,
            None,
            "a" * 40,
            evidence_path,
            heads_path,
        )
        self.assertEqual(result, {"parent_snapshot_id": None, "head_count": 0})
        self.assertEqual(json.loads(evidence_path.read_text(encoding="utf-8")), {
            "version": 1,
            "parent_database": {"missing": True},
            "production_source_sha": "a" * 40,
            "historical_heads": {"scope": "all_historical", "head_count": 0, "heads_sha256": digest({})},
            "legacy_baseline_receipt": receipt,
        })
        self.assertEqual(json.loads(heads_path.read_text(encoding="utf-8")), {
            "version": 1,
            "snapshotId": None,
            "scope": "all_historical",
            "parentDatabaseSha256": None,
            "snapshotSeq": None,
            "headCount": 0,
            "headsSha256": digest({}),
            "heads": {},
        })

    def test_parent_export_includes_last_head_for_every_historical_slug(self):
        database = self.root / "parent.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28", repository_count=2)
            parent_snapshot_id = insert_run(
                connection,
                2,
                "2026-08-28T02:00:00.000Z",
                "2026-08-28",
                repository_count=1,
            )
            insert_profile(connection, 1, "owner/a")
            insert_profile(connection, 2, "owner/b")
            insert_item(connection, 1, "owner/a", 1, stars=1, display_rank=1, daily=1, head="a" * 40)
            insert_item(connection, 1, "owner/b", 2, stars=2, display_rank=2, daily=2, head="b" * 40)
            insert_item(connection, 2, "owner/a", 1, stars=3, display_rank=1, daily=1, head="c" * 40)
            connection.commit()

        evidence_path = self.root / "parent-evidence.json"
        heads_path = self.root / "prior-heads.json"
        export_parent_inputs(database, {"version": 1, "sources": {}}, parent_snapshot_id, "b" * 40, evidence_path, heads_path)
        payload = json.loads(heads_path.read_text(encoding="utf-8"))
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        expected_heads = {
            "owner/a": {"branch": "main", "headSha": "c" * 40},
            "owner/b": {"branch": "main", "headSha": "b" * 40},
        }
        self.assertEqual(payload, {
            "version": 1,
            "snapshotId": parent_snapshot_id,
            "scope": "all_historical",
            "parentDatabaseSha256": _file_sha256(database),
            "snapshotSeq": 2,
            "headCount": 2,
            "headsSha256": digest(expected_heads),
            "heads": expected_heads,
        })
        self.assertIn("owner/b", payload["heads"])
        self.assertNotIn("owner/c", payload["heads"])
        self.assertEqual(evidence["historical_heads"], {
            "scope": "all_historical",
            "head_count": 2,
            "heads_sha256": digest(expected_heads),
        })
        self.assertEqual(evidence["production_source_sha"], "b" * 40)

    def test_parent_verifier_remeasures_v1_and_exact_missing_parent_receipts(self):
        database = self.root / "parent.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            snapshot_id = insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28", repository_count=2)
            insert_profile(connection, 1, "owner/a")
            insert_profile(connection, 2, "owner/b")
            insert_item(connection, 1, "owner/a", 1, stars=1, display_rank=1, daily=1, head="a" * 40)
            insert_item(connection, 1, "owner/b", 2, stars=2, display_rank=2, daily=2, head="b" * 40)
            connection.commit()
        evidence_path = self.root / "parent-evidence.json"
        heads_path = self.root / "prior-heads.json"
        export_parent_inputs(database, {"version": 1, "sources": {}}, snapshot_id, "b" * 40, evidence_path, heads_path)
        self.assertEqual(repository_artifacts.verify_parent_inputs(database, evidence_path, heads_path), {"verified": True, "version": 1})
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(repository_artifacts.main([
                "verify-parent-inputs", "--parent-database", str(database),
                "--parent-evidence", str(evidence_path), "--prior-heads", str(heads_path),
            ]), 0)
        self.assertEqual(output.getvalue(), '{"verified":true,"version":1}\n')

        for label, source_sha in (("v0", "c" * 40), ("404", "d" * 40)):
            with self.subTest(label=label):
                missing = self.root / f"missing-{label}.sqlite"
                missing_evidence = self.root / f"missing-{label}-evidence.json"
                missing_heads = self.root / f"missing-{label}-heads.json"
                export_parent_inputs(missing, {"version": 1, "sources": {}}, None, source_sha, missing_evidence, missing_heads)
                self.assertEqual(repository_artifacts.verify_parent_inputs(missing, missing_evidence, missing_heads), {"verified": True, "version": 1})

    def test_parent_verifier_rejects_self_rehashed_partial_receipt_and_database_swap(self):
        database = self.root / "parent.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            snapshot_id = insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28", repository_count=2)
            insert_profile(connection, 1, "owner/a")
            insert_profile(connection, 2, "owner/b")
            insert_item(connection, 1, "owner/a", 1, stars=1, display_rank=1, daily=1, head="a" * 40)
            insert_item(connection, 1, "owner/b", 2, stars=2, display_rank=2, daily=2, head="b" * 40)
            connection.commit()
        evidence_path = self.root / "parent-evidence.json"
        heads_path = self.root / "prior-heads.json"
        export_parent_inputs(database, {"version": 1, "sources": {}}, snapshot_id, "b" * 40, evidence_path, heads_path)

        partial = json.loads(heads_path.read_text(encoding="utf-8"))
        partial["heads"].pop("owner/b")
        partial["headCount"] = len(partial["heads"])
        partial["headsSha256"] = digest(partial["heads"])
        partial_path = self.root / "partial-heads.json"
        partial_path.write_text(json.dumps(partial), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "parent input receipt mismatch"):
            repository_artifacts.verify_parent_inputs(database, evidence_path, partial_path)

        swapped = self.root / "swapped.sqlite"
        swapped.write_bytes(database.read_bytes())
        with closing(sqlite3.connect(swapped)) as connection:
            insert_profile(connection, 3, "owner/c")
            connection.commit()
        with self.assertRaisesRegex(ValueError, "parent database evidence mismatch"):
            repository_artifacts.verify_parent_inputs(swapped, evidence_path, heads_path)

        with closing(sqlite3.connect(database)) as connection:
            insert_run(connection, 2, "2026-08-28T02:00:00.000Z", "2026-08-28", repository_count=2)
            insert_item(connection, 2, "owner/a", 1, stars=3, display_rank=1, daily=1, head="c" * 40)
            insert_item(connection, 2, "owner/b", 2, stars=4, display_rank=2, daily=2, head="d" * 40)
            connection.commit()
        with self.assertRaisesRegex(ValueError, "parent database evidence mismatch"):
            repository_artifacts.verify_parent_inputs(database, evidence_path, heads_path)

    def test_parent_verifier_does_not_reopen_source_between_byte_and_logical_measurements(self):
        database = self.root / "parent-aba.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            snapshot_id = insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28")
            insert_profile(connection, 1, "owner/a")
            insert_item(connection, 1, "owner/a", 1, stars=1, display_rank=1, daily=1, head="a" * 40)
            connection.commit()
        evidence_path = self.root / "parent-aba-evidence.json"
        heads_path = self.root / "parent-aba-heads.json"
        export_parent_inputs(database, {"version": 1, "sources": {}}, snapshot_id, "b" * 40, evidence_path, heads_path)

        original = self.root / "parent-aba-original.sqlite"
        replacement = self.root / "parent-aba-replacement.sqlite"
        replacement.write_bytes(database.read_bytes())
        with closing(sqlite3.connect(replacement)) as connection:
            # This changes the bytes without changing any reviewed table/head
            # evidence, so a digest/logical/digest sequence can be fooled.
            connection.execute("PRAGMA application_id=7")
        original_digest = repository_ledger._file_sha256
        original_connect = repository_ledger.sqlite3.connect
        state = {"armed": True, "executed": False, "restored": False}

        def digest_then_swap(path):
            result = original_digest(path)
            if state["armed"] and Path(path).resolve(strict=False) == database.resolve(strict=False):
                state["armed"] = False
                database.replace(original)
                replacement.replace(database)
                state["executed"] = True
            return result

        class RestoreAfterMeasure:
            def __init__(self, connection):
                self.connection = connection

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def close(self):
                self.connection.close()
                database.replace(replacement)
                original.replace(database)
                state["restored"] = True

        def connect_then_restore(target, *args, **kwargs):
            connection = original_connect(target, *args, **kwargs)
            if state["executed"] and not state["restored"] and database.name in str(target):
                return RestoreAfterMeasure(connection)
            return connection

        try:
            with patch.object(repository_ledger, "_file_sha256", side_effect=digest_then_swap), \
                    patch.object(repository_ledger.sqlite3, "connect", side_effect=connect_then_restore):
                self.assertEqual(
                    repository_artifacts.verify_parent_inputs(database, evidence_path, heads_path),
                    {"verified": True, "version": 1},
                )
            self.assertFalse(state["executed"], "verifier reopened the mutable source path between measurements")
        finally:
            if not state["restored"] and original.exists():
                database.unlink(missing_ok=True)
                original.replace(database)

    def assert_sanitized_failure(self, action, expected_message, forbidden):
        try:
            action()
        except Exception as error:
            rendered = "".join(traceback.format_exception(error))
            self.assertEqual(str(error), expected_message)
            for value in forbidden:
                self.assertNotIn(value, str(error))
                self.assertNotIn(value, rendered)
        else:
            self.fail("expected a sanitized failure")

    def test_failures_do_not_expose_hostile_values_or_absolute_paths(self):
        sentinel = "HOSTILE_DB_VALUE_97d3"
        absolute_root = str(self.root.resolve())
        forbidden = (sentinel, absolute_root)

        self.assert_sanitized_failure(
            lambda: _utc_milliseconds(f"{sentinel}:{absolute_root}"),
            "snapshot time is invalid",
            forbidden,
        )

        missing_root = self.root / sentinel / "missing-candidate"
        missing_root.mkdir(parents=True)
        self.assert_sanitized_failure(
            lambda: hash_pages_artifacts(missing_root, PAGES_BASE_ARTIFACT_PATHS),
            "artifact file is unavailable",
            forbidden,
        )

        readable_root = self.root / sentinel / "read-candidate"
        for relative in PAGES_BASE_ARTIFACT_PATHS:
            target = readable_root.joinpath(*relative.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(relative.encode())
        with patch.object(Path, "read_bytes", side_effect=OSError(f"{sentinel}:{absolute_root}")):
            self.assert_sanitized_failure(
                lambda: hash_pages_artifacts(readable_root, PAGES_BASE_ARTIFACT_PATHS),
                "artifact file is unavailable",
                forbidden,
            )

        database = self.root / sentinel / "candidate" / "data" / "repository-observations.sqlite"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"candidate")
        with patch(
            "scripts.derive_repository_artifacts.sqlite3.connect",
            side_effect=sqlite3.DatabaseError(f"{sentinel}:{absolute_root}"),
        ):
            self.assert_sanitized_failure(
                lambda: finalize_snapshot_derivatives(database, "snapshot", [], []),
                "candidate database finalization failed",
                forbidden,
            )

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

    def test_s1_s2_s3_membership_flows_from_ledger_to_json_atom_and_reentry(self):
        baselines, _ = writer_legacy_baselines(self.root)
        legacy = Path(baselines["legacy_trending_membership"])
        legacy.unlink()
        legacy_status = self.root / "legacy-membership-status.json"
        legacy_slugs = tuple(f"legacy/repo-{index}" for index in range(41))
        for day in range(20, 27):
            record_membership(legacy, legacy_status, MembershipSnapshot(
                f"2026-08-{day:02d}T00:00:00.000Z", f"2026-08-{day:02d}", legacy_slugs,
            ))
        receipt = measure_legacy_baseline_receipt(baselines)

        def payload(snapshot_id, utc, kst, kind, parent, slugs):
            value = writer_payload(
                snapshot_id=snapshot_id, utc=utc, kst=kst, stats_date="2026-08-28",
                run_kind=kind, parent_snapshot_id=parent,
            )
            repository_template = value["repositories"][0]
            summary_template = value["enrichmentIndex"]["owner/repo"]["summary"]
            repositories = []
            summaries = {}
            for rank, slug in enumerate(slugs, start=1):
                repository = json.loads(json.dumps(repository_template))
                repository.update({"slug": slug, "displaySlug": slug, "displayRank": rank, "rankDaily": rank})
                repository["provenance"]["repository"]["api_path"] = f"/repos/{slug}"
                repository["provenance"]["contributors"]["api_path"] = f"/repos/{slug}/contributors"
                repository["provenance"]["default_branch_head"]["api_path"] = f"/repos/{slug}/commits/main"
                repository["provenance"]["readme"].update({
                    "api_path": f"/repos/{slug}/readme",
                    "blob_api_path": f"/repos/{slug}/git/blobs/{sha1('b')}",
                    "variant_tree_api_path": f"/repos/{slug}/git/trees/{sha1()}",
                })
                repository["provenance"]["trending"]["daily"]["rank"] = rank
                repositories.append(repository)
                summary = json.loads(json.dumps(summary_template))
                summary["source"]["slug"] = slug
                summaries[slug] = {"summary": summary}
            value["repositories"] = repositories
            value["enrichmentIndex"] = summaries
            value["legacyBaselines"], value["legacyBaselineReceipt"] = baselines, receipt
            return value

        def events(slugs, transitions):
            return {
                "heads": [
                    {"slug": slug, "branch": "main", "headSha": sha1(), "transition": transitions[slug]}
                    for slug in slugs
                ],
                "releases": [], "latestReleaseIds": {slug: None for slug in slugs}, "commits": [],
                "estimates": [
                    {"slug": slug, "rows": [], "sourcePayloadSha256": sha256("b"), "publicRows": []}
                    for slug in slugs
                ],
            }

        stable = [f"owner/stable-{index}" for index in range(9)]
        returning = "owner/returning"
        newcomer = "owner/newcomer"
        s1_slugs = [*stable, returning]
        s2_slugs = [*stable, newcomer]
        s3_slugs = [*stable, newcomer, returning]
        times = [
            ("2026-08-28T01:01:01.001Z", "2026-08-28T10:01:01.001+09:00"),
            ("2026-08-28T03:01:01.001Z", "2026-08-28T12:01:01.001+09:00"),
            ("2026-08-28T05:01:01.001Z", "2026-08-28T14:01:01.001+09:00"),
        ]
        ids = [
            f"{''.join(character for character in utc if character.isdigit())[:14]}-{hashlib.sha256(f'{utc}|run-context-v1'.encode()).hexdigest()[:16]}"
            for utc, _ in times
        ]
        candidate = self.root / "s1-s2-s3.sqlite"
        prepare_candidate_database(self.root / "missing.sqlite", candidate, None)
        state = {}

        s1_payload = payload(ids[0], *times[0], "migration_baseline", None, s1_slugs)
        record_writer_snapshot(candidate, s1_payload, events(s1_slugs, {slug: "baseline" for slug in s1_slugs}), state)
        s1 = derive_candidate_artifacts(candidate, legacy, s1_payload["enrichmentIndex"], ids[0])
        self.assertTrue(s1["membership_status"]["baseline"])
        self.assertEqual({row["status"] for row in s1["membership_status"]["current"]}, {"baseline"})
        self.assertEqual(s1["membership_status"]["exited"], [])

        s2_payload = payload(ids[1], *times[1], "refresh", ids[0], s2_slugs)
        s2_transitions = {slug: "unchanged" for slug in stable}
        s2_transitions[newcomer] = "baseline"
        record_writer_snapshot(candidate, s2_payload, events(s2_slugs, s2_transitions), state)
        s2 = derive_candidate_artifacts(candidate, legacy, s2_payload["enrichmentIndex"], ids[1])
        s2_status = {row["slug"]: row["status"] for row in s2["membership_status"]["current"]}
        self.assertFalse(s2["membership_status"]["baseline"])
        self.assertEqual(s2_status[newcomer], "new")
        self.assertEqual({row["slug"] for row in s2["membership_status"]["exited"]}, {returning})

        s3_payload = payload(ids[2], *times[2], "refresh", ids[1], s3_slugs)
        record_writer_snapshot(candidate, s3_payload, events(s3_slugs, {slug: "unchanged" for slug in s3_slugs}), state)
        s3 = derive_candidate_artifacts(candidate, legacy, s3_payload["enrichmentIndex"], ids[2])
        s3_status = {row["slug"]: row["status"] for row in s3["membership_status"]["current"]}
        self.assertEqual(s3_status[newcomer], "stayed")
        self.assertEqual(s3_status[returning], "reentered")
        self.assertEqual(s3["membership_status"]["exited"], [])

        with closing(sqlite3.connect(candidate)) as connection:
            timeline = derive_membership_timeline(connection, legacy, 3)
        snapshot = s3["snapshot_export"]
        latest = {
            "snapshotId": snapshot["snapshotId"], "generatedAt": snapshot["generatedAt"],
            "statsDate": snapshot["statsDate"], "count": len(snapshot["repositories"]),
            "repos": snapshot["repositories"],
        }
        page_repositories = [{
            "slug": repository["slug"], "desc": repository["description"],
            "tag_rule_version": repository["tag_rule_version"], "field_tags": repository["field_tags"],
            "form_tags": repository["form_tags"], "_snapshot_id": latest["snapshotId"],
            "_generated_at": latest["generatedAt"], "_stats_date": latest["statsDate"],
        } for repository in latest["repos"]]
        page = f"// GENERATED:TRENDING-REPOS:START\nconst REPOS = {json.dumps(page_repositories)};\n// GENERATED:TRENDING-REPOS:END\n"
        feed, changes = self.root / "s3-feed.xml", self.root / "s3-changes.xml"
        self.assertTrue(generate_atom_feeds_from_timeline(page, latest, timeline, feed, changes))
        namespace = {"atom": ATOM_NAMESPACE}
        change_rows = {
            (entry.find("atom:link", namespace).get("href").removeprefix("https://github.com/"),
             entry.find("atom:category", namespace).get("term"))
            for entry in ET.parse(changes).getroot().findall("atom:entry", namespace)
        }
        self.assertIn((newcomer, "new"), change_rows)
        self.assertIn((returning, "reentered"), change_rows)

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
        contract = verify_pages_artifacts(database, snapshot_id, candidate_root)
        self.assertEqual(contract["snapshotId"], snapshot_id)
        self.assertEqual(
            [row["artifact_path"] for row in contract["artifacts"]],
            sorted(PAGES_BASE_ARTIFACT_PATHS),
        )
        contract_target = candidate_root.joinpath(*PAGES_BASE_ARTIFACT_PATHS[0].split("/"))
        contract_bytes = contract_target.read_bytes()
        contract_target.write_bytes(b"contract mutation")
        with self.assertRaisesRegex(ValueError, "contract"):
            verify_pages_artifacts(database, snapshot_id, candidate_root)
        contract_target.write_bytes(contract_bytes)
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
