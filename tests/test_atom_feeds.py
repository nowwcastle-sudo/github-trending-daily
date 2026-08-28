import copy
import json
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

from scripts.generate_atom_feeds import (
    ATOM_NAMESPACE,
    SITE_URL,
    generate_atom_feeds_from_timeline,
    select_change_events,
    validate_atom_publication_from_timeline,
    validate_membership_timeline,
)


ATOM = {"atom": ATOM_NAMESPACE}
SNAPSHOT_ID = "20260826182000-d88e9972357720d2"
GENERATED_AT = "2026-08-26T18:20:00.000Z"
LEGACY_UPDATED = "2026-08-26T13:21:30.208Z"
LEGACY_NAMES = [
    ("tt-a1i/archify", "tt-a1i/archify"),
    ("alishahryar1/free-claude-code", "Alishahryar1/free-claude-code"),
    ("conardli/garden-skills", "ConardLi/garden-skills"),
    ("browser-use/browser-use", "browser-use/browser-use"),
    ("k-dense-ai/scientific-agent-skills", "K-Dense-AI/scientific-agent-skills"),
    ("voltagent/awesome-agent-skills", "VoltAgent/awesome-agent-skills"),
    ("chaitanyagiri/munder-difflin", "chaitanyagiri/munder-difflin"),
    ("cursor/plugins", "cursor/plugins"),
    ("tashfeenahmed/freellmapi", "tashfeenahmed/freellmapi"),
    ("bookorbit/bookorbit", "bookorbit/bookorbit"),
]
LEGACY_TUPLES = [
    (f"{SITE_URL}changes.xml#{LEGACY_UPDATED.replace(':', '%3A') .replace('.', '.')}%7Cnew%7C{slug.replace('/', '%2F')}", LEGACY_UPDATED, "new")
    for slug, _ in LEGACY_NAMES
]


def latest_payload():
    repositories = []
    for index, (slug, display_slug) in enumerate(LEGACY_NAMES):
        repositories.append({
            "slug": display_slug,
            "name": display_slug.replace("/", " / ", 1),
            "description": f"Description {index}",
            "lang": "Python",
            "topics": ["testing"],
            "stars": index,
            "forks": index,
            "issues": index,
            "contributors": index + 1,
            "gains": {"daily": index, "weekly": None, "monthly": None},
            "signal": None,
            "summary": {"goal": "g", "usage": "u", "pros": "p", "cons": "c", "fit": "f"},
            "tag_rule_version": 1,
            "field_tags": ["dev-tools"],
            "form_tags": ["cli"],
        })
    return {
        "snapshotId": SNAPSHOT_ID,
        "generatedAt": GENERATED_AT,
        "statsDate": "2026-08-27",
        "count": len(repositories),
        "repos": repositories,
    }


def page_payload(latest=None):
    latest = latest or latest_payload()
    repositories = [{
        "slug": repo["slug"],
        "desc": repo["description"],
        "tag_rule_version": repo["tag_rule_version"],
        "field_tags": repo["field_tags"],
        "form_tags": repo["form_tags"],
        "_snapshot_id": latest["snapshotId"],
        "_generated_at": latest["generatedAt"],
        "_stats_date": latest["statsDate"],
    } for repo in latest["repos"]]
    return (
        "before\n// GENERATED:TRENDING-REPOS:START\n"
        f"const REPOS = {json.dumps(repositories, ensure_ascii=False)};\n"
        "// GENERATED:TRENDING-REPOS:END\nafter\n"
    )


def legacy_snapshots():
    result = []
    for snapshot_id in range(1, 8):
        members = [
            {"ordinal": ordinal, "slug": f"legacy-{snapshot_id}/repo-{ordinal}"}
            for ordinal in range(41)
        ]
        if snapshot_id == 3:
            members[:len(LEGACY_NAMES)] = [
                {"ordinal": ordinal, "slug": display}
                for ordinal, (_, display) in enumerate(LEGACY_NAMES)
            ]
        result.append({
            "snapshotId": snapshot_id,
            "generatedAt": LEGACY_UPDATED if snapshot_id == 3 else f"2026-08-26T0{snapshot_id}:00:00.000Z",
            "statsDate": "2026-08-26",
            "slugSetSha256": f"{snapshot_id:064x}",
            "members": members,
        })
    return result


def timeline():
    current = [
        {"ordinal": index, "slug": slug, "displaySlug": display, "status": "baseline_present"}
        for index, (slug, display) in enumerate(LEGACY_NAMES)
    ]
    events = [
        {
            "provenance": "legacy_snapshot",
            "snapshotId": 3,
            "generatedAt": LEGACY_UPDATED,
            "statsDate": "2026-08-26",
            "ordinal": index,
            "slug": slug,
            "displaySlug": display,
            "status": "new",
        }
        for index, (slug, display) in enumerate(LEGACY_NAMES)
    ]
    return {
        "version": 1,
        "targetSnapshotId": SNAPSHOT_ID,
        "legacySnapshots": legacy_snapshots(),
        "databaseSnapshots": [{
            "snapshotId": SNAPSHOT_ID,
            "generatedAt": GENERATED_AT,
            "statsDate": "2026-08-27",
            "members": copy.deepcopy(current),
        }],
        "current": current,
        "exited": [],
        "events": events,
    }


def entries(path):
    return ET.parse(path).getroot().findall("atom:entry", ATOM)


def tuple_entries(path):
    return [
        (
            entry.findtext("atom:id", namespaces=ATOM),
            entry.findtext("atom:updated", namespaces=ATOM),
            entry.find("atom:category", ATOM).get("term"),
        )
        for entry in entries(path)
    ]


class AtomFeedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.feed = self.root / "feed.xml"
        self.changes = self.root / "changes.xml"
        self.latest = latest_payload()
        self.page = page_payload(self.latest)
        self.timeline = timeline()

    def tearDown(self):
        self.temporary.cleanup()

    def generate(self, timeline_value=None):
        return generate_atom_feeds_from_timeline(
            self.page,
            self.latest,
            timeline_value or self.timeline,
            self.feed,
            self.changes,
        )

    def test_consumer_pins_legacy_seven_snapshots_287_members_and_ordinals(self):
        result = validate_membership_timeline(self.timeline, SNAPSHOT_ID)
        self.assertEqual(len(result["legacySnapshots"]), 7)
        self.assertEqual(sum(len(row["members"]) for row in result["legacySnapshots"]), 287)
        for snapshot in result["legacySnapshots"]:
            self.assertEqual([member["ordinal"] for member in snapshot["members"]], list(range(41)))
        broken = copy.deepcopy(self.timeline)
        broken["legacySnapshots"][0]["members"][1]["ordinal"] = 9
        with self.assertRaisesRegex(ValueError, "membership timeline is invalid"):
            validate_membership_timeline(broken, SNAPSHOT_ID)

    def test_first_cutover_preserves_reviewed_ten_legacy_entry_tuples_exactly(self):
        self.assertTrue(self.generate())
        self.assertEqual(tuple_entries(self.changes), LEGACY_TUPLES)
        self.assertEqual(len(entries(self.feed)), 10)
        self.assertEqual(
            [entry.findtext("atom:summary", namespaces=ATOM) for entry in entries(self.feed)],
            [repo["description"] for repo in self.latest["repos"]],
        )
        self.assertFalse(self.generate())
        self.assertEqual(
            validate_atom_publication_from_timeline(
                self.page, self.latest, self.timeline, self.feed, self.changes
            ),
            {"current": 10, "changes": 10},
        )

    def test_database_events_sort_ahead_of_legacy_and_one_final_cap_is_applied(self):
        value = copy.deepcopy(self.timeline)
        previous_id = "20260826162000-1111111111111111"
        previous_time = "2026-08-26T16:20:00.000Z"
        previous_members = [
            {"ordinal": index, "slug": f"previous/repo-{index}", "displaySlug": f"Previous/Repo-{index}", "status": "new"}
            for index in range(60)
        ]
        target_members = [
            {"ordinal": index, "slug": f"target/repo-{index}", "displaySlug": f"Target/Repo-{index}", "status": "new"}
            for index in range(55)
        ]
        value["databaseSnapshots"] = [
            {"snapshotId": previous_id, "generatedAt": previous_time, "statsDate": "2026-08-27", "members": previous_members},
            {"snapshotId": SNAPSHOT_ID, "generatedAt": GENERATED_AT, "statsDate": "2026-08-27", "members": target_members},
        ]
        value["current"] = target_members
        events = [
            {"provenance": "repository_snapshot", "snapshotId": previous_id, "generatedAt": previous_time,
             "statsDate": "2026-08-27", **member}
            for member in previous_members
        ] + [
            {"provenance": "repository_snapshot", "snapshotId": SNAPSHOT_ID, "generatedAt": GENERATED_AT,
             "statsDate": "2026-08-27", **member}
            for member in target_members
        ]
        value["events"] = list(reversed(value["events"])) + list(reversed(events))
        selected = select_change_events(validate_membership_timeline(value, SNAPSHOT_ID))
        self.assertEqual(len(selected), 100)
        self.assertEqual(selected[0]["displaySlug"], "Target/Repo-0")
        self.assertEqual(selected[-1]["displaySlug"], "Previous/Repo-44")
        self.assertTrue(all(event["provenance"] == "repository_snapshot" for event in selected))

    def test_migration_baseline_never_emits_fake_current_events_and_exits_remain_exact(self):
        selected = select_change_events(validate_membership_timeline(self.timeline, SNAPSHOT_ID))
        self.assertTrue(all(event["provenance"] == "legacy_snapshot" for event in selected))
        self.assertFalse(any(event["snapshotId"] == SNAPSHOT_ID for event in selected))
        value = copy.deepcopy(self.timeline)
        value["exited"] = [{
            "ordinal": 4,
            "slug": "owner/exited",
            "displaySlug": "Owner/Exited",
            "lastSeenAt": "2026-08-26T16:20:00.000Z",
            "exitedAt": GENERATED_AT,
        }]
        self.assertEqual(validate_membership_timeline(value, SNAPSHOT_ID)["exited"], value["exited"])

    def test_visible_event_uses_display_casing_but_id_uses_lowercase_slug(self):
        value = copy.deepcopy(self.timeline)
        value["databaseSnapshots"][0]["members"][1]["status"] = "reentered"
        value["current"][1]["status"] = "reentered"
        value["events"] = [{
            "provenance": "repository_snapshot",
            "snapshotId": SNAPSHOT_ID,
            "generatedAt": GENERATED_AT,
            "statsDate": "2026-08-27",
            "ordinal": 1,
            "slug": "alishahryar1/free-claude-code",
            "displaySlug": "Alishahryar1/free-claude-code",
            "status": "reentered",
        }]
        self.generate(value)
        entry = entries(self.changes)[0]
        self.assertIn("alishahryar1%2Ffree-claude-code", entry.findtext("atom:id", namespaces=ATOM))
        self.assertEqual(entry.findtext("atom:title", namespaces=ATOM), "Alishahryar1/free-claude-code 재진입")
        self.assertEqual(entry.find("atom:link", ATOM).get("href"), "https://github.com/Alishahryar1/free-claude-code")

    def test_cross_run_or_tag_drift_fails_before_writing(self):
        cross_page = self.page.replace(SNAPSHOT_ID, "20260826182001-b9c37b77b0e00ed1")
        with self.assertRaisesRegex(ValueError, "Atom input is invalid"):
            generate_atom_feeds_from_timeline(cross_page, self.latest, self.timeline, self.feed, self.changes)
        self.assertFalse(self.feed.exists())
        for field, replacement in (
            ("tag_rule_version", 2),
            ("field_tags", ["dev-tools", "ai-ml"]),
            ("form_tags", ["cli", "agent"]),
        ):
            latest = copy.deepcopy(self.latest)
            latest["repos"][0][field] = replacement
            with self.assertRaisesRegex(ValueError, "Atom input is invalid"):
                generate_atom_feeds_from_timeline(page_payload(latest), latest, self.timeline, self.feed, self.changes)

    def test_failed_second_install_restores_both_last_good_files(self):
        self.generate()
        before = (self.feed.read_bytes(), self.changes.read_bytes())
        value = copy.deepcopy(self.timeline)
        value["events"] = []
        real_replace = os.replace

        def fail_changes(source, target):
            source = Path(source)
            target = Path(target)
            if target == self.changes and ".pending-" in source.name:
                raise OSError("injected")
            return real_replace(source, target)

        with mock.patch("scripts.generate_atom_feeds.os.replace", side_effect=fail_changes):
            with self.assertRaises(OSError):
                self.generate(value)
        self.assertEqual((self.feed.read_bytes(), self.changes.read_bytes()), before)
        self.assertEqual(list(self.root.glob("*.pending-*")), [])
        self.assertEqual(list(self.root.glob("*.backup-*")), [])

    def test_cli_contract_names_new_and_frozen_databases_without_legacy_status(self):
        source = (Path(__file__).resolve().parents[1] / "scripts" / "generate_atom_feeds.py").read_text(encoding="utf-8")
        self.assertIn('"--database"', source)
        self.assertIn('"--legacy-membership-database"', source)
        self.assertNotIn('"--status"', source)
        self.assertNotIn("record_trending_membership", source)


if __name__ == "__main__":
    unittest.main()
