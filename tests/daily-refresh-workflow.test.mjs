import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/daily-refresh.yml";

async function workflowText() {
  return (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");
}

function assertDeadlineAnchorsFirstShellStep(workflow) {
  const buildJob = workflow.indexOf("  build:");
  const buildSteps = workflow.indexOf("    steps:\n", buildJob);
  const deadlineStep = workflow.indexOf("- name: Anchor refresh job deadline", buildSteps);
  const checkoutStep = workflow.indexOf("- uses: actions/checkout@", buildSteps);
  assert.ok(buildJob > 0 && buildSteps > buildJob && deadlineStep > buildSteps && deadlineStep < checkoutStep);
  assert.doesNotMatch(workflow.slice(buildSteps, deadlineStep), /^\s+run:/m);
}

test("schedule and manual dispatch share one fail-closed candidate build path", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /^on:\n  schedule:\n    - cron: "7 \*\/2 \* \* \*"\n  workflow_dispatch:/m);
  assert.match(workflow, /^concurrency:\n  group: daily-refresh\n  cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request):/m);
  assert.doesNotMatch(workflow, /continue-on-error|force(?:-with-lease)?|git push[^\n]*--force/);
  assert.match(workflow, /timeout-minutes: 90/);
  assertDeadlineAnchorsFirstShellStep(workflow);
  const earlierShellStep = workflow.replace(
    "      - name: Anchor refresh job deadline",
    "      - name: Earlier shell step\n        run: echo too-late\n      - name: Anchor refresh job deadline",
  );
  assert.throws(() => assertDeadlineAnchorsFirstShellStep(earlierShellStep));
  assert.match(workflow, /JOB_STARTED_MS="\$\{EPOCHREALTIME\/\.\/\}"[\s\S]*?JOB_STARTED_MS="\$\{JOB_STARTED_MS:0:13\}"[\s\S]*?ENRICHMENT_DEADLINE_EPOCH_MS=\$\(\( 10#\$JOB_STARTED_MS \+ 4200000 \)\)/);
  assert.equal((workflow.match(/scripts\/prepare-refresh-candidate\.mjs --checkout/g) ?? []).length, 1);
  assert.match(workflow, /RUN_CONTEXT_JSON/);
  assert.match(workflow, /node scripts\/validate-enrichment-coverage\.mjs --root "\$CANDIDATE" --json-counts/);
  const manifestFetch = workflow.match(/HTTP_STATUS="\$\(curl ([^\n]+)\)"/)?.[1] ?? "";
  assert.match(manifestFetch, /--connect-timeout 5/);
  assert.match(manifestFetch, /--max-time 15/);
  assert.match(manifestFetch, /--max-filesize 1048576/);
  assert.doesNotMatch(manifestFetch, /--location|-L(?:\s|$)/);
  assert.doesNotMatch(workflow, /snapshotId[^\n]*sed|date \+/);
  assert.match(workflow, /\$\{RUNNER_TEMP\}\/candidate/);
});

test("bootstrap enrichment budget is bound to one verified manual legacy recovery", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /if \[ "\$RECOVERY_VERSION" = "0" \]; then[\s\S]*?\[\[ "\$GITHUB_EVENT_NAME" = "workflow_dispatch" \]\][\s\S]*?\[\[ "\$BOOTSTRAP_SOURCE_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\][\s\S]*?\[ "\$BOOTSTRAP_SOURCE_SHA" = "\$HYDRATION_SOURCE_SHA" \]/);
  assert.match(workflow, /else[\s\S]*?\[ -z "\$BOOTSTRAP_SOURCE_SHA" \][\s\S]*?fi/);
  assert.match(workflow, /ENRICHMENT_BUDGET_MODE: \$\{\{ steps\.state\.outputs\.recovery_version == '0' && 'bootstrap_v0_pending_approval' \|\| 'normal' \}\}/);
  assert.match(workflow, /VERIFIED_RECOVERY_VERSION: \$\{\{ steps\.state\.outputs\.recovery_version \}\}/);
  assert.match(workflow, /VERIFIED_BOOTSTRAP_SOURCE_SHA: \$\{\{ steps\.state\.outputs\.recovery_source_sha \}\}/);
  assert.match(workflow, /MANUAL_BOOTSTRAP_SOURCE_SHA: \$\{\{ inputs\['bootstrap-source-sha'\] \}\}/);
  assert.match(workflow, /HYDRATION_SOURCE_SHA: \$\{\{ steps\.state\.outputs\.hydration_source_sha \}\}/);
  assert.doesNotMatch(workflow, /ENRICHMENT_(?:INPUT|OUTPUT)_(?:CAP|BUDGET)|MAX_(?:INPUT|OUTPUT)_TOKENS:/);
});

test("build and deploy jobs have exact least-privilege Pages contracts", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /build:\n(?:[\s\S]*?)    permissions:\n      contents: write/);
  assert.match(workflow, /deploy:\n(?:[\s\S]*?)    permissions:\n      pages: write\n      id-token: write/);
  const deploySection = workflow.slice(workflow.indexOf("  deploy:"), workflow.indexOf("  verify:"));
  assert.doesNotMatch(deploySection, /contents: write/);
  assert.match(deploySection, /environment:\n      name: github-pages\n      url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) {
    assert.match(match[2], /^[0-9a-f]{40}$/, `${match[1]} must be pinned by commit`);
  }
  assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9/);
  assert.match(workflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128/);
  assert.match(workflow, /artifact_name: github-pages-candidate-\$\{\{ github\.run_id \}\}/);
});

test("publication hydrates from verified production, probes locally, then publishes one exact commit", async () => {
  const workflow = await workflowText();
  const ordered = [
    "Resolve verified production state",
    "Preserve recovery artifact",
    "Prepare isolated candidate",
    "Create one run context",
    "Generate candidate snapshot",
    "Validate candidate snapshot",
    "Publish generated commit",
    "Build and locally probe candidate Pages artifact",
    "Upload recovery artifact",
    "Upload candidate Pages artifact",
  ];
  let cursor = 0;
  for (const fragment of ordered) {
    const next = workflow.indexOf(fragment, cursor);
    assert.ok(next >= 0, `missing or out-of-order workflow step: ${fragment}`);
    cursor = next + fragment.length;
  }
  assert.match(workflow, /git fetch origin main/);
  assert.match(workflow, /ORIGINAL_SHA[\s\S]*origin\/main/);
  assert.match(workflow, /git add -- index\.html/);
  assert.doesNotMatch(workflow, /git add (?:\.|-A|--all)(?:\s|$)/);
  const candidateArtifactStep = workflow.slice(workflow.indexOf("Build and locally probe candidate Pages artifact"), workflow.indexOf("Upload recovery artifact"));
  assert.match(candidateArtifactStep, /scripts\/build-pages-artifact\.mjs[\s\S]*scripts\/probe-production\.mjs --artifact-dir/);
  assert.ok(workflow.indexOf("Build and locally probe candidate Pages artifact") < workflow.indexOf("actions/upload-pages-artifact"));
  assert.match(candidateArtifactStep, /git archive --format=tar "\$SOURCE_SHA"/);
  assert.doesNotMatch(candidateArtifactStep, /--source "\$\{RUNNER_TEMP\}\/candidate"/);
  assert.match(workflow, /github-pages-recovery-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /github-pages-candidate-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /recovery_source_sha: \$\{\{ steps\.state\.outputs\.hydration_source_sha \}\}/);
  assert.match(workflow, /if git diff --cached --quiet; then\n            SOURCE_SHA="\$ORIGINAL_SHA"/);
  assert.match(workflow, /origin\/main advanced during refresh/);
});

test("failed production verification preserves a red conclusion and deploys only the saved recovery artifact", async () => {
  const workflow = await workflowText();
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  recovery:"));
  const recovery = workflow.slice(workflow.indexOf("  recovery:"));
  assert.match(verify, /scripts\/probe-production\.mjs --base-url/);
  assert.doesNotMatch(verify, /continue-on-error/);
  assert.match(recovery, /needs\.verify\.result == 'failure'/);
  assert.match(recovery, /artifact_name: github-pages-recovery-\$\{\{ github\.run_id \}\}/);
  assert.match(recovery, /--legacy-recovery-sha|--source-sha/);
  assert.doesNotMatch(recovery, /git push|git commit|force/);
});

test("workflow resolves all three production states without main-only hydration", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /manifest 404|HTTP_STATUS.*404|404 preflight/i);
  assert.match(workflow, /version[^\n]*0|legacyBootstrap/);
  assert.match(workflow, /version[^\n]*1/);
  assert.match(workflow, /HYDRATION_SOURCE_SHA/);
  assert.match(workflow, /PARENT_SNAPSHOT_ID/);
  assert.match(workflow, /PARENT_SOURCE_SHA/);
  assert.doesNotMatch(workflow, /HYDRATION_SOURCE_SHA="\$ORIGINAL_SHA"/);
  assert.match(workflow, /bootstrap-source-sha/);
  assert.match(workflow, /value\?\.version === 0[\s\S]*?HYDRATION_SOURCE_SHA=\$\{value\.sourceSha\}[\s\S]*?PARENT_SOURCE_SHA=/);
  assert.match(workflow, /value\?\.version === 1[\s\S]*?PARENT_SOURCE_SHA=\$\{value\.sourceSha\}[\s\S]*?PARENT_SNAPSHOT_ID=\$\{value\.snapshotId\}/);
});
