import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote
from unittest import mock

from scripts.generate_atom_feeds import (
    ATOM_NAMESPACE,
    SITE_URL,
    generate_atom_feeds,
    validate_atom_publication,
)
from scripts.record_trending_membership import (
    MembershipSnapshot,
    load_finalized_snapshot,
    record_membership,
)


ATOM = {"atom": ATOM_NAMESPACE}


def page_and_latest(slugs, generated_at, *, description="A public repository"):
    stats_date = "2026-08-26"
    repos = [
        {
            "slug": slug,
            "name": slug.split("/", 1)[1],
            "desc": description if index == 0 else f"Description {index}",
            "language": "Python",
            "topics": ["testing"],
            "_stats_date": stats_date,
        }
        for index, slug in enumerate(slugs)
    ]
    page = (
        "before\n// GENERATED:TRENDING-REPOS:START\n"
        f"const REPOS = {json.dumps(repos, ensure_ascii=False)};\n"
        "// GENERATED:TRENDING-REPOS:END\nafter\n"
    )
    latest = {
        "generatedAt": generated_at,
        "snapshotId": (
            f"{generated_at.replace('-', '').replace(':', '').replace('.', '').replace('T', '').replace('Z', '')[:14]}-"
            f"{hashlib.sha256(f'{generated_at}|run-context-v1'.encode()).hexdigest()[:16]}"
        ),
        "statsDate": stats_date,
        "count": len(repos),
        "repos": [
            {
                "slug": repo["slug"],
                "name": repo["name"],
                "description": repo["desc"],
                "lang": repo["language"],
                "topics": repo["topics"],
                "stars": 1,
                "forks": 2,
                "issues": 3,
                "contributors": 4,
                "gains": {"daily": 1, "weekly": None, "monthly": None},
                "signal": None,
                "summary": {"goal": "g", "usage": "u", "pros": "p", "cons": "c", "fit": "f"},
            }
            for repo in repos
        ],
    }
    return page, latest


def entries(path):
    return ET.parse(path).getroot().findall("atom:entry", ATOM)


class AtomFeedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "trending-membership.sqlite"
        self.status = self.root / "membership-status.json"
        self.feed = self.root / "feed.xml"
        self.changes = self.root / "changes.xml"
        self.slugs = [f"owner/repo-{index}" for index in range(10)]

    def tearDown(self):
        self.temporary.cleanup()

    def record(self, generated_at, slugs):
        record_membership(
            self.database,
            self.status,
            MembershipSnapshot(generated_at, "2026-08-26", tuple(slugs)),
        )

    def generate(self, page, latest):
        return generate_atom_feeds(
            page,
            latest,
            self.database,
            self.feed,
            self.changes,
        )

    def test_baseline_generates_valid_atom_current_feed_and_empty_changes_idempotently(self):
        generated_at = "2026-08-26T10:07:00.000Z"
        page, latest = page_and_latest(self.slugs, generated_at)
        self.record(generated_at, self.slugs)

        self.assertTrue(self.generate(page, latest))
        current_root = ET.parse(self.feed).getroot()
        changes_root = ET.parse(self.changes).getroot()
        self.assertEqual(current_root.tag, f"{{{ATOM_NAMESPACE}}}feed")
        self.assertEqual(changes_root.tag, f"{{{ATOM_NAMESPACE}}}feed")
        self.assertEqual(current_root.findtext("atom:id", namespaces=ATOM), f"{SITE_URL}feed.xml")
        self.assertEqual(current_root.findtext("atom:updated", namespaces=ATOM), generated_at)
        snapshot_category = current_root.find("atom:category", ATOM)
        self.assertEqual(snapshot_category.get("scheme"), f"{SITE_URL}snapshot")
        self.assertEqual(snapshot_category.get("term"), latest["snapshotId"])
        self.assertIsNotNone(current_root.find("atom:author/atom:name", ATOM))
        self.assertEqual(len(entries(self.feed)), 10)
        self.assertEqual(entries(self.changes), [])
        self.assertEqual(
            [entry.findtext("atom:title", namespaces=ATOM) for entry in entries(self.feed)],
            self.slugs,
        )
        self.assertEqual(
            [entry.find("atom:link", ATOM).get("href") for entry in entries(self.feed)],
            [f"https://github.com/{slug}" for slug in self.slugs],
        )
        before = (self.feed.read_bytes(), self.changes.read_bytes())
        self.assertFalse(self.generate(page, latest))
        self.assertEqual((self.feed.read_bytes(), self.changes.read_bytes()), before)
        self.assertEqual(
            validate_atom_publication(page, latest, self.database, self.feed, self.changes),
            {"current": 10, "changes": 0},
        )

    def test_changes_include_only_new_and_reentered_events_in_newest_snapshot_order(self):
        self.record("2026-08-26T10:07:00.000Z", self.slugs)
        second = self.slugs[1:] + ["fresh/project"]
        self.record("2026-08-26T12:07:00.000Z", second)
        self.record("2026-08-26T14:07:00.000Z", self.slugs)
        page, latest = page_and_latest(self.slugs, "2026-08-26T14:07:00.000Z")

        self.generate(page, latest)
        change_entries = entries(self.changes)
        self.assertEqual(
            [entry.findtext("atom:title", namespaces=ATOM) for entry in change_entries],
            ["owner/repo-0 재진입", "fresh/project 신규"],
        )
        self.assertEqual(
            [entry.find("atom:category", ATOM).get("term") for entry in change_entries],
            ["reentered", "new"],
        )
        self.assertEqual(
            [entry.findtext("atom:updated", namespaces=ATOM) for entry in change_entries],
            ["2026-08-26T14:07:00.000Z", "2026-08-26T12:07:00.000Z"],
        )
        ids = [entry.findtext("atom:id", namespaces=ATOM) for entry in change_entries]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(ids, [
            f"{SITE_URL}changes.xml#{quote('2026-08-26T14:07:00.000Z|reentered|owner/repo-0', safe='')}",
            f"{SITE_URL}changes.xml#{quote('2026-08-26T12:07:00.000Z|new|fresh/project', safe='')}",
        ])
        self.assertNotIn("stayed", self.changes.read_text(encoding="utf-8"))
        self.assertNotIn("exited", self.changes.read_text(encoding="utf-8"))

    def test_changes_feed_caps_the_newest_events_at_one_hundred(self):
        baseline = [f"baseline/repo-{index}" for index in range(20)]
        self.record("2026-08-26T00:07:00.000Z", baseline)
        final_slugs = baseline
        for group in range(6):
            final_slugs = [f"owner/change-{group}-{index}" for index in range(20)]
            self.record(f"2026-08-26T{2 + group * 2:02d}:07:00.000Z", final_slugs)
        page, latest = page_and_latest(final_slugs, "2026-08-26T12:07:00.000Z")

        self.generate(page, latest)
        change_entries = entries(self.changes)
        self.assertEqual(len(change_entries), 100)
        self.assertEqual(change_entries[0].findtext("atom:title", namespaces=ATOM), "owner/change-5-0 신규")
        self.assertEqual(change_entries[-1].findtext("atom:title", namespaces=ATOM), "owner/change-1-19 신규")

    def test_xml_escapes_public_text_and_preserves_unicode_newlines_after_parsing(self):
        description = "Ampersand & less < greater > quote \" apostrophe ' \n한글"
        generated_at = "2026-08-26T10:07:00.000Z"
        page, latest = page_and_latest(self.slugs, generated_at, description=description)
        self.record(generated_at, self.slugs)

        self.generate(page, latest)
        raw = self.feed.read_text(encoding="utf-8")
        self.assertIn("&amp;", raw)
        self.assertIn("&lt;", raw)
        self.assertIn("&gt;", raw)
        self.assertEqual(entries(self.feed)[0].findtext("atom:summary", namespaces=ATOM), description)
        self.assertEqual(
            entries(self.feed)[0].findtext("atom:id", namespaces=ATOM),
            "https://github.com/owner/repo-0",
        )

    def test_invalid_inputs_and_duplicate_ids_fail_closed(self):
        generated_at = "2026-08-26T10:07:00.000Z"
        page, latest = page_and_latest(self.slugs, generated_at)
        with self.assertRaises(ValueError):
            self.generate(page, latest)
        self.record(generated_at, self.slugs)

        bad_latest = {**latest, "generatedAt": "2026-08-26 10:07:00Z"}
        with self.assertRaises(ValueError):
            self.generate(page, bad_latest)
        with self.assertRaises(ValueError):
            self.generate(page, {**latest, "unexpected": True})
        with self.assertRaises(ValueError):
            self.generate(page, {**latest, "snapshotId": "20260826100700-0123456789abcdef"})
        with self.assertRaises(ValueError):
            self.generate(page, {**latest, "repos": list(reversed(latest["repos"]))})
        missing_description = {**latest, "repos": [dict(repo) for repo in latest["repos"]]}
        del missing_description["repos"][0]["description"]
        with self.assertRaises(ValueError):
            self.generate(page, missing_description)
        with self.assertRaises(ValueError):
            self.generate(page.replace("owner/repo-0", "invalid", 1), latest)

        self.generate(page, latest)
        tree = ET.parse(self.feed)
        feed_entries = tree.getroot().findall("atom:entry", ATOM)
        feed_entries[1].find("atom:id", ATOM).text = feed_entries[0].findtext("atom:id", namespaces=ATOM)
        tree.write(self.feed, encoding="utf-8", xml_declaration=True)
        with self.assertRaises(ValueError):
            validate_atom_publication(page, latest, self.database, self.feed, self.changes)

    def test_failed_second_install_restores_both_last_good_xml_files(self):
        baseline_time = "2026-08-26T10:07:00.000Z"
        baseline_page, baseline_latest = page_and_latest(self.slugs, baseline_time)
        self.record(baseline_time, self.slugs)
        self.generate(baseline_page, baseline_latest)
        before = (self.feed.read_bytes(), self.changes.read_bytes())

        next_time = "2026-08-26T12:07:00.000Z"
        next_slugs = self.slugs[1:] + ["fresh/project"]
        next_page, next_latest = page_and_latest(next_slugs, next_time)
        self.record(next_time, next_slugs)
        real_replace = os.replace

        def fail_changes_install(source, target):
            source = Path(source)
            target = Path(target)
            if target == self.changes and ".pending-" in source.name:
                raise OSError("injected changes feed install failure")
            return real_replace(source, target)

        with mock.patch("scripts.generate_atom_feeds.os.replace", side_effect=fail_changes_install):
            with self.assertRaises(OSError):
                self.generate(next_page, next_latest)

        self.assertEqual((self.feed.read_bytes(), self.changes.read_bytes()), before)
        self.assertEqual(list(self.root.glob("*.pending-*")), [])
        self.assertEqual(list(self.root.glob("*.backup-*")), [])

    def test_script_path_cli_matches_the_workflow_invocation(self):
        generated_at = "2026-08-26T10:07:00.000Z"
        page, latest = page_and_latest(self.slugs, generated_at)
        self.record(generated_at, self.slugs)
        page_path = self.root / "index.html"
        latest_path = self.root / "latest.json"
        page_path.write_text(page, encoding="utf-8")
        latest_path.write_text(json.dumps(latest), encoding="utf-8")
        script = Path(__file__).resolve().parents[1] / "scripts" / "generate_atom_feeds.py"

        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--page", str(page_path),
                "--latest", str(latest_path),
                "--database", str(self.database),
                "--status", str(self.status),
                "--feed", str(self.feed),
                "--changes", str(self.changes),
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "atom_changed=true")


if __name__ == "__main__":
    unittest.main()
