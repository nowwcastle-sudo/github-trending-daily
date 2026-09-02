import hashlib
import io
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import traceback
import unittest
from contextlib import closing, redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from scripts.record_repository_observations import (
    EMPTY_RELEASE_INVENTORY_SHA256,
    PAGES_BASE_ARTIFACT_PATHS,
    SCHEMA_VERSION,
    create_database,
    parent_database_evidence,
    measure_legacy_baseline_receipt,
    prepare_candidate_database,
    record_core_snapshot,
    verify_core_snapshot,
    schema_fingerprint,
    validate_schema,
)
from scripts.record_repository_observations import _validate_populated_rows
import scripts.record_repository_observations as ledger


EXPECTED_TABLES = {
    "schema_meta",
    "baseline_sources",
    "baseline_membership_slugs",
    "snapshot_runs",
    "repository_profiles",
    "snapshot_items",
    "release_versions",
    "snapshot_release_items",
    "historical_star_estimates",
    "historical_star_observations",
    "commit_events",
    "readme_change_events",
    "repository_insights",
    "artifact_hashes",
}
PINNED_SCHEMA_FINGERPRINT = "2d6af4ad04f09869aa44b71ac1bc7444f8c29b714c97f429e2f6b18957340644"
PINNED_LEGACY_PUBLIC_SCHEMA_FINGERPRINT = "a138d48d9698c96aa008598b0b259e5d11d733c1afb71b967806623f0d7d79b2"


def sha256(value="a"):
    return value * 64


def sha1(value="a"):
    return value * 40


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def historical_heads_receipt(heads=None):
    heads = {} if heads is None else heads
    return {"scope": "all_historical", "head_count": len(heads), "heads_sha256": canonical_hash(heads)}


def baseline_run(connection, *, snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00"):
    core = sha256("b")
    chain = canonical_hash({"schema_fingerprint_sha256": PINNED_SCHEMA_FINGERPRINT, "parent_chain_sha256": None, "core_payload_sha256": core, "snapshot_id": snapshot_id, "snapshot_seq": 1})
    connection.execute(
        """INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (1, snapshot_id, "migration_baseline", utc, kst, "2026-08-28", None, None,
         sha1(), sha256(), core, None, chain, 1),
    )


def profile(connection, *, profile_id=1, slug="owner/repo", display_slug="owner/repo", topics="[]", fields='["unclassified"]', forms="[]"):
    digest = hashlib.sha256(json.dumps({
        "slug": slug, "display_slug": display_slug, "description": None,
        "primary_language": None, "topics": json.loads(topics), "license_spdx": None,
        "archived": False, "is_fork": False, "default_branch": "main",
        "created_at": "2026-08-28T01:01:01.001Z", "field_tags": json.loads(fields),
        "form_tags": json.loads(forms), "tag_rule_version": 1,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    connection.execute(
        """INSERT INTO repository_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (profile_id, slug, display_slug, 1, None, None, topics, None, 0, 0, "main",
         "2026-08-28T01:01:01.001Z", fields, forms, 1, digest),
    )


def refresh_run(connection, *, seq, snapshot_id, parent_seq, parent_id, parent_chain, utc):
    core = sha256(chr(97 + seq))
    chain = canonical_hash({"schema_fingerprint_sha256": PINNED_SCHEMA_FINGERPRINT, "parent_chain_sha256": parent_chain, "core_payload_sha256": core, "snapshot_id": snapshot_id, "snapshot_seq": seq})
    kst = f"2026-08-28T10:01:01.{seq:03d}+09:00"
    connection.execute("INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (seq, snapshot_id, "refresh", utc, kst, "2026-08-28", parent_seq, parent_id, sha1(chr(97 + seq)), sha256(chr(97 + seq)), core, parent_chain, chain, 1))
    return chain


def copy_item(connection, snapshot_seq, slug="owner/repo", **changes):
    columns = [row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")]
    source = dict(zip(columns, connection.execute("SELECT * FROM snapshot_items WHERE snapshot_seq = 1 AND slug = ?", (slug,)).fetchone()))
    source["snapshot_seq"] = snapshot_seq
    source.update(changes)
    connection.execute(f"INSERT INTO snapshot_items VALUES ({','.join('?' for _ in columns)})", [source[name] for name in columns])


def complete_fixture(connection, *, display_slug="owner/repo", applicable=False):
    baseline_run(connection)
    profile(connection, display_slug=display_slug)
    readme_path, readme_blob, readme_content = ("README.md", sha1("b"), sha256("c")) if applicable else (None, None, None)
    translation_status = "applicable" if applicable else "not_applicable:no_readme"
    translation_source, translation_envelope = (sha256("d"), sha256("e")) if applicable else (None, None)
    connection.execute(
        """INSERT INTO snapshot_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (1, "owner/repo", 1, 1, 1, None, None, 0, None, None, "#112233", None, None,
         "#112233", "daily", 1, 0, 0, 0, 0, 0, "2026-08-28T01:01:01.001Z", None,
         sha1(), None, "baseline", "present" if applicable else "absent", readme_path, readme_blob, readme_content, "baseline_present", 0,
         EMPTY_RELEASE_INVENTORY_SHA256, None, "complete_empty", sha256("e"), 0, sha256("f"),
         sha256("a"), sha256("b"), translation_status, translation_source, translation_envelope),
    )
    connection.execute(
        "INSERT INTO historical_star_estimates VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("legacy_star_history_cache", "owner/repo", "2026-08-28", 1, 1, canonical_hash({"slug": "owner/repo", "date": "2026-08-28", "is_present": True, "stars": 1}), sha256("d"), 1),
    )
    connection.execute(
        "INSERT INTO historical_star_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("legacy_public_star_history", None, "owner/repo", "2026-08-28", 1, None, None, canonical_hash({"source": "legacy_public_star_history", "slug": "owner/repo", "observation_date": "2026-08-28", "stars": 1}), 1),
    )
    connection.execute(
        "INSERT INTO commit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("owner/repo", sha1(), 1, 0, "main", "2026-08-28T01:01:01.001Z", "2026-08-28T01:01:01.001Z", None, "[]", "https://github.com/owner/repo/commit/" + sha1()),
    )
    connection.execute(
        "INSERT INTO readme_change_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (1, "owner/repo", None, readme_path, None, readme_blob, None, readme_content, "baseline"),
    )
    connection.execute(
        "INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (1, "owner/repo", None, None, None, None, None, None, None, "repository-insight-v1", canonical_hash({"snapshot_seq": 1, "slug": "owner/repo", "previous_observed_snapshot_seq": None, "observation_gap_milliseconds": None, "stars_delta_since_previous_observation": None, "display_rank_delta": None, "rank_daily_delta": None, "rank_weekly_delta": None, "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1"})),
    )
    for artifact_path in PAGES_BASE_ARTIFACT_PATHS:
        connection.execute("INSERT INTO artifact_hashes VALUES (?, ?, ?, ?)", (1, artifact_path, sha256("a"), 1))
    if applicable:
        connection.execute("INSERT INTO artifact_hashes VALUES (?, ?, ?, ?)", (1, f"translations/{display_slug.replace('/', '__')}.json", sha256("b"), 1))


def recompute_snapshot_chain(connection, snapshot_seq):
    snapshot_id, parent_chain, core = connection.execute(
        "SELECT snapshot_id, parent_chain_sha256, core_payload_sha256 FROM snapshot_runs WHERE snapshot_seq = ?",
        (snapshot_seq,),
    ).fetchone()
    connection.execute(
        "UPDATE snapshot_runs SET chain_sha256 = ? WHERE snapshot_seq = ?",
        (canonical_hash({
            "schema_fingerprint_sha256": PINNED_SCHEMA_FINGERPRINT,
            "parent_chain_sha256": parent_chain,
            "core_payload_sha256": core,
            "snapshot_id": snapshot_id,
            "snapshot_seq": snapshot_seq,
        }), snapshot_seq),
    )


def recompute_profile_hash(connection, profile_id=1):
    row = connection.execute(
        """SELECT slug, display_slug, description, primary_language, topics_json, license_spdx,
                  archived, is_fork, default_branch, created_at, field_tags_json, form_tags_json,
                  tag_rule_version
           FROM repository_profiles WHERE profile_id = ?""",
        (profile_id,),
    ).fetchone()
    slug, display_slug, description, language, topics, license_spdx, archived, is_fork, branch, created, fields, forms, version = row
    connection.execute(
        "UPDATE repository_profiles SET profile_sha256 = ? WHERE profile_id = ?",
        (canonical_hash({
            "slug": slug,
            "display_slug": display_slug,
            "description": description,
            "primary_language": language,
            "topics": json.loads(topics),
            "license_spdx": license_spdx,
            "archived": bool(archived),
            "is_fork": bool(is_fork),
            "default_branch": branch,
            "created_at": created,
            "field_tags": json.loads(fields),
            "form_tags": json.loads(forms),
            "tag_rule_version": version,
        }), profile_id),
    )


def recompute_release_hash(connection, release_id):
    row = connection.execute(
        """SELECT slug, release_id, tag_name, name, target_commitish, draft, prerelease,
                  created_at, published_at, html_url
           FROM release_versions WHERE release_id = ?""",
        (release_id,),
    ).fetchone()
    slug, identifier, tag, name, target, draft, prerelease, created, published, url = row
    connection.execute(
        "UPDATE release_versions SET metadata_sha256 = ? WHERE release_id = ?",
        (canonical_hash({
            "slug": slug,
            "release_id": identifier,
            "tag_name": tag,
            "name": name,
            "target_commitish": target,
            "draft": bool(draft),
            "prerelease": bool(prerelease),
            "created_at": created,
            "published_at": published,
            "html_url": url,
        }), release_id),
    )


def recompute_estimate_hash(connection):
    source, slug, date, present, stars = connection.execute(
        "SELECT source, slug, estimate_date, is_present, stars FROM historical_star_estimates"
    ).fetchone()
    connection.execute(
        "UPDATE historical_star_estimates SET point_sha256 = ?",
        (canonical_hash({"slug": slug, "date": date, "is_present": bool(present), "stars": stars}),),
    )


def recompute_legacy_observation_hash(connection):
    source, row_id, slug, date, stars, delta, legacy = connection.execute(
        """SELECT source, legacy_row_id, slug, observation_date, stars, stars_delta,
                  legacy_source FROM historical_star_observations"""
    ).fetchone()
    value = ({"source": source, "slug": slug, "observation_date": date, "stars": stars}
             if source == "legacy_public_star_history" else
             {"source": source, "legacy_row_id": row_id, "slug": slug,
              "observation_date": date, "stars": stars, "stars_delta": delta,
              "legacy_source": legacy})
    connection.execute(
        "UPDATE historical_star_observations SET source_row_sha256 = ?",
        (canonical_hash(value),),
    )


def recompute_insight_hash(connection, snapshot_seq):
    columns = (
        "snapshot_seq", "slug", "previous_observed_snapshot_seq",
        "observation_gap_milliseconds", "stars_delta_since_previous_observation",
        "display_rank_delta", "rank_daily_delta", "rank_weekly_delta",
        "rank_monthly_delta", "insight_rule_version",
    )
    row = connection.execute(
        f"SELECT {', '.join(columns)} FROM repository_insights WHERE snapshot_seq = ?",
        (snapshot_seq,),
    ).fetchone()
    connection.execute(
        "UPDATE repository_insights SET insight_sha256 = ? WHERE snapshot_seq = ?",
        (canonical_hash(dict(zip(columns, row))), snapshot_seq),
    )


def three_snapshot_fixture(connection):
    complete_fixture(connection)
    connection.execute("DROP TRIGGER snapshot_items_reject_update")
    connection.execute(
        "UPDATE snapshot_items SET rank_weekly = 1, gain_weekly = 0, rank_monthly = 1, gain_monthly = 0"
    )
    first_id, first_chain = connection.execute(
        "SELECT snapshot_id, chain_sha256 FROM snapshot_runs WHERE snapshot_seq = 1"
    ).fetchone()
    second_id = "20260828010102-bbbbbbbbbbbbbbbb"
    second_chain = refresh_run(
        connection, seq=2, snapshot_id=second_id, parent_seq=1, parent_id=first_id,
        parent_chain=first_chain, utc="2026-08-28T01:01:01.002Z",
    )
    refresh_run(
        connection, seq=3, snapshot_id="20260828010103-cccccccccccccccc", parent_seq=2,
        parent_id=second_id, parent_chain=second_chain, utc="2026-08-28T01:01:01.003Z",
    )
    copy_item(
        connection, 2, stars=3, display_rank=1, rank_daily=1, gain_daily=0,
        rank_weekly=1, gain_weekly=0, rank_monthly=1, gain_monthly=0,
        updated_at="2026-08-28T01:01:01.002Z",
    )
    copy_item(
        connection, 3, stars=7, display_rank=1, rank_daily=1, gain_daily=0,
        rank_weekly=1, gain_weekly=0, rank_monthly=1, gain_monthly=0,
        updated_at="2026-08-28T01:01:01.003Z",
    )
    for snapshot_seq, previous in ((2, 1), (3, 2)):
        current = connection.execute(
            "SELECT display_rank, rank_daily, rank_weekly, rank_monthly, stars FROM snapshot_items WHERE snapshot_seq = ? AND slug = 'owner/repo'",
            (snapshot_seq,),
        ).fetchone()
        prior = connection.execute(
            "SELECT display_rank, rank_daily, rank_weekly, rank_monthly, stars FROM snapshot_items WHERE snapshot_seq = ? AND slug = 'owner/repo'",
            (previous,),
        ).fetchone()
        current_utc = connection.execute(
            "SELECT observed_at_utc FROM snapshot_runs WHERE snapshot_seq = ?", (snapshot_seq,)
        ).fetchone()[0]
        prior_utc = connection.execute(
            "SELECT observed_at_utc FROM snapshot_runs WHERE snapshot_seq = ?", (previous,)
        ).fetchone()[0]
        gap = int((datetime.strptime(current_utc, "%Y-%m-%dT%H:%M:%S.%fZ") - datetime.strptime(prior_utc, "%Y-%m-%dT%H:%M:%S.%fZ")).total_seconds() * 1000)
        insight = {
            "snapshot_seq": snapshot_seq,
            "slug": "owner/repo",
            "previous_observed_snapshot_seq": previous,
            "observation_gap_milliseconds": gap,
            "stars_delta_since_previous_observation": current[4] - prior[4],
            "display_rank_delta": prior[0] - current[0],
            "rank_daily_delta": prior[1] - current[1] if prior[1] is not None and current[1] is not None else None,
            "rank_weekly_delta": prior[2] - current[2] if prior[2] is not None and current[2] is not None else None,
            "rank_monthly_delta": prior[3] - current[3] if prior[3] is not None and current[3] is not None else None,
            "insight_rule_version": "repository-insight-v1",
        }
        connection.execute(
            "INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*insight.values(), canonical_hash(insight)),
        )


def calendar_fixture(connection):
    complete_fixture(connection)
    connection.execute("DROP TRIGGER snapshot_items_reject_update")
    connection.execute(
        "UPDATE snapshot_items SET pushed_at = '2026-08-28T01:01:01.001Z'"
    )
    release = {
        "slug": "owner/repo", "release_id": 9, "tag_name": "v9", "name": "Calendar release",
        "target_commitish": "main", "draft": False, "prerelease": False,
        "created_at": "2026-08-28T01:01:01.001Z", "published_at": "2026-08-28T01:01:01.002Z",
        "html_url": "https://github.com/owner/repo/releases/tag/v9",
    }
    connection.execute(
        "INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (release["slug"], release["release_id"], canonical_hash(release), 1,
         release["tag_name"], release["name"], release["target_commitish"], 0, 0,
         release["created_at"], release["published_at"], release["html_url"]),
    )


def writer_payload(*, snapshot_id, utc, kst, stats_date, run_kind, parent_snapshot_id=None, summary_source=None):
    profile_value = {
        "slug": "owner/repo", "display_slug": "owner/repo", "description": None,
        "primary_language": None, "topics": [], "license_spdx": None, "archived": False,
        "is_fork": False, "default_branch": "main", "created_at": utc,
        "field_tags": ["unclassified"], "form_tags": [], "tag_rule_version": 1,
    }
    source = json.loads(json.dumps(summary_source)) if summary_source is not None else {
        "kind": "readme", "slug": "owner/repo", "path": "README.md",
        "blob_sha": sha1("b"), "content_sha256": sha256("c"),
        "provider": "claude-cli-oauth", "interface": "claude-p", "cli_version": "2.1.241",
        "auth_method": "oauth_token", "api_provider": "firstParty",
        "model": "claude-sonnet-5", "schema_version": 3, "prompt_schema_version": 3,
        "translation_applicable": False,
    }
    provenance = {
        "repository": {"api_path": "/repos/owner/repo", "fact_sha256": sha256("1")},
        "contributors": {"api_path": "/repos/owner/repo/contributors", "fact_sha256": sha256("2")},
        "default_branch_head": {"api_path": "/repos/owner/repo/commits/main", "fact_sha256": sha256("3")},
        "readme": {
            "api_path": "/repos/owner/repo/readme", "blob_api_path": f"/repos/owner/repo/git/blobs/{sha1('b')}",
            "status": "present", "path": "README.md", "blob_sha": sha1("b"), "content_sha256": sha256("c"),
            "locale": None, "variant_tree_api_path": f"/repos/owner/repo/git/trees/{sha1()}", "variants": [],
        },
        "trending": {
            "daily": {"source_path": "/trending?since=daily", "rank": 1, "gain": 0, "language_color": "#112233", "fact_sha256": sha256("4")},
            "weekly": {"source_path": "/trending?since=weekly", "rank": None, "gain": None, "language_color": None, "fact_sha256": sha256("5")},
            "monthly": {"source_path": "/trending?since=monthly", "rank": None, "gain": None, "language_color": None, "fact_sha256": sha256("6")},
            "language_color_selection": {"rule": "daily_then_weekly_then_monthly", "selected_period": "daily", "value": "#112233"},
        },
    }
    return {
        "snapshotId": snapshot_id, "observedAtUtc": utc, "observedAtKst": kst,
        "statsDate": stats_date, "runKind": run_kind, "parentSnapshotId": parent_snapshot_id,
        "inputSourceSha": sha1(), "inputManifestSha256": sha256(),
        "hydrationSourceSha": sha1(),
        "productionManifestStatus": "verified_v1",
        "enrichmentIndex": {"owner/repo": {"status": "verified", "summary": {
            "content": {"goal": "g", "usage": "u", "pros": "p", "cons": "c", "fit": "f"},
            "source": source,
        }}},
        "repositories": [{
            "slug": "owner/repo", "displaySlug": "owner/repo", "description": None,
            "primaryLanguage": None, "topics": [], "licenseSpdx": None,
            "archived": False, "isFork": False,
            "fieldTags": ["unclassified"], "formTags": [], "tagRuleVersion": 1,
            "defaultBranch": "main", "defaultBranchHeadSha": sha1(),
            "createdAt": utc, "displayRank": 1,
            "rankDaily": 1, "gainDaily": 0, "rankWeekly": None, "gainWeekly": None,
            "rankMonthly": None, "gainMonthly": None, "languageColor": "#112233",
            "stars": 1, "forks": 0, "watchersCount": 2, "subscribers": 3,
            "openIssuesAndPullRequests": 4, "contributors": 5, "updatedAt": utc,
            "pushedAt": None, "readmeStatus": "present", "readmePath": "README.md",
            "readmeBlobSha": sha1("b"), "readmeContentSha256": sha256("c"), "readmeLocale": None,
            "readmeVariants": [], "provenance": provenance,
        }],
    }


def writer_events(*, head, transition, estimate_rows=None):
    rows = estimate_rows or []
    return {
        "heads": [{"slug": "owner/repo", "branch": "main", "headSha": head, "transition": transition}],
        "releases": [], "latestReleaseIds": {"owner/repo": None}, "commits": [],
        "estimates": [{"slug": "owner/repo", "rows": rows, "sourcePayloadSha256": sha256("b"), "publicRows": rows[-500:]}],
    }


def held_two_repository_inputs(*, readme_absent):
    """owner/repo is held (README present or absent); other/repo is verified. Ratio 1/2."""
    payload = writer_payload(snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
    other = json.loads(json.dumps(payload["repositories"][0]))
    other.update({"slug": "other/repo", "displaySlug": "other/repo", "displayRank": 2, "rankDaily": 2})
    other["provenance"]["trending"]["daily"]["rank"] = 2
    payload["repositories"].append(other)
    verified = json.loads(json.dumps(payload["enrichmentIndex"]["owner/repo"]))
    verified["summary"]["source"]["slug"] = "other/repo"
    payload["enrichmentIndex"] = {
        "owner/repo": {"status": "held", "held_reason": "quality_defects", "defect_codes": ["GENERIC_OR_PLACEHOLDER"], "warnings": []},
        "other/repo": verified,
    }
    if readme_absent:
        held = payload["repositories"][0]
        held.update({"readmeStatus": "absent", "readmePath": None, "readmeBlobSha": None, "readmeContentSha256": None, "readmeLocale": None, "readmeVariants": []})
        held["provenance"]["readme"] = {
            "api_path": "/repos/owner/repo/readme", "blob_api_path": None, "status": "absent", "path": None,
            "blob_sha": None, "content_sha256": None, "locale": None, "variant_tree_api_path": None, "variants": [],
        }
    events = writer_events(head=sha1(), transition="baseline")
    events["heads"].append({"slug": "other/repo", "branch": "main", "headSha": sha1(), "transition": "baseline"})
    events["latestReleaseIds"]["other/repo"] = None
    events["estimates"].append({"slug": "other/repo", "rows": [], "sourcePayloadSha256": sha256("b"), "publicRows": []})
    bind_writer_inputs(payload, events)
    return payload, events


def bind_writer_inputs(payload, events):
    repositories = payload["repositories"]
    snapshot_id = payload["snapshotId"]
    source_sha = payload["inputSourceSha"]
    hydration_source_sha = payload["hydrationSourceSha"]
    run_context_sha = canonical_hash({
        "observedAtUtc": payload["observedAtUtc"],
        "observedAtKst": payload["observedAtKst"],
        "statsDateKst": payload["statsDate"],
        "snapshotId": snapshot_id,
        "parentSnapshotId": payload["parentSnapshotId"],
        "parentSourceSha": hydration_source_sha if payload["parentSnapshotId"] is not None else None,
    })
    source_set_sha = sha256("7")
    active_set_sha = canonical_hash(sorted(repository["slug"].lower() for repository in repositories))
    facts_sha = canonical_hash({
        "snapshot_id": snapshot_id,
        "input_source_sha": source_sha,
        "repositories": repositories,
    })
    for key in ("version", "snapshotId", "activeSetSha256", "factsSha256", "sourceSetSha256", "runContextSha256", "completeSetSha256"):
        events.pop(key, None)
    events_sha = canonical_hash(events)
    events.update({
        "version": 1, "snapshotId": snapshot_id, "activeSetSha256": active_set_sha,
        "factsSha256": facts_sha, "sourceSetSha256": source_set_sha,
        "runContextSha256": run_context_sha, "completeSetSha256": events_sha,
    })
    entries = payload["enrichmentIndex"].get("repositories", payload["enrichmentIndex"])
    held_entries = sum(1 for entry in entries.values() if isinstance(entry, dict) and entry.get("status") == "held")
    payload["enrichmentIndex"] = {
        "version": 2, "snapshotId": snapshot_id, "activeSetSha256": active_set_sha,
        "factsSha256": facts_sha, "sourceSetSha256": source_set_sha,
        "runContextSha256": run_context_sha, "eventsSha256": events_sha,
        "heldRatio": held_entries / len(entries) if entries else 0, "repositories": entries,
    }
    enrichment_sha = canonical_hash(payload["enrichmentIndex"])
    payload.update({
        "activeSetSha256": active_set_sha, "factsSha256": facts_sha,
        "sourceSetSha256": source_set_sha, "runContextSha256": run_context_sha,
        "eventsSha256": events_sha, "enrichmentIndexSha256": enrichment_sha,
    })
    return events


def record_writer_snapshot(candidate, payload, events, state):
    return record_core_snapshot(candidate, payload, bind_writer_inputs(payload, events), state)


def write_legacy_public(path, payload):
    Path(path).write_bytes((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def writer_legacy_baselines(directory):
    star = Path(directory) / "legacy-star.sqlite"
    membership = Path(directory) / "legacy-membership.sqlite"
    public = Path(directory) / "legacy-public.json"
    with closing(sqlite3.connect(star)) as connection:
        connection.execute("CREATE TABLE star_observations(id INTEGER PRIMARY KEY, slug TEXT, observed_date TEXT, stars_total INTEGER, stars_delta INTEGER, source TEXT)")
    with closing(sqlite3.connect(membership)) as connection:
        connection.execute("CREATE TABLE snapshot_members(snapshot_id INTEGER, ordinal INTEGER, slug TEXT, PRIMARY KEY(snapshot_id, slug))")
    write_legacy_public(public, {"version": 1, "generatedAt": "2026-08-28", "repositories": []})
    paths = {"legacy_star_observations": str(star), "legacy_trending_membership": str(membership), "legacy_public_star_history": str(public)}
    return paths, measure_legacy_baseline_receipt(paths)


def writer_cli_case(directory, *, candidate_name="candidate.sqlite", state_name="readme-state.json"):
    root = Path(directory)
    paths, receipt = writer_legacy_baselines(directory)
    payload = writer_payload(
        snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
        utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
        stats_date="2026-08-28", run_kind="migration_baseline",
    )
    events = writer_events(head=sha1(), transition="baseline")
    bind_writer_inputs(payload, events)
    index = payload.pop("enrichmentIndex")
    inputs = {
        "snapshot": root / "snapshot.json", "events": root / "events.json",
        "index": root / "index.json", "evidence": root / "evidence.json",
    }
    inputs["snapshot"].write_text(json.dumps(payload), encoding="utf-8")
    inputs["events"].write_text(json.dumps(events), encoding="utf-8")
    inputs["index"].write_text(json.dumps(index), encoding="utf-8")
    inputs["evidence"].write_text(json.dumps({
        "version": 1, "parent_database": {"missing": True},
        "production_source_sha": payload["hydrationSourceSha"],
        "historical_heads": historical_heads_receipt(),
        "legacy_baseline_receipt": receipt,
    }), encoding="utf-8")
    candidate = root / candidate_name
    state = root / state_name
    arguments = [
        "--parent-database", str(root / "missing-parent.sqlite"),
        "--candidate-database", str(candidate),
        "--snapshot", str(inputs["snapshot"]),
        "--events", str(inputs["events"]),
        "--enrichment-index", str(inputs["index"]),
        "--parent-evidence", str(inputs["evidence"]),
        "--legacy-star-database", paths["legacy_star_observations"],
        "--legacy-membership-database", paths["legacy_trending_membership"],
        "--legacy-public-star-history", paths["legacy_public_star_history"],
        "--readme-state", str(state),
    ]
    return arguments, candidate, state


class RepositoryObservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary.name) / "repository-observations.sqlite"

    def tearDown(self):
        self.temporary.cleanup()

    def test_legacy_public_v1_preserves_source_case_and_uses_casefold_receipt_order(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        repositories = [
            {
                "slug": "Zed/Repo",
                "estimated": [{"date": "2026-08-27", "stars": 7}],
                "observed": [{"date": "2026-08-28", "stars": 8}],
            },
            {
                "slug": "Alpha/Repo",
                "estimated": [],
                "observed": [{"date": "2026-08-26", "stars": 3}],
            },
        ]
        public_path = Path(paths["legacy_public_star_history"])
        write_legacy_public(public_path, {
            "version": 1,
            "generatedAt": "2026-08-28",
            "repositories": repositories,
        })
        original_bytes = public_path.read_bytes()

        receipt = measure_legacy_baseline_receipt(paths)
        public_receipt = receipt["sources"]["legacy_public_star_history"]
        self.assertEqual(public_path.read_bytes(), original_bytes)
        self.assertEqual(public_receipt["logical_row_count"], 2)
        self.assertEqual(
            public_receipt["schema_fingerprint_sha256"],
            PINNED_LEGACY_PUBLIC_SCHEMA_FINGERPRINT,
        )
        self.assertEqual(
            public_receipt["logical_rows_sha256"],
            "0024c04cbe8f9a3ace8513d6530e3decbc1b338e570807dc6c25537fc1f6a1a0",
        )
        self.assertEqual(public_receipt["last_logical_key_json"], '"zed/repo"')

        projected = ledger.project_legacy_baselines(paths, receipt, 1)
        self.assertEqual(
            [row["slug"] for row in projected["historical_star_observations"]],
            ["zed/repo", "alpha/repo"],
        )
        self.assertEqual(
            json.loads(public_path.read_text(encoding="utf-8"))["repositories"],
            repositories,
        )

    def test_legacy_public_v1_rejects_obsolete_duplicate_unsafe_and_nonordered_data(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        public_path = Path(paths["legacy_public_star_history"])
        invalid_payloads = {
            "obsolete": {"repositories": []},
            "noninteger version": {"version": 1.0, "generatedAt": "2026-08-28", "repositories": []},
            "casefold duplicate": {
                "version": 1,
                "generatedAt": "2026-08-28",
                "repositories": [
                    {"slug": "Owner/Repo", "estimated": [], "observed": []},
                    {"slug": "owner/repo", "estimated": [], "observed": []},
                ],
            },
            "unsafe integer": {
                "version": 1,
                "generatedAt": "2026-08-28",
                "repositories": [{
                    "slug": "Owner/Repo",
                    "estimated": [],
                    "observed": [{"date": "2026-08-28", "stars": 9_007_199_254_740_992}],
                }],
            },
            "nonordered dates": {
                "version": 1,
                "generatedAt": "2026-08-28",
                "repositories": [{
                    "slug": "Owner/Repo",
                    "estimated": [],
                    "observed": [
                        {"date": "2026-08-28", "stars": 2},
                        {"date": "2026-08-27", "stars": 1},
                    ],
                }],
            },
            "point field": {
                "version": 1,
                "generatedAt": "2026-08-28",
                "repositories": [{
                    "slug": "Owner/Repo",
                    "estimated": [],
                    "observed": [{"date": "2026-08-28", "stars": 1, "delta": 1}],
                }],
            },
            "repository field order": {
                "version": 1,
                "generatedAt": "2026-08-28",
                "repositories": [{
                    "slug": "Owner/Repo",
                    "observed": [],
                    "estimated": [],
                }],
            },
        }
        for label, payload in invalid_payloads.items():
            with self.subTest(label=label):
                write_legacy_public(public_path, payload)
                with self.assertRaises(ValueError):
                    measure_legacy_baseline_receipt(paths)

    def test_legacy_public_v1_requires_pretty_two_space_lf_bytes(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        public_path = Path(paths["legacy_public_star_history"])
        public_path.write_text(
            json.dumps({"version": 1, "generatedAt": "2026-08-28", "repositories": []}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "canonical pretty-2 LF"):
            measure_legacy_baseline_receipt(paths)

    def test_legacy_public_v1_rejects_repository_and_series_cardinality_overflow(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        public_path = Path(paths["legacy_public_star_history"])

        def points(count):
            first = datetime(2024, 1, 1).toordinal()
            return [
                {"date": datetime.fromordinal(first + index).strftime("%Y-%m-%d"), "stars": index}
                for index in range(count)
            ]

        invalid_repositories = {
            "76 repositories": [
                {"slug": f"Owner{index}/Repo", "estimated": [], "observed": []}
                for index in range(76)
            ],
            "501 estimates": [{"slug": "Owner/Repo", "estimated": points(501), "observed": []}],
            "731 observations": [{"slug": "Owner/Repo", "estimated": [], "observed": points(731)}],
        }
        for label, repositories in invalid_repositories.items():
            with self.subTest(label=label):
                write_legacy_public(public_path, {
                    "version": 1,
                    "generatedAt": "2026-08-28",
                    "repositories": repositories,
                })
                with self.assertRaisesRegex(ValueError, "cardinality"):
                    measure_legacy_baseline_receipt(paths)

    def test_strict_json_loader_rejects_duplicate_keys_constants_and_hides_content(self):
        samples = {
            "top duplicate": '{"SENSITIVE_VALUE":1,"SENSITIVE_VALUE":2}',
            "nested duplicate": '{"outer":{"SENSITIVE_VALUE":1,"SENSITIVE_VALUE":2}}',
            "nan": '{"value":NaN,"SENSITIVE_VALUE":1}',
            "infinity": '{"value":Infinity,"SENSITIVE_VALUE":1}',
        }
        for label, contents in samples.items():
            with self.subTest(label=label):
                path = Path(self.temporary.name) / f"{label}.json"
                path.write_text(contents, encoding="utf-8")
                with self.assertRaises(ValueError) as caught:
                    ledger._load_json_file(path, "candidate input")
                rendered = "".join(traceback.format_exception(caught.exception))
                self.assertNotIn("SENSITIVE_VALUE", str(caught.exception))
                self.assertNotIn("SENSITIVE_VALUE", rendered)
                self.assertNotIn(str(path), str(caught.exception))
                self.assertNotIn(str(path), rendered)

        paths, _ = writer_legacy_baselines(self.temporary.name)
        public_path = Path(paths["legacy_public_star_history"])
        public_path.write_text(
            '{"version":1,"generatedAt":"2026-08-28","repositories":['
            '{"slug":"Owner/Repo","estimated":[],"observed":['
            '{"date":"2026-08-28","stars":1,"stars":1}]}]}',
            encoding="utf-8",
        )
        with self.assertRaises(ValueError) as caught:
            measure_legacy_baseline_receipt(paths)
        self.assertNotIn("Owner/Repo", "".join(traceback.format_exception(caught.exception)))

    def test_every_recorder_cli_json_input_uses_the_strict_loader(self):
        for option in ("--snapshot", "--events", "--enrichment-index", "--parent-evidence", "--readme-state"):
            with self.subTest(option=option):
                root = Path(self.temporary.name) / option.removeprefix("--")
                root.mkdir()
                arguments, candidate, _ = writer_cli_case(root)
                target = Path(arguments[arguments.index(option) + 1])
                target.write_text('{"outer":{"SENSITIVE_VALUE":1,"SENSITIVE_VALUE":2}}', encoding="utf-8")
                with self.assertRaises(ValueError) as caught:
                    ledger.main(arguments)
                rendered = "".join(traceback.format_exception(caught.exception))
                self.assertNotIn("SENSITIVE_VALUE", rendered)
                self.assertNotIn(str(target), rendered)
                self.assertFalse(candidate.exists())

    def test_sqlite_receipt_hashes_pk_ordered_rows_but_last_value_is_only_the_key(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        star_path = Path(paths["legacy_star_observations"])
        with closing(sqlite3.connect(star_path)) as connection:
            connection.execute(
                "INSERT INTO star_observations VALUES (2, 'owner/repo', '2026-08-28', 2, 1, 'github_rest')"
            )
            connection.execute(
                "INSERT INTO star_observations VALUES (1, 'owner/repo', '2026-08-27', 1, NULL, 'github_rest')"
            )
            connection.commit()

        receipt = measure_legacy_baseline_receipt(paths)["sources"]["legacy_star_observations"]
        self.assertEqual(receipt["logical_row_count"], 2)
        self.assertEqual(
            receipt["logical_rows_sha256"],
            "bfb0e815ca0554c48bdfdfc0e2ec4cf57951e438cf26fedc801d705490983e20",
        )
        self.assertEqual(
            receipt["last_logical_key_json"],
            '{"key":[2],"table":"star_observations"}',
        )

    def test_baseline_receipt_creator_is_create_new_canonical_and_remeasures_sources(self):
        paths, expected = writer_legacy_baselines(self.temporary.name)
        output = Path(self.temporary.name) / "legacy-observation-baseline.json"
        created = ledger.create_legacy_baseline_receipt(paths, output)
        self.assertEqual(created, expected)
        self.assertEqual(
            output.read_bytes(),
            (json.dumps(expected, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        )
        self.assertEqual(ledger._load_json_file(output, "baseline receipt"), expected)

        original = output.read_bytes()
        output.write_bytes(original + b"SENSITIVE_VALUE")
        with self.assertRaises(ValueError) as caught:
            ledger.create_legacy_baseline_receipt(paths, output)
        self.assertNotIn("SENSITIVE_VALUE", "".join(traceback.format_exception(caught.exception)))
        self.assertEqual(output.read_bytes(), original + b"SENSITIVE_VALUE")

        failed_output = Path(self.temporary.name) / "changed-during-measure.json"
        changed = json.loads(json.dumps(expected))
        changed["sources"]["legacy_public_star_history"]["byte_size"] += 1
        with mock.patch.object(
            ledger,
            "measure_legacy_baseline_receipt",
            side_effect=(expected, changed),
        ):
            with self.assertRaises(ValueError) as caught:
                ledger.create_legacy_baseline_receipt(paths, failed_output)
        self.assertNotIn(str(failed_output), "".join(traceback.format_exception(caught.exception)))
        self.assertFalse(failed_output.exists())

    def test_baseline_receipt_creator_rejects_pkless_tables_without_content_leak(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        star_path = Path(paths["legacy_star_observations"])
        sentinel = "SENSITIVE" + "_PKLESS_BODY"
        with closing(sqlite3.connect(star_path)) as connection:
            connection.execute("CREATE TABLE zzz_no_pk(body TEXT)")
            connection.execute("INSERT INTO zzz_no_pk VALUES (?)", (sentinel,))
            connection.commit()
        output = Path(self.temporary.name) / "pkless-baseline-receipt.json"
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            with self.assertRaises(ValueError) as caught:
                ledger.create_legacy_baseline_receipt(paths, output)
        rendered = "".join(traceback.format_exception(caught.exception)) + stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(sentinel, rendered)
        self.assertNotIn(str(star_path), rendered)
        self.assertFalse(output.exists())

    def test_baseline_receipt_cli_uses_explicit_sources_and_create_new_output(self):
        paths, expected = writer_legacy_baselines(self.temporary.name)
        output = Path(self.temporary.name) / "cli-baseline-receipt.json"
        arguments = [
            "create-baseline-receipt",
            "--legacy-star-database", paths["legacy_star_observations"],
            "--legacy-membership-database", paths["legacy_trending_membership"],
            "--legacy-public-star-history", paths["legacy_public_star_history"],
            "--output", str(output),
        ]
        with mock.patch("sys.stdout"):
            self.assertEqual(ledger.main(arguments), 0)
        self.assertEqual(ledger._load_json_file(output, "baseline receipt"), expected)
        with self.assertRaisesRegex(ValueError, "already exists"):
            ledger.main(arguments)

    def test_schema_has_exact_tables_and_rejects_update_delete(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")},
                EXPECTED_TABLES,
            )
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(
                connection.execute("SELECT schema_version, creation_policy FROM schema_meta").fetchall(),
                [(1, "append_only")],
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE schema_meta SET creation_policy='mutable'")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM schema_meta")

    def test_strict_schema_fingerprint_rejects_trigger_mutation(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            original = schema_fingerprint(connection)
            connection.execute("DROP TRIGGER schema_meta_reject_update")
            self.assertNotEqual(schema_fingerprint(connection), original)
            with self.assertRaisesRegex(ValueError, "canonical"):
                validate_schema(connection)

    def test_fingerprint_is_independently_pinned_and_preserves_sql_literal_case(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(schema_fingerprint(connection), PINNED_SCHEMA_FINGERPRINT)
            connection.execute("PRAGMA writable_schema = ON")
            connection.execute(
                "UPDATE sqlite_schema SET sql = replace(sql, '''refresh''', '''REFRESH''') "
                "WHERE type = 'table' AND name = 'snapshot_runs'"
            )
            connection.execute("PRAGMA writable_schema = OFF")
            with self.assertRaisesRegex(ValueError, "canonical"):
                validate_schema(connection)

    def test_pinned_fingerprint_rejects_trigger_fk_index_and_check_text_mutations(self):
        mutations = (
            ("trigger", "schema_meta_reject_update", "append-only", "append-only!"),
            ("table", "snapshot_runs", "ON DELETE RESTRICT", "ON DELETE CASCADE"),
            ("index", "idx_snapshot_items_slug_seq", "slug, snapshot_seq", "snapshot_seq, slug"),
            ("table", "snapshot_items", "stars >= 0", "stars >= 1"),
        )
        for object_type, name, before, after in mutations:
            with self.subTest(name=name):
                path = Path(self.temporary.name) / f"{name}.sqlite"
                create_database(path)
                with closing(sqlite3.connect(path)) as connection:
                    connection.execute("PRAGMA writable_schema = ON")
                    connection.execute(
                        "UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE type = ? AND name = ?",
                        (before, after, object_type, name),
                    )
                    connection.execute("PRAGMA writable_schema = OFF")
                    with self.assertRaisesRegex(ValueError, "canonical"):
                        validate_schema(connection)

    def test_profile_rejects_noncanonical_slugs_display_mismatch_and_noncanonical_tags(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            baseline_run(connection)
            for kwargs in (
                {"slug": "owner/"},
                {"slug": "owner/repo/extra"},
                {"slug": "owner/repo", "display_slug": "other/repo"},
                {"topics": "{}"},
                {"fields": "{}"},
                {"forms": "null"},
            ):
                with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                    connection.execute("SAVEPOINT profile_probe")
                    profile(connection, **kwargs)
                    validate_schema(connection)
                connection.execute("ROLLBACK TO profile_probe")
                connection.execute("RELEASE profile_probe")

    def test_profile_slug_constraints_accept_hyphens_and_reject_other_characters(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            baseline_run(connection)
            profile(
                connection,
                slug="owner-name/repo-0",
                display_slug="Owner-Name/Repo-0",
            )
            self.assertEqual(
                connection.execute(
                    "SELECT slug, display_slug FROM repository_profiles"
                ).fetchone(),
                ("owner-name/repo-0", "Owner-Name/Repo-0"),
            )
            validate_schema(connection)

            for slug, display_slug in (
                ("owner name/repo", "owner name/repo"),
                ("owner/repo@0", "owner/repo@0"),
                ("owner/repo\\0", "owner/repo\\0"),
                ("owner/repo", "Owner/Repo+0"),
            ):
                with self.subTest(slug=slug, display_slug=display_slug):
                    with self.assertRaises(sqlite3.IntegrityError):
                        profile(
                            connection,
                            profile_id=2,
                            slug=slug,
                            display_slug=display_slug,
                        )

    def test_snapshot_run_requires_real_matching_utc_kst_calendar_values_and_unique_utc(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for utc, kst in (
                ("2026-99-99T99:99:99.999Z", "2026-99-99T99:99:99.999+09:00"),
                ("2026-08-28T01:01:01.001Z", "2026-08-28T09:01:01.001+09:00"),
            ):
                with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                    connection.execute("SAVEPOINT time_probe")
                    baseline_run(connection, utc=utc, kst=kst)
                    validate_schema(connection)
                connection.execute("ROLLBACK TO time_probe")
                connection.execute("RELEASE time_probe")
            baseline_run(connection)
            with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                connection.execute(
                    "INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (2, "20260828010102-bbbbbbbbbbbbbbbb", "refresh", "2026-08-28T01:01:01.001Z",
                     "2026-08-28T10:01:01.001+09:00", "2026-08-28", 1,
                     "20260828010101-aaaaaaaaaaaaaaaa", sha1("b"), sha256("c"), sha256("d"),
                     sha256("c"), sha256("e"), 1),
                )

    def test_snapshot_id_and_chain_hash_are_exact(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for bad_id in ("20260828010101-aaaaaaaaaaaaaaa-", "20260828010101-aaaaaaaaaaaaaaaA", "20260828010101aaaaaaaaaaaaaaaa"):
                connection.execute("SAVEPOINT snapshot_probe")
                with self.assertRaises((sqlite3.IntegrityError, ValueError)):
                    baseline_run(connection, snapshot_id=bad_id)
                    validate_schema(connection)
                connection.execute("ROLLBACK TO snapshot_probe")
                connection.execute("RELEASE snapshot_probe")
            complete_fixture(connection)
            connection.execute("SAVEPOINT chain_probe")
            connection.execute("DROP TRIGGER snapshot_runs_reject_update")
            connection.execute("UPDATE snapshot_runs SET chain_sha256 = ?", (sha256("f"),))
            with self.assertRaisesRegex(ValueError, "chain hash"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO chain_probe")
            connection.execute("RELEASE chain_probe")

    def test_db_only_hash_preimages_reject_mutation(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            for table, column, label in (
                ("historical_star_estimates", "point_sha256", "estimate point"),
                ("historical_star_observations", "source_row_sha256", "legacy observation"),
                ("repository_insights", "insight_sha256", "insight hash"),
            ):
                connection.execute("SAVEPOINT hash_probe")
                connection.execute(f"DROP TRIGGER {table}_reject_update")
                connection.execute(f"UPDATE {table} SET {column} = ?", (sha256("f"),))
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO hash_probe")
                connection.execute("RELEASE hash_probe")

    def test_release_hash_and_api_merge_parent_order_are_recomputed(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            release = {"slug": "owner/repo", "release_id": 1, "tag_name": "v1", "name": None, "target_commitish": "main", "draft": False, "prerelease": False, "created_at": "2026-08-28T01:01:01.001Z", "published_at": None, "html_url": "https://github.com/owner/repo/releases/tag/v1"}
            connection.execute("INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (release["slug"], release["release_id"], canonical_hash(release), 1, release["tag_name"], release["name"], release["target_commitish"], 0, 0, release["created_at"], release["published_at"], release["html_url"]))
            connection.execute("INSERT INTO commit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ("owner/merge", sha1("b"), 1, 1, "main", "2026-08-28T01:01:01.001Z", "2026-08-28T01:01:01.001Z", None, json.dumps([sha1("f"), sha1("a")], separators=(",", ":")), "https://github.com/owner/merge/commit/" + sha1("b")))
            validate_schema(connection)
            connection.execute("SAVEPOINT release_hash_probe")
            connection.execute("DROP TRIGGER release_versions_reject_update")
            connection.execute("UPDATE release_versions SET metadata_sha256 = ?", (sha256("e"),))
            with self.assertRaisesRegex(ValueError, "release metadata"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO release_hash_probe")
            connection.execute("RELEASE release_hash_probe")

    def test_multi_repo_rank_gaps_and_two_release_ordinals_are_permanent(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            profile(connection, profile_id=2, slug="owner/two", display_slug="Owner/Two")
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET rank_weekly = 1, gain_weekly = 1, rank_monthly = 1, gain_monthly = 1 WHERE slug = 'owner/repo'")
            original = dict(zip([row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")], connection.execute("SELECT * FROM snapshot_items").fetchone()))
            original.update({"slug": "owner/two", "profile_id": 2, "display_rank": 2, "rank_daily": 2, "gain_daily": 1, "rank_weekly": 2, "gain_weekly": 1, "rank_monthly": 2, "gain_monthly": 1})
            connection.execute(f"INSERT INTO snapshot_items VALUES ({','.join('?' for _ in original)})", list(original.values()))
            releases = []
            for release_id in (1, 2):
                value = {"slug": "owner/repo", "release_id": release_id, "tag_name": f"v{release_id}", "name": None, "target_commitish": "main", "draft": False, "prerelease": False, "created_at": "2026-08-28T01:01:01.001Z", "published_at": None, "html_url": f"https://github.com/owner/repo/releases/tag/v{release_id}"}
                digest = canonical_hash(value)
                releases.append((release_id, digest))
                connection.execute("INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (value["slug"], release_id, digest, 1, value["tag_name"], None, "main", 0, 0, value["created_at"], None, value["html_url"]))
                connection.execute("INSERT INTO snapshot_release_items VALUES (?, ?, ?, ?, ?)", (1, "owner/repo", release_id, digest, release_id - 1))
            connection.execute("UPDATE snapshot_items SET release_count = 2, release_inventory_sha256 = ?, latest_release_id = 2 WHERE slug = 'owner/repo'", (canonical_hash([{"release_id": release_id, "metadata_sha256": digest} for release_id, digest in releases]),))
            _validate_populated_rows(connection)
            for statement, label in (("UPDATE snapshot_items SET display_rank = 3 WHERE slug = 'owner/two'", "display ranks"), ("UPDATE snapshot_items SET rank_daily = 3 WHERE slug = 'owner/two'", "rank_daily"), ("UPDATE snapshot_release_items SET release_ordinal = 2 WHERE release_id = 2", "release ordinals")):
                connection.execute("SAVEPOINT multi_probe")
                if "snapshot_items" not in statement:
                    connection.execute("DROP TRIGGER snapshot_release_items_reject_update")
                connection.execute(statement)
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO multi_probe")
                connection.execute("RELEASE multi_probe")

    def test_three_snapshot_chain_and_insight_deltas_are_permanent(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            first = connection.execute("SELECT snapshot_id, chain_sha256 FROM snapshot_runs WHERE snapshot_seq = 1").fetchone()
            second_id = "20260828010102-bbbbbbbbbbbbbbbb"
            second_chain = refresh_run(connection, seq=2, snapshot_id=second_id, parent_seq=1, parent_id=first[0], parent_chain=first[1], utc="2026-08-28T01:01:01.002Z")
            third_id = "20260828010103-cccccccccccccccc"
            refresh_run(connection, seq=3, snapshot_id=third_id, parent_seq=2, parent_id=second_id, parent_chain=second_chain, utc="2026-08-28T01:01:01.003Z")
            copy_item(connection, 2, stars=2, display_rank=1, rank_daily=1, gain_daily=1, updated_at="2026-08-28T01:01:01.002Z")
            copy_item(connection, 3, stars=5, display_rank=1, rank_daily=None, gain_daily=None, rank_weekly=1, gain_weekly=1, updated_at="2026-08-28T01:01:01.003Z")
            insight = {"snapshot_seq": 2, "slug": "owner/repo", "previous_observed_snapshot_seq": 1, "observation_gap_milliseconds": 1, "stars_delta_since_previous_observation": 1, "display_rank_delta": 0, "rank_daily_delta": 0, "rank_weekly_delta": None, "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1"}
            connection.execute("INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*insight.values(), canonical_hash(insight)))
            insight3 = {"snapshot_seq": 3, "slug": "owner/repo", "previous_observed_snapshot_seq": 2, "observation_gap_milliseconds": 1, "stars_delta_since_previous_observation": 3, "display_rank_delta": 0, "rank_daily_delta": None, "rank_weekly_delta": None, "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1"}
            connection.execute("INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*insight3.values(), canonical_hash(insight3)))
            _validate_populated_rows(connection)
            connection.execute("SAVEPOINT insight_probe")
            connection.execute("DROP TRIGGER repository_insights_reject_update")
            wrong = {**insight3, "previous_observed_snapshot_seq": 1}
            connection.execute("UPDATE repository_insights SET previous_observed_snapshot_seq = 1, insight_sha256 = ? WHERE snapshot_seq = 3", (canonical_hash(wrong),))
            with self.assertRaisesRegex(ValueError, "actual prior"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO insight_probe")
            connection.execute("RELEASE insight_probe")

    def test_three_snapshot_refresh_and_insight_invariants_reject_recomputed_mutations(self):
        mutations = (
            ("refresh_sequence", "refresh snapshot sequence", lambda connection: connection.execute(
                "UPDATE snapshot_runs SET parent_snapshot_seq = 3, parent_snapshot_id = snapshot_id WHERE snapshot_seq = 3")),
            ("parent_identity", "snapshot parent identity", lambda connection: connection.execute(
                "UPDATE snapshot_runs SET parent_snapshot_id = ? WHERE snapshot_seq = 3",
                (connection.execute("SELECT snapshot_id FROM snapshot_runs WHERE snapshot_seq = 1").fetchone()[0],))),
            ("parent_chain", "snapshot parent chain", lambda connection: (
                connection.execute("UPDATE snapshot_runs SET parent_chain_sha256 = ? WHERE snapshot_seq = 3", (sha256("f"),)),
                recompute_snapshot_chain(connection, 3))),
            ("child_chain_preimage", "snapshot chain hash preimage", lambda connection: connection.execute(
                "UPDATE snapshot_runs SET chain_sha256 = ? WHERE snapshot_seq = 3", (sha256("f"),))),
            ("gap", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET observation_gap_milliseconds = 2 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("stars_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET stars_delta_since_previous_observation = 99 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("display_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET display_rank_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("daily_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET rank_daily_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("weekly_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET rank_weekly_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("monthly_delta", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE repository_insights SET rank_monthly_delta = 1 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("null_current_rank", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE snapshot_items SET rank_daily = NULL, gain_daily = NULL WHERE snapshot_seq = 3"),
                connection.execute("UPDATE repository_insights SET rank_daily_delta = 0 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
            ("null_previous_rank", "insight gap or primary deltas", lambda connection: (
                connection.execute("UPDATE snapshot_items SET rank_daily = NULL, gain_daily = NULL WHERE snapshot_seq = 2"),
                connection.execute("UPDATE repository_insights SET rank_daily_delta = NULL WHERE snapshot_seq = 2"),
                recompute_insight_hash(connection, 2),
                connection.execute("UPDATE repository_insights SET rank_daily_delta = 0 WHERE snapshot_seq = 3"),
                recompute_insight_hash(connection, 3))),
        )
        for name, error, mutate in mutations:
            with self.subTest(mutation=name):
                path = Path(self.temporary.name) / f"three-snapshot-{name}.sqlite"
                create_database(path)
                with closing(sqlite3.connect(path)) as connection:
                    three_snapshot_fixture(connection)
                    _validate_populated_rows(connection)
                    connection.execute("DROP TRIGGER snapshot_runs_reject_update")
                    connection.execute("DROP TRIGGER repository_insights_reject_update")
                    mutate(connection)
                    with self.assertRaisesRegex(ValueError, error):
                        _validate_populated_rows(connection)

    def test_calendar_matrix_rejects_impossible_values_after_recomputing_bound_hashes(self):
        probes = (
            ("observed_utc", "snapshot_runs", "observed_at_utc", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: recompute_snapshot_chain(connection, 1)),
            ("observed_kst", "snapshot_runs", "observed_at_kst", "2026-02-30T10:01:01.001+09:00", "KST timestamp is not an exact calendar millisecond", lambda connection: recompute_snapshot_chain(connection, 1)),
            ("stats_date", "snapshot_runs", "stats_date_kst", "2026-02-30", "snapshot UTC, KST, and stats date must name one instant", lambda connection: recompute_snapshot_chain(connection, 1)),
            ("profile_created", "repository_profiles", "created_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", recompute_profile_hash),
            ("item_updated", "snapshot_items", "updated_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
            ("item_pushed", "snapshot_items", "pushed_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
            ("release_created", "release_versions", "created_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: recompute_release_hash(connection, 9)),
            ("release_published", "release_versions", "published_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: recompute_release_hash(connection, 9)),
            ("estimate_date", "historical_star_estimates", "estimate_date", "2026-02-30", "(?:day 30 must be in range|day is out of range for month)", recompute_estimate_hash),
            ("legacy_observation_date", "historical_star_observations", "observation_date", "2026-02-30", "(?:day 30 must be in range|day is out of range for month)", recompute_legacy_observation_hash),
            ("commit_authored", "commit_events", "authored_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
            ("commit_committed", "commit_events", "committed_at", "2026-02-30T01:01:01.001Z", "UTC timestamp is not an exact calendar millisecond", lambda connection: None),
        )
        for name, table, column, invalid, error, recompute in probes:
            with self.subTest(calendar_field=name):
                path = Path(self.temporary.name) / f"calendar-{name}.sqlite"
                create_database(path)
                with closing(sqlite3.connect(path)) as connection:
                    calendar_fixture(connection)
                    _validate_populated_rows(connection)
                    connection.execute(f"DROP TRIGGER IF EXISTS {table}_reject_update")
                    if table != "snapshot_runs":
                        connection.execute("DROP TRIGGER snapshot_runs_reject_update")
                    connection.execute(f"UPDATE {table} SET {column} = ?", (invalid,))
                    recompute(connection)
                    with self.assertRaisesRegex(ValueError, error):
                        _validate_populated_rows(connection)

    def test_hash_bound_calendar_probe_fails_if_timestamp_parser_is_bypassed(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            calendar_fixture(connection)
            connection.execute("DROP TRIGGER repository_profiles_reject_update")
            connection.execute(
                "UPDATE repository_profiles SET created_at = '2026-02-30T01:01:01.001Z'"
            )
            recompute_profile_hash(connection)
            original = ledger._parse_utc
            try:
                ledger._parse_utc = lambda value: original("2026-08-28T01:01:01.001Z") if value.startswith("2026-02-30") else original(value)
                with self.assertRaisesRegex(AssertionError, "ValueError not raised"):
                    with self.assertRaisesRegex(ValueError, "UTC timestamp is not an exact calendar millisecond"):
                        _validate_populated_rows(connection)
            finally:
                ledger._parse_utc = original

    def test_all_persisted_calendar_fields_reject_impossible_values(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            release = {"slug": "owner/repo", "release_id": 8, "tag_name": "v8", "name": None, "target_commitish": "main", "draft": False, "prerelease": False, "created_at": "2026-08-28T01:01:01.001Z", "published_at": None, "html_url": "https://github.com/owner/repo/releases/tag/v8"}
            connection.execute("INSERT INTO release_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (release["slug"], 8, canonical_hash(release), 1, "v8", None, "main", 0, 0, release["created_at"], None, release["html_url"]))
            for table, column in (("snapshot_items", "updated_at"), ("snapshot_items", "pushed_at"), ("release_versions", "created_at"), ("historical_star_estimates", "estimate_date"), ("historical_star_observations", "observation_date"), ("commit_events", "authored_at"), ("commit_events", "committed_at")):
                connection.execute("SAVEPOINT calendar_probe")
                connection.execute(f"DROP TRIGGER {table}_reject_update")
                value = "9999-99-99" if column in ("estimate_date", "observation_date") else "9999-99-99T99:99:99.999Z"
                connection.execute(f"UPDATE {table} SET {column} = ?", (value,))
                with self.assertRaises(ValueError):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO calendar_probe")
                connection.execute("RELEASE calendar_probe")

    def test_each_rank_dimension_has_an_isolated_gap_mutation(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            profile(connection, profile_id=2, slug="owner/two", display_slug="Owner/Two")
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET rank_weekly = 1, gain_weekly = 1, rank_monthly = 1, gain_monthly = 1 WHERE slug = 'owner/repo'")
            source = dict(zip([row[1] for row in connection.execute("PRAGMA table_info(snapshot_items)")], connection.execute("SELECT * FROM snapshot_items").fetchone()))
            source.update({"slug": "owner/two", "profile_id": 2, "display_rank": 2, "rank_daily": 2, "gain_daily": 1, "rank_weekly": 2, "gain_weekly": 1, "rank_monthly": 2, "gain_monthly": 1})
            connection.execute(f"INSERT INTO snapshot_items VALUES ({','.join('?' for _ in source)})", list(source.values()))
            _validate_populated_rows(connection)
            for field, label in (("display_rank", "display ranks"), ("rank_daily", "rank_daily"), ("rank_weekly", "rank_weekly"), ("rank_monthly", "rank_monthly")):
                connection.execute("SAVEPOINT isolated_rank")
                connection.execute(f"UPDATE snapshot_items SET {field} = 3 WHERE slug = 'owner/two'")
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO isolated_rank")
                connection.execute("RELEASE isolated_rank")

    def test_calendar_parser_mutation_proves_calendar_probe_efficacy(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            connection.execute("SAVEPOINT parser_probe")
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET updated_at = '9999-99-99T99:99:99.999Z'")
            original = ledger._parse_utc
            try:
                ledger._parse_utc = lambda value: original("2026-08-28T01:01:01.001Z") if value.startswith("9999") else original(value)
                with self.assertRaisesRegex(AssertionError, "ValueError not raised"):
                    with self.assertRaises(ValueError):
                        _validate_populated_rows(connection)
            finally:
                ledger._parse_utc = original
            connection.execute("ROLLBACK TO parser_probe")
            connection.execute("RELEASE parser_probe")

    def test_complete_cross_table_fixture_and_actual_immutable_triggers(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            validate_schema(connection)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE snapshot_items SET stars = 2")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM repository_profiles")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO snapshot_items SELECT * FROM snapshot_items")

    def test_applicable_translation_uses_display_case_and_slug_to_file_separator(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection, display_slug="Owner/Repo", applicable=True)
            validate_schema(connection)
            connection.execute("SAVEPOINT translation_path_probe")
            connection.execute("DROP TRIGGER artifact_hashes_reject_update")
            connection.execute("UPDATE artifact_hashes SET artifact_path = 'translations/owner--repo.json' WHERE artifact_path = 'translations/Owner__Repo.json'")
            with self.assertRaisesRegex(ValueError, "translation"):
                _validate_populated_rows(connection)
            connection.execute("ROLLBACK TO translation_path_probe")
            connection.execute("RELEASE translation_path_probe")

    def test_row_validator_rejects_wrong_selected_color_latest_release_and_artifact_set(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            for artifact_path in ("docs/private.txt", "translations/owner--repo.json"):
                connection.execute("SAVEPOINT cross_table_probe")
                connection.execute("INSERT INTO artifact_hashes VALUES (?, ?, ?, ?)", (1, artifact_path, sha256("b"), 1))
                with self.assertRaisesRegex(ValueError, "artifact"):
                    validate_schema(connection)
                connection.execute("ROLLBACK TO cross_table_probe")
                connection.execute("RELEASE cross_table_probe")

    def test_row_validator_rejects_negative_gain_wrong_color_source_and_empty_inventory_latest(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            probes = (
                ("gain_daily = -1", "gains"),
                ("selected_language_color_source_period = 'weekly'", "selected color"),
                ("latest_release_id = 99", "latest release"),
            )
            for assignment, label in probes:
                connection.execute("SAVEPOINT item_probe")
                connection.execute("DROP TRIGGER snapshot_items_reject_update")
                connection.execute(f"UPDATE snapshot_items SET {assignment}")
                with self.assertRaisesRegex(ValueError, label):
                    _validate_populated_rows(connection)
                connection.execute("ROLLBACK TO item_probe")
                connection.execute("RELEASE item_probe")

    def test_all_tables_are_strict_and_all_have_immutable_guards(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            definitions = dict(
                connection.execute("SELECT name, sql FROM sqlite_schema WHERE type = 'table'")
            )
            triggers = {
                name
                for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
            }
        for table in EXPECTED_TABLES:
            self.assertIn(" STRICT", definitions[table].upper())
            self.assertIn(f"{table}_reject_update", triggers)
            self.assertIn(f"{table}_reject_delete", triggers)
            self.assertIn(f"{table}_reject_replace", triggers)

    def test_schema_rejects_uppercase_and_non_hex_hashes(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for bad in ("A" * 64, "g" * 64, "a" * 63):
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "INSERT INTO schema_meta VALUES (2, 'append_only', ?)", (bad,)
                    )

    def test_schema_meta_fingerprint_matches_its_stored_value(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT schema_fingerprint_sha256 FROM schema_meta").fetchone()[0],
                schema_fingerprint(connection),
            )
            validate_schema(connection)

    def test_schema_excludes_inferred_ai_columns(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(repository_profiles)")
            }
        self.assertFalse({"is_ai", "ai_tag", "ai_related"} & columns)

    def test_empty_release_inventory_hash_contract_is_documented_in_schema(self):
        create_database(self.database)
        empty_hash = hashlib.sha256(b"[]").hexdigest()
        with closing(sqlite3.connect(self.database)) as connection:
            definition = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE type='table' AND name='snapshot_items'"
            ).fetchone()[0]
        self.assertIn(empty_hash, definition)

    def test_candidate_copy_requires_complete_parent_evidence_and_preserves_static_rows(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            connection.commit()
        evidence = parent_database_evidence(self.database)
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(self.database, candidate, evidence)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM schema_meta").fetchone()[0], 1)
        truncated = dict(evidence)
        truncated["tables"] = dict(evidence["tables"])
        truncated["tables"]["snapshot_runs"] = dict(evidence["tables"]["snapshot_runs"])
        truncated["tables"]["snapshot_runs"]["rows"] = []
        with self.assertRaisesRegex(ValueError, "row digest"):
            prepare_candidate_database(self.database, Path(self.temporary.name) / "bad.sqlite", truncated)

    def test_candidate_copy_rejects_parent_replaced_after_evidence_was_measured(self):
        create_database(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            complete_fixture(connection)
            connection.commit()
        evidence = parent_database_evidence(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            # A normal SQLite rewrite changes file evidence without weakening
            # the schema; the old parent receipt must still be rejected.
            connection.execute("VACUUM")
        with self.assertRaisesRegex(ValueError, "parent database evidence mismatch: file_sha256"):
            prepare_candidate_database(self.database, Path(self.temporary.name) / "replaced.sqlite", evidence)

    def test_first_snapshot_is_baseline_and_identical_next_run_still_appends(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        first["legacyBaselines"], first["legacyBaselineReceipt"] = baselines, receipt
        state = {}
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        second = writer_payload(snapshot_id="20260828030101-bbbbbbbbbbbbbbbb", utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00", stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id)
        second["legacyBaselines"], second["legacyBaselineReceipt"] = baselines, receipt
        record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (2,))
            self.assertEqual(connection.execute("SELECT membership_status FROM snapshot_items WHERE snapshot_seq=1").fetchone(), ("baseline_present",))
            self.assertEqual(connection.execute("SELECT membership_status FROM snapshot_items WHERE snapshot_seq=2").fetchone(), ("stayed",))

    def test_held_repository_records_sentinel_summary_digests_without_schema_change(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        payload, events = held_two_repository_inputs(readme_absent=False)
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = baselines, receipt
        record_writer_snapshot(candidate, payload, events, {})
        held_source = {"kind": "held", "slug": "owner/repo", "reason": "quality_defects", "schema_version": 3}
        with closing(sqlite3.connect(candidate)) as connection:
            row = connection.execute("SELECT summary_source_sha256, summary_content_sha256, summary_envelope_sha256, translation_status FROM snapshot_items WHERE slug = 'owner/repo'").fetchone()
            count = connection.execute("SELECT COUNT(*) FROM snapshot_items").fetchone()
        self.assertEqual(count, (2,))
        self.assertEqual(row, (
            canonical_hash(held_source),
            canonical_hash({"status": "held"}),
            canonical_hash({"content": {"status": "held"}, "source": held_source}),
            "not_applicable:no_prose",
        ))

    def test_held_repository_without_readme_records_no_readme_translation_status(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        payload, events = held_two_repository_inputs(readme_absent=True)
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = baselines, receipt
        record_writer_snapshot(candidate, payload, events, {})
        with closing(sqlite3.connect(candidate)) as connection:
            row = connection.execute("SELECT readme_status, translation_status, translation_source_sha256 FROM snapshot_items WHERE slug = 'owner/repo'").fetchone()
        self.assertEqual(row, ("absent", "not_applicable:no_readme", None))

    def test_enrichment_index_declared_held_ratio_must_match_its_entries(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        payload, events = held_two_repository_inputs(readme_absent=False)
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = baselines, receipt
        payload["enrichmentIndex"]["heldRatio"] = 0
        payload["enrichmentIndexSha256"] = canonical_hash(payload["enrichmentIndex"])
        with self.assertRaisesRegex(ValueError, "held ratio"):
            record_core_snapshot(candidate, payload, events, {})

    def test_enrichment_entry_with_unknown_status_is_rejected(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        payload = writer_payload(snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload["enrichmentIndex"]["owner/repo"]["status"] = "bogus"
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = baselines, receipt
        events = writer_events(head=sha1(), transition="baseline")
        bind_writer_inputs(payload, events)
        with self.assertRaisesRegex(ValueError, "entry status"):
            record_core_snapshot(candidate, payload, events, {})

    def test_enrichment_index_held_ratio_above_half_is_rejected_before_binding(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        payload = writer_payload(snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload["enrichmentIndex"] = {"owner/repo": {"status": "held", "held_reason": "request_failed", "defect_codes": [], "warnings": []}}
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = baselines, receipt
        events = writer_events(head=sha1(), transition="baseline")
        bind_writer_inputs(payload, events)
        payload["enrichmentIndex"]["heldRatio"] = 0.6
        payload["enrichmentIndexSha256"] = canonical_hash(payload["enrichmentIndex"])
        with self.assertRaisesRegex(ValueError, "held ratio"):
            record_core_snapshot(candidate, payload, events, {})
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_oss_estimates_preserve_value_change_tombstone_and_reappearance(self):
        candidate = Path(self.temporary.name) / "candidate.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-parent.sqlite", candidate, None)
        snapshots = [
            ("20260828010101-aaaaaaaaaaaaaaaa", "2026-08-28T01:01:01.001Z", "2026-08-28T10:01:01.001+09:00", "migration_baseline", None, "baseline", [{"date": "2026-08-20", "stars": 1}]),
            ("20260828030101-bbbbbbbbbbbbbbbb", "2026-08-28T03:01:01.001Z", "2026-08-28T12:01:01.001+09:00", "refresh", "20260828010101-aaaaaaaaaaaaaaaa", "unchanged", [{"date": "2026-08-20", "stars": 2}]),
            ("20260828050101-cccccccccccccccc", "2026-08-28T05:01:01.001Z", "2026-08-28T14:01:01.001+09:00", "refresh", "20260828030101-bbbbbbbbbbbbbbbb", "unchanged", []),
            ("20260828070101-dddddddddddddddd", "2026-08-28T07:01:01.001Z", "2026-08-28T16:01:01.001+09:00", "refresh", "20260828050101-cccccccccccccccc", "unchanged", [{"date": "2026-08-20", "stars": 1}]),
        ]
        baselines, receipt = writer_legacy_baselines(self.temporary.name)
        state = {}
        for snapshot_id, utc, kst, kind, parent, transition, estimates in snapshots:
            payload = writer_payload(snapshot_id=snapshot_id, utc=utc, kst=kst, stats_date="2026-08-28", run_kind=kind, parent_snapshot_id=parent)
            payload["legacyBaselines"] = baselines
            payload["legacyBaselineReceipt"] = receipt
            record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition=transition, estimate_rows=estimates), state)
        with closing(sqlite3.connect(candidate)) as connection:
            rows = connection.execute("SELECT is_present, stars FROM historical_star_estimates WHERE source='ossinsight_api' ORDER BY first_observed_snapshot_seq").fetchall()
        self.assertEqual(rows, [(1, 1), (1, 2), (0, None), (1, 1)])

    def test_reviewed_receipt_imports_nested_public_history_and_mismatch_rolls_back_baseline(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        write_legacy_public(paths["legacy_public_star_history"], {"version": 1, "generatedAt": "2026-08-28", "repositories": [{"slug": "owner/repo", "estimated": [{"date": "2026-08-21", "stars": 4}], "observed": [{"date": "2026-08-20", "stars": 3}]}]})
        receipt = measure_legacy_baseline_receipt(paths)
        candidate = Path(self.temporary.name) / "receipt.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM baseline_sources").fetchone(), (3,))
            self.assertEqual(connection.execute("SELECT source, slug, stars FROM historical_star_observations WHERE source='legacy_public_star_history'").fetchone(), ("legacy_public_star_history", "owner/repo", 3))
            self.assertEqual(connection.execute("SELECT source, slug, stars FROM historical_star_estimates WHERE source='legacy_star_history_cache'").fetchone(), ("legacy_star_history_cache", "owner/repo", 4))
        bad_candidate = Path(self.temporary.name) / "bad-receipt.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "another-missing.sqlite", bad_candidate, None)
        bad = json.loads(json.dumps(receipt)); bad["sources"]["legacy_public_star_history"]["logical_row_count"] += 1
        payload["legacyBaselineReceipt"] = bad
        with self.assertRaisesRegex(ValueError, "reviewed legacy receipt mismatch"):
            record_writer_snapshot(bad_candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(bad_candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_baseline_core_hash_binds_every_static_row_and_enrichment_summary(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        with closing(sqlite3.connect(paths["legacy_trending_membership"])) as connection:
            connection.execute("INSERT INTO snapshot_members VALUES (1, 0, 'Owner/Repo')")
            connection.commit()
        with closing(sqlite3.connect(paths["legacy_star_observations"])) as connection:
            connection.execute(
                "INSERT INTO star_observations VALUES (1, 'owner/repo', '2026-08-19', 2, 1, 'github_rest')"
            )
            connection.commit()
        write_legacy_public(paths["legacy_public_star_history"], {
            "version": 1,
            "generatedAt": "2026-08-28",
            "repositories": [{
                "slug": "owner/repo",
                "estimated": [{"date": "2026-08-21", "stars": 4}],
                "observed": [{"date": "2026-08-20", "stars": 3}],
            }],
        })
        receipt = measure_legacy_baseline_receipt(paths)
        candidate = Path(self.temporary.name) / "pinned-core.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        events = writer_events(
            head=sha1(), transition="baseline",
            estimate_rows=[{"date": "2026-08-22", "stars": 5}],
        )
        result = record_writer_snapshot(candidate, payload, events, {})

        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT slug FROM baseline_membership_slugs").fetchall(),
                [("owner/repo",)],
            )
            self.assertEqual(
                connection.execute("SELECT source, COUNT(*) FROM historical_star_observations GROUP BY source ORDER BY source").fetchall(),
                [("legacy_public_star_history", 1), ("legacy_star_observations_db", 1)],
            )
            entry = payload["enrichmentIndex"]["repositories"]["owner/repo"]
            source = entry["summary"]["source"]
            content = entry["summary"]["content"]
            hashes = connection.execute(
                "SELECT summary_source_sha256, summary_content_sha256, summary_envelope_sha256 FROM snapshot_items"
            ).fetchone()
            self.assertEqual(hashes, (
                canonical_hash(source), canonical_hash(content),
                canonical_hash({"content": content, "source": source}),
            ))
            self.assertEqual(verify_core_snapshot(connection, 1), result.core_payload_sha256)
        replay = Path(self.temporary.name) / "pinned-core-replay.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", replay, None)
        replay_result = record_writer_snapshot(
            replay,
            json.loads(json.dumps(payload)),
            json.loads(json.dumps(events)),
            {},
        )
        self.assertEqual(replay_result.core_payload_sha256, result.core_payload_sha256)

    def test_codex_summary_source_hashes_and_records_while_hybrids_fail_closed(self):
        codex_source = {
            "kind": "readme", "slug": "owner/repo", "path": "README.md",
            "blob_sha": sha1("b"), "content_sha256": sha256("c"),
            "provider": "codex-cli", "interface": "codex-exec", "cli_version": "0.151.0",
            "auth_method": "chatgpt_session", "api_provider": "openai_first_party",
            "model": "codex-cli/gpt-5.6-sol", "schema_version": 3, "prompt_schema_version": 3,
            "translation_applicable": False,
        }
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28",
            run_kind="migration_baseline",
            summary_source=codex_source,
        )
        hashes = ledger._enrichment_hashes(
            payload["repositories"][0],
            {"slug": "owner/repo"},
            payload["enrichmentIndex"],
        )
        content = payload["enrichmentIndex"]["owner/repo"]["summary"]["content"]
        self.assertEqual(hashes[:3], (
            canonical_hash(codex_source),
            canonical_hash(content),
            canonical_hash({"content": content, "source": codex_source}),
        ))

        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "codex-summary.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT summary_source_sha256 FROM snapshot_items").fetchone(),
                (canonical_hash(codex_source),),
            )

        claude_values = {
            "provider": "claude-cli-oauth",
            "interface": "claude-p",
            "auth_method": "oauth_token",
            "api_provider": "firstParty",
            "model": "claude-sonnet-5",
        }
        for field, value in claude_values.items():
            with self.subTest(field=field):
                hybrid_source = {**codex_source, field: value}
                hybrid = writer_payload(
                    snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
                    utc="2026-08-28T01:01:01.001Z",
                    kst="2026-08-28T10:01:01.001+09:00",
                    stats_date="2026-08-28",
                    run_kind="migration_baseline",
                    summary_source=hybrid_source,
                )
                with self.assertRaisesRegex(ValueError, "summary source"):
                    ledger._enrichment_hashes(
                        hybrid["repositories"][0],
                        {"slug": "owner/repo"},
                        hybrid["enrichmentIndex"],
                    )

    def test_summary_producer_rejects_non_ascii_and_non_string_semver(self):
        producer = {
            "provider": "codex-cli",
            "interface": "codex-exec",
            "cli_version": "0.151.0",
            "auth_method": "chatgpt_session",
            "api_provider": "openai_first_party",
            "model": "codex-cli/gpt-5.6-sol",
        }
        for label, version in (
                ("unicode_digits", "٠.١٥١.٠"),
                ("null", None),
                ("number", 151)):
            with self.subTest(label=label):
                self.assertFalse(ledger._supported_summary_producer({**producer, "cli_version": version}))

    def test_reused_profile_and_release_rows_are_part_of_refresh_core_hash(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        second_id = "20260828030101-bbbbbbbbbbbbbbbb"

        def snapshot(snapshot_id, utc, kind, parent=None):
            kst = f"{utc[:11]}{int(utc[11:13]) + 9:02d}{utc[13:-1]}+09:00"
            value = writer_payload(
                snapshot_id=snapshot_id, utc=utc,
                kst=kst,
                stats_date="2026-08-28", run_kind=kind,
                parent_snapshot_id=parent,
            )
            value["repositories"][0]["createdAt"] = "2026-08-28T01:01:01.001Z"
            value["legacyBaselines"], value["legacyBaselineReceipt"] = paths, receipt
            return value

        release = {
            "slug": "owner/repo", "releaseId": 7, "tagName": "v1", "name": "One",
            "targetCommitish": "main", "draft": False, "prerelease": False,
            "createdAt": "2026-08-28T01:01:01.001Z", "publishedAt": None,
            "htmlUrl": "https://github.com/owner/repo/releases/tag/v1",
        }
        release["metadataSha256"] = canonical_hash({
            "slug": "owner/repo", "release_id": 7, "tag_name": "v1", "name": "One",
            "target_commitish": "main", "draft": False, "prerelease": False,
            "created_at": "2026-08-28T01:01:01.001Z", "published_at": None,
            "html_url": "https://github.com/owner/repo/releases/tag/v1",
        })

        def events(transition):
            value = writer_events(head=sha1(), transition=transition)
            value["releases"] = [release]
            value["latestReleaseIds"] = {"owner/repo": 7}
            return value

        original = Path(self.temporary.name) / "reuse.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", original, None)
        state = {}
        first = snapshot(first_id, "2026-08-28T01:01:01.001Z", "migration_baseline")
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(original, first, events("baseline"), state)
        record_writer_snapshot(
            original,
            snapshot(second_id, "2026-08-28T03:01:01.001Z", "refresh", first_id),
            events("unchanged"), state,
        )

        clean = Path(self.temporary.name) / "reuse-clean.sqlite"
        mutated = Path(self.temporary.name) / "reuse-mutated.sqlite"
        shutil.copy2(original, clean)
        shutil.copy2(original, mutated)
        with closing(sqlite3.connect(mutated)) as connection:
            trigger_rows = connection.execute(
                "SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND name IN (?, ?)",
                ("repository_profiles_reject_update", "release_versions_reject_update"),
            ).fetchall()
            self.assertEqual(len(trigger_rows), 2)
            for name, _ in trigger_rows:
                connection.execute(f"DROP TRIGGER {name}")
            connection.execute("UPDATE repository_profiles SET captured_snapshot_seq=2 WHERE profile_id=1")
            connection.execute("UPDATE release_versions SET first_observed_snapshot_seq=2 WHERE release_id=7")
            for _, sql in trigger_rows:
                connection.execute(sql)
            connection.commit()

        third = snapshot(
            "20260828050101-cccccccccccccccc",
            "2026-08-28T05:01:01.001Z", "refresh", second_id,
        )
        clean_state = json.loads(json.dumps(state))
        mutated_state = json.loads(json.dumps(state))
        clean_result = record_writer_snapshot(clean, third, events("unchanged"), clean_state)
        mutated_result = record_writer_snapshot(mutated, third, events("unchanged"), mutated_state)
        self.assertNotEqual(clean_result.core_payload_sha256, mutated_result.core_payload_sha256)
        with closing(sqlite3.connect(mutated)) as connection:
            self.assertEqual(verify_core_snapshot(connection, 3), mutated_result.core_payload_sha256)

    def test_readme_state_survives_exit_and_reentry_records_real_change(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)

        def payload(snapshot_id, utc, kst, kind, parent, include_other, other_blob="b", other_content="c"):
            value = writer_payload(
                snapshot_id=snapshot_id, utc=utc, kst=kst, stats_date="2026-08-28",
                run_kind=kind, parent_snapshot_id=parent,
            )
            if include_other:
                repository = json.loads(json.dumps(value["repositories"][0]))
                repository.update({
                    "slug": "other/repo", "displaySlug": "other/repo", "displayRank": 2,
                    "rankDaily": 2, "readmePath": "README.md",
                    "readmeBlobSha": sha1(other_blob), "readmeContentSha256": sha256(other_content),
                    "readmeStatus": "present",
                })
                repository["provenance"]["readme"].update({
                    "status": "present", "path": "README.md", "blob_sha": sha1(other_blob),
                    "content_sha256": sha256(other_content),
                })
                repository["provenance"]["trending"]["daily"]["rank"] = 2
                value["repositories"].append(repository)
                source = {
                    "kind": "readme", "slug": "other/repo", "path": "README.md",
                    "blob_sha": sha1(other_blob), "content_sha256": sha256(other_content),
                    "provider": "claude-cli-oauth", "interface": "claude-p", "cli_version": "2.1.241",
                    "auth_method": "oauth_token", "api_provider": "firstParty",
                    "model": "claude-sonnet-5", "schema_version": 3, "prompt_schema_version": 3,
                    "translation_applicable": False,
                }
                value["enrichmentIndex"]["other/repo"] = {
                    "status": "verified",
                    "summary": {
                        "content": {"goal": "g", "usage": "u", "pros": "p", "cons": "c", "fit": "f"},
                        "source": source,
                    },
                    "translation": {"source": source, "markdown": "번역"},
                }
            value["legacyBaselines"], value["legacyBaselineReceipt"] = paths, receipt
            return value

        def events(active, transitions, heads=None, commits=None):
            heads = heads or {}
            return {
                "heads": [
                    {"slug": slug, "branch": "main", "headSha": heads.get(slug, sha1()), "transition": transitions[slug]}
                    for slug in active
                ],
                "releases": [], "latestReleaseIds": {slug: None for slug in active},
                "commits": commits or [],
                "estimates": [
                    {"slug": slug, "rows": [], "sourcePayloadSha256": sha256("b"), "publicRows": []}
                    for slug in active
                ],
            }

        candidate = Path(self.temporary.name) / "readme-reentry.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = payload(first_id, "2026-08-28T01:01:01.001Z", "2026-08-28T10:01:01.001+09:00", "migration_baseline", None, True)
        first["repositories"][1]["defaultBranchHeadSha"] = sha1("b")
        first["repositories"][1]["provenance"]["readme"]["variant_tree_api_path"] = f"/repos/other/repo/git/trees/{sha1('b')}"
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(
            candidate,
            first,
            events(
                ["owner/repo", "other/repo"],
                {"owner/repo": "baseline", "other/repo": "baseline"},
                {"other/repo": sha1("b")},
            ),
            state,
        )
        second_id = "20260828030101-bbbbbbbbbbbbbbbb"
        record_writer_snapshot(
            candidate,
            payload(second_id, "2026-08-28T03:01:01.001Z", "2026-08-28T12:01:01.001+09:00", "refresh", first_id, False),
            events(["owner/repo"], {"owner/repo": "unchanged"}), state,
        )
        third = payload("20260828050101-cccccccccccccccc", "2026-08-28T05:01:01.001Z", "2026-08-28T14:01:01.001+09:00", "refresh", second_id, True, "d", "e")
        third["repositories"][1]["defaultBranchHeadSha"] = sha1("d")
        third["repositories"][1]["provenance"]["readme"]["variant_tree_api_path"] = f"/repos/other/repo/git/trees/{sha1('d')}"
        with self.assertRaisesRegex(ValueError, "existing repository cannot use baseline"):
            record_writer_snapshot(
                candidate,
                json.loads(json.dumps(third)),
                events(
                    ["owner/repo", "other/repo"],
                    {"owner/repo": "unchanged", "other/repo": "baseline"},
                    {"other/repo": sha1("d")},
                ),
                state,
            )
        commit = {
            "slug": "other/repo", "sha": sha1("d"), "firstObservedOrdinal": 1,
            "branch": "main", "authoredAt": "2026-08-28T04:01:01.001Z",
            "committedAt": "2026-08-28T04:01:01.001Z", "authorLogin": "other",
            "parentShas": [sha1("b")],
            "htmlUrl": f"https://github.com/other/repo/commit/{sha1('d')}",
        }
        record_writer_snapshot(
            candidate,
            third,
            events(
                ["owner/repo", "other/repo"],
                {"owner/repo": "unchanged", "other/repo": "fast_forward"},
                {"other/repo": sha1("d")},
                [commit],
            ),
            state,
        )
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT snapshot_seq, membership_status FROM snapshot_items WHERE slug='other/repo' ORDER BY snapshot_seq").fetchall(),
                [(1, "baseline_present"), (3, "reentered")],
            )
            self.assertEqual(
                connection.execute("SELECT change_kind, old_blob_sha, new_blob_sha FROM readme_change_events WHERE snapshot_seq=3 AND slug='other/repo'").fetchone(),
                ("changed", sha1("b"), sha1("d")),
            )
            self.assertEqual(
                connection.execute("SELECT previous_default_branch_head_sha, head_transition FROM snapshot_items WHERE snapshot_seq=3 AND slug='other/repo'").fetchone(),
                (sha1("b"), "fast_forward"),
            )
        self.assertEqual(state["other/repo"]["previous"]["blob_sha"], sha1("b"))
        self.assertEqual(state["other/repo"]["current"]["blob_sha"], sha1("d"))

    def test_release_version_a_b_a_reuses_original_and_links_every_snapshot(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)

        def release(name):
            canonical = {
                "slug": "owner/repo", "release_id": 7, "tag_name": "v1", "name": name,
                "target_commitish": "main", "draft": False, "prerelease": False,
                "created_at": "2026-08-28T01:01:01.001Z", "published_at": None,
                "html_url": "https://github.com/owner/repo/releases/tag/v1",
            }
            return {
                "slug": canonical["slug"], "releaseId": canonical["release_id"],
                "tagName": canonical["tag_name"], "name": canonical["name"],
                "targetCommitish": canonical["target_commitish"], "draft": False,
                "prerelease": False, "createdAt": canonical["created_at"],
                "publishedAt": None, "htmlUrl": canonical["html_url"],
                "metadataSha256": canonical_hash(canonical),
            }

        def events(name, transition):
            value = writer_events(head=sha1(), transition=transition)
            value["releases"] = [release(name)]
            value["latestReleaseIds"] = {"owner/repo": 7}
            return value

        candidate = Path(self.temporary.name) / "release-aba.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        ids = [
            "20260828010101-aaaaaaaaaaaaaaaa",
            "20260828030101-bbbbbbbbbbbbbbbb",
            "20260828050101-cccccccccccccccc",
        ]
        times = [
            ("2026-08-28T01:01:01.001Z", "2026-08-28T10:01:01.001+09:00"),
            ("2026-08-28T03:01:01.001Z", "2026-08-28T12:01:01.001+09:00"),
            ("2026-08-28T05:01:01.001Z", "2026-08-28T14:01:01.001+09:00"),
        ]
        results = []
        for index, name in enumerate(("A", "B", "A")):
            payload = writer_payload(
                snapshot_id=ids[index], utc=times[index][0], kst=times[index][1],
                stats_date="2026-08-28", run_kind="migration_baseline" if index == 0 else "refresh",
                parent_snapshot_id=None if index == 0 else ids[index - 1],
            )
            if index == 0:
                payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            else:
                payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            results.append(record_writer_snapshot(candidate, payload, events(name, "baseline" if index == 0 else "unchanged"), state))
        hash_a = release("A")["metadataSha256"]
        hash_b = release("B")["metadataSha256"]
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT metadata_sha256, first_observed_snapshot_seq FROM release_versions ORDER BY first_observed_snapshot_seq").fetchall(),
                [(hash_a, 1), (hash_b, 2)],
            )
            self.assertEqual(
                connection.execute("SELECT snapshot_seq, metadata_sha256 FROM snapshot_release_items ORDER BY snapshot_seq").fetchall(),
                [(1, hash_a), (2, hash_b), (3, hash_a)],
            )
            self.assertEqual(verify_core_snapshot(connection, 3), results[2].core_payload_sha256)
        self.assertEqual(results[2].reused.get("release_versions"), 1)

    def test_renderer_verified_v1_manifest_bytes_sha_records_exactly(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "renderer-compatible.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-renderer.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        production_manifest_bytes = (
            b'{"version":1,"sourceSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",'
            b'"snapshotId":"20260828000101-bbbbbbbbbbbbbbbb","files":{}}\n'
        )
        production_manifest_sha = hashlib.sha256(production_manifest_bytes).hexdigest()
        payload["inputManifestSha256"] = production_manifest_sha
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt

        result = record_writer_snapshot(
            candidate, payload, writer_events(head=sha1(), transition="baseline"), {},
        )

        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT input_manifest_sha256 FROM snapshot_runs").fetchone(),
                (production_manifest_sha,),
            )
            self.assertEqual(verify_core_snapshot(connection, 1), result.core_payload_sha256)

    def test_production_manifest_status_sha_and_bootstrap_source_matrix(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        valid_modes = (
            ("verified_v1", sha256("1"), None),
            ("verified_v0", sha256("2"), None),
            ("verified_404", None, sha1()),
        )
        for index, (status, manifest_sha, bootstrap_source) in enumerate(valid_modes):
            with self.subTest(valid=status):
                candidate = Path(self.temporary.name) / f"manifest-valid-{index}.sqlite"
                prepare_candidate_database(Path(self.temporary.name) / f"missing-valid-{index}.sqlite", candidate, None)
                payload = writer_payload(
                    snapshot_id=f"20260828010{index + 1}01-{chr(97 + index) * 16}",
                    utc=f"2026-08-28T01:0{index + 1}:01.001Z",
                    kst=f"2026-08-28T10:0{index + 1}:01.001+09:00",
                    stats_date="2026-08-28", run_kind="migration_baseline",
                )
                payload["productionManifestStatus"] = status
                payload["inputManifestSha256"] = manifest_sha
                if bootstrap_source is not None:
                    payload["explicitBootstrapSourceSha"] = bootstrap_source
                payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
                record_writer_snapshot(
                    candidate, payload, writer_events(head=sha1(), transition="baseline"), {},
                )
                with closing(sqlite3.connect(candidate)) as connection:
                    self.assertEqual(
                        connection.execute("SELECT input_manifest_sha256 FROM snapshot_runs").fetchone(),
                        (manifest_sha,),
                    )

        private_marker = "do-not-" + "echo-production-evidence"
        invalid_modes = (
            ("verified_v1", None, None),
            ("verified_v0", None, None),
            ("verified_404", sha256("3"), sha1()),
            ("verified_404", None, None),
            ("verified_404", None, sha1("b")),
            ("verified_v1", sha256("4"), sha1()),
            (private_marker, sha256("5"), None),
            ("verified_v0", private_marker, None),
        )
        for index, (status, manifest_sha, bootstrap_source) in enumerate(invalid_modes):
            with self.subTest(invalid=index):
                candidate = Path(self.temporary.name) / f"manifest-invalid-{index}.sqlite"
                prepare_candidate_database(Path(self.temporary.name) / f"missing-invalid-{index}.sqlite", candidate, None)
                payload = writer_payload(
                    snapshot_id=f"20260828020{index + 1}01-{'abcdef0123456789'[index] * 16}",
                    utc=f"2026-08-28T02:{index + 1:02d}:01.001Z",
                    kst=f"2026-08-28T11:{index + 1:02d}:01.001+09:00",
                    stats_date="2026-08-28", run_kind="migration_baseline",
                )
                payload["productionManifestStatus"] = status
                payload["inputManifestSha256"] = manifest_sha
                if bootstrap_source is not None:
                    payload["explicitBootstrapSourceSha"] = bootstrap_source
                payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
                with self.assertRaises(ValueError) as raised:
                    record_writer_snapshot(
                        candidate, payload, writer_events(head=sha1(), transition="baseline"), {},
                    )
                self.assertNotIn(private_marker, str(raised.exception))
                self.assertNotIn(str(candidate), str(raised.exception))
                with closing(sqlite3.connect(candidate)) as connection:
                    self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_production_manifest_sha_aliases_must_be_exclusive(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        for index, alias_value in enumerate((sha256("b"), sha256())):
            with self.subTest(alias_value=alias_value):
                candidate = Path(self.temporary.name) / f"manifest-alias-{index}.sqlite"
                prepare_candidate_database(Path(self.temporary.name) / f"missing-alias-{index}.sqlite", candidate, None)
                payload = writer_payload(
                    snapshot_id=f"20260828030{index + 1}01-{'ab'[index] * 16}",
                    utc=f"2026-08-28T03:0{index + 1}:01.001Z",
                    kst=f"2026-08-28T12:0{index + 1}:01.001+09:00",
                    stats_date="2026-08-28", run_kind="migration_baseline",
                )
                payload["input_manifest_sha256"] = alias_value
                payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
                with self.assertRaisesRegex(ValueError, "production manifest SHA aliases"):
                    record_writer_snapshot(
                        candidate, payload, writer_events(head=sha1(), transition="baseline"), {},
                    )
                with closing(sqlite3.connect(candidate)) as connection:
                    self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_cross_input_bindings_reject_event_and_enrichment_drift(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        for label, mutation, message in (
            ("event-content", lambda payload, events: events["heads"][0].update({"headSha": sha1("c")}), "event payload does not bind"),
            ("enrichment-content", lambda payload, events: payload["enrichmentIndex"]["repositories"]["owner/repo"]["summary"]["content"].update({"goal": "drift"}), "snapshot input hash bindings"),
            ("event-source-set", lambda payload, events: events.update({"sourceSetSha256": sha256("8")}), "event payload does not bind"),
            ("enrichment-run-context", lambda payload, events: payload["enrichmentIndex"].update({"runContextSha256": sha256("8")}), "enrichment index does not bind"),
            ("snapshot-run-context", lambda payload, events: payload.update({"runContextSha256": sha256("8")}), "snapshot run context"),
        ):
            candidate = Path(self.temporary.name) / f"binding-{label}.sqlite"
            prepare_candidate_database(Path(self.temporary.name) / f"missing-{label}.sqlite", candidate, None)
            payload = writer_payload(
                snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
                utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
                stats_date="2026-08-28", run_kind="migration_baseline",
            )
            payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            events = writer_events(head=sha1(), transition="baseline")
            bind_writer_inputs(payload, events)
            mutation(payload, events)
            with self.assertRaisesRegex(ValueError, message):
                record_core_snapshot(candidate, payload, events, {})
            with closing(sqlite3.connect(candidate)) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_strict_event_allowlists_reject_duplicate_slug_and_hostile_release_url(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        for label, mutate, message in (
            ("duplicate", lambda events: events["heads"].append(dict(events["heads"][0])), "duplicate"),
            ("extra", lambda events: events["heads"][0].update({"message": "forbidden"}), "exact allowlist"),
            ("url", lambda events: events.update({
                "releases": [{
                    "slug": "owner/repo", "releaseId": 7, "tagName": "v1", "name": None,
                    "targetCommitish": "main", "draft": False, "prerelease": False,
                    "createdAt": "2026-08-28T01:01:01.001Z", "publishedAt": None,
                    "htmlUrl": "https://evil.example/owner/repo/releases/tag/v1",
                    "metadataSha256": sha256("a"),
                }], "latestReleaseIds": {"owner/repo": 7},
            }), "release URL"),
        ):
            candidate = Path(self.temporary.name) / f"event-{label}.sqlite"
            prepare_candidate_database(Path(self.temporary.name) / f"missing-{label}.sqlite", candidate, None)
            payload = writer_payload(
                snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
                utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
                stats_date="2026-08-28", run_kind="migration_baseline",
            )
            payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            events = writer_events(head=sha1(), transition="baseline")
            mutate(events)
            bind_writer_inputs(payload, events)
            with self.assertRaisesRegex(ValueError, message):
                record_core_snapshot(candidate, payload, events, {})

    def test_event_maps_accept_github_slug_case_but_keep_casefolded_duplicate_rejection(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "event-case.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing-event-case.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        payload["repositories"][0]["createdAt"] = "2026-08-28T01:01:01Z"
        payload["repositories"][0]["updatedAt"] = "2026-08-28T01:01:02Z"
        payload["repositories"][0]["pushedAt"] = "2026-08-28T01:01:03Z"
        events = writer_events(head=sha1(), transition="baseline")
        events["heads"][0]["slug"] = "Owner/Repo"
        events["estimates"][0]["slug"] = "Owner/Repo"
        release = {
            "slug": "owner/repo", "release_id": 7, "tag_name": "v1", "name": None,
            "target_commitish": "main", "draft": False, "prerelease": False,
            "created_at": "2026-08-28T01:01:01.001Z", "published_at": None,
            "html_url": "https://github.com/Owner/Repo/releases/tag/v1",
        }
        events["releases"] = [{
            "slug": release["slug"], "releaseId": release["release_id"],
            "tagName": release["tag_name"], "name": release["name"],
            "targetCommitish": release["target_commitish"], "draft": release["draft"],
            "prerelease": release["prerelease"], "createdAt": release["created_at"],
            "publishedAt": release["published_at"], "htmlUrl": release["html_url"],
            "metadataSha256": canonical_hash(release),
        }]
        events["latestReleaseIds"] = {"owner/repo": 7}
        bind_writer_inputs(payload, events)

        result = record_core_snapshot(candidate, payload, events, {})

        self.assertEqual(result.snapshot_seq, 1)

    def test_post_append_preserves_exact_rows_in_all_fourteen_tables(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "all-table-prefix.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        insight = {
            "snapshot_seq": 1, "slug": "owner/repo", "previous_observed_snapshot_seq": None,
            "observation_gap_milliseconds": None, "stars_delta_since_previous_observation": None,
            "display_rank_delta": None, "rank_daily_delta": None, "rank_weekly_delta": None,
            "rank_monthly_delta": None, "insight_rule_version": "repository-insight-v1",
        }
        with closing(sqlite3.connect(candidate)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("INSERT INTO repository_insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*insight.values(), canonical_hash(insight)))
            for artifact_path in PAGES_BASE_ARTIFACT_PATHS:
                connection.execute("INSERT INTO artifact_hashes VALUES (1, ?, ?, 1)", (artifact_path, sha256("a")))
            connection.commit()
            before = {
                table: connection.execute(f"SELECT * FROM {table}").fetchall()
                for table in EXPECTED_TABLES
            }
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with closing(sqlite3.connect(candidate)) as connection:
            for table, expected_rows in before.items():
                actual = connection.execute(f"SELECT * FROM {table}").fetchall()
                for row in expected_rows:
                    self.assertIn(row, actual, table)

    def test_legacy_receipt_rejects_symlink_sidecar_and_semantic_drift(self):
        paths, _ = writer_legacy_baselines(self.temporary.name)
        star = Path(paths["legacy_star_observations"])
        sidecar = Path(f"{star}-wal")
        sidecar.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "pending sidecar"):
            measure_legacy_baseline_receipt(paths)
        sidecar.unlink()
        with mock.patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaisesRegex(ValueError, "source is missing"):
                measure_legacy_baseline_receipt(paths)
        write_legacy_public(paths["legacy_public_star_history"], {
            "version": 1,
            "generatedAt": "2026-08-28",
            "repositories": [{"slug": "owner/repo", "estimated": [], "observed": [{"date": "2026-02-30", "stars": 1}]}],
        })
        with self.assertRaisesRegex(ValueError, "exact date"):
            measure_legacy_baseline_receipt(paths)

    def test_refresh_remeasures_all_frozen_baseline_logical_rows(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "refresh-baseline.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        write_legacy_public(paths["legacy_public_star_history"], {
            "version": 1,
            "generatedAt": "2026-08-28",
            "repositories": [{"slug": "owner/repo", "estimated": [], "observed": []}],
        })
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        with self.assertRaisesRegex(ValueError, "reviewed legacy receipt mismatch"):
            record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (1,))

    def test_legacy_sources_are_remeasured_inside_transaction_immediately_before_commit(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "legacy-final-remeasure.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        original = ledger._project_commit_rows

        def mutate_after_projection(*args, **kwargs):
            rows = original(*args, **kwargs)
            write_legacy_public(paths["legacy_public_star_history"], {
                "version": 1,
                "generatedAt": "2026-08-28",
                "repositories": [{"slug": "owner/repo", "estimated": [], "observed": []}],
            })
            return rows

        with mock.patch.object(ledger, "_project_commit_rows", side_effect=mutate_after_projection):
            with self.assertRaisesRegex(ValueError, "legacy baseline source changed before commit"):
                record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (0,))

    def test_fast_forward_commit_chain_must_reach_previous_head(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "commit-gap.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1("a"), transition="baseline"), state)
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        second["repositories"][0]["defaultBranchHeadSha"] = sha1("b")
        second["repositories"][0]["provenance"]["readme"]["variant_tree_api_path"] = f"/repos/owner/repo/git/trees/{sha1('b')}"
        events = writer_events(head=sha1("b"), transition="fast_forward")
        events["commits"] = [{
            "slug": "owner/repo", "sha": sha1("b"), "firstObservedOrdinal": 1,
            "branch": "main", "authoredAt": "2026-08-28T02:01:01.001Z",
            "committedAt": "2026-08-28T02:01:01.001Z", "authorLogin": "owner",
            "parentShas": [sha1("c")],
            "htmlUrl": f"https://github.com/owner/repo/commit/{sha1('b')}",
        }]
        with self.assertRaisesRegex(ValueError, "does not reach previous head"):
            record_writer_snapshot(candidate, second, events, state)
        events["commits"][0]["parentShas"] = [sha1("a")]
        result = record_writer_snapshot(candidate, second, events, state)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(
                connection.execute("SELECT commit_sha, first_observed_ordinal FROM commit_events").fetchone(),
                (sha1("b"), 1),
            )
            self.assertEqual(verify_core_snapshot(connection, 2), result.core_payload_sha256)

    def test_fast_forward_rejects_supplied_commit_outside_current_to_prior_graph(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "commit-side-branch.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1("a"), transition="baseline"), state)
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        second["repositories"][0]["defaultBranchHeadSha"] = sha1("b")
        second["repositories"][0]["provenance"]["readme"]["variant_tree_api_path"] = f"/repos/owner/repo/git/trees/{sha1('b')}"
        events = writer_events(head=sha1("b"), transition="fast_forward")
        events["commits"] = [
            {
                "slug": "owner/repo", "sha": sha1("b"), "firstObservedOrdinal": 1,
                "branch": "main", "authoredAt": "2026-08-28T02:01:01.001Z",
                "committedAt": "2026-08-28T02:01:01.001Z", "authorLogin": "owner",
                "parentShas": [sha1("a")],
                "htmlUrl": f"https://github.com/owner/repo/commit/{sha1('b')}",
            },
            {
                "slug": "owner/repo", "sha": sha1("c"), "firstObservedOrdinal": 2,
                "branch": "main", "authoredAt": "2026-08-28T01:31:01.001Z",
                "committedAt": "2026-08-28T01:31:01.001Z", "authorLogin": "owner",
                "parentShas": [sha1("d")],
                "htmlUrl": f"https://github.com/owner/repo/commit/{sha1('c')}",
            },
        ]
        with self.assertRaisesRegex(ValueError, "outside current-to-previous graph"):
            record_writer_snapshot(candidate, second, events, state)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (1,))

    def test_refresh_core_references_frozen_baseline_rows(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "refresh-core-baselines.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with closing(sqlite3.connect(candidate)) as connection:
            trigger = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='baseline_sources_reject_update'"
            ).fetchone()[0]
            connection.execute("DROP TRIGGER baseline_sources_reject_update")
            connection.execute("UPDATE baseline_sources SET byte_size=byte_size+1 WHERE source_name='legacy_public_star_history'")
            connection.execute(trigger)
            connection.commit()
            with self.assertRaisesRegex(ValueError, "core payload hash preimage mismatch for snapshot 2"):
                verify_core_snapshot(connection, 2)

    def test_candidate_copy_uses_exact_capture_when_source_appends_after_capture(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        parent = Path(self.temporary.name) / "racing-parent.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", parent, None)
        state = {}
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(parent, first, writer_events(head=sha1(), transition="baseline"), state)
        reviewed = parent_database_evidence(parent)
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        original_capture = ledger._capture_parent_database

        def capture_then_append(source, expected_snapshot_seq=None):
            captured = original_capture(source, expected_snapshot_seq)
            record_writer_snapshot(parent, second, writer_events(head=sha1(), transition="unchanged"), state)
            return captured

        candidate = Path(self.temporary.name) / "racing-candidate.sqlite"
        with mock.patch.object(ledger, "_capture_parent_database", side_effect=capture_then_append):
            prepare_candidate_database(parent, candidate, reviewed)
        with closing(sqlite3.connect(parent)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (2,))
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (1,))

    def test_independent_core_verifier_detects_post_write_row_mutation(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "core-verifier.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(candidate)) as connection:
            trigger = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='snapshot_items_reject_update'"
            ).fetchone()[0]
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET stars=stars+1 WHERE snapshot_seq=1")
            connection.execute(trigger)
            connection.commit()
            self.assertEqual(schema_fingerprint(connection), PINNED_SCHEMA_FINGERPRINT)
            with self.assertRaisesRegex(ValueError, "core payload hash preimage mismatch for snapshot 1"):
                verify_core_snapshot(connection, 1)

    def test_same_snapshot_id_is_exact_noop_but_changed_fact_conflicts(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "no-op.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(snapshot_id="20260828010101-aaaaaaaaaaaaaaaa", utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28", run_kind="migration_baseline")
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        events = writer_events(head=sha1(), transition="baseline")
        state = {}
        first = record_writer_snapshot(candidate, payload, events, state)
        replay = record_writer_snapshot(candidate, payload, events, state)
        self.assertEqual(replay.snapshot_seq, first.snapshot_seq)
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (1,))
        changed = json.loads(json.dumps(payload)); changed["repositories"][0]["stars"] = 99
        with self.assertRaisesRegex(ValueError, "conflicting core payload"):
            record_writer_snapshot(candidate, changed, events, state)

    def test_same_snapshot_replay_verifies_stored_core_before_noop(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "corrupt-replay.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        events = writer_events(head=sha1(), transition="baseline")
        state = {}
        record_writer_snapshot(candidate, payload, events, state)
        with closing(sqlite3.connect(candidate)) as connection:
            trigger = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='snapshot_items_reject_update'"
            ).fetchone()[0]
            connection.execute("DROP TRIGGER snapshot_items_reject_update")
            connection.execute("UPDATE snapshot_items SET stars=stars+1 WHERE snapshot_seq=1")
            connection.execute(trigger)
            connection.commit()
        with self.assertRaisesRegex(ValueError, "core payload hash preimage mismatch for snapshot 1"):
            record_writer_snapshot(candidate, payload, events, state)

    def test_non_latest_snapshot_id_replay_fails_closed(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "old-replay.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        first_id = "20260828010101-aaaaaaaaaaaaaaaa"
        first = writer_payload(
            snapshot_id=first_id, utc="2026-08-28T01:01:01.001Z",
            kst="2026-08-28T10:01:01.001+09:00", stats_date="2026-08-28",
            run_kind="migration_baseline",
        )
        first["legacyBaselines"], first["legacyBaselineReceipt"] = paths, receipt
        state = {}
        record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), state)
        first_state = json.loads(json.dumps(state))
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh", parent_snapshot_id=first_id,
        )
        second["legacyBaselines"], second["legacyBaselineReceipt"] = paths, receipt
        record_writer_snapshot(candidate, second, writer_events(head=sha1(), transition="unchanged"), state)
        with self.assertRaisesRegex(ValueError, "replay must be the current latest snapshot"):
            record_writer_snapshot(candidate, first, writer_events(head=sha1(), transition="baseline"), first_state)

    def test_cli_parent_evidence_envelope_carries_reviewed_legacy_receipt(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        events = writer_events(head=sha1(), transition="baseline")
        bind_writer_inputs(payload, events)
        index = payload.pop("enrichmentIndex")
        root = Path(self.temporary.name)
        files = {
            "snapshot": root / "cli-snapshot.json",
            "events": root / "cli-events.json",
            "index": root / "cli-index.json",
            "evidence": root / "cli-evidence.json",
        }
        files["snapshot"].write_text(json.dumps(payload), encoding="utf-8")
        files["events"].write_text(json.dumps(events), encoding="utf-8")
        files["index"].write_text(json.dumps(index), encoding="utf-8")
        files["evidence"].write_text(json.dumps({
            "version": 1,
            "parent_database": {"missing": True},
            "production_source_sha": payload["hydrationSourceSha"],
            "historical_heads": historical_heads_receipt(),
            "legacy_baseline_receipt": receipt,
        }), encoding="utf-8")

        def arguments(evidence_path, candidate, parent=None):
            return [
                "--parent-database", str(parent or root / "missing-parent.sqlite"),
                "--candidate-database", str(candidate),
                "--snapshot", str(files["snapshot"]),
                "--events", str(files["events"]),
                "--enrichment-index", str(files["index"]),
                "--parent-evidence", str(evidence_path),
                "--legacy-star-database", paths["legacy_star_observations"],
                "--legacy-membership-database", paths["legacy_trending_membership"],
                "--legacy-public-star-history", paths["legacy_public_star_history"],
                "--readme-state", str(root / "cli-readme-state.json"),
            ]

        first_candidate = root / "cli-candidate.sqlite"
        with mock.patch("sys.stdout"):
            self.assertEqual(ledger.main(arguments(files["evidence"], first_candidate)), 0)
        second = writer_payload(
            snapshot_id="20260828030101-bbbbbbbbbbbbbbbb",
            utc="2026-08-28T03:01:01.001Z", kst="2026-08-28T12:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="refresh",
            parent_snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
        )
        second_events = writer_events(head=sha1(), transition="unchanged")
        bind_writer_inputs(second, second_events)
        second_index = second.pop("enrichmentIndex")
        files["snapshot"].write_text(json.dumps(second), encoding="utf-8")
        files["events"].write_text(json.dumps(second_events), encoding="utf-8")
        files["index"].write_text(json.dumps(second_index), encoding="utf-8")
        files["evidence"].write_text(json.dumps({
            "version": 1,
            "parent_database": parent_database_evidence(first_candidate),
            "production_source_sha": second["hydrationSourceSha"],
            "historical_heads": ledger.measure_historical_heads(first_candidate)[0],
            "legacy_baseline_receipt": receipt,
        }), encoding="utf-8")
        refresh_candidate = root / "cli-refresh-candidate.sqlite"
        with mock.patch("sys.stdout"):
            self.assertEqual(ledger.main(arguments(files["evidence"], refresh_candidate, first_candidate)), 0)
        with closing(sqlite3.connect(refresh_candidate)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM snapshot_runs").fetchone(), (2,))
        stale_heads = json.loads(files["evidence"].read_text(encoding="utf-8"))
        stale_heads["historical_heads"]["heads_sha256"] = "0" * 64
        stale_path = root / "cli-evidence-stale-heads.json"
        stale_path.write_text(json.dumps(stale_heads), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "historical head evidence mismatch"):
            ledger.main(arguments(stale_path, root / "cli-candidate-stale-heads.sqlite", first_candidate))
        wrong_source = json.loads(files["evidence"].read_text(encoding="utf-8"))
        wrong_source["production_source_sha"] = sha1("f")
        wrong_source_path = root / "cli-evidence-wrong-production-source.json"
        wrong_source_path.write_text(json.dumps(wrong_source), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "hydration source does not match parent evidence"):
            ledger.main(arguments(wrong_source_path, root / "cli-candidate-wrong-production-source.sqlite", first_candidate))
        for label, envelope in (
            ("alias", {"version": 1, "parentEvidence": {"missing": True}, "legacy_baseline_receipt": receipt}),
            ("extra", {"version": 1, "parent_database": {"missing": True}, "production_source_sha": sha1(), "historical_heads": historical_heads_receipt(), "legacy_baseline_receipt": receipt, "receipt": receipt}),
        ):
            evidence_path = root / f"cli-evidence-{label}.json"
            evidence_path.write_text(json.dumps(envelope), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "parent evidence envelope fields are not the exact allowlist"):
                ledger.main(arguments(evidence_path, root / f"cli-candidate-{label}.sqlite"))

    def test_cli_rejects_resolved_path_aliases_and_tracked_readme_state(self):
        arguments, _, state = writer_cli_case(
            self.temporary.name, candidate_name="same-path.json", state_name="same-path.json",
        )
        with self.assertRaisesRegex(ValueError, "CLI paths must not alias"):
            ledger.main(arguments)
        self.assertFalse(state.exists())

        args = mock.Mock()
        root = Path(ledger.__file__).resolve().parents[1]
        unique = [Path(self.temporary.name) / f"input-{index}" for index in range(9)]
        (
            args.parent_database, args.candidate_database, args.snapshot, args.events,
            args.enrichment_index, args.parent_evidence, args.legacy_star_database,
            args.legacy_membership_database, args.legacy_public_star_history,
        ) = map(str, unique)
        args.readme_state = str(root / "data" / "readme-state.json")
        with self.assertRaisesRegex(ValueError, "tracked readme state"):
            ledger._validate_cli_paths(args)

    def test_cli_state_write_is_atomic_and_removes_new_candidate_on_failure(self):
        arguments, candidate, state = writer_cli_case(self.temporary.name)
        original_state = b"{}\n"
        state.write_bytes(original_state)
        with mock.patch.object(ledger, "_write_state_atomically", create=True, side_effect=OSError("private path")):
            with self.assertRaisesRegex(ValueError, "README state candidate write failed"):
                ledger.main(arguments)
        self.assertEqual(state.read_bytes(), original_state)
        self.assertFalse(candidate.exists())
        for suffix in ("-journal", "-wal", "-shm"):
            self.assertFalse(Path(f"{candidate}{suffix}").exists())

    def test_cli_record_failure_removes_candidate_and_allows_same_path_retry(self):
        for label in ("state", "fact"):
            root = Path(self.temporary.name) / label
            root.mkdir()
            arguments, candidate, state = writer_cli_case(root)
            state.write_text(
                json.dumps({"owner/repo": {"invalid": True}}) if label == "state" else "{}",
                encoding="utf-8",
            )
            original_state = state.read_bytes()
            snapshot_path = root / "snapshot.json"
            if label == "fact":
                payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
                events = json.loads((root / "events.json").read_text(encoding="utf-8"))
                payload["enrichmentIndex"] = json.loads((root / "index.json").read_text(encoding="utf-8"))
                payload["repositories"][0]["archived"] = 0
                bind_writer_inputs(payload, events)
                index = payload.pop("enrichmentIndex")
                snapshot_path.write_text(json.dumps(payload), encoding="utf-8")
                (root / "events.json").write_text(json.dumps(events), encoding="utf-8")
                (root / "index.json").write_text(json.dumps(index), encoding="utf-8")
            with self.assertRaises(ValueError):
                ledger.main(arguments)
            self.assertEqual(state.read_bytes(), original_state)
            self.assertFalse(candidate.exists())
            for suffix in ("-journal", "-wal", "-shm"):
                self.assertFalse(Path(f"{candidate}{suffix}").exists())

            if label == "state":
                state.write_text("{}", encoding="utf-8")
            else:
                payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
                events = json.loads((root / "events.json").read_text(encoding="utf-8"))
                payload["enrichmentIndex"] = json.loads((root / "index.json").read_text(encoding="utf-8"))
                payload["repositories"][0]["archived"] = False
                bind_writer_inputs(payload, events)
                index = payload.pop("enrichmentIndex")
                snapshot_path.write_text(json.dumps(payload), encoding="utf-8")
                (root / "events.json").write_text(json.dumps(events), encoding="utf-8")
                (root / "index.json").write_text(json.dumps(index), encoding="utf-8")
            with mock.patch("sys.stdout"):
                self.assertEqual(ledger.main(arguments), 0)
            self.assertTrue(candidate.is_file())

    def test_repository_fact_requires_one_exact_collector_or_camel_shape(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        mutations = (
            ("extra", lambda fact: fact.update({"attackerBody": "must not be ignored"}), "exact allowlist"),
            ("missing", lambda fact: fact.pop("topics"), "exact allowlist"),
            ("mixed", lambda fact: fact.update({"default_branch": fact.pop("defaultBranch")}), "exact allowlist"),
            ("bool", lambda fact: fact.update({"archived": 0}), "archived must be a boolean"),
            ("provenance", lambda fact: fact["provenance"]["repository"].update({"body": "must not be ignored"}), "provenance fields"),
        )
        for label, mutate, message in mutations:
            candidate = Path(self.temporary.name) / f"fact-{label}.sqlite"
            prepare_candidate_database(Path(self.temporary.name) / f"missing-{label}.sqlite", candidate, None)
            payload = writer_payload(
                snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
                utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
                stats_date="2026-08-28", run_kind="migration_baseline",
            )
            payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
            mutate(payload["repositories"][0])
            with self.assertRaisesRegex(ValueError, message):
                record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})

    def test_repository_fact_accepts_the_exact_task2_snake_shape(self):
        paths, receipt = writer_legacy_baselines(self.temporary.name)
        candidate = Path(self.temporary.name) / "collector-snake.sqlite"
        prepare_candidate_database(Path(self.temporary.name) / "missing.sqlite", candidate, None)
        payload = writer_payload(
            snapshot_id="20260828010101-aaaaaaaaaaaaaaaa",
            utc="2026-08-28T01:01:01.001Z", kst="2026-08-28T10:01:01.001+09:00",
            stats_date="2026-08-28", run_kind="migration_baseline",
        )
        camel_to_snake = {
            "createdAt": "created_at", "defaultBranch": "default_branch",
            "defaultBranchHeadSha": "default_branch_head_sha", "displayRank": "display_rank",
            "displaySlug": "display_slug", "fieldTags": "field_tags", "formTags": "form_tags",
            "gainDaily": "gain_daily", "gainMonthly": "gain_monthly", "gainWeekly": "gain_weekly",
            "isFork": "is_fork", "languageColor": "language_color", "licenseSpdx": "license_spdx",
            "openIssuesAndPullRequests": "open_issues_and_pull_requests", "primaryLanguage": "primary_language",
            "readmeBlobSha": "readme_blob_sha", "readmeContentSha256": "readme_content_sha256",
            "readmeLocale": "readme_locale", "readmePath": "readme_path", "readmeStatus": "readme_status",
            "readmeVariants": "readme_variants", "pushedAt": "pushed_at",
            "rankDaily": "rank_daily", "rankMonthly": "rank_monthly", "rankWeekly": "rank_weekly",
            "tagRuleVersion": "tag_rule_version", "updatedAt": "updated_at", "watchersCount": "watchers_count",
        }
        fact = payload["repositories"][0]
        payload["repositories"] = [{camel_to_snake.get(key, key): value for key, value in fact.items()}]
        payload["repositories"][0]["display_slug"] = "owner / repo"
        payload["legacyBaselines"], payload["legacyBaselineReceipt"] = paths, receipt
        result = record_writer_snapshot(candidate, payload, writer_events(head=sha1(), transition="baseline"), {})
        with closing(sqlite3.connect(candidate)) as connection:
            self.assertEqual(connection.execute("SELECT display_slug FROM repository_profiles").fetchone(), ("owner/repo",))
            self.assertEqual(verify_core_snapshot(connection, 1), result.core_payload_sha256)

    def test_cli_requires_every_candidate_and_frozen_source_input(self):
        result = subprocess.run(
            [sys.executable, "scripts/record_repository_observations.py"],
            cwd=Path(__file__).resolve().parents[1], text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 2)
        for option in ("--parent-database", "--candidate-database", "--snapshot", "--events", "--enrichment-index", "--parent-evidence", "--legacy-star-database", "--legacy-membership-database", "--legacy-public-star-history", "--readme-state"):
            self.assertIn(option, result.stderr)


if __name__ == "__main__":
    unittest.main()
