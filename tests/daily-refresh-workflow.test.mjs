import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/daily-refresh.yml";

async function workflowText() {
  return (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");
}

function assertInOrder(value, fragments) {
  let cursor = 0;
  for (const fragment of fragments) {
    const next = value.indexOf(fragment, cursor);
    assert.ok(next >= 0, `missing or out-of-order fragment: ${fragment}`);
    cursor = next + fragment.length;
  }
}

function assertClockAnchorsFirstExecutableStep(workflow) {
  const prepareJob = workflow.indexOf("  prepare:");
  const prepareSteps = workflow.indexOf("    steps:\n", prepareJob);
  const clockStep = workflow.indexOf("- name: Anchor immutable refresh clock and gates", prepareSteps);
  const checkoutStep = workflow.indexOf("- uses: actions/checkout@", prepareSteps);
  assert.ok(prepareJob > 0 && prepareSteps > prepareJob && clockStep > prepareSteps && clockStep < checkoutStep);
  assert.doesNotMatch(workflow.slice(prepareSteps, clockStep), /^\s+(?:run:|uses:)/m);
}

test("schedule is held before checkout and the approved manual bootstrap keeps its fail-closed guard", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /^on:\n  schedule:\n    - cron: "7 \*\/2 \* \* \*"\n  workflow_dispatch:\n    inputs:\n      bootstrap-source-sha:\n        description: [^\n]+\n        required: false\n        type: string$/m);
  assert.match(workflow, /if: \$\{\{ \(github\.event_name == 'schedule' && vars\.GH_TRENDING_REFRESH_SCHEDULE == 'enabled'\) \|\| github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(workflow, /MANUAL_BOOTSTRAP_GATE: bootstrap_v0_approved/);
  assert.match(workflow, /GITHUB_EVENT_NAME.*workflow_dispatch[\s\S]*MANUAL_BOOTSTRAP_GATE.*bootstrap_v0_pending_approval[\s\S]*exit 1/);
  assert.match(workflow, /REQUESTED_BOOTSTRAP_SOURCE_SHA: \$\{\{ inputs\['bootstrap-source-sha'\] \|\| '' \}\}/);
  assert.match(workflow, /REQUESTED_BOOTSTRAP_SOURCE_SHA[\s\S]*\^\[a-f0-9\]\{40\}\$/);
  assert.match(workflow, /PRODUCTION_MANIFEST_STATUS.*verified_404[\s\S]*REQUESTED_BOOTSTRAP_SOURCE_SHA.*HYDRATION_SOURCE_SHA/);
  assert.match(workflow, /PRODUCTION_MANIFEST_STATUS.*verified_v0[\s\S]*-z "\$REQUESTED_BOOTSTRAP_SOURCE_SHA"/);
  assert.match(workflow, /PRODUCTION_VERSION.*1[\s\S]*-z "\$REQUESTED_BOOTSTRAP_SOURCE_SHA"/);
  assertClockAnchorsFirstExecutableStep(workflow);
  const mutation = workflow.replace(
    "      - name: Anchor immutable refresh clock and gates",
    "      - name: Premature checkout\n        uses: actions/checkout@0000000000000000000000000000000000000000\n      - name: Anchor immutable refresh clock and gates",
  );
  assert.throws(() => assertClockAnchorsFirstExecutableStep(mutation));
});

test("one immutable 120-minute clock governs events enrichment and teardown", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /timeout-minutes: 120/);
  assert.match(workflow, /REFRESH_ORIGIN_EPOCH_MS=/);
  assert.match(workflow, /REFRESH_HARD_DEADLINE_EPOCH_MS=.*6900000/);
  assert.match(workflow, /REFRESH_EVENT_DEADLINE_EPOCH_MS=.*900000/);
  assert.match(workflow, /REFRESH_TEARDOWN_CUSHION_MS=300000/);
  assert.match(workflow, /REFRESH_ENRICHMENT_DEADLINE_EPOCH_MS/);
  assert.doesNotMatch(workflow, /ENRICHMENT_DEADLINE_EPOCH_MS=.*4200000|timeout-minutes: 90/);
  assert.equal((workflow.match(/^\s*REFRESH_ORIGIN_EPOCH_MS="/gm) ?? []).length, 1);
});

test("frozen facts events and enrichment precede core recording and publication", async () => {
  const workflow = await workflowText();
  assertInOrder(workflow, [
    "Collect frozen repository facts",
    "Collect complete repository events",
    "Generate bound enrichment with Claude OAuth",
    "Record core repository snapshot",
    "Derive and render public artifacts",
    "Finalize repository derivatives",
    "Validate whole candidate",
    "Build and probe validated candidate",
    "Promote and scan staged candidate",
    "Publish generated child commit",
    "Build and locally probe committed Pages artifact",
  ]);
  assert.match(workflow, /update-trending\.mjs --facts-out/);
  assert.match(workflow, /FROZEN_SOURCE_SET_SHA256=\$\{value\.sourceSetSha256\}[\s\S]*FROZEN_RUN_CONTEXT_SHA256=\$\{value\.runContextSha256\}/);
  assert.match(workflow, /derive_repository_artifacts\.py export-parent-inputs[\s\S]*--production-source-sha "\$HYDRATION_SOURCE_SHA"/);
  assertInOrder(workflow, [
    "derive_repository_artifacts.py export-parent-inputs",
    "derive_repository_artifacts.py verify-parent-inputs",
    "Collect frozen repository facts",
  ]);
  assert.match(workflow, /collect-repository-events\.mjs --facts[\s\S]*--prior-heads[\s\S]*--parent-evidence[\s\S]*--parent-database/);
  assert.match(workflow, /generate-summary-bundles\.mjs --facts[\s\S]*--events[\s\S]*--enrichment-index-out[\s\S]*--source-root \$candidate[\s\S]*--output-root \$candidate[\s\S]*--prior-heads[\s\S]*--parent-evidence[\s\S]*--parent-database/);
  assert.match(workflow, /validate-enrichment-coverage\.mjs --root "\$CANDIDATE" --facts "\$\{RUNNER_TEMP\}\/repository-facts\.json" --json-counts/);
  assert.match(workflow, /ENRICHMENT_BUDGET_MODE=normal[\s\S]*VERIFIED_RECOVERY_VERSION=1[\s\S]*VERIFIED_BOOTSTRAP_SOURCE_SHA=\$HYDRATION_SOURCE_SHA/);
  assert.match(workflow, /PRODUCTION_MANIFEST_STATUS=\$\{value\.manifestStatus\}[\s\S]*PRODUCTION_MANIFEST_SHA256=\$\{value\.manifestSha256 \?\? ""\}/);
  assert.match(workflow, /update-trending\.mjs --render-facts[\s\S]*--snapshot-out/);
  assert.match(workflow, /record_repository_observations\.py[\s\S]*--parent-database[\s\S]*--candidate-database[\s\S]*--snapshot[\s\S]*--events[\s\S]*--enrichment-index[\s\S]*--readme-state/);
  assert.doesNotMatch(workflow, /record_star_observations\.py|record_trending_membership\.py/);
});

test("one create-new parent database capture is reused across every frozen boundary", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /set -o noclobber[\s\S]*git (?:show|cat-file)[\s\S]*> "\$PARENT_DATABASE"/);
  assert.doesNotMatch(workflow, /rm -f "\$PARENT_DATABASE"/);
  assert.equal((workflow.match(/PARENT_DATABASE="\$PARENT_CAPTURE_DIR\/repository-observations\.sqlite"/g) ?? []).length, 1);
  assert.match(workflow, /collect-repository-events\.mjs[^\n]*--parent-database "\$PARENT_DATABASE"/);
  assert.match(workflow, /generate-summary-bundles\.mjs[^\n]*--parent-database \$parentDatabase/);
  assert.match(workflow, /frozen-parent-input\/repository-observations\.sqlite/);
  assert.match(workflow, /record_repository_observations\.py[^\n]*--parent-database "\$PARENT_DATABASE"/);
});

test("failed enrichment uploads bounded defect diagnostics without a partial candidate", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /generate-summary-bundles\.mjs[^\n]*--failure-diagnostics-out \(Join-Path \$root "enrichment-failure\.json"\)/);
  assertInOrder(workflow, [
    "Generate bound enrichment with Claude OAuth",
    "Upload bounded enrichment failure diagnostics",
    "Upload bounded enrichment output",
  ]);
  assert.match(workflow, /- name: Upload bounded enrichment failure diagnostics\n\s+if: failure\(\)\n\s+uses: actions\/upload-artifact@[0-9a-f]{40}[\s\S]*name: refresh-enrichment-failure-\$\{\{ github\.run_id \}\}[\s\S]*path: \$\{\{ runner\.temp \}\}\/refresh-input\/enrichment-failure\.json[\s\S]*if-no-files-found: ignore/);
  const failureUpload = workflow.slice(
    workflow.indexOf("Upload bounded enrichment failure diagnostics"),
    workflow.indexOf("Upload bounded enrichment output"),
  );
  assert.doesNotMatch(failureUpload, /refresh-enriched|repo-summaries|translation-sources|enrichment-index/);
});

test("parent capture directory is sealed before verification and every possible first fetch", async () => {
  const workflow = await workflowText();
  const freezeStart = workflow.indexOf("- name: Freeze one run context and parent evidence");
  const factsStart = workflow.indexOf("- name: Collect frozen repository facts");
  const freeze = workflow.slice(freezeStart, factsStart);
  assert.match(freeze, /PARENT_CAPTURE_DIR="\$\{RUNNER_TEMP\}\/frozen-parent-input"/);
  assert.match(freeze, /mkdir "\$PARENT_CAPTURE_DIR"/);
  assert.match(freeze, /PARENT_DATABASE="\$PARENT_CAPTURE_DIR\/repository-observations\.sqlite"/);
  assert.match(freeze, /chmod 0444 "\$PARENT_DATABASE"/);
  const seal = freeze.indexOf('chmod 0555 "$PARENT_CAPTURE_DIR"');
  const exportInputs = freeze.indexOf("derive_repository_artifacts.py export-parent-inputs");
  const verifyInputs = freeze.indexOf("derive_repository_artifacts.py verify-parent-inputs");
  assert.ok(seal > -1 && seal < exportInputs && seal < verifyInputs,
    "an existing or absent parent path must be sealed before it is measured");
  assert.doesNotMatch(workflow.slice(freezeStart), /chmod [^\n]*[+w7][^\n]*\$PARENT_CAPTURE_DIR/);
});

test("candidate finalizes before checkout promotion and staged SQLite scanning", async () => {
  const workflow = await workflowText();
  const finalization = workflow.indexOf("Finalize repository derivatives");
  const validation = workflow.indexOf("Validate whole candidate");
  const promotion = workflow.indexOf("Promote and scan staged candidate");
  const add = workflow.indexOf("git add --", promotion);
  const stagedBlob = workflow.indexOf("git show :data/repository-observations.sqlite", add);
  const scanner = workflow.indexOf("scan_repository_observations.py", stagedBlob);
  const commit = workflow.indexOf("git commit -m", scanner);
  assert.ok(finalization >= 0 && finalization < validation && validation < promotion && promotion < add && add < stagedBlob && stagedBlob < scanner && scanner < commit);
  for (const checkoutWrite of [
    'cp "$CANDIDATE/index.html" index.html',
    'cp "$CANDIDATE/data/repository-observations.sqlite" data/repository-observations.sqlite',
    'cp "$CANDIDATE/data/readme-state.json" data/readme-state.json',
    'rsync --archive --delete "$CANDIDATE/translations/" translations/',
  ]) {
    assert.ok(workflow.indexOf(checkoutWrite) > promotion, `checkout promotion occurred before finalization: ${checkoutWrite}`);
  }
  assert.match(workflow.slice(finalization, validation), /derive_repository_artifacts\.py finalize/);
  assert.match(workflow.slice(validation, promotion), /verify-pages/);
  assert.match(workflow.slice(promotion, add), /git diff --quiet --[\s\S]*git diff --cached --quiet --/);
  assert.match(workflow.slice(promotion, add), /\[ "\$ORIGINAL_SHA" = "\$\(git rev-parse HEAD\)" \]/);
  assert.match(workflow.slice(scanner, commit), /git diff --cached --check/);
  assert.doesNotMatch(workflow, /git add (?:\.|-A|--all)(?:\s|$)/);
  assert.match(workflow, /if git diff --cached --quiet; then[\s\S]*exit 1/);
});

test("recurring allowlists contain only the new DB and README state", async () => {
  const workflow = await workflowText();
  const promotion = workflow.slice(workflow.indexOf("Promote and scan staged candidate"), workflow.indexOf("Publish generated child commit"));
  assert.match(promotion, /data\/repository-observations\.sqlite/);
  assert.match(promotion, /data\/readme-state\.json/);
  assert.doesNotMatch(promotion, /data\/star-observations\.sqlite|data\/trending-membership\.sqlite|data\/legacy-public-star-history\.json|data\/legacy-observation-baseline\.json/);
  assert.match(workflow, /scan_repository_observations\.py --database/);
});

test("v1 publication is one nonempty generated child and refresh chain is rechecked", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /git fetch origin main/);
  assert.match(workflow, /origin\/main advanced during refresh/);
  assert.match(workflow, /git commit -m "chore: refresh trending snapshot"/);
  assert.match(workflow, /SOURCE_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(workflow, /\[ "\$SOURCE_SHA" != "\$ORIGINAL_SHA" \]/);
  assert.doesNotMatch(workflow, /(?:^|\n)\s+SOURCE_SHA="\$ORIGINAL_SHA"/);
  assert.match(workflow, /verify-refresh-chain\.mjs|probe-production\.mjs/);
});

test("Pages jobs retain pinned least privilege and recovery", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /prepare:\n(?:[\s\S]*?)    permissions:\n      contents: read/);
  assert.match(workflow, /enrich:\n(?:[\s\S]*?)    permissions:\n      contents: read/);
  assert.match(workflow, /publish:\n(?:[\s\S]*?)    permissions:\n      contents: write/);
  assert.equal((workflow.match(/^      contents: write$/gm) ?? []).length, 1);
  assert.match(workflow, /deploy:\n(?:[\s\S]*?)    permissions:\n      pages: write\n      id-token: write/);
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) {
    assert.match(match[2], /^[0-9a-f]{40}$/, `${match[1]} must be pinned by commit`);
  }
  assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9/);
  assert.match(workflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(workflow, /needs\.verify\.result == 'failure'/);
});

test("Claude enrichment is tool-free on the dedicated Windows runner and cannot publish", async () => {
  const workflow = await workflowText();
  const enrichStart = workflow.indexOf("  enrich:");
  const publishStart = workflow.indexOf("  publish:");
  const enrich = workflow.slice(enrichStart, publishStart);
  assert.match(enrich, /runs-on: \[self-hosted, Windows, X64, gh-trending-claude\]/);
  assert.match(enrich, /Generate bound enrichment with Claude OAuth/);
  assert.match(enrich, /GetEnvironmentVariable\("CLAUDE_CODE_OAUTH_TOKEN", "User"\)/);
  assert.match(enrich, /\$env:CLAUDE_CODE_OAUTH_TOKEN = \$null/);
  assert.match(enrich, /\}\s*finally\s*\{\s*\n\s*\$env:CLAUDE_CODE_OAUTH_TOKEN = \$null/);
  assert.doesNotMatch(enrich, /Write-(?:Output|Host)[^\n]*CLAUDE_CODE_OAUTH_TOKEN|echo[^\n]*CLAUDE_CODE_OAUTH_TOKEN/i);
  assert.match(enrich, /generate-summary-bundles\.mjs/);
  assert.match(enrich, /claude-cli-oauth[\s\S]*claude-p[\s\S]*oauth_token[\s\S]*firstParty[\s\S]*claude-sonnet-5/);
  assert.match(enrich, /cli_version/);
  assert.match(enrich, /git status --porcelain/);
  assert.doesNotMatch(enrich, /contents: write|git push|git commit|deploy-pages|upload-pages-artifact|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(workflow, /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL/);
  assert.match(workflow, /refresh-input-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /refresh-enriched-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /data\/repo-summaries\.json[\s\S]*data\/translation-sources\.json[\s\S]*enrichment-index\.json[\s\S]*enrichment-usage\.json/);
});

test("GitHub-hosted publication reconstructs its candidate and distrusts self-hosted residue", async () => {
  const workflow = await workflowText();
  const publishStart = workflow.indexOf("  publish:");
  const deployStart = workflow.indexOf("  deploy:");
  const publish = workflow.slice(publishStart, deployStart);
  assert.match(publish, /EXPECTED_FILES=\$'data\/repo-summaries\.json\\ndata\/translation-sources\.json\\nenrichment-index\.json\\nenrichment-usage\.json'/);
  assert.match(publish, /find "\$ENRICHED_ROOT" -type f/);
  assert.match(publish, /find "\$ENRICHED_ROOT" -type l/);
  assert.match(publish, /prepare-refresh-candidate\.mjs --checkout "\$GITHUB_WORKSPACE"/);
  assert.match(publish, /candidate-baseline/);
  assertInOrder(publish, [
    "Rebuild and install bounded enrichment candidate",
    "Record core repository snapshot",
    "Validate whole candidate",
    "Promote and scan staged candidate",
  ]);
  assert.doesNotMatch(publish, /cp -a "\$\{RUNNER_TEMP\}\/refresh-input\/candidate"/);
});

test("recovery preserves the verified production manifest version and identity", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /recovery_snapshot_id: \$\{\{ steps\.state\.outputs\.parent_snapshot_id \}\}/);
  assert.match(workflow, /recovery_version=\$\{value\.version\}/);
  assert.doesNotMatch(workflow, /recovery_version=0/);

  const buildStart = workflow.indexOf("- name: Build verified recovery artifact");
  const buildEnd = workflow.indexOf("- name: Prepare isolated refresh candidate", buildStart);
  const recoveryBuild = workflow.slice(buildStart, buildEnd);
  assert.match(recoveryBuild, /if \[ "\$PRODUCTION_VERSION" = "0" \]; then/);
  assert.match(recoveryBuild, /--mode legacy[\s\S]*--legacy-recovery-sha/);
  assert.match(recoveryBuild, /else[\s\S]*derive_repository_artifacts\.py export-contract[\s\S]*--snapshot-id "\$PARENT_SNAPSHOT_ID"/);
  assert.match(recoveryBuild, /build-pages-artifact\.mjs --source[\s\S]*--snapshot-id "\$PARENT_SNAPSHOT_ID"[\s\S]*--artifact-contract "\$RECOVERY_CONTRACT"/);
  assert.match(recoveryBuild, /probe-production\.mjs --artifact-dir[\s\S]*--source-sha "\$HYDRATION_SOURCE_SHA"[\s\S]*--snapshot-id "\$PARENT_SNAPSHOT_ID"[\s\S]*--artifact-contract "\$RECOVERY_CONTRACT"/);

  const verifyStart = workflow.indexOf("- name: Verify recovered production");
  const recoveryVerify = workflow.slice(verifyStart);
  assert.match(recoveryVerify, /if \[ "\$RECOVERY_VERSION" = "0" \]; then/);
  assert.match(recoveryVerify, /--legacy-recovery-sha "\$RECOVERY_SOURCE_SHA"/);
  assert.match(recoveryVerify, /else[\s\S]*--source-sha "\$RECOVERY_SOURCE_SHA"[\s\S]*--snapshot-id "\$RECOVERY_SNAPSHOT_ID"/);
});

test("production preflight distinguishes strict v0 v1 and verified 404", async () => {
  const workflow = await workflowText();
  const stateStart = workflow.indexOf("- name: Resolve verified production state");
  const stateEnd = workflow.indexOf("- name: Build verified recovery artifact", stateStart);
  const state = workflow.slice(stateStart, stateEnd);
  assert.match(state, /FALLBACK_SOURCE_SHA="\$ORIGINAL_SHA"[\s\S]*?"\$HTTP_STATUS" = "404"[\s\S]*?FALLBACK_SOURCE_SHA="\$REQUESTED_BOOTSTRAP_SOURCE_SHA"[\s\S]*?build-pages-artifact\.mjs --inspect-manifest "\$MANIFEST_FILE" --http-status "\$HTTP_STATUS" --fallback-source-sha "\$FALLBACK_SOURCE_SHA"/);
  assert.match(state, /PRODUCTION_MANIFEST_STATUS/);
  assert.match(state, /verified_404[\s\S]*--bootstrap-preflight-sha/);
  assert.match(state, /verified_v0[\s\S]*--legacy-recovery-sha/);
  assert.doesNotMatch(state, /\[ "\$HTTP_STATUS" = "200" \] \|\|/);
});

test("the separate legacy writer workflow is removed", async () => {
  await assert.rejects(access(".github/workflows/update-star-history.yml"), /ENOENT/);
});
