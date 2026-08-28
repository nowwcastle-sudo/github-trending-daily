"""Content-free security scan for one materialized staged SQLite database."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

try:
    from scripts.record_repository_observations import SCHEMA_VERSION, validate_schema
except ModuleNotFoundError:
    from record_repository_observations import SCHEMA_VERSION, validate_schema


PATTERNS = (
    ("github-pat", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}")),
    ("anthropic-key", re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")),
    ("google-api-key", re.compile(r"AIza[A-Za-z0-9_-]{30,}")),
    ("private-key-header", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
)


class ScanFailure(Exception):
    def __init__(self, code, *, pattern_ids=(), locations=()):
        super().__init__(code)
        self.code = code
        self.pattern_ids = tuple(sorted(set(pattern_ids)))
        self.locations = tuple(
            sorted(
                ({"table": table, "column": column, "patternId": pattern_id}
                 for table, column, pattern_id in locations),
                key=lambda item: (item["table"], item["column"], item["patternId"]),
            )
        )


class ContentFreeArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        raise ScanFailure("invalid-arguments") from None


def _parse_arguments(argv):
    parser = ContentFreeArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--database", required=True)
    parser.add_argument("--expect-snapshot", required=True)
    return parser.parse_args(argv)


def _matches(value):
    return tuple(pattern_id for pattern_id, pattern in PATTERNS if pattern.search(value))


def _raw_matches(raw):
    found = set()
    for pattern_id, pattern in PATTERNS:
        byte_pattern = re.compile(pattern.pattern.encode("ascii"))
        if byte_pattern.search(raw):
            found.add(pattern_id)
    for encoding in ("utf-16le", "utf-16be"):
        for offset in (0, 1):
            usable = len(raw) - offset
            usable -= usable % 2
            if usable <= 0:
                continue
            decoded = raw[offset : offset + usable].decode(encoding, errors="ignore")
            found.update(_matches(decoded))
    return found


def _read_database_bytes(database):
    try:
        raw = database.read_bytes()
    except (OSError, ValueError):
        raise ScanFailure("database-unreadable") from None
    if not raw.startswith(b"SQLite format 3\x00"):
        raise ScanFailure("database-unreadable") from None
    return raw


def _deserialize_database(raw):
    connection = None
    try:
        connection = sqlite3.connect(":memory:")
        connection.deserialize(raw)
        return connection
    except (ValueError, sqlite3.Error):
        if connection is not None:
            connection.close()
        raise ScanFailure("database-unreadable") from None


def _validate_integrity(connection):
    try:
        connection.execute("PRAGMA query_only = ON")
        if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ScanFailure("integrity-invalid")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ScanFailure("foreign-key-invalid")
    except ScanFailure:
        raise
    except sqlite3.Error:
        raise ScanFailure("database-unreadable") from None


def _validate_exact_schema(connection):
    try:
        validate_schema(connection)
    except (RuntimeError, ValueError, sqlite3.Error):
        raise ScanFailure("schema-invalid") from None


def _enumerate_logical_cells(connection):
    row_count = 0
    cell_count = 0
    pattern_ids = set()
    locations = set()
    tables = [
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_schema "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
            "ORDER BY name"
        )
    ]
    for table in tables:
        columns = connection.execute(f"PRAGMA table_info({table})").fetchall()
        names = [column[1] for column in columns]
        declared_types = [column[2] for column in columns]
        for row in connection.execute(f"SELECT * FROM {table}"):
            row_count += 1
            cell_count += len(row)
            for name, declared_type, value in zip(names, declared_types, row):
                if value is None:
                    continue
                expected_type = int if declared_type == "INTEGER" else str if declared_type == "TEXT" else None
                if expected_type is None or type(value) is not expected_type:
                    raise ScanFailure("runtime-type-invalid")
                if expected_type is str:
                    matches = _matches(value)
                    pattern_ids.update(matches)
                    locations.update((table, name, pattern_id) for pattern_id in matches)
    return tables, row_count, cell_count, pattern_ids, locations


def scan_database(database, expected_snapshot):
    raw_before = _read_database_bytes(database)
    digest_before = hashlib.sha256(raw_before).hexdigest()
    size_before = len(raw_before)

    connection = _deserialize_database(raw_before)
    with closing(connection):
        _validate_integrity(connection)
        _validate_exact_schema(connection)
        try:
            expected_count = connection.execute(
                "SELECT COUNT(*) FROM snapshot_runs WHERE snapshot_id = ?",
                (expected_snapshot,),
            ).fetchone()[0]
        except sqlite3.Error:
            raise ScanFailure("schema-invalid") from None
        if expected_count != 1:
            raise ScanFailure("snapshot-mismatch")
        tables, row_count, cell_count, pattern_ids, locations = _enumerate_logical_cells(connection)

    pattern_ids.update(_raw_matches(raw_before))
    raw_after = _read_database_bytes(database)
    digest_after = hashlib.sha256(raw_after).hexdigest()
    if len(raw_after) != size_before or digest_after != digest_before:
        raise ScanFailure("database-mutated")
    if pattern_ids:
        raise ScanFailure(
            "secret-pattern-detected",
            pattern_ids=pattern_ids,
            locations=locations,
        )
    return {
        "databaseSha256Prefix": digest_before[:12],
        "expectedSnapshotCount": expected_count,
        "logicalCellCount": cell_count,
        "ok": True,
        "rawByteSize": size_before,
        "rowCount": row_count,
        "schemaVersion": SCHEMA_VERSION,
        "tableCount": len(tables),
    }


def _failure_receipt(error):
    receipt = {"error": error.code, "ok": False}
    if error.code == "secret-pattern-detected":
        receipt["locations"] = list(error.locations)
        receipt["patternIds"] = list(error.pattern_ids)
    return receipt


def _write_receipt(receipt):
    encoded = json.dumps(receipt, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(encoded + b"\n")


def main(argv=None):
    try:
        arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
        receipt = scan_database(Path(arguments.database), arguments.expect_snapshot)
    except ScanFailure as error:
        _write_receipt(_failure_receipt(error))
        return 1
    except Exception:
        _write_receipt({"error": "database-unreadable", "ok": False})
        return 1
    _write_receipt(receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
