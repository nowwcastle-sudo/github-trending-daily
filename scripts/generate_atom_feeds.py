"""Generate deterministic Atom feeds from finalized public Trending data."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

try:
    from scripts.record_trending_membership import (
        DEFAULT_DATABASE,
        DEFAULT_LATEST,
        DEFAULT_PAGE,
        DEFAULT_STATUS,
        _load_json,
        _marked_repositories,
        _timestamp,
        load_finalized_snapshot,
        membership_change_events,
        validate_membership_publication,
    )
except ModuleNotFoundError as error:
    if error.name not in {"scripts", "scripts.record_trending_membership"}:
        raise
    from record_trending_membership import (
        DEFAULT_DATABASE,
        DEFAULT_LATEST,
        DEFAULT_PAGE,
        DEFAULT_STATUS,
        _load_json,
        _marked_repositories,
        _timestamp,
        load_finalized_snapshot,
        membership_change_events,
        validate_membership_publication,
    )


ATOM_NAMESPACE = "http://www.w3.org/2005/Atom"
SITE_URL = "https://nowwcastle-sudo.github.io/github-trending-daily/"
SNAPSHOT_SCHEME = f"{SITE_URL}snapshot"
STATS_DATE_SCHEME = f"{SITE_URL}stats-date"
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FEED = REPOSITORY_ROOT / "feed.xml"
DEFAULT_CHANGES = REPOSITORY_ROOT / "changes.xml"
ET.register_namespace("", ATOM_NAMESPACE)


def _atom(name: str) -> str:
    return f"{{{ATOM_NAMESPACE}}}{name}"


def _child(parent, name, text=None, **attributes):
    element = ET.SubElement(parent, _atom(name), attributes)
    if text is not None:
        element.text = text
    return element


def _snapshot_id(value, generated_at):
    if not isinstance(value, str) or not re.fullmatch(r"\d{14}-[a-f0-9]{16}", value):
        raise ValueError("Latest feed snapshotId is invalid")
    expected = hashlib.sha256(f"{generated_at}|run-context-v1".encode("utf-8")).hexdigest()[:16]
    timestamp = generated_at.replace("-", "").replace(":", "").replace(".", "").replace("T", "").replace("Z", "")
    if value != f"{timestamp[:14]}-{expected}":
        raise ValueError("Latest feed snapshotId does not match generatedAt")
    return value


def _validate_latest_contract(page, latest):
    if not isinstance(latest, dict) or set(latest) != {"snapshotId", "generatedAt", "statsDate", "count", "repos"}:
        raise ValueError("Latest feed has an invalid top-level schema")
    generated_at = latest.get("generatedAt")
    _timestamp(generated_at)
    snapshot_id = _snapshot_id(latest.get("snapshotId"), generated_at)
    page_repositories = _marked_repositories(page)
    repositories = latest.get("repos")
    if not isinstance(page_repositories, list) or not isinstance(repositories, list):
        raise ValueError("Page and latest feed repositories must be lists")
    if latest.get("count") != len(page_repositories) or len(repositories) != len(page_repositories):
        raise ValueError("Page and latest feed counts do not match")
    required_repository_fields = {
        "slug", "name", "description", "lang", "topics", "stars", "forks", "issues", "contributors",
        "gains", "signal", "summary",
    }
    for page_repository, repository in zip(page_repositories, repositories):
        if not isinstance(page_repository, dict) or not isinstance(repository, dict):
            raise ValueError("Page and latest feed repository metadata is invalid")
        if set(repository) != required_repository_fields:
            raise ValueError("Latest feed repository schema is invalid")
        slug = repository.get("slug")
        description = repository.get("description")
        if (
            not isinstance(slug, str)
            or not isinstance(description, str)
            or not description.strip()
            or page_repository.get("slug") != slug
            or page_repository.get("desc") != description
            or page_repository.get("_snapshot_id") != snapshot_id
            or page_repository.get("_generated_at") != generated_at
            or page_repository.get("_stats_date") != latest.get("statsDate")
        ):
            raise ValueError("Page and latest feed repository identity does not match")
    return snapshot_id


def _feed(feed_id: str, title: str, updated: str, self_url: str, snapshot_id: str, stats_date: str):
    root = ET.Element(_atom("feed"))
    _child(root, "id", feed_id)
    _child(root, "title", title)
    _child(root, "updated", updated)
    author = _child(root, "author")
    _child(author, "name", "GitHub Trending Daily")
    _child(root, "category", scheme=SNAPSHOT_SCHEME, term=snapshot_id)
    _child(root, "category", scheme=STATS_DATE_SCHEME, term=stats_date)
    _child(root, "link", rel="self", type="application/atom+xml", href=self_url)
    _child(root, "link", rel="alternate", type="text/html", href=SITE_URL)
    return root


def _latest_repositories(latest, ordered_slugs):
    repositories = latest.get("repos") if isinstance(latest, dict) else None
    if not isinstance(repositories, list):
        raise ValueError("Latest feed repositories must be a list")
    by_slug = {}
    for repository in repositories:
        if not isinstance(repository, dict) or not isinstance(repository.get("slug"), str):
            raise ValueError("Latest feed repository metadata is invalid")
        key = repository["slug"].lower()
        if key in by_slug:
            raise ValueError("Latest feed repository identities must be unique")
        by_slug[key] = repository
    ordered = []
    for slug in ordered_slugs:
        repository = by_slug.get(slug.lower())
        if repository is None:
            raise ValueError("Latest feed is missing repository metadata")
        description = repository.get("description")
        if not isinstance(description, str) or not description.strip():
            raise ValueError("Repository description must be nonempty text")
        ordered.append((slug, description))
    return ordered


def _current_document(snapshot, latest):
    root = _feed(
        f"{SITE_URL}feed.xml",
        "GitHub Trending Daily — 현재 전체",
        snapshot.generated_at,
        f"{SITE_URL}feed.xml",
        latest["snapshotId"],
        latest["statsDate"],
    )
    for slug, description in _latest_repositories(latest, snapshot.slugs):
        entry = _child(root, "entry")
        repository_url = f"https://github.com/{slug}"
        _child(entry, "id", repository_url)
        _child(entry, "title", slug)
        _child(entry, "updated", snapshot.generated_at)
        _child(entry, "link", rel="alternate", type="text/html", href=repository_url)
        _child(entry, "summary", description, type="text")
    return root


def _change_id(event):
    identity = f"{event['generatedAt']}|{event['status']}|{event['slug'].lower()}"
    return f"{SITE_URL}changes.xml#{quote(identity, safe='')}"


def _changes_document(snapshot, events, snapshot_id, stats_date):
    root = _feed(
        f"{SITE_URL}changes.xml",
        "GitHub Trending Daily — 신규·재진입",
        snapshot.generated_at,
        f"{SITE_URL}changes.xml",
        snapshot_id,
        stats_date,
    )
    labels = {"new": "신규", "reentered": "재진입"}
    summaries = {
        "new": "baseline 이후 처음 관측된 저장소입니다.",
        "reentered": "직전 목록에서 빠졌다가 다시 등장한 저장소입니다.",
    }
    for event in events:
        entry = _child(root, "entry")
        repository_url = f"https://github.com/{event['slug']}"
        _child(entry, "id", _change_id(event))
        _child(entry, "title", f"{event['slug']} {labels[event['status']]}")
        _child(entry, "updated", event["generatedAt"])
        _child(entry, "link", rel="alternate", type="text/html", href=repository_url)
        _child(entry, "category", term=event["status"])
        _child(entry, "summary", summaries[event["status"]], type="text")
    return root


def _document_bytes(root) -> bytes:
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True, short_empty_elements=True) + b"\n"


def _one_text(root, name):
    values = root.findall(_atom(name))
    if len(values) != 1 or not isinstance(values[0].text, str) or not values[0].text:
        raise ValueError(f"Atom feed requires one {name}")
    return values[0].text


def _one_link(parent):
    links = parent.findall(_atom("link"))
    if len(links) != 1:
        raise ValueError("Atom entry requires one link")
    link = links[0]
    if link.get("rel") != "alternate" or link.get("type") != "text/html":
        raise ValueError("Atom entry link metadata is invalid")
    return link.get("href")


def _parse_document(path: Path):
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise ValueError(f"Atom file is missing: {path.name}") from error
    if b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper():
        raise ValueError("Atom documents cannot contain DTDs or entities")
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as error:
        raise ValueError(f"Atom file is not well-formed XML: {path.name}") from error
    if root.tag != _atom("feed"):
        raise ValueError("Atom document must use the Atom 1.0 feed namespace")
    return root


def _validate_feed_header(root, expected_id, expected_title, expected_updated, expected_self, snapshot_id, stats_date):
    if _one_text(root, "id") != expected_id or _one_text(root, "title") != expected_title:
        raise ValueError("Atom feed identity is invalid")
    if _one_text(root, "updated") != expected_updated:
        raise ValueError("Atom feed updated timestamp is invalid")
    _timestamp(expected_updated)
    names = root.findall(f"{_atom('author')}/{_atom('name')}")
    if len(names) != 1 or names[0].text != "GitHub Trending Daily":
        raise ValueError("Atom feed author is invalid")
    categories = root.findall(_atom("category"))
    expected_categories = {(SNAPSHOT_SCHEME, snapshot_id), (STATS_DATE_SCHEME, stats_date)}
    if len(categories) != 2 or {(category.get("scheme"), category.get("term")) for category in categories} != expected_categories:
        raise ValueError("Atom feed run identity is invalid")
    links = {(link.get("rel"), link.get("type"), link.get("href")) for link in root.findall(_atom("link"))}
    if links != {
        ("self", "application/atom+xml", expected_self),
        ("alternate", "text/html", SITE_URL),
    }:
        raise ValueError("Atom feed links are invalid")


def _validate_documents(snapshot, latest, events, feed_root, changes_root):
    snapshot_id = latest["snapshotId"]
    stats_date = latest["statsDate"]
    _validate_feed_header(
        feed_root,
        f"{SITE_URL}feed.xml",
        "GitHub Trending Daily — 현재 전체",
        snapshot.generated_at,
        f"{SITE_URL}feed.xml",
        snapshot_id,
        stats_date,
    )
    _validate_feed_header(
        changes_root,
        f"{SITE_URL}changes.xml",
        "GitHub Trending Daily — 신규·재진입",
        snapshot.generated_at,
        f"{SITE_URL}changes.xml",
        snapshot_id,
        stats_date,
    )
    current_entries = feed_root.findall(_atom("entry"))
    if not 10 <= len(current_entries) <= 75 or len(current_entries) != len(snapshot.slugs):
        raise ValueError("Current Atom entry count is invalid")
    current_ids = []
    for entry, (slug, description) in zip(current_entries, _latest_repositories(latest, snapshot.slugs)):
        repository_url = f"https://github.com/{slug}"
        entry_id = _one_text(entry, "id")
        current_ids.append(entry_id)
        if entry_id != repository_url or _one_text(entry, "title") != slug:
            raise ValueError("Current Atom entry identity is invalid")
        if _one_text(entry, "updated") != snapshot.generated_at or _one_link(entry) != repository_url:
            raise ValueError("Current Atom entry time or link is invalid")
        summaries = entry.findall(_atom("summary"))
        if len(summaries) != 1 or summaries[0].get("type") != "text" or (summaries[0].text or "") != description:
            raise ValueError("Current Atom entry summary is invalid")
    if len(current_ids) != len(set(current_ids)):
        raise ValueError("Current Atom entry ids must be unique")

    change_entries = changes_root.findall(_atom("entry"))
    if len(change_entries) != len(events) or len(change_entries) > 100:
        raise ValueError("Changes Atom entry count is invalid")
    change_ids = []
    labels = {"new": "신규", "reentered": "재진입"}
    for entry, event in zip(change_entries, events):
        entry_id = _one_text(entry, "id")
        change_ids.append(entry_id)
        if entry_id != _change_id(event):
            raise ValueError("Changes Atom entry id is invalid")
        if _one_text(entry, "title") != f"{event['slug']} {labels[event['status']]}":
            raise ValueError("Changes Atom entry title is invalid")
        if _one_text(entry, "updated") != event["generatedAt"]:
            raise ValueError("Changes Atom entry timestamp is invalid")
        _timestamp(event["generatedAt"])
        if _one_link(entry) != f"https://github.com/{event['slug']}":
            raise ValueError("Changes Atom entry link is invalid")
        categories = entry.findall(_atom("category"))
        if len(categories) != 1 or categories[0].get("term") != event["status"]:
            raise ValueError("Changes Atom category is invalid")
        summaries = entry.findall(_atom("summary"))
        if len(summaries) != 1 or summaries[0].get("type") != "text":
            raise ValueError("Changes Atom summary is invalid")
    if len(change_ids) != len(set(change_ids)):
        raise ValueError("Changes Atom entry ids must be unique")
    return {"current": len(current_entries), "changes": len(change_entries)}


def _write_pending(path: Path, payload: bytes):
    with path.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def _install_pair(feed_path: Path, changes_path: Path, pending_feed: Path, pending_changes: Path):
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


def generate_atom_feeds(
    page: str,
    latest,
    database_path: str | Path,
    feed_path: str | Path,
    changes_path: str | Path,
    status_path: str | Path | None = None,
):
    database_path = Path(database_path)
    feed_path = Path(feed_path)
    changes_path = Path(changes_path)
    status_path = Path(status_path) if status_path is not None else database_path.with_name("membership-status.json")
    snapshot_id = _validate_latest_contract(page, latest)
    validate_membership_publication(database_path, status_path, page, latest)
    snapshot = load_finalized_snapshot(page, latest)
    events = membership_change_events(database_path)
    feed_root = _current_document(snapshot, latest)
    changes_root = _changes_document(snapshot, events, snapshot_id, latest["statsDate"])
    _validate_documents(snapshot, latest, events, feed_root, changes_root)
    feed_bytes = _document_bytes(feed_root)
    changes_bytes = _document_bytes(changes_root)
    if (
        feed_path.is_file() and changes_path.is_file()
        and feed_path.read_bytes() == feed_bytes
        and changes_path.read_bytes() == changes_bytes
    ):
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


def validate_atom_publication(
    page: str,
    latest,
    database_path: str | Path,
    feed_path: str | Path,
    changes_path: str | Path,
    status_path: str | Path | None = None,
):
    database_path = Path(database_path)
    status_path = Path(status_path) if status_path is not None else database_path.with_name("membership-status.json")
    _validate_latest_contract(page, latest)
    validate_membership_publication(database_path, status_path, page, latest)
    snapshot = load_finalized_snapshot(page, latest)
    events = membership_change_events(database_path)
    return _validate_documents(
        snapshot,
        latest,
        events,
        _parse_document(Path(feed_path)),
        _parse_document(Path(changes_path)),
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Generate static Atom feeds")
    parser.add_argument("--page", type=Path, default=DEFAULT_PAGE)
    parser.add_argument("--latest", type=Path, default=DEFAULT_LATEST)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--status", type=Path, default=DEFAULT_STATUS)
    parser.add_argument("--feed", type=Path, default=DEFAULT_FEED)
    parser.add_argument("--changes", type=Path, default=DEFAULT_CHANGES)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        page = args.page.read_text(encoding="utf-8")
        latest = _load_json(args.latest.read_text(encoding="utf-8"))
        if args.validate_only:
            counts = validate_atom_publication(
                page,
                latest,
                args.database,
                args.feed,
                args.changes,
                args.status,
            )
            print(f"atom_validated=current:{counts['current']} changes:{counts['changes']}")
        else:
            changed = generate_atom_feeds(
                page,
                latest,
                args.database,
                args.feed,
                args.changes,
                args.status,
            )
            print(f"atom_changed={str(changed).lower()}")
    except (OSError, UnicodeError, ValueError, ET.ParseError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
