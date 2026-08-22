"""Parse and append public GitHub star observations to schema v1."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Sequence


REPOS_START = "// GENERATED:TRENDING-REPOS:START"
REPOS_END = "// GENERATED:TRENDING-REPOS:END"
REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SUMMARY_FIELDS = ("goal", "usage", "pros", "cons", "fit")
PERIOD_FIELDS = ("stars_daily", "stars_weekly", "stars_monthly")
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SCHEMA_VERSION = 1


@dataclass(frozen=True)
class RepositoryObservation:
    slug: str
    observed_date: str
    stars: int


@dataclass(frozen=True)
class StarObservation:
    slug: str
    observed_date: str
    stars: int
    source: str


@dataclass(frozen=True)
class RecordResult:
    rest_inserted: int
    legacy_inserted: int


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


def _valid_count(value) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def _valid_text(value, *, nonempty=False) -> bool:
    return isinstance(value, str) and (not nonempty or bool(value.strip()))


def _slug(value) -> str:
    if not isinstance(value, str) or not REPO_PATTERN.fullmatch(value):
        raise ValueError(f"Invalid repository slug: {value!r}")
    return value


def _marked_repositories(page: str) -> str:
    if not isinstance(page, str):
        raise ValueError("REPOS page must be text")
    if page.count(REPOS_START) != 1 or page.count(REPOS_END) != 1:
        raise ValueError("Expected exactly one REPOS marker pair")
    start = page.index(REPOS_START) + len(REPOS_START)
    end = page.index(REPOS_END, start)
    if end < start:
        raise ValueError("Invalid REPOS marker order")
    body = page[start:end].strip()
    match = re.fullmatch(r"const REPOS = (\[[\s\S]*\]);", body)
    if not match:
        raise ValueError("Generated REPOS region is malformed")
    return match.group(1)


def _complete_summary(repo: dict) -> bool:
    summary = repo.get("summary")
    detail = repo.get("detail")
    return (
        isinstance(summary, dict)
        and isinstance(detail, dict)
        and all(_valid_text(summary.get(field), nonempty=True) for field in SUMMARY_FIELDS)
        and all(_valid_text(detail.get(field), nonempty=True) for field in SUMMARY_FIELDS)
        and _valid_text(detail.get("stars_note"), nonempty=True)
    )


def parse_repositories(page: str) -> list[RepositoryObservation]:
    """Parse the exact generated REPOS region and validate the complete UI boundary."""
    repos = _load_json(_marked_repositories(page))
    if not isinstance(repos, list) or not 10 <= len(repos) <= 75:
        raise ValueError("REPOS must contain 10-75 repositories")

    parsed = []
    seen = set()
    snapshot_date = repos[0].get("_stats_date") if isinstance(repos[0], dict) else None
    if not _valid_date(snapshot_date):
        raise ValueError("REPOS must use one valid _stats_date")

    for repo in repos:
        if not isinstance(repo, dict):
            raise ValueError("Every REPOS item must be an object")
        slug = _slug(repo.get("slug"))
        key = slug.lower()
        if key in seen:
            raise ValueError(f"Duplicate REPOS slug: {slug}")
        seen.add(key)
        if repo.get("_stats_date") != snapshot_date:
            raise ValueError(f"Inconsistent _stats_date for {slug}")
        if not (
            _valid_text(repo.get("name"), nonempty=True)
            and _valid_text(repo.get("desc"))
            and _valid_text(repo.get("lang"))
            and _valid_text(repo.get("color"))
            and all(_valid_count(repo.get(field)) for field in ("stars", "forks", "issues", "contributors"))
            and _complete_summary(repo)
        ):
            raise ValueError(f"Invalid full UI schema for {slug}")
        gains = [repo[field] for field in PERIOD_FIELDS if field in repo]
        if not gains or not all(_valid_count(value) for value in gains):
            raise ValueError(f"Invalid period gains for {slug}")
        parsed.append(RepositoryObservation(slug, snapshot_date, repo["stars"]))
    return parsed


def parse_legacy_star_history(page: str) -> list[StarObservation]:
    """Parse every valid point from the single legacy inline STAR_HISTORY constant."""
    if not isinstance(page, str):
        raise ValueError("STAR_HISTORY page must be text")
    declarations = list(re.finditer(r"(?m)^const STAR_HISTORY=", page))
    if len(declarations) != 1:
        raise ValueError("Expected exactly one STAR_HISTORY declaration")
    start = declarations[0].end()
    try:
        entries, end = json.JSONDecoder(parse_constant=_json_error).raw_decode(page, start)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError("STAR_HISTORY is not valid JSON") from error
    line_end = page.find("\n", end)
    if page[end:line_end if line_end >= 0 else len(page)].strip() != ";":
        raise ValueError("STAR_HISTORY declaration is malformed")
    if not isinstance(entries, list):
        raise ValueError("STAR_HISTORY must be an array")

    observations = []
    seen_slugs = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Every STAR_HISTORY item must be an object")
        slug = _slug(entry.get("slug"))
        key = slug.lower()
        if key in seen_slugs:
            raise ValueError(f"Duplicate STAR_HISTORY slug: {slug}")
        seen_slugs.add(key)
        history = entry.get("hist")
        if not isinstance(history, list):
            raise ValueError(f"Invalid STAR_HISTORY points for {slug}")
        seen_dates = set()
        for point in history:
            if not isinstance(point, dict) or not _valid_date(point.get("d")) or not _valid_count(point.get("s")):
                raise ValueError(f"Invalid STAR_HISTORY point for {slug}")
            if point["d"] in seen_dates:
                raise ValueError(f"Duplicate STAR_HISTORY date for {slug}: {point['d']}")
            seen_dates.add(point["d"])
            observations.append(StarObservation(slug, point["d"], point["s"], "legacy_inline"))
    return observations


SCHEMA_STATEMENTS = (
    """CREATE TABLE schema_meta (
    schema_version INTEGER PRIMARY KEY CHECK (schema_version = 1),
    creation_policy TEXT NOT NULL CHECK (creation_policy = 'append_only')
)""",
    "INSERT INTO schema_meta VALUES (1, 'append_only')",
    """CREATE TABLE repositories (
    slug TEXT PRIMARY KEY COLLATE NOCASE,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    CHECK (first_seen <= last_seen)
)""",
    """CREATE TABLE star_observations (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL COLLATE NOCASE REFERENCES repositories(slug),
    observed_date TEXT NOT NULL,
    stars_total INTEGER NOT NULL CHECK (stars_total >= 0),
    stars_delta INTEGER,
    source TEXT NOT NULL CHECK (source IN ('legacy_inline', 'github_rest')),
    UNIQUE (slug, observed_date, source)
)""",
    "CREATE INDEX idx_star_observations_date ON star_observations(observed_date)",
    "CREATE INDEX idx_star_observations_slug_date ON star_observations(slug, observed_date)",
    """CREATE TRIGGER star_observations_no_update
BEFORE UPDATE ON star_observations
BEGIN
    SELECT RAISE(ABORT, 'star observations are append-only');
END""",
    """CREATE TRIGGER star_observations_no_delete
BEFORE DELETE ON star_observations
BEGIN
    SELECT RAISE(ABORT, 'star observations are append-only');
END""",
)


EXPECTED_OBJECTS = {
    ("table", "schema_meta"),
    ("table", "repositories"),
    ("table", "star_observations"),
    ("index", "idx_star_observations_date"),
    ("index", "idx_star_observations_slug_date"),
    ("trigger", "star_observations_no_update"),
    ("trigger", "star_observations_no_delete"),
}


def _validate_schema(connection: sqlite3.Connection):
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version != SCHEMA_VERSION:
        raise ValueError(f"Unsupported existing database schema version: {version}")
    objects = set(connection.execute(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    ))
    if not EXPECTED_OBJECTS <= objects:
        raise ValueError("Existing schema v1 is incomplete")
    if connection.execute("SELECT schema_version, creation_policy FROM schema_meta").fetchall() != [(1, "append_only")]:
        raise ValueError("Existing schema v1 metadata is invalid")


def _validate_repository_inputs(repositories: Sequence[RepositoryObservation]):
    if not isinstance(repositories, Sequence) or isinstance(repositories, (str, bytes)) or not 10 <= len(repositories) <= 75:
        raise ValueError("repositories must contain 10-75 observations")
    seen = set()
    dates = set()
    for repo in repositories:
        if not isinstance(repo, RepositoryObservation):
            raise ValueError("Invalid repository observation")
        slug = _slug(repo.slug)
        if slug.lower() in seen or not _valid_date(repo.observed_date) or not _valid_count(repo.stars):
            raise ValueError(f"Invalid repository observation: {slug}")
        seen.add(slug.lower())
        dates.add(repo.observed_date)
    if len(dates) != 1:
        raise ValueError("repository observations must share one date")


def _validate_legacy_inputs(observations: Sequence[StarObservation]):
    if not isinstance(observations, Sequence) or isinstance(observations, (str, bytes)):
        raise ValueError("legacy observations must be a sequence")
    seen = set()
    for observation in observations:
        if not isinstance(observation, StarObservation):
            raise ValueError("Invalid legacy observation")
        slug = _slug(observation.slug)
        key = (slug.lower(), observation.observed_date)
        if (
            observation.source != "legacy_inline"
            or not _valid_date(observation.observed_date)
            or not _valid_count(observation.stars)
            or key in seen
        ):
            raise ValueError(f"Invalid legacy observation: {slug}")
        seen.add(key)


def _upsert_repository(connection: sqlite3.Connection, slug: str, seen_date: str):
    connection.execute(
        """
        INSERT INTO repositories(slug, first_seen, last_seen) VALUES (?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            first_seen = MIN(repositories.first_seen, excluded.first_seen),
            last_seen = MAX(repositories.last_seen, excluded.last_seen)
        """,
        (slug, seen_date, seen_date),
    )


def _append_observation(connection: sqlite3.Connection, observation: StarObservation) -> int:
    canonical_slug = connection.execute(
        "SELECT slug FROM repositories WHERE slug = ? COLLATE NOCASE", (observation.slug,)
    ).fetchone()[0]
    if connection.execute(
        "SELECT 1 FROM star_observations WHERE slug = ? COLLATE NOCASE AND observed_date = ? AND source = ?",
        (canonical_slug, observation.observed_date, observation.source),
    ).fetchone():
        return 0
    prior = connection.execute(
        """
        SELECT stars_total FROM star_observations
        WHERE slug = ? COLLATE NOCASE AND source = ? AND observed_date < ?
        ORDER BY observed_date DESC LIMIT 1
        """,
        (canonical_slug, observation.source, observation.observed_date),
    ).fetchone()
    delta = None if prior is None else observation.stars - prior[0]
    connection.execute(
        "INSERT INTO star_observations(slug, observed_date, stars_total, stars_delta, source) VALUES (?, ?, ?, ?, ?)",
        (canonical_slug, observation.observed_date, observation.stars, delta, observation.source),
    )
    return 1


def _remove_new_database(path: Path):
    for candidate in (path, Path(f"{path}-journal"), Path(f"{path}-wal"), Path(f"{path}-shm")):
        candidate.unlink(missing_ok=True)


def record_observations(
    database_path: str | Path,
    repositories: Sequence[RepositoryObservation],
    legacy_observations: Sequence[StarObservation],
) -> RecordResult:
    """Append one complete run atomically; existing observation rows never change."""
    _validate_repository_inputs(repositories)
    _validate_legacy_inputs(legacy_observations)
    path = Path(database_path)
    existed = path.exists()
    connection = sqlite3.connect(path)
    succeeded = False
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        if existed:
            _validate_schema(connection)
        journal_mode = connection.execute("PRAGMA journal_mode = DELETE").fetchone()[0]
        if journal_mode.lower() != "delete":
            raise sqlite3.DatabaseError(f"Could not set DELETE journal mode: {journal_mode}")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("BEGIN IMMEDIATE")
        if not existed:
            for statement in SCHEMA_STATEMENTS:
                connection.execute(statement)
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        _validate_schema(connection)

        for repo in repositories:
            _upsert_repository(connection, repo.slug, repo.observed_date)
        for observation in legacy_observations:
            _upsert_repository(connection, observation.slug, observation.observed_date)

        legacy_inserted = sum(
            _append_observation(connection, observation)
            for observation in sorted(legacy_observations, key=lambda item: (item.slug.lower(), item.observed_date))
        )
        rest_inserted = sum(
            _append_observation(
                connection,
                StarObservation(repo.slug, repo.observed_date, repo.stars, "github_rest"),
            )
            for repo in repositories
        )
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise sqlite3.IntegrityError("Foreign-key check failed")
        if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise sqlite3.DatabaseError("SQLite integrity check failed")
        connection.commit()
        succeeded = True
        return RecordResult(rest_inserted, legacy_inserted)
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
        if not existed and not succeeded:
            _remove_new_database(path)
