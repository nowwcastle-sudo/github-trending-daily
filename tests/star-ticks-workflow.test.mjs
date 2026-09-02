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
});

test("star ticks collect with the repository token only, pick the tier from the clock, and commit only the three ledger paths", async () => {
  const workflow = await text(workflowPath);
  const secrets = [...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(match => match[1]);
  assert.ok(secrets.length > 0);
  assert.deepEqual([...new Set(secrets)], ["GITHUB_TOKEN"]);
  assert.doesNotMatch(workflow, /ANTHROPIC|CLAUDE|CODEX|update-trending|generate-summary-bundles|collect-repository-events|record_repository_observations|self-hosted/);
  assert.match(workflow, /git fetch origin main[\s\S]*git rev-parse HEAD[\s\S]*refs\/remotes\/origin\/main/);
  assert.match(workflow, /TIER=ab/);
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
  assert.match(workflow, /\[ -f data\/repository-observations\.sqlite \] \|\| \{ echo "::error::star ticks require the version-1 repository database"; exit 1; \}/);
  assertInOrder(workflow, [
    "star-ticks.mjs collect",
    "star-ticks.mjs derive",
    "- name: Commit star tick ledgers",
    "derive_repository_artifacts.py export-contract",
    "build-pages-artifact.mjs --source \".\"",
    "probe-production.mjs --artifact-dir",
    "actions/upload-pages-artifact@",
    "actions/deploy-pages@",
    "probe-production.mjs --base-url",
  ]);
  assert.match(workflow, /export-contract --database "\$\{GITHUB_WORKSPACE\}\/data\/repository-observations\.sqlite" --snapshot-id "\$SNAPSHOT_ID" --contract-out "\$ARTIFACT_CONTRACT"/);
  assert.match(workflow, /probe-production\.mjs --base-url "\$\{\{ steps\.deployment\.outputs\.page_url \}\}" --source-sha "\$SOURCE_SHA" --snapshot-id "\$SNAPSHOT_ID" --artifact-contract "\$ARTIFACT_CONTRACT"/);
  assert.match(workflow, /if: \$\{\{ steps\.collect\.outputs\.skipped != 'true' && steps\.commit\.outputs\.committed == 'true' \}\}/);
});

test("the tick ledgers start empty and tracked", async () => {
  await access("data/star-ticks/.gitkeep");
  assert.equal(await readFile("data/star-daily.jsonl", "utf8"), '{"version":1}\n');
  const anchors = JSON.parse(await readFile("data/star-anchors.json", "utf8"));
  assert.deepEqual(anchors, { version: 1, generatedAt: null, anchors: {}, warnings: [] });
});
