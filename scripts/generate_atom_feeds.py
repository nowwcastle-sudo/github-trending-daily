"""Generate deterministic Atom feeds from one verified repository snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import uuid
import xml.etree.ElementTree as ET
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

try:
    from scripts.record_repository_observations import FIELD_TAGS, FORM_TAGS, validate_schema
except ModuleNotFoundError as error:
    if error.name not in {"scripts", "scripts.record_repository_observations"}:
        raise
    from record_repository_observations import FIELD_TAGS, FORM_TAGS, validate_schema


ATOM_NAMESPACE = "http://www.w3.org/2005/Atom"
SITE_URL = "https://nowwcastle-sudo.github.io/github-trending-daily/"
SNAPSHOT_SCHEME = f"{SITE_URL}snapshot"
STATS_DATE_SCHEME = f"{SITE_URL}stats-date"
TAG_RULE_VERSION = 1
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PAGE = REPOSITORY_ROOT / "index.html"
DEFAULT_LATEST = REPOSITORY_ROOT / "data" / "latest.json"
DEFAULT_DATABASE = REPOSITORY_ROOT / "data" / "repository-observations.sqlite"
DEFAULT_LEGACY_MEMBERSHIP = REPOSITORY_ROOT / "data" / "trending-membership.sqlite"
DEFAULT_FEED = REPOSITORY_ROOT / "feed.xml"
DEFAULT_CHANGES = REPOSITORY_ROOT / "changes.xml"
ET.register_namespace("", ATOM_NAMESPACE)

_SNAPSHOT_RE = re.compile(r"\d{14}-[a-f0-9]{16}")
_SHA256_RE = re.compile(r"[a-f0-9]{64}")
_SLUG_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_UTC_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_LATEST_KEYS = {"snapshotId", "generatedAt", "statsDate", "count", "repos"}
_REPOSITORY_KEYS = {
    "slug", "name", "description", "lang", "topics", "stars", "forks", "issues", "contributors",
    "gains", "signal", "summary", "tag_rule_version", "field_tags", "form_tags",
}
_SUMMARY_KEYS = {"goal", "usage", "pros", "cons", "fit"}
_TIMELINE_KEYS = {"version", "targetSnapshotId", "legacySnapshots", "databaseSnapshots", "current", "exited", "events"}


def _input_error() -> ValueError:
    return ValueError("Atom input is invalid")


def _timeline_error() -> ValueError:
    return ValueError("membership timeline is invalid")


def _atom(name: str) -> str:
    return f"{{{ATOM_NAMESPACE}}}{name}"


def _child(parent, name, text=None, **attributes):
    element = ET.SubElement(parent, _atom(name), attributes)
    if text is not None:
        element.text = text
    return element


def _exact(value, keys) -> bool:
    return isinstance(value, dict) and set(value) == set(keys)


def _timestamp(value):
    if not isinstance(value, str) or not _UTC_RE.fullmatch(value):
        raise _input_error()
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise _input_error() from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        raise _input_error()
    return parsed


def _date(value):
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise _input_error()
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError as error:
        raise _input_error() from error
    if parsed.strftime("%Y-%m-%d") != value:
        raise _input_error()
    return value


def _slug(value, *, canonical=False):
    if not isinstance(value, str) or not _SLUG_RE.fullmatch(value):
        raise _input_error()
    if canonical and value != value.lower():
        raise _input_error()
    return value


def _ordered_tags(value, allowed, *, field=False):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value) or len(value) != len(set(value)):
        raise _input_error()
    if field and value == ["unclassified"]:
        return value
    if field and (not value or "unclassified" in value):
        raise _input_error()
    if any(item not in allowed for item in value) or value != [item for item in allowed if item in value]:
        raise _input_error()
    return value


def _snapshot_id(value, generated_at):
    if not isinstance(value, str) or not _SNAPSHOT_RE.fullmatch(value):
        raise _input_error()
    expected = hashlib.sha256(f"{generated_at}|run-context-v1".encode()).hexdigest()[:16]
    digits = re.sub(r"\D", "", generated_at)[:14]
    if value != f"{digits}-{expected}":
        raise _input_error()
    return value


def _marked_repositories(page: str):
    if not isinstance(page, str):
        raise _input_error()
    start = "// GENERATED:TRENDING-REPOS:START"
    end = "// GENERATED:TRENDING-REPOS:END"
    if page.count(start) != 1 or page.count(end) != 1:
        raise _input_error()
    block = page.split(start, 1)[1].split(end, 1)[0]
    match = re.search(r"const\s+REPOS\s*=\s*(\[[\s\S]*\])\s*;", block)
    if match is None:
        raise _input_error()
    try:
        repositories = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise _input_error() from error
    if not isinstance(repositories, list):
        raise _input_error()
    return repositories


def _validate_repository(repository):
    if not _exact(repository, _REPOSITORY_KEYS):
        raise _input_error()
    _slug(repository["slug"])
    if not isinstance(repository["name"], str) or not repository["name"].strip():
        raise _input_error()
    if not isinstance(repository["description"], str) or not repository["description"].strip():
        raise _input_error()
    if repository["lang"] is not None and not isinstance(repository["lang"], str):
        raise _input_error()
    topics = repository["topics"]
    if (
        not isinstance(topics, list)
        or any(not isinstance(item, str) for item in topics)
        or len(topics) != len(set(topics))
        or topics != sorted(topics)
    ):
        raise _input_error()
    for key in ("stars", "forks", "issues", "contributors"):
        if isinstance(repository[key], bool) or not isinstance(repository[key], int) or repository[key] < 0:
            raise _input_error()
    gains = repository["gains"]
    if not _exact(gains, {"daily", "weekly", "monthly"}) or any(
        value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0)
        for value in gains.values()
    ):
        raise _input_error()
    signal = repository["signal"]
    if signal is not None and (
        not _exact(signal, {"streakDays", "starsChange"})
        or isinstance(signal["streakDays"], bool) or not isinstance(signal["streakDays"], int) or signal["streakDays"] < 0
        or (signal["starsChange"] is not None and (isinstance(signal["starsChange"], bool) or not isinstance(signal["starsChange"], int)))
    ):
        raise _input_error()
    summary = repository["summary"]
    if not _exact(summary, _SUMMARY_KEYS) or any(not isinstance(value, str) or not value.strip() for value in summary.values()):
        raise _input_error()
    if repository["tag_rule_version"] != TAG_RULE_VERSION or isinstance(repository["tag_rule_version"], bool):
        raise _input_error()
    _ordered_tags(repository["field_tags"], FIELD_TAGS, field=True)
    _ordered_tags(repository["form_tags"], FORM_TAGS)


def _validate_latest_contract(page, latest):
    if not _exact(latest, _LATEST_KEYS):
        raise _input_error()
    generated_at = latest["generatedAt"]
    _timestamp(generated_at)
    snapshot_id = _snapshot_id(latest["snapshotId"], generated_at)
    _date(latest["statsDate"])
    if datetime.fromtimestamp(_timestamp(generated_at).timestamp() + 9 * 60 * 60, tz=timezone.utc).strftime("%Y-%m-%d") != latest["statsDate"]:
        raise _input_error()
    repositories = latest["repos"]
    page_repositories = _marked_repositories(page)
    if not isinstance(repositories, list) or not 10 <= len(repositories) <= 75 or latest["count"] != len(repositories):
        raise _input_error()
    if len(page_repositories) != len(repositories):
        raise _input_error()
    seen = set()
    for page_repository, repository in zip(page_repositories, repositories):
        _validate_repository(repository)
        folded = repository["slug"].lower()
        if folded in seen or not isinstance(page_repository, dict):
            raise _input_error()
        seen.add(folded)
        required_page = {
            "slug", "desc", "tag_rule_version", "field_tags", "form_tags",
            "_snapshot_id", "_generated_at", "_stats_date",
        }
        if not required_page.issubset(page_repository):
            raise _input_error()
        if (
            page_repository["slug"] != repository["slug"]
            or page_repository["desc"] != repository["description"]
            or page_repository["tag_rule_version"] != repository["tag_rule_version"]
            or page_repository["field_tags"] != repository["field_tags"]
            or page_repository["form_tags"] != repository["form_tags"]
            or page_repository["_snapshot_id"] != snapshot_id
            or page_repository["_generated_at"] != generated_at
            or page_repository["_stats_date"] != latest["statsDate"]
        ):
            raise _input_error()
    return snapshot_id


def _timeline_timestamp(value):
    try:
        return _timestamp(value)
    except ValueError as error:
        raise _timeline_error() from error


def _timeline_date(value):
    try:
        return _date(value)
    except ValueError as error:
        raise _timeline_error() from error


def _timeline_slug(value, *, canonical=False):
    try:
        return _slug(value, canonical=canonical)
    except ValueError as error:
        raise _timeline_error() from error


def _validate_ordinals(members, keys, statuses=None):
    if not isinstance(members, list):
        raise _timeline_error()
    seen = set()
    for index, member in enumerate(members):
        if not _exact(member, keys) or member["ordinal"] != index:
            raise _timeline_error()
        slug = _timeline_slug(member["slug"], canonical="displaySlug" in member)
        if slug.lower() in seen:
            raise _timeline_error()
        seen.add(slug.lower())
        if "displaySlug" in member:
            _timeline_slug(member["displaySlug"])
            if member["displaySlug"].lower() != slug:
                raise _timeline_error()
        if statuses is not None and member["status"] not in statuses:
            raise _timeline_error()


def validate_membership_timeline(value, target_snapshot_id):
    if not _exact(value, _TIMELINE_KEYS) or value["version"] != 1 or value["targetSnapshotId"] != target_snapshot_id:
        raise _timeline_error()
    legacy = value["legacySnapshots"]
    if not isinstance(legacy, list) or len(legacy) != 7:
        raise _timeline_error()
    legacy_by_id = {}
    total_members = 0
    for snapshot in legacy:
        if not _exact(snapshot, {"snapshotId", "generatedAt", "statsDate", "slugSetSha256", "members"}):
            raise _timeline_error()
        if isinstance(snapshot["snapshotId"], bool) or not isinstance(snapshot["snapshotId"], int) or snapshot["snapshotId"] < 1:
            raise _timeline_error()
        if snapshot["snapshotId"] in legacy_by_id or not _SHA256_RE.fullmatch(snapshot["slugSetSha256"]):
            raise _timeline_error()
        _timeline_timestamp(snapshot["generatedAt"])
        _timeline_date(snapshot["statsDate"])
        _validate_ordinals(snapshot["members"], {"ordinal", "slug"})
        legacy_by_id[snapshot["snapshotId"]] = snapshot
        total_members += len(snapshot["members"])
    if total_members != 287 or list(legacy_by_id) != sorted(legacy_by_id):
        raise _timeline_error()

    database = value["databaseSnapshots"]
    if not isinstance(database, list) or not database:
        raise _timeline_error()
    database_by_id = {}
    for snapshot in database:
        if not _exact(snapshot, {"snapshotId", "generatedAt", "statsDate", "members"}):
            raise _timeline_error()
        snapshot_id = snapshot["snapshotId"]
        if not isinstance(snapshot_id, str) or not _SNAPSHOT_RE.fullmatch(snapshot_id) or snapshot_id in database_by_id:
            raise _timeline_error()
        _timeline_timestamp(snapshot["generatedAt"])
        _timeline_date(snapshot["statsDate"])
        _validate_ordinals(snapshot["members"], {"ordinal", "slug", "displaySlug", "status"}, {"baseline_present", "new", "reentered", "stayed"})
        database_by_id[snapshot_id] = snapshot
    if target_snapshot_id not in database_by_id or value["current"] != database_by_id[target_snapshot_id]["members"]:
        raise _timeline_error()

    exited = value["exited"]
    if not isinstance(exited, list):
        raise _timeline_error()
    seen_exited = set()
    for row in exited:
        if not _exact(row, {"ordinal", "slug", "displaySlug", "lastSeenAt", "exitedAt"}):
            raise _timeline_error()
        if isinstance(row["ordinal"], bool) or not isinstance(row["ordinal"], int) or row["ordinal"] < 0:
            raise _timeline_error()
        slug = _timeline_slug(row["slug"], canonical=True)
        _timeline_slug(row["displaySlug"])
        if row["displaySlug"].lower() != slug or slug in seen_exited:
            raise _timeline_error()
        seen_exited.add(slug)
        if _timeline_timestamp(row["lastSeenAt"]) >= _timeline_timestamp(row["exitedAt"]):
            raise _timeline_error()

    events = value["events"]
    if not isinstance(events, list):
        raise _timeline_error()
    seen_events = set()
    for event in events:
        if not _exact(event, {"provenance", "snapshotId", "generatedAt", "statsDate", "ordinal", "slug", "displaySlug", "status"}):
            raise _timeline_error()
        if event["provenance"] not in {"legacy_snapshot", "repository_snapshot"} or event["status"] not in {"new", "reentered"}:
            raise _timeline_error()
        if isinstance(event["ordinal"], bool) or not isinstance(event["ordinal"], int) or event["ordinal"] < 0:
            raise _timeline_error()
        slug = _timeline_slug(event["slug"], canonical=True)
        _timeline_slug(event["displaySlug"])
        if event["displaySlug"].lower() != slug:
            raise _timeline_error()
        _timeline_timestamp(event["generatedAt"])
        _timeline_date(event["statsDate"])
        source = legacy_by_id.get(event["snapshotId"]) if event["provenance"] == "legacy_snapshot" else database_by_id.get(event["snapshotId"])
        if source is None or source["generatedAt"] != event["generatedAt"] or source["statsDate"] != event["statsDate"]:
            raise _timeline_error()
        if event["ordinal"] >= len(source["members"]):
            raise _timeline_error()
        source_member = source["members"][event["ordinal"]]
        if source_member["slug"].lower() != slug:
            raise _timeline_error()
        if event["provenance"] == "repository_snapshot" and (
            source_member["displaySlug"] != event["displaySlug"]
            or source_member["status"] != event["status"]
        ):
            raise _timeline_error()
        identity = (event["provenance"], str(event["snapshotId"]), slug, event["status"])
        if identity in seen_events:
            raise _timeline_error()
        seen_events.add(identity)
    return value


def select_change_events(timeline):
    events = list(timeline["events"])
    events.sort(key=lambda row: (-int(_timeline_timestamp(row["generatedAt"]).timestamp() * 1000), row["ordinal"]))
    return events[:100]


def _feed(feed_id, title, updated, snapshot_id, stats_date):
    root = ET.Element(_atom("feed"))
    _child(root, "id", feed_id)
    _child(root, "title", title)
    _child(root, "updated", updated)
    author = _child(root, "author")
    _child(author, "name", "GitHub Trending Daily")
    _child(root, "category", scheme=SNAPSHOT_SCHEME, term=snapshot_id)
    _child(root, "category", scheme=STATS_DATE_SCHEME, term=stats_date)
    _child(root, "link", rel="self", type="application/atom+xml", href=feed_id)
    _child(root, "link", rel="alternate", type="text/html", href=SITE_URL)
    return root


def _latest_by_slug(latest):
    return {repository["slug"].lower(): repository for repository in latest["repos"]}


def _current_document(latest, timeline):
    root = _feed(f"{SITE_URL}feed.xml", "GitHub Trending Daily — 현재 전체", latest["generatedAt"], latest["snapshotId"], latest["statsDate"])
    repositories = _latest_by_slug(latest)
    if [member["slug"] for member in timeline["current"]] != list(repositories):
        raise _input_error()
    for member in timeline["current"]:
        repository = repositories[member["slug"]]
        if repository["slug"].lower() != member["slug"] or repository["slug"] != member["displaySlug"]:
            raise _input_error()
        entry = _child(root, "entry")
        repository_url = f"https://github.com/{member['displaySlug']}"
        _child(entry, "id", f"https://github.com/{member['slug']}")
        _child(entry, "title", member["displaySlug"])
        _child(entry, "updated", latest["generatedAt"])
        _child(entry, "link", rel="alternate", type="text/html", href=repository_url)
        _child(entry, "summary", repository["description"], type="text")
    return root


def _change_id(event):
    identity = f"{event['generatedAt']}|{event['status']}|{event['slug']}"
    return f"{SITE_URL}changes.xml#{quote(identity, safe='')}"


def _changes_document(latest, events):
    root = _feed(f"{SITE_URL}changes.xml", "GitHub Trending Daily — 신규·재진입", latest["generatedAt"], latest["snapshotId"], latest["statsDate"])
    labels = {"new": "신규", "reentered": "재진입"}
    summaries = {"new": "baseline 이후 처음 관측된 저장소입니다.", "reentered": "직전 목록에서 빠졌다가 다시 등장한 저장소입니다."}
    for event in events:
        entry = _child(root, "entry")
        repository_url = f"https://github.com/{event['displaySlug']}"
        _child(entry, "id", _change_id(event))
        _child(entry, "title", f"{event['displaySlug']} {labels[event['status']]}")
        _child(entry, "updated", event["generatedAt"])
        _child(entry, "link", rel="alternate", type="text/html", href=repository_url)
        _child(entry, "category", term=event["status"])
        _child(entry, "summary", summaries[event["status"]], type="text")
    return root


def _document_bytes(root):
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True, short_empty_elements=True) + b"\n"


def _one_text(root, name):
    values = root.findall(_atom(name))
    if len(values) != 1 or not isinstance(values[0].text, str) or not values[0].text:
        raise _input_error()
    return values[0].text


def _one_link(parent):
    links = parent.findall(_atom("link"))
    if len(links) != 1 or links[0].get("rel") != "alternate" or links[0].get("type") != "text/html":
        raise _input_error()
    return links[0].get("href")


def _parse_document(path):
    try:
        payload = Path(path).read_bytes()
    except OSError as error:
        raise _input_error() from error
    if b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper():
        raise _input_error()
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as error:
        raise _input_error() from error
    if root.tag != _atom("feed"):
        raise _input_error()
    return root


def _validate_header(root, feed_id, title, latest):
    if _one_text(root, "id") != feed_id or _one_text(root, "title") != title or _one_text(root, "updated") != latest["generatedAt"]:
        raise _input_error()
    categories = root.findall(_atom("category"))
    expected = {(SNAPSHOT_SCHEME, latest["snapshotId"]), (STATS_DATE_SCHEME, latest["statsDate"])}
    if len(categories) != 2 or {(item.get("scheme"), item.get("term")) for item in categories} != expected:
        raise _input_error()
    names = root.findall(f"{_atom('author')}/{_atom('name')}")
    if len(names) != 1 or names[0].text != "GitHub Trending Daily":
        raise _input_error()
    links = {(link.get("rel"), link.get("type"), link.get("href")) for link in root.findall(_atom("link"))}
    if links != {("self", "application/atom+xml", feed_id), ("alternate", "text/html", SITE_URL)}:
        raise _input_error()


def _validate_documents(latest, timeline, events, feed_root, changes_root):
    _validate_header(feed_root, f"{SITE_URL}feed.xml", "GitHub Trending Daily — 현재 전체", latest)
    _validate_header(changes_root, f"{SITE_URL}changes.xml", "GitHub Trending Daily — 신규·재진입", latest)
    current_entries = feed_root.findall(_atom("entry"))
    if len(current_entries) != len(timeline["current"]):
        raise _input_error()
    repositories = _latest_by_slug(latest)
    current_ids = []
    for entry, member in zip(current_entries, timeline["current"]):
        repository = repositories[member["slug"]]
        current_ids.append(_one_text(entry, "id"))
        if (
            current_ids[-1] != f"https://github.com/{member['slug']}"
            or _one_text(entry, "title") != member["displaySlug"]
            or _one_text(entry, "updated") != latest["generatedAt"]
            or _one_link(entry) != f"https://github.com/{member['displaySlug']}"
        ):
            raise _input_error()
        summaries = entry.findall(_atom("summary"))
        if len(summaries) != 1 or summaries[0].get("type") != "text" or (summaries[0].text or "") != repository["description"]:
            raise _input_error()
    if len(current_ids) != len(set(current_ids)):
        raise _input_error()

    change_entries = changes_root.findall(_atom("entry"))
    if len(change_entries) != len(events) or len(change_entries) > 100:
        raise _input_error()
    labels = {"new": "신규", "reentered": "재진입"}
    change_ids = []
    for entry, event in zip(change_entries, events):
        entry_id = _one_text(entry, "id")
        change_ids.append(entry_id)
        if (
            entry_id != _change_id(event)
            or _one_text(entry, "title") != f"{event['displaySlug']} {labels[event['status']]}"
            or _one_text(entry, "updated") != event["generatedAt"]
            or _one_link(entry) != f"https://github.com/{event['displaySlug']}"
        ):
            raise _input_error()
        categories = entry.findall(_atom("category"))
        if len(categories) != 1 or categories[0].get("term") != event["status"]:
            raise _input_error()
    if len(change_ids) != len(set(change_ids)):
        raise _input_error()
    return {"current": len(current_entries), "changes": len(change_entries)}


def _write_pending(path, payload):
    with Path(path).open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def _install_pair(feed_path, changes_path, pending_feed, pending_changes):
    suffix = uuid.uuid4().hex
    backups = {
        feed_path: feed_path.with_name(f"{feed_path.name}.backup-{suffix}"),
        changes_path: changes_path.with_name(f"{changes_path.name}.backup-{suffix}"),
    }
    installed = []
    backed_up = []
    try:
        for target in (feed_path, changes_path):
            if target.exists():
                os.replace(target, backups[target])
                backed_up.append(target)
        os.replace(pending_feed, feed_path)
        installed.append(feed_path)
        os.replace(pending_changes, changes_path)
        installed.append(changes_path)
    except Exception:
        for target in reversed(installed):
            target.unlink(missing_ok=True)
        for target in reversed(backed_up):
            if backups[target].exists():
                os.replace(backups[target], target)
        raise
    finally:
        pending_feed.unlink(missing_ok=True)
        pending_changes.unlink(missing_ok=True)
        for backup in backups.values():
            backup.unlink(missing_ok=True)


def generate_atom_feeds_from_timeline(page, latest, timeline, feed_path, changes_path):
    snapshot_id = _validate_latest_contract(page, latest)
    timeline = validate_membership_timeline(timeline, snapshot_id)
    events = select_change_events(timeline)
    feed_root = _current_document(latest, timeline)
    changes_root = _changes_document(latest, events)
    _validate_documents(latest, timeline, events, feed_root, changes_root)
    feed_bytes = _document_bytes(feed_root)
    changes_bytes = _document_bytes(changes_root)
    feed_path = Path(feed_path)
    changes_path = Path(changes_path)
    if feed_path.is_file() and changes_path.is_file() and feed_path.read_bytes() == feed_bytes and changes_path.read_bytes() == changes_bytes:
        return False
    feed_path.parent.mkdir(parents=True, exist_ok=True)
    changes_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = uuid.uuid4().hex
    pending_feed = feed_path.with_name(f"{feed_path.name}.pending-{suffix}")
    pending_changes = changes_path.with_name(f"{changes_path.name}.pending-{suffix}")
    try:
        _write_pending(pending_feed, feed_bytes)
        _write_pending(pending_changes, changes_bytes)
        _install_pair(feed_path, changes_path, pending_feed, pending_changes)
    finally:
        pending_feed.unlink(missing_ok=True)
        pending_changes.unlink(missing_ok=True)
    return True


def validate_atom_publication_from_timeline(page, latest, timeline, feed_path, changes_path):
    snapshot_id = _validate_latest_contract(page, latest)
    timeline = validate_membership_timeline(timeline, snapshot_id)
    events = select_change_events(timeline)
    return _validate_documents(latest, timeline, events, _parse_document(feed_path), _parse_document(changes_path))


def _load_timeline(database_path, legacy_membership_path, snapshot_id):
    database_path = Path(database_path)
    legacy_membership_path = Path(legacy_membership_path)
    if not database_path.is_file() or database_path.is_symlink() or not legacy_membership_path.is_file() or legacy_membership_path.is_symlink():
        raise _input_error()
    for path in (database_path, legacy_membership_path):
        if any(Path(f"{path}{suffix}").exists() for suffix in ("-journal", "-wal", "-shm")):
            raise _input_error()
    try:
        try:
            from scripts.derive_repository_artifacts import derive_membership_timeline
        except ModuleNotFoundError as error:
            if error.name not in {"scripts", "scripts.derive_repository_artifacts"}:
                raise
            from derive_repository_artifacts import derive_membership_timeline
        with closing(sqlite3.connect(database_path.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
            connection.execute("PRAGMA query_only = ON")
            validate_schema(connection)
            row = connection.execute("SELECT snapshot_seq FROM snapshot_runs WHERE snapshot_id=?", (snapshot_id,)).fetchone()
            if row is None:
                raise _input_error()
            timeline = derive_membership_timeline(connection, legacy_membership_path, row[0])
    except (OSError, sqlite3.Error, ValueError) as error:
        raise _input_error() from error
    return validate_membership_timeline(timeline, snapshot_id)


def generate_atom_feeds(page, latest, database_path, legacy_membership_path, feed_path, changes_path):
    snapshot_id = _validate_latest_contract(page, latest)
    timeline = _load_timeline(database_path, legacy_membership_path, snapshot_id)
    return generate_atom_feeds_from_timeline(page, latest, timeline, feed_path, changes_path)


def validate_atom_publication(page, latest, database_path, legacy_membership_path, feed_path, changes_path):
    snapshot_id = _validate_latest_contract(page, latest)
    timeline = _load_timeline(database_path, legacy_membership_path, snapshot_id)
    return validate_atom_publication_from_timeline(page, latest, timeline, feed_path, changes_path)


def _load_json(path):
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise _input_error() from error


def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate static Atom feeds")
    parser.add_argument("--page", type=Path, default=DEFAULT_PAGE)
    parser.add_argument("--latest", type=Path, default=DEFAULT_LATEST)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--legacy-membership-database", type=Path, default=DEFAULT_LEGACY_MEMBERSHIP)
    parser.add_argument("--feed", type=Path, default=DEFAULT_FEED)
    parser.add_argument("--changes", type=Path, default=DEFAULT_CHANGES)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        page = args.page.read_text(encoding="utf-8")
        latest = _load_json(args.latest)
        if args.validate_only:
            counts = validate_atom_publication(page, latest, args.database, args.legacy_membership_database, args.feed, args.changes)
            print(f"atom_validated=current:{counts['current']} changes:{counts['changes']}")
        else:
            changed = generate_atom_feeds(page, latest, args.database, args.legacy_membership_database, args.feed, args.changes)
            print(f"atom_changed={str(changed).lower()}")
    except (OSError, UnicodeError, ValueError, sqlite3.Error, ET.ParseError):
        print("error: Atom generation failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
