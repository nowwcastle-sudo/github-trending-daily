import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import closing
from unittest import mock

import scripts.scan_repository_observations as scanner_module
from scripts.record_repository_observations import SCHEMA_STATEMENTS, create_database
from tests.test_repository_observations import (
    complete_fixture,
    recompute_profile_hash,
    recompute_snapshot_chain,
)


ROOT = Path(__file__).resolve().parents[1]
SCANNER = ROOT / "scripts" / "scan_repository_observations.py"
SNAPSHOT_ID = "20260828010101-aaaaaaaaaaaaaaaa"


def _trigger_statement(name):
    marker = f"CREATE TRIGGER {name} "
    return next(statement for statement in SCHEMA_STATEMENTS if marker in statement)


def make_valid_database(path):
    create_database(path)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        complete_fixture(connection)
        connection.commit()


def set_live_description(path, value):
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("DROP TRIGGER repository_profiles_reject_update")
        connection.execute(
            "UPDATE repository_profiles SET description = ? WHERE profile_id = 1",
            (value,),
        )
        recompute_profile_hash(connection)
        connection.execute(_trigger_statement("repository_profiles_reject_update"))
        connection.commit()


def set_snapshot_id(path, snapshot_id):
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("DROP TRIGGER snapshot_runs_reject_update")
        connection.execute(
            "UPDATE snapshot_runs SET snapshot_id = ? WHERE snapshot_seq = 1",
            (snapshot_id,),
        )
        recompute_snapshot_chain(connection, 1)
        connection.execute(_trigger_statement("snapshot_runs_reject_update"))
        connection.commit()


def leave_freelist_payload(path, value, *, encoding="ascii"):
    padding = "Q" * 262144
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA secure_delete = OFF")
        connection.execute("DROP TRIGGER repository_profiles_reject_delete")
        connection.execute(
            """INSERT INTO repository_profiles VALUES
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                2,
                "unused/repository",
                "unused/repository",
                1,
                "P" * 4096 + value + padding,
                None,
                "[]",
                None,
                0,
                0,
                "main",
                "2026-08-28T01:01:01.001Z",
                '["unclassified"]',
                "[]",
                1,
                "0" * 64,
            ),
        )
        connection.execute("DELETE FROM repository_profiles WHERE profile_id = 2")
        connection.execute(_trigger_statement("repository_profiles_reject_delete"))
        connection.commit()
        freelist_count = connection.execute("PRAGMA freelist_count").fetchone()[0]
    if freelist_count < 1:
        raise AssertionError("fixture did not create a freelist page")

    raw = bytearray(path.read_bytes())
    original = value.encode("ascii")
    offset = raw.find(original)
    if offset < 0:
        raise AssertionError("fixture payload was not retained in raw SQLite bytes")
    if encoding != "ascii":
        encoded = value.encode(encoding)
        raw[offset : offset + len(encoded)] = encoded
        path.write_bytes(raw)


def run_scanner(path, expected=SNAPSHOT_ID, *extra):
    return subprocess.run(
        [
            sys.executable,
            str(SCANNER),
            "--database",
            str(path),
            "--expect-snapshot",
            expected,
            *extra,
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def parse_receipt(completed):
    lines = completed.stdout.splitlines()
    if len(lines) != 1:
        raise AssertionError(f"expected one stdout line, got {len(lines)}")
    return json.loads(lines[0].decode("utf-8"))


def _git_materialize(repo, destination):
    with destination.open("wb") as output:
        subprocess.run(
            ["git", "show", ":data/repository-observations.sqlite"],
            cwd=repo,
            stdout=output,
            stderr=subprocess.PIPE,
            check=True,
        )


def scan_staged_blob(repo, expected=SNAPSHOT_ID, *, materialize=_git_materialize, scanner=run_scanner):
    handle, name = tempfile.mkstemp(prefix="staged-observations-", suffix=".sqlite")
    os.close(handle)
    Path(name).unlink()
    try:
        materialize(repo, Path(name))
        return scanner(Path(name), expected)
    finally:
        Path(name).unlink(missing_ok=True)


class RepositoryObservationScannerTests(unittest.TestCase):
    def test_valid_database_returns_content_free_receipt_without_mutating_file(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "observations.sqlite"
            make_valid_database(database)
            before = database.read_bytes()

            completed = run_scanner(database)

            self.assertEqual(completed.returncode, 0)
            self.assertEqual(completed.stderr, b"")
            receipt = parse_receipt(completed)
            self.assertEqual(receipt["ok"], True)
            self.assertEqual(receipt["schemaVersion"], 1)
            self.assertEqual(receipt["tableCount"], 14)
            self.assertEqual(receipt["expectedSnapshotCount"], 1)
            self.assertGreater(receipt["rowCount"], 0)
            self.assertGreater(receipt["logicalCellCount"], receipt["rowCount"])
            self.assertEqual(receipt["databaseSha256"], hashlib.sha256(before).hexdigest())
            self.assertEqual(receipt["databaseSha256Prefix"], hashlib.sha256(before).hexdigest()[:12])
            self.assertEqual(receipt["rawByteSize"], len(before))
            self.assertEqual(database.read_bytes(), before)
            self.assertFalse(Path(f"{database}-journal").exists())
            self.assertFalse(Path(f"{database}-wal").exists())
            self.assertFalse(Path(f"{database}-shm").exists())

    def test_zero_truncated_and_corrupt_databases_fail_without_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = root / "valid.sqlite"
            make_valid_database(valid)
            variants = {
                "zero": b"",
                "truncated": valid.read_bytes()[:100],
                "corrupt": b"not a sqlite database\x00" * 100,
            }
            for label, raw in variants.items():
                with self.subTest(label=label):
                    database = root / f"{label}.sqlite"
                    database.write_bytes(raw)
                    completed = run_scanner(database)
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertEqual(completed.stderr, b"")
                    self.assertEqual(parse_receipt(completed), {"error": "database-unreadable", "ok": False})
                    self.assertNotIn(b"Traceback", completed.stdout)

    def test_noncanonical_schema_is_rejected_before_table_or_column_details(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "observations.sqlite"
            make_valid_database(database)
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("ALTER TABLE schema_meta ADD COLUMN hostile_column TEXT")
            completed = run_scanner(database)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stderr, b"")
            self.assertEqual(parse_receipt(completed), {"error": "schema-invalid", "ok": False})
            self.assertNotIn(b"hostile_column", completed.stdout)

    def test_each_live_secret_family_is_reported_without_the_value(self):
        families = {
            "github-token": "ghp_" + "A" * 24,
            "github-pat": "github" + "_pat_" + "B" * 32,
            "anthropic-key": "sk-" + "ant-" + "C" * 24,
            "google-api-key": "AI" + "za" + "D" * 32,
            "private-key-header": "-----BEGIN " + "PRIVATE KEY-----",
        }
        with tempfile.TemporaryDirectory() as directory:
            for pattern_id, secret in families.items():
                with self.subTest(pattern_id=pattern_id):
                    database = Path(directory) / f"{pattern_id}.sqlite"
                    make_valid_database(database)
                    set_live_description(database, secret)
                    completed = run_scanner(database)
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertEqual(completed.stderr, b"")
                    receipt = parse_receipt(completed)
                    self.assertEqual(receipt["error"], "secret-pattern-detected")
                    self.assertIn(pattern_id, receipt["patternIds"])
                    self.assertIn(
                        {"column": "description", "patternId": pattern_id, "table": "repository_profiles"},
                        receipt["locations"],
                    )
                    self.assertNotIn(secret.encode(), completed.stdout)

    def test_multiword_private_key_header_is_detected_in_a_logical_text_cell(self):
        secret = "-----BEGIN " + "OPEN SSH " + "PRIVATE KEY-----"
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "logical-private-key.sqlite"
            make_valid_database(database)
            set_live_description(database, secret)

            completed = run_scanner(database)

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stderr, b"")
            receipt = parse_receipt(completed)
            self.assertIn("private-key-header", receipt["patternIds"])
            self.assertIn(
                {
                    "column": "description",
                    "patternId": "private-key-header",
                    "table": "repository_profiles",
                },
                receipt["locations"],
            )
            self.assertNotIn(secret.encode(), completed.stdout)

    def test_multiword_private_key_header_is_detected_in_each_raw_encoding(self):
        secret = "-----BEGIN " + "CERTIFICATE AUTHORITY " + "PRIVATE KEY-----"
        with tempfile.TemporaryDirectory() as directory:
            for encoding in ("ascii", "utf-16le", "utf-16be"):
                with self.subTest(encoding=encoding):
                    database = Path(directory) / f"raw-private-{encoding}.sqlite"
                    make_valid_database(database)
                    leave_freelist_payload(database, secret, encoding=encoding)

                    completed = run_scanner(database)

                    self.assertNotEqual(completed.returncode, 0)
                    self.assertEqual(completed.stderr, b"")
                    receipt = parse_receipt(completed)
                    self.assertIn("private-key-header", receipt["patternIds"])
                    self.assertEqual(receipt["locations"], [])
                    self.assertNotIn(secret.encode(), completed.stdout)

    def test_raw_ascii_utf16le_and_utf16be_secret_matrix(self):
        secret = "github" + "_pat_" + "Z" * 40
        with tempfile.TemporaryDirectory() as directory:
            for encoding in ("ascii", "utf-16le", "utf-16be"):
                with self.subTest(encoding=encoding):
                    database = Path(directory) / f"raw-{encoding}.sqlite"
                    make_valid_database(database)
                    leave_freelist_payload(database, secret, encoding=encoding)
                    completed = run_scanner(database)
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertEqual(completed.stderr, b"")
                    receipt = parse_receipt(completed)
                    self.assertEqual(receipt["error"], "secret-pattern-detected")
                    self.assertIn("github-pat", receipt["patternIds"])
                    self.assertEqual(receipt.get("locations"), [])
                    self.assertNotIn(secret.encode(), completed.stdout)

    def test_secret_retained_only_on_freelist_is_detected(self):
        secret = "sk-" + "ant-" + "F" * 40
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "freelist.sqlite"
            make_valid_database(database)
            leave_freelist_payload(database, secret)
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM repository_profiles").fetchone()[0], 1)
                self.assertGreater(connection.execute("PRAGMA freelist_count").fetchone()[0], 0)
            completed = run_scanner(database)
            self.assertNotEqual(completed.returncode, 0)
            receipt = parse_receipt(completed)
            self.assertIn("anthropic-key", receipt["patternIds"])
            self.assertEqual(receipt["locations"], [])
            self.assertNotIn(secret.encode(), completed.stdout)

    def test_expected_snapshot_mismatch_and_hostile_inputs_never_leak(self):
        sentinel = "SENSITIVE_SENTINEL_VALUE"
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "observations.sqlite"
            make_valid_database(database)
            completed = run_scanner(database, sentinel)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stderr, b"")
            self.assertEqual(parse_receipt(completed), {"error": "snapshot-mismatch", "ok": False})
            self.assertNotIn(sentinel.encode(), completed.stdout + completed.stderr)

            missing = Path(directory) / f"{sentinel}.sqlite"
            completed = run_scanner(missing, sentinel)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stderr, b"")
            self.assertEqual(parse_receipt(completed), {"error": "database-unreadable", "ok": False})
            self.assertNotIn(sentinel.encode(), completed.stdout + completed.stderr)
            self.assertNotIn(b"Traceback", completed.stdout + completed.stderr)

            completed = run_scanner(database, SNAPSHOT_ID, sentinel)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stderr, b"")
            self.assertEqual(parse_receipt(completed), {"error": "invalid-arguments", "ok": False})
            self.assertNotIn(sentinel.encode(), completed.stdout + completed.stderr)

    def test_captured_raw_bytes_remain_the_only_logical_identity_during_an_aba_path_swap(self):
        alternate_snapshot = "20260828010101-bbbbbbbbbbbbbbbb"
        with tempfile.TemporaryDirectory() as directory:
            hostile = Path(directory) / "hostile.sqlite"
            safe_substitute = Path(directory) / "safe.sqlite"
            make_valid_database(hostile)
            make_valid_database(safe_substitute)
            set_snapshot_id(safe_substitute, alternate_snapshot)
            hostile_before = hostile.read_bytes()

            with mock.patch.object(
                scanner_module,
                "_open_immutable",
                create=True,
                side_effect=lambda _path: sqlite3.connect(safe_substitute),
            ):
                with self.assertRaises(scanner_module.ScanFailure) as raised:
                    scanner_module.scan_database(hostile, alternate_snapshot)

            self.assertEqual(raised.exception.code, "snapshot-mismatch")
            self.assertEqual(hostile.read_bytes(), hostile_before)

    def test_divergent_git_index_materialization_scans_staged_blob_not_worktree(self):
        secret = "gho_" + "G" * 32
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            data = repo / "data"
            data.mkdir()
            database = data / "repository-observations.sqlite"
            make_valid_database(database)
            leave_freelist_payload(database, secret)
            subprocess.run(["git", "add", "data/repository-observations.sqlite"], cwd=repo, check=True)

            database.unlink()
            make_valid_database(database)
            self.assertEqual(run_scanner(database).returncode, 0)

            completed = scan_staged_blob(repo)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stderr, b"")
            receipt = parse_receipt(completed)
            self.assertIn("github-token", receipt["patternIds"])
            self.assertNotIn(secret.encode(), completed.stdout)

    def test_staged_blob_temp_file_is_cleaned_on_success_scan_failure_and_git_show_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.sqlite"
            make_valid_database(source)
            observed = []

            def materialize(_repo, destination):
                observed.append(destination)
                shutil.copyfile(source, destination)

            completed = scan_staged_blob(Path(directory), materialize=materialize)
            self.assertEqual(completed.returncode, 0)
            self.assertFalse(observed[-1].exists())

            def scanner_failure(destination, _expected):
                observed.append(destination)
                raise RuntimeError("scanner failed")

            with self.assertRaisesRegex(RuntimeError, "scanner failed"):
                scan_staged_blob(Path(directory), materialize=materialize, scanner=scanner_failure)
            self.assertFalse(observed[-1].exists())

            def materialize_failure(_repo, destination):
                observed.append(destination)
                raise subprocess.CalledProcessError(1, ["git", "show"])

            with self.assertRaises(subprocess.CalledProcessError):
                scan_staged_blob(Path(directory), materialize=materialize_failure)
            self.assertFalse(observed[-1].exists())


if __name__ == "__main__":
    unittest.main()
