import copy
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scripts import derive_repository_artifacts as artifacts
from scripts import record_repository_observations as ledger
from tests.test_repository_artifacts import insert_item, insert_profile, insert_run


class ParentEvidenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="parent evidence (검증) ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.database = self.root / "parent.sqlite"
        ledger.create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.snapshot = insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28")
            insert_profile(connection, 1, "owner/repo")
            insert_item(connection, 1, "owner/repo", 1, stars=1)
            connection.commit()
        self.evidence = self.root / "parent-evidence.json"
        self.heads = self.root / "prior-heads.json"
        self.original_bytes = self.database.read_bytes()

    def export(self):
        artifacts.export_parent_inputs(self.database, {"version": 1, "sources": {}},
                                       self.snapshot, "b" * 40, self.evidence, self.heads)
        return json.loads(self.evidence.read_bytes())

    def test_export_is_bounded_by_tables_not_historical_row_count(self):
        captured = ledger._capture_parent_database(self.database)
        measured = captured[1]
        rows = [{"key": [index, "owner/repo"], "row_sha256": "a" * 64} for index in range(10000)]
        measured["tables"]["snapshot_items"] = {
            "count": len(rows), "logical_rows_sha256": ledger._digest(rows), "rows": rows,
        }
        before = copy.deepcopy(measured)
        with patch.object(artifacts, "_capture_parent_database", return_value=captured):
            envelope = self.export()
        self.assertEqual(envelope["version"], 2)
        self.assertLess(self.evidence.stat().st_size, 16 * 1024)
        self.assertEqual(measured, before)
        for table, evidence in measured["tables"].items():
            self.assertEqual(envelope["parent_database"]["tables"][table], {
                "count": evidence["count"], "logical_rows_sha256": evidence["logical_rows_sha256"],
            })
        self.assertEqual(self.database.read_bytes(), self.original_bytes)

    def test_v2_and_existing_v1_receipts_verify_and_copy_every_parent_row(self):
        envelope = self.export()
        self.assertEqual(envelope["version"], 2)
        for version in (2, 1):
            with self.subTest(version=version):
                if version == 1:
                    envelope["version"] = 1
                    envelope["parent_database"] = ledger.parent_database_evidence(self.database)
                    self.evidence.write_text(json.dumps(envelope), encoding="utf-8")
                self.assertEqual(artifacts.verify_parent_inputs(self.database, self.evidence, self.heads),
                                 {"verified": True, "version": 1})
                parent, _, _, _ = ledger._parse_parent_evidence_envelope(envelope)
                candidate = self.root / f"candidate-{version}.sqlite"
                ledger.prepare_candidate_database(self.database, candidate, parent)
                self.assertEqual(candidate.read_bytes(), self.original_bytes)
        self.assertEqual(self.database.read_bytes(), self.original_bytes)

    def test_v2_rejects_mutated_or_missing_evidence_before_candidate_creation(self):
        original = self.export()
        self.assertEqual(original["version"], 2)
        mutations = {
            "file hash": lambda value: value["parent_database"].update(file_sha256="0" * 64),
            "file size": lambda value: value["parent_database"].update(byte_size=1),
            "snapshot": lambda value: value["parent_database"].update(last_snapshot_id="20260828000000-0000000000000000"),
            "chain": lambda value: value["parent_database"].update(last_chain_sha256="0" * 64),
            "count": lambda value: value["parent_database"]["tables"]["snapshot_items"].update(count=0),
            "table hash": lambda value: value["parent_database"]["tables"]["snapshot_items"].update(logical_rows_sha256="0" * 64),
            "missing table": lambda value: value["parent_database"]["tables"].pop("snapshot_items"),
            "extra rows": lambda value: value["parent_database"]["tables"]["snapshot_items"].update(rows=[]),
            "missing hash": lambda value: value["parent_database"]["tables"]["snapshot_items"].pop("logical_rows_sha256"),
            "unknown version": lambda value: value.update(version=3),
            "boolean version": lambda value: value.update(version=True),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                value = copy.deepcopy(original)
                mutate(value)
                self.evidence.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(ValueError):
                    artifacts.verify_parent_inputs(self.database, self.evidence, self.heads)
                candidate = self.root / f"bad-{label}.sqlite"
                with self.assertRaises(ValueError):
                    parent, _, _, _ = ledger._parse_parent_evidence_envelope(value)
                    ledger.prepare_candidate_database(self.database, candidate, parent)
                self.assertFalse(candidate.exists())
        self.assertEqual(self.database.read_bytes(), self.original_bytes)

    def test_truncated_and_duplicate_json_still_fail_closed(self):
        envelope = self.export()
        for payload in (b"", b'{"version":2,', b'{"version":2,"version":2}'):
            with self.subTest(payload=payload):
                self.evidence.write_bytes(payload)
                with self.assertRaises(ValueError):
                    artifacts.verify_parent_inputs(self.database, self.evidence, self.heads)
        self.evidence.write_text(json.dumps(envelope), encoding="utf-8")
        self.assertEqual(artifacts.verify_parent_inputs(self.database, self.evidence, self.heads),
                         {"verified": True, "version": 1})

    def test_atomic_export_failure_keeps_prior_receipt(self):
        self.export()
        original = self.evidence.read_bytes()
        with patch.object(artifacts.json, "dump", side_effect=OSError("partial write")):
            with self.assertRaises(OSError):
                self.export()
        self.assertEqual(self.evidence.read_bytes(), original)
        self.assertEqual(list(self.root.glob(".*.tmp")), [])
        self.assertEqual(self.database.read_bytes(), self.original_bytes)

    def test_existing_json_size_bound_is_not_relaxed(self):
        limit = 64 * 1024 * 1024
        payload = b"{}" + b" " * (limit - 2)
        self.assertEqual(artifacts._strict_json_bytes(payload, "parent evidence"), {})
        with self.assertRaisesRegex(ValueError, "parent evidence size is invalid"):
            artifacts._strict_json_bytes(payload + b" ", "parent evidence")


if __name__ == "__main__":
    unittest.main()
