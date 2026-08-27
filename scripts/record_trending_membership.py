"""Append finalized Trending membership snapshots and publish a baseline-safe status feed."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Sequence


REPOS_START = "// GENERATED:TRENDING-REPOS:START"
REPOS_END = "// GENERATED:TRENDING-REPOS:END"
REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SNAPSHOT_ID_PATTERN = re.compile(r"^\d{14}-[a-f0-9]{16}$")
SCHEMA_VERSION = 1
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PAGE = REPOSITORY_ROOT / "index.html"
DEFAULT_LATEST = REPOSITORY_ROOT / "data" / "latest.json"
DEFAULT_DATABASE = REPOSITORY_ROOT / "data" / "trending-membership.sqlite"
DEFAULT_STATUS = REPOSITORY_ROOT / "data" / "membership-status.json"


@dataclass(frozen=True)
class MembershipSnapshot:
    generated_at: str
    stats_date: str
    slugs: tuple[str, ...]


@dataclass(frozen=True)
class RecordMembershipResult:
    changed: bool
    snapshot_id: int
    baseline: bool


def _json_error(value: str):
    raise ValueError(f"Invalid JSON constant: {value}")


def _load_json(value: str):
    try:
        return json.loads(value, parse_constant=_json_error)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError("Generated data is not valid JSON") from error


def _valid_date(value) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
        raise ValueError("generatedAt must be a UTC ISO timestamp with milliseconds")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ValueError("generatedAt must be a valid UTC ISO timestamp") from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        raise ValueError("generatedAt must be canonical UTC ISO milliseconds")
    return parsed


def _snapshot_id(value, generated_at, *, verify_digest=True) -> str:
    if not isinstance(value, str) or not SNAPSHOT_ID_PATTERN.fullmatch(value):
        raise ValueError("snapshotId must be a valid run snapshot id")
    timestamp = generated_at.replace("-", "").replace(":", "").replace(".", "").replace("T", "").replace("Z", "")
    if value[:14] != timestamp[:14]:
        raise ValueError("snapshotId must match generatedAt")
    if verify_digest:
        digest = hashlib.sha256(f"{generated_at}|run-context-v1".encode("utf-8")).hexdigest()[:16]
        if value != f"{timestamp[:14]}-{digest}":
            raise ValueError("snapshotId must match the run context")
    return value


def _slug(value) -> str:
    if not isinstance(value, str) or len(value) > 201 or not REPO_PATTERN.fullmatch(value):
        raise ValueError(f"Invalid repository slug: {value!r}")
    return value


def _validate_slugs(values: Sequence[str]) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)) or not isinstance(values, Sequence) or not 10 <= len(values) <= 75:
        raise ValueError("membership snapshot must contain 10-75 repositories")
    seen = set()
    slugs = []
    for value in values:
        slug = _slug(value)
        key = slug.lower()
        if key in seen:
            raise ValueError(f"Duplicate membership slug: {slug}")
        seen.add(key)
        slugs.append(slug)
    return tuple(slugs)


def _validated_snapshot(value: MembershipSnapshot) -> MembershipSnapshot:
    if not isinstance(value, MembershipSnapshot):
        raise ValueError("Invalid membership snapshot")
    _timestamp(value.generated_at)
    if not _valid_date(value.stats_date):
        raise ValueError("statsDate must be a valid YYYY-MM-DD date")
    return MembershipSnapshot(value.generated_at, value.stats_date, _validate_slugs(value.slugs))


def _marked_repositories(page: str):
    if not isinstance(page, str):
        raise ValueError("REPOS page must be text")
    if page.count(REPOS_START) != 1 or page.count(REPOS_END) != 1:
        raise ValueError("Expected exactly one REPOS marker pair")
    start = page.index(REPOS_START) + len(REPOS_START)
    end = page.index(REPOS_END, start)
    body = page[start:end].strip()
    match = re.fullmatch(r"const REPOS = (\[[\s\S]*\]);", body)
    if not match:
        raise ValueError("Generated REPOS region is malformed")
    return _load_json(match.group(1))


def load_finalized_snapshot(page: str, latest) -> MembershipSnapshot:
    """Validate the finalized page/latest pair and preserve the page's display order."""
    repos = _marked_repositories(page)
    if not isinstance(repos, list) or not 10 <= len(repos) <= 75:
        raise ValueError("REPOS must contain 10-75 repositories")
    page_slugs = []
    page_identity = None
    for repo in repos:
        if not isinstance(repo, dict):
            raise ValueError("Every REPOS item must be an object")
        page_slugs.append(_slug(repo.get("slug")))
        identity = (repo.get("_snapshot_id"), repo.get("_generated_at"), repo.get("_stats_date"))
        if page_identity is None:
            page_identity = identity
        elif identity != page_identity:
            raise ValueError("REPOS must use one exact run identity")
    page_slugs = _validate_slugs(page_slugs)
    page_snapshot_id, page_generated_at, stats_date = page_identity
    _timestamp(page_generated_at)
    _snapshot_id(page_snapshot_id, page_generated_at, verify_digest=False)
    if not _valid_date(stats_date):
        raise ValueError("REPOS must use one valid _stats_date")

    if not isinstance(latest, dict) or set(latest) != {"snapshotId", "generatedAt", "statsDate", "count", "repos"}:
        raise ValueError("Latest feed has an invalid top-level schema")
    generated_at = latest.get("generatedAt")
    _timestamp(generated_at)
    snapshot_id = _snapshot_id(latest.get("snapshotId"), generated_at)
    if page_snapshot_id != snapshot_id:
        raise ValueError("Page and latest feed snapshotId do not match")
    if page_generated_at != generated_at:
        raise ValueError("Page and latest feed generatedAt do not match")
    if latest.get("statsDate") != stats_date:
        raise ValueError("Page and latest feed statsDate do not match")
    if type(latest.get("count")) is not int or latest["count"] != len(page_slugs):
        raise ValueError("Page and latest feed counts do not match")
    latest_repos = latest.get("repos")
    if not isinstance(latest_repos, list):
        raise ValueError("Latest feed repositories must be a list")
    latest_slugs = _validate_slugs([repo.get("slug") if isinstance(repo, dict) else None for repo in latest_repos])
    if {slug.lower() for slug in latest_slugs} != {slug.lower() for slug in page_slugs}:
        raise ValueError("Page and latest feed repository sets do not match")
    return MembershipSnapshot(generated_at, stats_date, page_slugs)


SCHEMA_STATEMENTS = (
    """CREATE TABLE schema_meta (
    schema_version INTEGER PRIMARY KEY CHECK (schema_version = 1),
    creation_policy TEXT NOT NULL CHECK (creation_policy = 'append_only')
)""",
    "INSERT INTO schema_meta VALUES (1, 'append_only')",
    """CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    generated_at TEXT NOT NULL UNIQUE,
    stats_date TEXT NOT NULL,
    slug_set_sha256 TEXT NOT NULL,
    item_count INTEGER NOT NULL CHECK (item_count BETWEEN 10 AND 75),
    is_baseline INTEGER NOT NULL CHECK (is_baseline IN (0, 1))
)""",
    """CREATE TABLE snapshot_members (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    slug TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (snapshot_id, slug),
    UNIQUE (snapshot_id, ordinal)
)""",
    "CREATE INDEX idx_snapshots_generated_at ON snapshots(generated_at)",
    "CREATE INDEX idx_snapshot_members_slug ON snapshot_members(slug)",
    """CREATE TRIGGER snapshots_no_update
BEFORE UPDATE ON snapshots
BEGIN
    SELECT RAISE(ABORT, 'membership snapshots are append-only');
END""",
    """CREATE TRIGGER snapshots_no_delete
BEFORE DELETE ON snapshots
BEGIN
    SELECT RAISE(ABORT, 'membership snapshots are append-only');
END""",
    """CREATE TRIGGER snapshots_no_replace
BEFORE INSERT ON snapshots
WHEN EXISTS (SELECT 1 FROM snapshots WHERE id = NEW.id OR generated_at = NEW.generated_at)
BEGIN
    SELECT RAISE(ABORT, 'membership snapshot conflicts are immutable');
END""",
    """CREATE TRIGGER snapshot_members_no_update
BEFORE UPDATE ON snapshot_members
BEGIN
    SELECT RAISE(ABORT, 'membership rows are append-only');
END""",
    """CREATE TRIGGER snapshot_members_no_delete
BEFORE DELETE ON snapshot_members
BEGIN
    SELECT RAISE(ABORT, 'membership rows are append-only');
END""",
    """CREATE TRIGGER snapshot_members_no_replace
BEFORE INSERT ON snapshot_members
WHEN EXISTS (
    SELECT 1 FROM snapshot_members
    WHERE snapshot_id = NEW.snapshot_id
      AND (slug = NEW.slug COLLATE NOCASE OR ordinal = NEW.ordinal)
)
BEGIN
    SELECT RAISE(ABORT, 'membership row conflicts are immutable');
END""",
)


def _schema_rows(connection: sqlite3.Connection):
    return connection.execute(
        "SELECT type, name, sql FROM sqlite_schema "
        "WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name"
    ).fetchall()


def _schema_fingerprint(rows) -> str:
    normalized = [
        (object_type, name, re.sub(r"\s+", " ", definition.strip()).lower())
        for object_type, name, definition in rows
    ]
    return hashlib.sha256(json.dumps(normalized, separators=(",", ":")).encode()).hexdigest()


@lru_cache(maxsize=1)
def _canonical_schema():
    with closing(sqlite3.connect(":memory:")) as connection:
        for statement in SCHEMA_STATEMENTS:
            connection.execute(statement)
        rows = _schema_rows(connection)
    return {(kind, name) for kind, name, _ in rows}, _schema_fingerprint(rows)


def _validate_schema(connection: sqlite3.Connection):
    if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        raise ValueError("Unsupported membership database schema version")
    rows = _schema_rows(connection)
    objects = {(kind, name) for kind, name, _ in rows}
    expected_objects, expected_fingerprint = _canonical_schema()
    if objects != expected_objects or _schema_fingerprint(rows) != expected_fingerprint:
        raise ValueError("Existing membership schema v1 does not match the canonical definition")
    if connection.execute("SELECT schema_version, creation_policy FROM schema_meta").fetchall() != [(1, "append_only")]:
        raise ValueError("Existing membership schema metadata is invalid")


def _sidecars(database_path: Path):
    return [Path(f"{database_path}{suffix}") for suffix in ("-journal", "-wal", "-shm")]


def _validate_health(connection: sqlite3.Connection):
    connection.execute("PRAGMA foreign_keys = ON")
    _validate_schema(connection)
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Membership database foreign-key check failed")
    if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise ValueError("Membership database integrity check failed")


def _checksum(slugs: Sequence[str]) -> str:
    payload = "\n".join(sorted(slug.lower() for slug in slugs)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _members(connection: sqlite3.Connection, snapshot_id: int):
    return connection.execute(
        "SELECT slug FROM snapshot_members WHERE snapshot_id = ? ORDER BY ordinal", (snapshot_id,)
    ).fetchall()


def _status_from_connection(connection: sqlite3.Connection, snapshot_id: int):
    row = connection.execute(
        "SELECT generated_at, stats_date, is_baseline FROM snapshots WHERE id = ?", (snapshot_id,)
    ).fetchone()
    if row is None:
        raise ValueError("Membership snapshot is missing")
    generated_at, stats_date, is_baseline = row
    current = [slug for (slug,) in _members(connection, snapshot_id)]
    previous = connection.execute(
        "SELECT id, generated_at FROM snapshots WHERE id < ? ORDER BY id DESC LIMIT 1", (snapshot_id,)
    ).fetchone()
    previous_slugs = [] if previous is None else [slug for (slug,) in _members(connection, previous[0])]
    previous_keys = {slug.lower() for slug in previous_slugs}
    historical_keys = {
        slug.lower() for (slug,) in connection.execute(
            "SELECT DISTINCT slug FROM snapshot_members WHERE snapshot_id < ?", (snapshot_id,)
        ).fetchall()
    }
    current_keys = {slug.lower() for slug in current}
    statuses = []
    for slug in current:
        key = slug.lower()
        status = "baseline" if is_baseline else "stayed" if key in previous_keys else "reentered" if key in historical_keys else "new"
        statuses.append({"slug": slug, "status": status})
    exited = [] if previous is None else [
        {"slug": slug, "lastSeenAt": previous[1], "exitedAt": generated_at}
        for slug in previous_slugs if slug.lower() not in current_keys
    ]
    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "statsDate": stats_date,
        "baseline": bool(is_baseline),
        "current": statuses,
        "exited": exited,
    }


def _validate_status(value):
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "generatedAt", "statsDate", "baseline", "current", "exited"}:
        raise ValueError("Membership status has an invalid top-level schema")
    if value.get("schemaVersion") != 1 or type(value.get("baseline")) is not bool:
        raise ValueError("Membership status version or baseline is invalid")
    _timestamp(value.get("generatedAt"))
    if not _valid_date(value.get("statsDate")):
        raise ValueError("Membership status statsDate is invalid")
    current = value.get("current")
    if not isinstance(current, list) or not 10 <= len(current) <= 75:
        raise ValueError("Membership status current list is invalid")
    seen = set()
    allowed = {"baseline"} if value["baseline"] else {"new", "reentered", "stayed"}
    for item in current:
        if not isinstance(item, dict) or set(item) != {"slug", "status"}:
            raise ValueError("Membership current item is invalid")
        slug = _slug(item.get("slug"))
        if slug.lower() in seen or item.get("status") not in allowed:
            raise ValueError("Membership current identity or status is invalid")
        seen.add(slug.lower())
    exited = value.get("exited")
    if not isinstance(exited, list) or len(exited) > 75 or (value["baseline"] and exited):
        raise ValueError("Membership exited list is invalid")
    exited_seen = set()
    for item in exited:
        if not isinstance(item, dict) or set(item) != {"slug", "lastSeenAt", "exitedAt"}:
            raise ValueError("Membership exited item is invalid")
        slug = _slug(item.get("slug"))
        _timestamp(item.get("lastSeenAt"))
        _timestamp(item.get("exitedAt"))
        if slug.lower() in seen or slug.lower() in exited_seen or item["exitedAt"] != value["generatedAt"]:
            raise ValueError("Membership exited identity or timestamp is invalid")
        exited_seen.add(slug.lower())
    return value


def _status_bytes(value) -> bytes:
    _validate_status(value)
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _write_pending(path: Path, payload: bytes):
    with path.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def _install_pair(database_path: Path, status_path: Path, pending_database: Path, pending_status: Path):
    suffix = uuid.uuid4().hex
    backups = {
        database_path: database_path.with_name(f"{database_path.name}.backup-{suffix}"),
        status_path: status_path.with_name(f"{status_path.name}.backup-{suffix}"),
    }
    installed = []
    backed_up = []
    try:
        for target in (database_path, status_path):
            if target.exists():
                os.replace(target, backups[target])
                backed_up.append(target)
        os.replace(pending_database, database_path)
        installed.append(database_path)
        os.replace(pending_status, status_path)
        installed.append(status_path)
    except Exception:
        for target in reversed(installed):
            target.unlink(missing_ok=True)
        for target in reversed(backed_up):
            if backups[target].exists():
                os.replace(backups[target], target)
        raise
    finally:
        pending_database.unlink(missing_ok=True)
        pending_status.unlink(missing_ok=True)
        for backup in backups.values():
            backup.unlink(missing_ok=True)


def _replace_status(status_path: Path, value):
    pending = status_path.with_name(f"{status_path.name}.pending-{uuid.uuid4().hex}")
    try:
        _write_pending(pending, _status_bytes(value))
        os.replace(pending, status_path)
    finally:
        pending.unlink(missing_ok=True)


def record_membership(database_path: str | Path, status_path: str | Path, snapshot: MembershipSnapshot) -> RecordMembershipResult:
    """Append one snapshot through a staged database and publish its derived status pair."""
    value = _validated_snapshot(snapshot)
    database_path = Path(database_path)
    status_path = Path(status_path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    for sidecar in _sidecars(database_path):
        if sidecar.exists():
            raise ValueError(f"Membership SQLite sidecar remains: {sidecar.name}")

    if database_path.exists():
        with closing(sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
            _validate_health(connection)
            latest = connection.execute(
                "SELECT id, generated_at, stats_date, slug_set_sha256, item_count, is_baseline "
                "FROM snapshots ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if latest is None:
                raise ValueError("Existing membership database has no baseline")
            if value.generated_at == latest[1]:
                expected_members = tuple(slug for (slug,) in _members(connection, latest[0]))
                if (
                    value.stats_date != latest[2]
                    or _checksum(value.slugs) != latest[3]
                    or len(value.slugs) != latest[4]
                    or value.slugs != expected_members
                ):
                    raise ValueError("Conflicting membership snapshot uses an existing generatedAt")
                expected_status = _status_from_connection(connection, latest[0])
                try:
                    existing_status = _validate_status(_load_json(status_path.read_text(encoding="utf-8")))
                except (OSError, UnicodeError, ValueError):
                    existing_status = None
                if existing_status == expected_status:
                    return RecordMembershipResult(False, latest[0], bool(latest[5]))
                _replace_status(status_path, expected_status)
                return RecordMembershipResult(True, latest[0], bool(latest[5]))
            if _timestamp(value.generated_at) < _timestamp(latest[1]):
                raise ValueError("Cannot append a membership snapshot before the latest finalized snapshot")

    suffix = uuid.uuid4().hex
    pending_database = database_path.with_name(f"{database_path.name}.pending-{suffix}")
    pending_status = status_path.with_name(f"{status_path.name}.pending-{suffix}")
    try:
        if database_path.exists():
            with closing(sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)) as source:
                with closing(sqlite3.connect(pending_database)) as destination:
                    source.backup(destination)
        with closing(sqlite3.connect(pending_database)) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            mode = connection.execute("PRAGMA journal_mode = DELETE").fetchone()[0]
            if mode.lower() != "delete":
                raise ValueError("Could not set membership DELETE journal mode")
            connection.execute("PRAGMA synchronous = FULL")
            connection.execute("BEGIN IMMEDIATE")
            if not database_path.exists():
                for statement in SCHEMA_STATEMENTS:
                    connection.execute(statement)
                connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            _validate_schema(connection)
            baseline = connection.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0] == 0
            cursor = connection.execute(
                "INSERT INTO snapshots(generated_at, stats_date, slug_set_sha256, item_count, is_baseline) "
                "VALUES (?, ?, ?, ?, ?)",
                (value.generated_at, value.stats_date, _checksum(value.slugs), len(value.slugs), int(baseline)),
            )
            snapshot_id = cursor.lastrowid
            connection.executemany(
                "INSERT INTO snapshot_members(snapshot_id, ordinal, slug) VALUES (?, ?, ?)",
                [(snapshot_id, ordinal, slug) for ordinal, slug in enumerate(value.slugs)],
            )
            _validate_health(connection)
            status = _status_from_connection(connection, snapshot_id)
            connection.commit()
        for sidecar in _sidecars(pending_database):
            if sidecar.exists():
                raise ValueError(f"Pending membership SQLite sidecar remains: {sidecar.name}")
        _write_pending(pending_status, _status_bytes(status))
        _install_pair(database_path, status_path, pending_database, pending_status)
        return RecordMembershipResult(True, snapshot_id, baseline)
    finally:
        pending_database.unlink(missing_ok=True)
        pending_status.unlink(missing_ok=True)
        for sidecar in _sidecars(pending_database):
            sidecar.unlink(missing_ok=True)


def validate_membership_publication(database_path: str | Path, status_path: str | Path, page: str, latest):
    """Read-only validation tying the page, latest feed, DB, and derived JSON together."""
    snapshot = load_finalized_snapshot(page, latest)
    database_path = Path(database_path)
    status_path = Path(status_path)
    if not database_path.is_file() or not status_path.is_file():
        raise ValueError("Membership database and status feed are required")
    for sidecar in _sidecars(database_path):
        if sidecar.exists():
            raise ValueError(f"Membership SQLite sidecar remains: {sidecar.name}")
    with closing(sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
        _validate_health(connection)
        row = connection.execute(
            "SELECT id, generated_at, stats_date, slug_set_sha256, item_count FROM snapshots ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None or row[1:] != (
            snapshot.generated_at,
            snapshot.stats_date,
            _checksum(snapshot.slugs),
            len(snapshot.slugs),
        ):
            raise ValueError("Latest membership snapshot does not match the finalized page and feed")
        if tuple(slug for (slug,) in _members(connection, row[0])) != snapshot.slugs:
            raise ValueError("Latest membership order does not match the finalized page")
        expected = _status_from_connection(connection, row[0])
    actual = _validate_status(_load_json(status_path.read_text(encoding="utf-8")))
    if actual != expected:
        raise ValueError("Membership status feed does not match the append-only database")
    return actual


def membership_change_events(database_path: str | Path, limit: int = 100):
    """Return recent public new/reentered events, newest snapshot first."""
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Membership event limit must be 1-100")
    database_path = Path(database_path)
    if not database_path.is_file():
        raise ValueError("Membership database is required")
    for sidecar in _sidecars(database_path):
        if sidecar.exists():
            raise ValueError(f"Membership SQLite sidecar remains: {sidecar.name}")
    events = []
    with closing(sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
        _validate_health(connection)
        rows = connection.execute(
            "SELECT id FROM snapshots WHERE is_baseline = 0 ORDER BY id DESC"
        ).fetchall()
        for (snapshot_id,) in rows:
            status = _status_from_connection(connection, snapshot_id)
            for item in status["current"]:
                if item["status"] not in {"new", "reentered"}:
                    continue
                events.append({
                    "slug": item["slug"],
                    "status": item["status"],
                    "generatedAt": status["generatedAt"],
                    "statsDate": status["statsDate"],
                })
                if len(events) == limit:
                    return events
    return events


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Append a finalized Trending membership snapshot")
    parser.add_argument("--page", type=Path, default=DEFAULT_PAGE)
    parser.add_argument("--latest", type=Path, default=DEFAULT_LATEST)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--status", type=Path, default=DEFAULT_STATUS)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        page = args.page.read_text(encoding="utf-8")
        latest = _load_json(args.latest.read_text(encoding="utf-8"))
        if args.validate_only:
            status = validate_membership_publication(args.database, args.status, page, latest)
            print(f"membership_validated={len(status['current'])} baseline={str(status['baseline']).lower()}")
        else:
            result = record_membership(
                args.database,
                args.status,
                load_finalized_snapshot(page, latest),
            )
            print(
                f"membership_changed={str(result.changed).lower()} snapshot_id={result.snapshot_id} "
                f"baseline={str(result.baseline).lower()}"
            )
    except (OSError, UnicodeError, ValueError, sqlite3.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
