import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/star-ticks.yml";
const refreshPath = ".github/workflows/daily-refresh.yml";
const deployPath = ".github/workflows/deploy-current-pages.yml";

async function text(path) {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

function assertInOrder(value, fragments) {
  let cursor = 0;
  for (const fragment of fragments) {
    const next = value.indexOf(fragment, cursor);
    assert.ok(next >= 0, `missing or out-of-order fragment: ${fragment}`);
    cursor = next + fragment.length;
  }
}

test("star ticks run every half hour behind the GH_TRENDING_TICKS variable and share the refresh concurrency group", async () => {
  const [workflow, refresh] = await Promise.all([text(workflowPath), text(refreshPath)]);
  assert.match(workflow, /^name: Star ticks$/m);
  assert.match(workflow, /^on:\n  schedule:\n    - cron: "5,35 \* \* \* \*"\n  workflow_dispatch:/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'schedule' && vars\.GH_TRENDING_TICKS == 'enabled'\) \}\}/);
  const concurrency = /^concurrency:\n  group: ([^\n]+)\n  cancel-in-progress: false$/m;
  assert.equal(workflow.match(concurrency)?.[1], "daily-refresh");
  assert.equal(refresh.match(concurrency)?.[1], "daily-refresh");
  assert.match(refresh, /vars\.GH_TRENDING_REFRESH_SCHEDULE == 'enabled'/);
  assert.match(workflow, /^      contents: write\n      pages: write\n      id-token: write$/m);
  assert.match(workflow, /timeout-minutes: 20/);
  // The job also serializes with the redeploy workflow on the Pages group.
  assert.match(workflow, /\n    concurrency:\n      group: pages\n      cancel-in-progress: false\n/);
});

test("star ticks collect with the repository token only, pick the tier from the clock, and commit only the three ledger paths", async () => {
  const workflow = await text(workflowPath);
  const secrets = [...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(match => match[1]);
  assert.ok(secrets.length > 0);
  assert.deepEqual([...new Set(secrets)], ["GITHUB_TOKEN"]);
  assert.doesNotMatch(workflow, /ANTHROPIC|CLAUDE|CODEX|update-trending|generate-summary-bundles|collect-repository-events|record_repository_observations|self-hosted/);
  assert.match(workflow, /git fetch origin main[\s\S]*git rev-parse HEAD[\s\S]*refs\/remotes\/origin\/main/);
  assert.match(workflow, /TIER="\$\(node scripts\/star-ticks\.mjs tier --event "\$GITHUB_EVENT_NAME" --requested "\$REQUESTED_TIER"\)"/);
  assert.doesNotMatch(workflow, /TIER=ab|date -u \+%H/);
  // Independent append-only check on the staged ledgers before the commit.
  assert.match(workflow, /REMOVED="\$\(git diff --cached -- data\/star-ticks data\/star-daily\.jsonl \| grep -E '\^-\[\^-\]' \|\| true\)"\n\s+if \[ -n "\$REMOVED" \]; then/);
  assert.doesNotMatch(workflow, /grep -qE '\^-\[\^-\]'/);
  assert.match(workflow, /star-ticks\.mjs collect --token-env GITHUB_TOKEN --tier "\$TIER" --published data\/latest\.json --ticks-dir data\/star-ticks --daily data\/star-daily\.jsonl --run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(workflow, /star-ticks\.mjs derive --published data\/latest\.json --ticks-dir data\/star-ticks --daily data\/star-daily\.jsonl --anchors data\/star-anchors\.json --out star-history\.json/);
  assert.match(workflow, /case "\$changed_path" in\n\s+data\/star-ticks\/\*\.jsonl\|data\/star-daily\.jsonl\|star-history\.json\) ;;\n\s+\*\) echo "::error::Unexpected star tick output: \$changed_path"; exit 1 ;;/);
  assert.match(workflow, /git add -- data\/star-ticks data\/star-daily\.jsonl star-history\.json/);
  assert.match(workflow, /git diff --cached --check/);
  assert.match(workflow, /git grep --cached -qE '\(sk-ant-/);
  assert.match(workflow, /git commit -q -m "chore: star ticks \$\{TICK_UTC\}"/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.doesNotMatch(workflow, /--force|reset --hard/);
});

test("star ticks deploy the committed tree through the same contract-checked builder and probes as the redeploy workflow", async () => {
  const [workflow, deploy] = await Promise.all([text(workflowPath), text(deployPath)]);
  for (const action of ["actions/checkout@", "actions/setup-node@", "actions/setup-python@", "actions/upload-pages-artifact@", "actions/deploy-pages@"]) {
    const pinned = deploy.match(new RegExp(`${action.replace("/", "\\/")}([a-f0-9]{40})`))?.[1];
    assert.ok(pinned, `deploy workflow pin missing for ${action}`);
    assert.match(workflow, new RegExp(`${action.replace("/", "\\/")}${pinned}`));
  }
  assert.match(workflow, /node scripts\/observation-db-store\.mjs resolve --source-sha "\$\(git rev-parse HEAD\)" --check \|\| \{ echo "::error::star ticks require the version-1 repository database"; exit 1; \}/);
  assert.match(workflow, /- name: Resolve observation database[\s\S]*rm -f "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"[\s\S]*observation-db-store\.mjs resolve --source-sha "\$SOURCE_SHA" --expect-snapshot-id "\$SNAPSHOT_ID" --out "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"/);
  assert.doesNotMatch(workflow, /GH_TOKEN:/);
  // the throwaway release-tag override belongs to the dispatch-only pre-flight workflow alone.
  assert.doesNotMatch(workflow, /OBSERVATION_DB_RELEASE_TAG_OVERRIDE/);
  assertInOrder(workflow, [
    "star-ticks.mjs collect",
    "star-ticks.mjs derive",
    "- name: Commit star tick ledgers",
    "- name: Resolve observation database",
    "derive_repository_artifacts.py export-contract",
    "build-pages-artifact.mjs --source \".\"",
    "probe-production.mjs --artifact-dir",
    "actions/upload-pages-artifact@",
    "actions/deploy-pages@",
    "probe-production.mjs --base-url",
  ]);
  assert.match(workflow, /export-contract --database "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite" --snapshot-id "\$SNAPSHOT_ID" --contract-out "\$ARTIFACT_CONTRACT"/);
  assert.match(workflow, /probe-production\.mjs --base-url "\$\{\{ steps\.deployment\.outputs\.page_url \}\}" --source-sha "\$SOURCE_SHA" --snapshot-id "\$SNAPSHOT_ID" --artifact-contract "\$ARTIFACT_CONTRACT"/);
  // Build, upload, deploy, and the production probe are all gated on a committed ledger change.
  const gated = workflow.match(/if: \$\{\{ steps\.collect\.outputs\.skipped != 'true' && steps\.commit\.outputs\.committed == 'true' \}\}/g) ?? [];
  assert.equal(gated.length, 5);
  for (const step of ["- name: Resolve observation database", "- name: Build committed Pages artifact", "- name: Upload Pages artifact", "- name: Deploy Pages artifact", "- name: Probe deployed Pages artifact"]) {
    const start = workflow.indexOf(step);
    assert.ok(start >= 0, step);
    assert.match(workflow.slice(start, start + 200), /\n\s+if: \$\{\{ steps\.collect\.outputs\.skipped != 'true' && steps\.commit\.outputs\.committed == 'true' \}\}/);
  }
});

test("the tick ledgers start tracked and well-formed", async () => {
  await access("data/star-ticks/.gitkeep");
  // The daily rollup is production data written by the tick workflow: pin its shape, not its contents.
  const dailyLines = (await readFile("data/star-daily.jsonl", "utf8")).replace(/\r\n/g, "\n").split("\n");
  assert.equal(dailyLines.at(-1), "", "the daily rollup must end with a newline");
  assert.equal(dailyLines[0], '{"version":1}', "the daily rollup must start with the version-1 header");
  for (const line of dailyLines.slice(1, -1)) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).sort(), ["date", "slug", "stars", "tier"], `unexpected daily row shape: ${line}`);
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/, `daily row date must be YYYY-MM-DD: ${line}`);
    assert.match(row.slug, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, `daily row slug must be owner/repo: ${line}`);
    assert.ok(Number.isInteger(row.stars) && row.stars >= 0, `daily row stars must be a non-negative integer: ${line}`);
    assert.ok(["A", "B"].includes(row.tier), `daily row tier must be A or B: ${line}`);
  }
  const anchors = JSON.parse(await readFile("data/star-anchors.json", "utf8"));
  assert.deepEqual(Object.keys(anchors).sort(), ["anchors", "generatedAt", "version", "warnings"]);
  assert.equal(anchors.version, 1);
  assert.ok(anchors.generatedAt === null || typeof anchors.generatedAt === "string", "generatedAt must be null or a string");
  assert.ok(anchors.anchors && typeof anchors.anchors === "object" && !Array.isArray(anchors.anchors), "anchors must be a plain object");
  assert.ok(Object.values(anchors.anchors).every(value => Array.isArray(value)), "every anchors entry must be an array");
  assert.ok(Array.isArray(anchors.warnings), "warnings must be an array");
});
