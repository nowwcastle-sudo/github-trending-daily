"""Deterministic, as-of derivation for the repository observation ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from scripts.record_repository_observations import (
        LEGACY_OVERLAY_ARTIFACT_PATHS,
        PAGES_BASE_ARTIFACT_PATH_HISTORY,
        PAGES_BASE_ARTIFACT_PATHS,
        _capture_parent_database,
        _file_sha256,
        _legacy_logical_rows,
        _parse_parent_evidence_envelope,
        held_summary_digests,
        validate_schema,
        verify_core_snapshot,
    )
except ModuleNotFoundError as error:
    if error.name not in {"scripts", "scripts.record_repository_observations"}:
        raise
    from record_repository_observations import (
        LEGACY_OVERLAY_ARTIFACT_PATHS,
        PAGES_BASE_ARTIFACT_PATH_HISTORY,
        PAGES_BASE_ARTIFACT_PATHS,
        _capture_parent_database,
        _file_sha256,
        _legacy_logical_rows,
        _parse_parent_evidence_envelope,
        held_summary_digests,
        validate_schema,
        verify_core_snapshot,
    )


INSIGHT_RULE_VERSION = "repository-insight-v1"
_SLUG_RE = re.compile(r"^[a-z0-9_.-]+/[a-z0-9_.-]+$")
_DISPLAY_SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_TRANSLATION_RE = re.compile(r"^translations/[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+\.json$")


@dataclass(frozen=True)
class FinalizeResult:
    changed: bool
    snapshot_seq: int
    insight_count: int
    artifact_count: int


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _columns(connection: sqlite3.Connection, table: str) -> tuple[str, ...]:
    return tuple(row[1] for row in connection.execute(f"PRAGMA table_info({table})"))


def _target_run(connection: sqlite3.Connection, snapshot_seq: int) -> dict[str, Any]:
    if isinstance(snapshot_seq, bool) or not isinstance(snapshot_seq, int) or snapshot_seq < 1:
        raise ValueError("target snapshot sequence is invalid")
    columns = _columns(connection, "snapshot_runs")
    row = connection.execute("SELECT * FROM snapshot_runs WHERE snapshot_seq = ?", (snapshot_seq,)).fetchone()
    if row is None:
        raise ValueError("target snapshot is absent")
    return dict(zip(columns, row))


def _utc_milliseconds(value: str) -> int:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        raise ValueError("snapshot time is invalid") from None
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        raise ValueError("snapshot time is not an exact millisecond")
    return (((parsed.toordinal() * 24 + parsed.hour) * 60 + parsed.minute) * 60 + parsed.second) * 1000 + parsed.microsecond // 1000


def _date_offset(value: str, days: int) -> str:
    return (date.fromisoformat(value).fromordinal(date.fromisoformat(value).toordinal() + days)).isoformat()


def derive_repository_insights(connection: sqlite3.Connection, snapshot_seq: int) -> list[dict[str, Any]]:
    """Return exact previous-observation deltas for every target item."""
    _target_run(connection, snapshot_seq)
    rows: list[dict[str, Any]] = []
    query = """
        SELECT i.slug, i.display_rank, i.rank_daily, i.rank_weekly, i.rank_monthly,
               i.stars, r.observed_at_utc,
               (SELECT MAX(p.snapshot_seq) FROM snapshot_items p
                WHERE p.slug = i.slug AND p.snapshot_seq < i.snapshot_seq) AS previous_seq
        FROM snapshot_items i
        JOIN snapshot_runs r USING(snapshot_seq)
        WHERE i.snapshot_seq = ?
        ORDER BY i.slug
    """
    for slug, display_rank, daily, weekly, monthly, stars, observed_at, previous_seq in connection.execute(query, (snapshot_seq,)):
        result = {
            "snapshot_seq": snapshot_seq,
            "slug": slug,
            "previous_observed_snapshot_seq": previous_seq,
            "observation_gap_milliseconds": None,
            "stars_delta_since_previous_observation": None,
            "display_rank_delta": None,
            "rank_daily_delta": None,
            "rank_weekly_delta": None,
            "rank_monthly_delta": None,
            "insight_rule_version": INSIGHT_RULE_VERSION,
        }
        if previous_seq is not None:
            previous = connection.execute(
                """SELECT i.display_rank, i.rank_daily, i.rank_weekly, i.rank_monthly,
                          i.stars, r.observed_at_utc
                   FROM snapshot_items i JOIN snapshot_runs r USING(snapshot_seq)
                   WHERE i.snapshot_seq = ? AND i.slug = ?""",
                (previous_seq, slug),
            ).fetchone()
            if previous is None:
                raise ValueError("previous observation is absent")
            previous_display, previous_daily, previous_weekly, previous_monthly, previous_stars, previous_at = previous
            gap = _utc_milliseconds(observed_at) - _utc_milliseconds(previous_at)
            if gap <= 0:
                raise ValueError("observation gap is not positive")
            result.update({
                "observation_gap_milliseconds": gap,
                "stars_delta_since_previous_observation": stars - previous_stars,
                "display_rank_delta": previous_display - display_rank,
                "rank_daily_delta": previous_daily - daily if previous_daily is not None and daily is not None else None,
                "rank_weekly_delta": previous_weekly - weekly if previous_weekly is not None and weekly is not None else None,
                "rank_monthly_delta": previous_monthly - monthly if previous_monthly is not None and monthly is not None else None,
            })
        result["insight_sha256"] = _digest(result)
        rows.append(result)
    expected_count = connection.execute("SELECT repository_count FROM snapshot_runs WHERE snapshot_seq = ?", (snapshot_seq,)).fetchone()[0]
    if len(rows) != expected_count:
        raise ValueError("target repository count is inconsistent")
    return rows


def _daily_metrics(closes: list[dict[str, Any]]) -> None:
    by_date = {row["date"]: row for row in closes if row["finalization"] == "finalized"}
    for row in closes:
        row.update({"velocity_7d": None, "acceleration_7d": None, "velocity_30d": None, "acceleration_30d": None})
        if row["finalization"] != "finalized":
            continue
        current = row["date"]
        d7, d14 = by_date.get(_date_offset(current, -7)), by_date.get(_date_offset(current, -14))
        d30, d60 = by_date.get(_date_offset(current, -30)), by_date.get(_date_offset(current, -60))
        if d7 is not None:
            row["velocity_7d"] = (row["stars"] - d7["stars"]) / 7
        if d7 is not None and d14 is not None:
            row["acceleration_7d"] = row["velocity_7d"] - (d7["stars"] - d14["stars"]) / 7
        if d30 is not None:
            row["velocity_30d"] = (row["stars"] - d30["stars"]) / 30
        if d30 is not None and d60 is not None:
            row["acceleration_30d"] = row["velocity_30d"] - (d30["stars"] - d60["stars"]) / 30


def derive_daily_star_series(connection: sqlite3.Connection, snapshot_seq: int) -> dict[str, Any]:
    """Derive last-successful-observation daily closes and internal provenance."""
    target = _target_run(connection, snapshot_seq)
    target_date = target["stats_date_kst"]
    repositories: list[dict[str, Any]] = []
    slugs = [row[0] for row in connection.execute(
        "SELECT DISTINCT slug FROM snapshot_items WHERE snapshot_seq <= ? ORDER BY slug", (snapshot_seq,)
    )]
    target_order = {slug: rank for slug, rank in connection.execute(
        "SELECT slug, display_rank FROM snapshot_items WHERE snapshot_seq = ?", (snapshot_seq,)
    )}
    for slug in slugs:
        close_rows = connection.execute(
            """SELECT i.snapshot_seq, r.stats_date_kst, r.observed_at_utc, i.stars,
                      p.display_slug,
                      (SELECT MAX(r2.snapshot_seq) FROM snapshot_runs r2
                       WHERE r2.stats_date_kst = r.stats_date_kst AND r2.snapshot_seq <= ?) AS day_last_seq
               FROM snapshot_items i
               JOIN snapshot_runs r USING(snapshot_seq)
               JOIN repository_profiles p ON p.profile_id=i.profile_id AND p.slug=i.slug
               WHERE i.slug = ? AND i.snapshot_seq <= ?
                 AND i.snapshot_seq = (SELECT MAX(i2.snapshot_seq)
                    FROM snapshot_items i2 JOIN snapshot_runs r3 USING(snapshot_seq)
                    WHERE i2.slug=i.slug AND r3.stats_date_kst=r.stats_date_kst
                      AND i2.snapshot_seq <= ?)
               ORDER BY r.stats_date_kst""",
            (snapshot_seq, slug, snapshot_seq, snapshot_seq),
        ).fetchall()
        closes = []
        for seq, stats_date, observed_at, stars, display_slug, day_last_seq in close_rows:
            closes.append({
                "date": stats_date,
                "stars": stars,
                "snapshot_seq": seq,
                "observed_at": observed_at,
                "finalization": "finalized" if stats_date < target_date else "provisional",
                "close_semantics": "last_observed_before_exit" if seq < day_last_seq else "last_successful_observation",
            })
        _daily_metrics(closes)
        display_row = connection.execute(
            """SELECT p.display_slug FROM snapshot_items i
               JOIN repository_profiles p ON p.profile_id=i.profile_id AND p.slug=i.slug
               WHERE i.slug=? AND i.snapshot_seq<=? ORDER BY i.snapshot_seq DESC LIMIT 1""",
            (slug, snapshot_seq),
        ).fetchone()
        auxiliary = [
            {"date": row[0], "stars": row[1], "legacyRowId": row[2], "legacySource": row[3]}
            for row in connection.execute(
                """SELECT observation_date, stars, legacy_row_id, legacy_source
                   FROM historical_star_observations
                   WHERE source='legacy_star_observations_db' AND slug=?
                     AND first_observed_snapshot_seq<=?
                   ORDER BY observation_date, legacy_row_id""",
                (slug, snapshot_seq),
            )
        ]
        releases = []
        for seq, snapshot_id, generated_at in connection.execute(
            """SELECT DISTINCT r.snapshot_seq,r.snapshot_id,r.observed_at_utc
               FROM snapshot_runs r JOIN snapshot_items i USING(snapshot_seq)
               WHERE i.slug=? AND r.snapshot_seq<=? ORDER BY r.snapshot_seq""", (slug, snapshot_seq)
        ):
            inventory = [
                {"releaseId": release_id, "metadataSha256": metadata_sha256, "ordinal": ordinal}
                for release_id, metadata_sha256, ordinal in connection.execute(
                    """SELECT release_id,metadata_sha256,release_ordinal
                       FROM snapshot_release_items WHERE snapshot_seq=? AND slug=?
                       ORDER BY release_ordinal""", (seq, slug)
                )
            ]
            releases.append({"snapshotSeq": seq, "snapshotId": snapshot_id, "generatedAt": generated_at, "inventory": inventory})
        repositories.append({
            "slug": slug,
            "displaySlug": display_row[0],
            "activeAtTarget": slug in target_order,
            "closes": closes,
            "auxiliaryExact": auxiliary,
            "releaseInventories": releases,
        })
    repositories.sort(key=lambda row: (0, target_order[row["slug"]]) if row["slug"] in target_order else (1, row["slug"]))
    return {
        "version": 1,
        "targetSnapshotId": target["snapshot_id"],
        "targetSnapshotSeq": snapshot_seq,
        "statsDate": target_date,
        "repositories": repositories,
    }


def _verify_legacy_membership(connection: sqlite3.Connection, path: Path, snapshot_seq: int) -> None:
    if not path.is_file() or path.is_symlink():
        raise ValueError("frozen membership source is unavailable")
    row = connection.execute(
        """SELECT byte_size,file_sha256,schema_fingerprint_sha256,logical_row_count,
                  logical_rows_sha256,last_logical_key_json
           FROM baseline_sources WHERE source_name='legacy_trending_membership'
             AND cutover_snapshot_seq<=?""", (snapshot_seq,)
    ).fetchone()
    if row is None:
        raise ValueError("frozen membership receipt is absent")
    schema, count, logical_hash, last = _legacy_logical_rows(path)
    actual = (path.stat().st_size, _file_sha256(path), schema, count, logical_hash, last)
    if actual != row:
        raise ValueError("frozen membership receipt does not match")


def derive_membership_timeline(connection: sqlite3.Connection, legacy_membership_path: str | Path, snapshot_seq: int) -> dict[str, Any]:
    """Union the verified frozen timeline and post-cutover DB snapshots without crossing the boundary."""
    target = _target_run(connection, snapshot_seq)
    path = Path(legacy_membership_path)
    _verify_legacy_membership(connection, path, snapshot_seq)
    legacy_snapshots = []
    legacy_events = []
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as legacy:
        seen: set[str] = set()
        previous: set[str] = set()
        for legacy_id, generated_at, stats_date, slug_set_sha, _, _ in legacy.execute(
            "SELECT id,generated_at,stats_date,slug_set_sha256,item_count,is_baseline FROM snapshots ORDER BY id"
        ):
            members = [
                {"ordinal": ordinal, "slug": slug}
                for ordinal, slug in legacy.execute(
                    "SELECT ordinal,slug FROM snapshot_members WHERE snapshot_id=? ORDER BY ordinal", (legacy_id,)
                )
            ]
            legacy_snapshots.append({
                "snapshotId": legacy_id,
                "generatedAt": generated_at,
                "statsDate": stats_date,
                "slugSetSha256": slug_set_sha,
                "members": members,
            })
            current = {member["slug"].lower() for member in members}
            if previous:
                for member in members:
                    folded = member["slug"].lower()
                    status = "new" if folded not in seen else "reentered" if folded not in previous else None
                    if status is not None:
                        legacy_events.append({
                            "provenance": "legacy_snapshot", "snapshotId": legacy_id,
                            "generatedAt": generated_at, "statsDate": stats_date,
                            "ordinal": member["ordinal"], "slug": folded,
                            "displaySlug": member["slug"], "status": status,
                        })
            seen |= current
            previous = current

    database_snapshots = []
    database_events = []
    prior_members: list[dict[str, Any]] | None = None
    for seq, snapshot_id, generated_at, stats_date, run_kind in connection.execute(
        """SELECT snapshot_seq,snapshot_id,observed_at_utc,stats_date_kst,run_kind
           FROM snapshot_runs WHERE snapshot_seq<=? ORDER BY snapshot_seq""", (snapshot_seq,)
    ):
        members = [
            {"ordinal": rank - 1, "slug": slug, "displaySlug": display_slug, "status": status}
            for rank, slug, display_slug, status in connection.execute(
                """SELECT i.display_rank,i.slug,p.display_slug,i.membership_status
                   FROM snapshot_items i JOIN repository_profiles p
                   ON p.profile_id=i.profile_id AND p.slug=i.slug
                   WHERE i.snapshot_seq=? ORDER BY i.display_rank""", (seq,)
            )
        ]
        if len(members) != connection.execute("SELECT repository_count FROM snapshot_runs WHERE snapshot_seq=?", (seq,)).fetchone()[0]:
            raise ValueError("database membership count is inconsistent")
        if run_kind == "migration_baseline":
            if any(member["status"] != "baseline_present" for member in members):
                raise ValueError("migration baseline membership is invalid")
        else:
            for member in members:
                if member["status"] in ("new", "reentered"):
                    database_events.append({
                        "provenance": "repository_snapshot", "snapshotId": snapshot_id,
                        "generatedAt": generated_at, "statsDate": stats_date,
                        "ordinal": member["ordinal"], "slug": member["slug"],
                        "displaySlug": member["displaySlug"], "status": member["status"],
                    })
        database_snapshots.append({
            "snapshotId": snapshot_id, "generatedAt": generated_at,
            "statsDate": stats_date, "members": members,
        })
        if seq == snapshot_seq:
            if prior_members is None or run_kind == "migration_baseline":
                exited = []
            else:
                current_keys = {member["slug"] for member in members}
                exited = [
                    {"ordinal": member["ordinal"], "slug": member["slug"],
                     "displaySlug": member["displaySlug"], "lastSeenAt": database_snapshots[-2]["generatedAt"],
                     "exitedAt": generated_at}
                    for member in prior_members if member["slug"] not in current_keys
                ]
            current = members
        prior_members = members

    all_events = legacy_events + database_events
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for event in all_events:
        groups.setdefault((event["generatedAt"], str(event["snapshotId"])), []).append(event)
    events = []
    for key in sorted(groups, reverse=True):
        events.extend(sorted(groups[key], key=lambda row: row["ordinal"]))
    return {
        "version": 1,
        "targetSnapshotId": target["snapshot_id"],
        "legacySnapshots": legacy_snapshots,
        "databaseSnapshots": database_snapshots,
        "current": current,
        "exited": exited,
        "events": events,
    }


def _normalized_artifact_paths(expected_paths: Iterable[str], base_paths: Iterable[str] = PAGES_BASE_ARTIFACT_PATHS) -> list[str]:
    if isinstance(expected_paths, (str, bytes)):
        raise ValueError("artifact path set is invalid")
    paths = list(expected_paths)
    if not paths or any(not isinstance(value, str) for value in paths):
        raise ValueError("artifact path set is invalid")
    if len(paths) != len(set(paths)) or len(paths) != len({value.casefold() for value in paths}):
        raise ValueError("artifact path set is ambiguous")
    base = set(base_paths)
    if not base.issubset(paths):
        raise ValueError("artifact path set is incomplete")
    for value in paths:
        if value.startswith("/") or "\\" in value or any(part in ("", ".", "..") for part in value.split("/")):
            raise ValueError("artifact path is unsafe")
        if value not in base and not _TRANSLATION_RE.fullmatch(value):
            raise ValueError("artifact path is outside the Pages allowlist")
    return sorted(paths)


def _artifact_bytes(root: Path, relative: str) -> bytes:
    target = root.joinpath(*relative.split("/"))
    try:
        root_real = root.resolve(strict=True)
        if root.is_symlink() or not root.is_dir():
            raise ValueError("candidate root is unsafe")
        current = root
        for part in relative.split("/"):
            current = current / part
            if current.is_symlink():
                raise ValueError("artifact path is unsafe")
        target_real = target.resolve(strict=True)
        if os.path.commonpath((str(root_real), str(target_real))) != str(root_real) or not target.is_file():
            raise ValueError("artifact path is unsafe")
        before = target.stat()
        payload = target.read_bytes()
        after = target.stat()
    except OSError:
        raise ValueError("artifact file is unavailable") from None
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity_before != identity_after or len(payload) != after.st_size:
        raise ValueError("artifact file changed while hashing")
    return payload


def hash_pages_artifacts(candidate_root: str | Path, expected_paths: Iterable[str]) -> list[dict[str, Any]]:
    root = Path(candidate_root)
    paths = _normalized_artifact_paths(expected_paths)
    result = []
    for relative in paths:
        payload = _artifact_bytes(root, relative)
        result.append({"artifact_path": relative, "sha256": hashlib.sha256(payload).hexdigest(), "byte_size": len(payload)})
    return result


def _expected_artifact_paths(connection: sqlite3.Connection, snapshot_seq: int, base_paths: Iterable[str] = PAGES_BASE_ARTIFACT_PATHS) -> list[str]:
    translations = [
        f"translations/{display_slug.replace('/', '__')}.json"
        for display_slug, status in connection.execute(
            """SELECT p.display_slug,i.translation_status FROM snapshot_items i
               JOIN repository_profiles p ON p.profile_id=i.profile_id AND p.slug=i.slug
               WHERE i.snapshot_seq=? ORDER BY i.display_rank""", (snapshot_seq,)
        ) if status == "applicable"
    ]
    return _normalized_artifact_paths((*base_paths, *translations), base_paths)


def _exact_rows(value: Any, keys: set[str], label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(row, dict) or set(row) != keys for row in value):
        raise ValueError(f"{label} rows are invalid")
    return value


def finalize_snapshot_derivatives(
    candidate_database_path: str | Path,
    snapshot_id: str,
    insights: list[dict[str, Any]],
    artifact_hashes: list[dict[str, Any]],
) -> FinalizeResult:
    """Atomically verify and insert the complete target derivative rows."""
    database = Path(candidate_database_path)
    if database.name != "repository-observations.sqlite" or database.parent.name != "data":
        raise ValueError("candidate database layout is invalid")
    candidate_root = database.parent.parent
    try:
        database_real = database.resolve(strict=True)
        root_real = candidate_root.resolve(strict=True)
    except OSError:
        raise ValueError("candidate database is unavailable") from None
    if database.is_symlink() or database_real != root_real / "data" / "repository-observations.sqlite":
        raise ValueError("candidate database layout is invalid")
    insight_keys = {
        "snapshot_seq", "slug", "previous_observed_snapshot_seq", "observation_gap_milliseconds",
        "stars_delta_since_previous_observation", "display_rank_delta", "rank_daily_delta",
        "rank_weekly_delta", "rank_monthly_delta", "insight_rule_version", "insight_sha256",
    }
    artifact_keys = {"artifact_path", "sha256", "byte_size"}
    _exact_rows(insights, insight_keys, "insight")
    _exact_rows(artifact_hashes, artifact_keys, "artifact")
    try:
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA synchronous=FULL")
            validate_schema(connection)
            target = connection.execute("SELECT snapshot_seq,core_payload_sha256,chain_sha256 FROM snapshot_runs WHERE snapshot_id=?", (snapshot_id,)).fetchone()
            if target is None:
                raise ValueError("target snapshot identity is absent")
            snapshot_seq, core_before, chain_before = target
            expected_insights = derive_repository_insights(connection, snapshot_seq)
            if insights != expected_insights:
                raise ValueError("insight derivation does not match the target")
            expected_paths = _expected_artifact_paths(connection, snapshot_seq)
            if [row["artifact_path"] for row in artifact_hashes] != expected_paths:
                raise ValueError("artifact derivation does not match the target")
            connection.execute("BEGIN IMMEDIATE")
            try:
                remeasured = hash_pages_artifacts(candidate_root, expected_paths)
                if artifact_hashes != remeasured:
                    raise ValueError("artifact bytes changed before finalization")
                existing_insights = [dict(zip(_columns(connection, "repository_insights"), row)) for row in connection.execute(
                    "SELECT * FROM repository_insights WHERE snapshot_seq=? ORDER BY slug", (snapshot_seq,)
                )]
                existing_artifacts = [dict(zip(_columns(connection, "artifact_hashes"), row)) for row in connection.execute(
                    "SELECT * FROM artifact_hashes WHERE snapshot_seq=? ORDER BY artifact_path", (snapshot_seq,)
                ) if row[1] not in LEGACY_OVERLAY_ARTIFACT_PATHS]
                artifact_db_rows = [{"snapshot_seq": snapshot_seq, **row} for row in artifact_hashes]
                if existing_insights or existing_artifacts:
                    if existing_insights != insights or existing_artifacts != artifact_db_rows:
                        raise ValueError("existing derivative rows conflict")
                    changed = False
                else:
                    for row in insights:
                        connection.execute(
                            "INSERT INTO repository_insights VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            tuple(row[column] for column in _columns(connection, "repository_insights")),
                        )
                    for row in artifact_db_rows:
                        connection.execute(
                            "INSERT INTO artifact_hashes VALUES (?,?,?,?)",
                            tuple(row[column] for column in _columns(connection, "artifact_hashes")),
                        )
                    changed = True
                validate_schema(connection)
                if connection.execute("PRAGMA foreign_key_check").fetchone() is not None or connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise ValueError("finalized database integrity check failed")
                after = connection.execute("SELECT core_payload_sha256,chain_sha256 FROM snapshot_runs WHERE snapshot_seq=?", (snapshot_seq,)).fetchone()
                if after != (core_before, chain_before):
                    raise ValueError("snapshot core identity changed during finalization")
                connection.commit()
            except Exception:
                connection.rollback()
                raise
    except sqlite3.Error:
        raise ValueError("candidate database finalization failed") from None
    return FinalizeResult(changed, snapshot_seq, len(insights), len(artifact_hashes))


def _strict_json_bytes(payload: bytes, label: str) -> Any:
    if not payload or len(payload) > 64 * 1024 * 1024:
        raise ValueError(f"{label} size is invalid")
    try:
        text = payload.decode("utf-8", errors="strict")

        def pairs(values):
            result = {}
            for key, value in values:
                if key in result:
                    raise ValueError("duplicate key")
                result[key] = value
            return result

        return json.loads(
            text,
            object_pairs_hook=pairs,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-JSON constant")),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ValueError(f"{label} is not strict JSON") from None


def _load_json_path(path: str | Path, label: str) -> Any:
    target = Path(path)
    try:
        if not target.is_file() or target.is_symlink():
            raise OSError
        before = target.stat()
        payload = target.read_bytes()
        after = target.stat()
    except OSError:
        raise ValueError(f"{label} is unavailable") from None
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
    if identity(before) != identity(after) or len(payload) != after.st_size:
        raise ValueError(f"{label} changed while reading")
    return _strict_json_bytes(payload, label)


def _outside_checkout(path: Path) -> None:
    checkout = Path(__file__).resolve().parents[1]
    requested = path.resolve(strict=False)
    if os.path.commonpath((str(checkout), str(requested))) == str(checkout):
        raise ValueError("derivation output must be outside the checkout")


def _write_json_atomic(path: str | Path, value: Any) -> None:
    target = Path(path)
    _outside_checkout(target)
    if target.is_symlink():
        raise ValueError("derivation output path is unsafe")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _snapshot_sequence(connection: sqlite3.Connection, snapshot_id: str, *, require_latest: bool = False) -> int:
    if not isinstance(snapshot_id, str):
        raise ValueError("snapshot identity is invalid")
    row = connection.execute("SELECT snapshot_seq FROM snapshot_runs WHERE snapshot_id=?", (snapshot_id,)).fetchone()
    if row is None:
        raise ValueError("snapshot identity is absent")
    if require_latest:
        latest = connection.execute("SELECT MAX(snapshot_seq) FROM snapshot_runs").fetchone()[0]
        if row[0] != latest:
            raise ValueError("snapshot is not the latest candidate")
    return row[0]


def export_parent_inputs(
    parent_database_path: str | Path,
    legacy_baseline_receipt: dict[str, Any],
    expected_parent_snapshot_id: str | None,
    production_source_sha: str,
    parent_evidence_output: str | Path,
    prior_heads_output: str | Path,
) -> dict[str, Any]:
    """Export exact recorder evidence and commit-continuity heads without repository content."""
    if not isinstance(legacy_baseline_receipt, dict):
        raise ValueError("legacy baseline receipt is invalid")
    if not isinstance(production_source_sha, str) or re.fullmatch(r"[a-f0-9]{40}", production_source_sha) is None:
        raise ValueError("production source SHA is invalid")
    parent = Path(parent_database_path)
    captured = _capture_parent_database(parent)
    if captured is not None:
        _raw, evidence, historical_heads, heads = captured
        if expected_parent_snapshot_id is None or evidence["last_snapshot_id"] != expected_parent_snapshot_id:
            raise ValueError("parent snapshot identity does not match production")
        snapshot_id = evidence["last_snapshot_id"]
        parent_database_sha256 = evidence["file_sha256"]
        snapshot_seq = evidence["last_snapshot_seq"]
    else:
        if expected_parent_snapshot_id is not None:
            raise ValueError("production parent database is missing")
        evidence = {"missing": True}
        heads = {}
        historical_heads = {"scope": "all_historical", "head_count": 0, "heads_sha256": _digest({})}
        snapshot_id = None
        parent_database_sha256 = None
        snapshot_seq = None
    _write_json_atomic(parent_evidence_output, {
        "version": 1,
        "parent_database": evidence,
        "production_source_sha": production_source_sha,
        "historical_heads": historical_heads,
        "legacy_baseline_receipt": legacy_baseline_receipt,
    })
    _write_json_atomic(prior_heads_output, {
        "version": 1,
        "snapshotId": snapshot_id,
        "scope": "all_historical",
        "parentDatabaseSha256": parent_database_sha256,
        "snapshotSeq": snapshot_seq,
        "headCount": len(heads),
        "headsSha256": _digest(heads),
        "heads": heads,
    })
    return {"parent_snapshot_id": snapshot_id, "head_count": len(heads)}


def verify_parent_inputs(
    parent_database_path: str | Path,
    parent_evidence_path: str | Path,
    prior_heads_path: str | Path,
) -> dict[str, Any]:
    """Remeasure one frozen parent DB and its two exact content-free receipts."""
    evidence_envelope = _load_json_path(parent_evidence_path, "parent evidence")
    prior_heads = _load_json_path(prior_heads_path, "prior heads")
    declared_parent, _legacy_receipt, declared_historical, _production_source_sha = _parse_parent_evidence_envelope(evidence_envelope)
    parent = Path(parent_database_path)
    captured = _capture_parent_database(parent)
    if captured is not None:
        _raw, actual, actual_historical, heads = captured
        if declared_parent != actual:
            raise ValueError("parent database evidence mismatch")
        if declared_historical != actual_historical:
            raise ValueError("parent historical evidence mismatch")
        expected_prior = {
            "version": 1,
            "snapshotId": actual["last_snapshot_id"],
            "scope": "all_historical",
            "parentDatabaseSha256": actual["file_sha256"],
            "snapshotSeq": actual["last_snapshot_seq"],
            "headCount": len(heads),
            "headsSha256": _digest(heads),
            "heads": heads,
        }
    else:
        if declared_parent != {"missing": True}:
            raise ValueError("parent database evidence mismatch")
        empty_historical = {"scope": "all_historical", "head_count": 0, "heads_sha256": _digest({})}
        if declared_historical != empty_historical:
            raise ValueError("parent historical evidence mismatch")
        expected_prior = {
            "version": 1,
            "snapshotId": None,
            "scope": "all_historical",
            "parentDatabaseSha256": None,
            "snapshotSeq": None,
            "headCount": 0,
            "headsSha256": _digest({}),
            "heads": {},
        }
    if prior_heads != expected_prior:
        raise ValueError("parent input receipt mismatch")
    return {"verified": True, "version": 1}


def _summary_content(index: dict[str, Any], item: dict[str, Any]) -> tuple[dict[str, str] | None, str]:
    repositories = index.get("repositories")
    entry = repositories.get(item["slug"]) if isinstance(repositories, dict) else None
    if isinstance(entry, dict) and entry.get("status") == "held":
        expected = held_summary_digests(item["slug"], entry.get("held_reason"))
        if expected != (item["summary_source_sha256"], item["summary_content_sha256"], item["summary_envelope_sha256"]):
            raise ValueError("enrichment summary does not match the recorded snapshot")
        return None, "held"
    status = entry.get("status", "verified") if isinstance(entry, dict) else "verified"
    if status not in ("verified", "retained"):
        raise ValueError("enrichment summary status is invalid")
    summary = entry.get("summary") if isinstance(entry, dict) else None
    content = summary.get("content") if isinstance(summary, dict) else None
    source = summary.get("source") if isinstance(summary, dict) else None
    if not isinstance(content, dict) or set(content) != {"goal", "usage", "pros", "cons", "fit"} or any(
        not isinstance(value, str) or not value.strip() for value in content.values()
    ) or not isinstance(source, dict):
        raise ValueError("enrichment summary is invalid")
    if (
        _digest(source) != item["summary_source_sha256"]
        or _digest(content) != item["summary_content_sha256"]
        or _digest({"content": content, "source": source}) != item["summary_envelope_sha256"]
    ):
        raise ValueError("enrichment summary does not match the recorded snapshot")
    return content, status


def _json_array(value: str, label: str) -> list[Any]:
    parsed = _strict_json_bytes(value.encode("utf-8"), label)
    if not isinstance(parsed, list):
        raise ValueError(f"{label} is invalid")
    return parsed


def derive_candidate_artifacts(
    database_path: str | Path,
    legacy_membership_path: str | Path,
    enrichment_index: dict[str, Any],
    snapshot_id: str,
) -> dict[str, Any]:
    """Derive every candidate public JSON input from one exact core snapshot."""
    database = Path(database_path)
    if not database.is_file() or database.is_symlink():
        raise ValueError("candidate database is unavailable")
    for suffix in ("-journal", "-wal", "-shm"):
        if Path(f"{database}{suffix}").exists():
            raise ValueError("candidate database has a pending SQLite sidecar")
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        validate_schema(connection)
        snapshot_seq = _snapshot_sequence(connection, snapshot_id, require_latest=True)
        target = _target_run(connection, snapshot_seq)
        items = []
        item_columns = _columns(connection, "snapshot_items")
        for raw in connection.execute("SELECT * FROM snapshot_items WHERE snapshot_seq=? ORDER BY display_rank", (snapshot_seq,)):
            item = dict(zip(item_columns, raw))
            profile_columns = _columns(connection, "repository_profiles")
            profile_raw = connection.execute("SELECT * FROM repository_profiles WHERE profile_id=? AND slug=?", (item["profile_id"], item["slug"])).fetchone()
            if profile_raw is None:
                raise ValueError("repository profile is absent")
            profile = dict(zip(profile_columns, profile_raw))
            summary, summary_status = _summary_content(enrichment_index, item)
            items.append({
                "slug": profile["display_slug"],
                "name": profile["display_slug"].replace("/", " / ", 1),
                "description": profile["description"] or "",
                "lang": profile["primary_language"],
                "topics": _json_array(profile["topics_json"], "repository topics"),
                "stars": item["stars"],
                "forks": item["forks"],
                "issues": item["open_issues_and_pull_requests"],
                "contributors": item["contributors"],
                "gains": {"daily": item["gain_daily"], "weekly": item["gain_weekly"], "monthly": item["gain_monthly"]},
                "signal": None,
                "summary": summary,
                "summary_status": summary_status,
                "tag_rule_version": profile["tag_rule_version"],
                "field_tags": _json_array(profile["field_tags_json"], "repository field tags"),
                "form_tags": _json_array(profile["form_tags_json"], "repository form tags"),
            })
        if len(items) != target["repository_count"]:
            raise ValueError("snapshot export count is inconsistent")
        insights = derive_repository_insights(connection, snapshot_seq)
        daily = derive_daily_star_series(connection, snapshot_seq)
        membership = derive_membership_timeline(connection, legacy_membership_path, snapshot_seq)
    status = {
        "schemaVersion": 1,
        "generatedAt": target["observed_at_utc"],
        "statsDate": target["stats_date_kst"],
        "baseline": target["run_kind"] == "migration_baseline",
        "current": [
            {"slug": row["displaySlug"], "status": "baseline" if row["status"] == "baseline_present" else row["status"]}
            for row in membership["current"]
        ],
        "exited": [
            {"slug": row["displaySlug"], "lastSeenAt": row["lastSeenAt"], "exitedAt": row["exitedAt"]}
            for row in membership["exited"]
        ],
    }
    return {
        "snapshot_export": {
            "version": 1,
            "snapshotId": target["snapshot_id"],
            "generatedAt": target["observed_at_utc"],
            "statsDate": target["stats_date_kst"],
            "repositories": items,
        },
        "membership_status": status,
        "insights": {"version": 1, "snapshotId": target["snapshot_id"], "insights": insights},
        "daily_star_series": daily,
    }


def verify_pages_artifacts(database_path: str | Path, snapshot_id: str, candidate_root: str | Path) -> dict[str, Any]:
    """Verify finalized DB rows equal the complete Pages path/hash/size contract."""
    database = Path(database_path)
    root = Path(candidate_root)
    try:
        if database.resolve(strict=True) != root.resolve(strict=True) / "data" / "repository-observations.sqlite":
            raise ValueError("candidate database layout is invalid")
    except OSError:
        raise ValueError("candidate database is unavailable") from None
    for suffix in ("-journal", "-wal", "-shm"):
        if Path(f"{database}{suffix}").exists():
            raise ValueError("candidate database has a pending SQLite sidecar")
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        validate_schema(connection)
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None or connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("candidate database integrity check failed")
        snapshot_seq = _snapshot_sequence(connection, snapshot_id, require_latest=True)
        for seq, in connection.execute("SELECT snapshot_seq FROM snapshot_runs ORDER BY snapshot_seq"):
            verify_core_snapshot(connection, seq)
        run_count = connection.execute("SELECT repository_count FROM snapshot_runs WHERE snapshot_seq=?", (snapshot_seq,)).fetchone()[0]
        item_count = connection.execute("SELECT COUNT(*) FROM snapshot_items WHERE snapshot_seq=?", (snapshot_seq,)).fetchone()[0]
        if run_count != item_count:
            raise ValueError("candidate repository count is inconsistent")
        expected_paths = _expected_artifact_paths(connection, snapshot_seq)
        columns = _columns(connection, "artifact_hashes")
        stored = [dict(zip(columns, row)) for row in connection.execute(
            "SELECT * FROM artifact_hashes WHERE snapshot_seq=? ORDER BY artifact_path", (snapshot_seq,)
        ) if row[columns.index("artifact_path")] not in LEGACY_OVERLAY_ARTIFACT_PATHS]
    expected_rows = [{"snapshot_seq": snapshot_seq, **row} for row in hash_pages_artifacts(root, expected_paths)]
    if stored != expected_rows:
        raise ValueError("finalized Pages artifact contract does not match candidate bytes")
    return {
        "version": 1,
        "snapshotId": snapshot_id,
        "artifacts": [
            {"artifact_path": row["artifact_path"], "sha256": row["sha256"], "byte_size": row["byte_size"]}
            for row in stored
        ],
    }


def read_finalized_artifact_contract(database_path: str | Path, snapshot_id: str) -> dict[str, Any]:
    """Read and validate the finalized Pages contract from a closed Git DB blob."""
    database = Path(database_path)
    if not database.is_file() or database.is_symlink():
        raise ValueError("repository observation database is unavailable")
    for suffix in ("-journal", "-wal", "-shm"):
        if Path(f"{database}{suffix}").exists():
            raise ValueError("repository observation database has a pending SQLite sidecar")
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        validate_schema(connection)
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None or connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("repository observation database integrity check failed")
        snapshot_seq = _snapshot_sequence(connection, snapshot_id, require_latest=True)
        for seq, in connection.execute("SELECT snapshot_seq FROM snapshot_runs ORDER BY snapshot_seq"):
            verify_core_snapshot(connection, seq)
        # A closed blob may hold a snapshot finalized by an earlier release, whose rows are exact
        # for that release's shipped-file list; the consumer (the probe, the builder) pins which
        # list the deployment must match, so this reader accepts any version a release has shipped.
        accepted_paths = [_expected_artifact_paths(connection, snapshot_seq, base) for base in PAGES_BASE_ARTIFACT_PATH_HISTORY]
        rows = [
            {"artifact_path": row[0], "sha256": row[1], "byte_size": row[2]}
            for row in connection.execute(
                "SELECT artifact_path,sha256,byte_size FROM artifact_hashes WHERE snapshot_seq=? ORDER BY artifact_path",
                (snapshot_seq,),
            ) if row[0] not in LEGACY_OVERLAY_ARTIFACT_PATHS
        ]
    if [row["artifact_path"] for row in rows] not in accepted_paths:
        raise ValueError("finalized artifact path set is incomplete")
    return {"version": 1, "snapshotId": snapshot_id, "artifacts": rows}


def _derive_cli(args: argparse.Namespace) -> dict[str, Any]:
    index = _load_json_path(args.enrichment_index, "enrichment index")
    derived = derive_candidate_artifacts(args.database, args.legacy_membership_database, index, args.snapshot_id)
    _write_json_atomic(args.snapshot_export_out, derived["snapshot_export"])
    _write_json_atomic(args.membership_status_out, derived["membership_status"])
    _write_json_atomic(args.insights_out, derived["insights"])
    return {"snapshot_id": args.snapshot_id, "repository_count": len(derived["snapshot_export"]["repositories"])}


def _finalize_cli(args: argparse.Namespace) -> dict[str, Any]:
    envelope = _load_json_path(args.insights, "insight derivation")
    if not isinstance(envelope, dict) or set(envelope) != {"version", "snapshotId", "insights"} or envelope["version"] != 1 or envelope["snapshotId"] != args.snapshot_id:
        raise ValueError("insight derivation envelope is invalid")
    database = Path(args.database)
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        validate_schema(connection)
        seq = _snapshot_sequence(connection, args.snapshot_id, require_latest=True)
        paths = _expected_artifact_paths(connection, seq)
    hashes = hash_pages_artifacts(args.candidate_root, paths)
    result = finalize_snapshot_derivatives(database, args.snapshot_id, envelope["insights"], hashes)
    if not result.changed:
        raise ValueError("snapshot derivatives were already finalized")
    return {"snapshot_seq": result.snapshot_seq, "insight_count": result.insight_count, "artifact_count": result.artifact_count}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Derive and finalize repository observation artifacts")
    commands = parser.add_subparsers(dest="command", required=True)
    parent = commands.add_parser("export-parent-inputs")
    parent.add_argument("--parent-database", required=True)
    parent.add_argument("--baseline-receipt", required=True)
    parent.add_argument("--expected-parent-snapshot", required=True)
    parent.add_argument("--production-source-sha", required=True)
    parent.add_argument("--parent-evidence-out", required=True)
    parent.add_argument("--prior-heads-out", required=True)
    verify_parent = commands.add_parser("verify-parent-inputs")
    verify_parent.add_argument("--parent-database", required=True)
    verify_parent.add_argument("--parent-evidence", required=True)
    verify_parent.add_argument("--prior-heads", required=True)
    derive = commands.add_parser("derive")
    derive.add_argument("--database", required=True)
    derive.add_argument("--legacy-membership-database", required=True)
    derive.add_argument("--enrichment-index", required=True)
    derive.add_argument("--snapshot-id", required=True)
    derive.add_argument("--snapshot-export-out", required=True)
    derive.add_argument("--membership-status-out", required=True)
    derive.add_argument("--insights-out", required=True)
    finalize = commands.add_parser("finalize")
    finalize.add_argument("--database", required=True)
    finalize.add_argument("--snapshot-id", required=True)
    finalize.add_argument("--insights", required=True)
    finalize.add_argument("--candidate-root", required=True)
    verify = commands.add_parser("verify-pages")
    verify.add_argument("--database", required=True)
    verify.add_argument("--snapshot-id", required=True)
    verify.add_argument("--candidate-root", required=True)
    verify.add_argument("--contract-out", required=True)
    export_contract = commands.add_parser("export-contract")
    export_contract.add_argument("--database", required=True)
    export_contract.add_argument("--snapshot-id", required=True)
    export_contract.add_argument("--contract-out", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "export-parent-inputs":
        receipt = _load_json_path(args.baseline_receipt, "legacy baseline receipt")
        result = export_parent_inputs(
            args.parent_database,
            receipt,
            None if args.expected_parent_snapshot == "none" else args.expected_parent_snapshot,
            args.production_source_sha,
            args.parent_evidence_out,
            args.prior_heads_out,
        )
    elif args.command == "verify-parent-inputs":
        result = verify_parent_inputs(args.parent_database, args.parent_evidence, args.prior_heads)
    elif args.command == "derive":
        result = _derive_cli(args)
    elif args.command == "finalize":
        result = _finalize_cli(args)
    elif args.command == "verify-pages":
        contract = verify_pages_artifacts(args.database, args.snapshot_id, args.candidate_root)
        _write_json_atomic(args.contract_out, contract)
        result = {"snapshot_id": args.snapshot_id, "artifact_count": len(contract["artifacts"])}
    else:
        contract = read_finalized_artifact_contract(args.database, args.snapshot_id)
        _write_json_atomic(args.contract_out, contract)
        result = {"snapshot_id": args.snapshot_id, "artifact_count": len(contract["artifacts"])}
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
