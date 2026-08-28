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
  const buildJob = workflow.indexOf("  build:");
  const buildSteps = workflow.indexOf("    steps:\n", buildJob);
  const clockStep = workflow.indexOf("- name: Anchor immutable refresh clock and gates", buildSteps);
  const checkoutStep = workflow.indexOf("- uses: actions/checkout@", buildSteps);
  assert.ok(buildJob > 0 && buildSteps > buildJob && clockStep > buildSteps && clockStep < checkoutStep);
  assert.doesNotMatch(workflow.slice(buildSteps, clockStep), /^\s+(?:run:|uses:)/m);
}

test("schedule is held before checkout and manual bootstrap has a separate immutable gate", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /^on:\n  schedule:\n    - cron: "7 \*\/2 \* \* \*"\n  workflow_dispatch:\s*\{\}$/m);
  assert.match(workflow, /if: \$\{\{ \(github\.event_name == 'schedule' && vars\.GH_TRENDING_REFRESH_SCHEDULE == 'enabled'\) \|\| github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(workflow, /MANUAL_BOOTSTRAP_GATE: bootstrap_v0_pending_approval/);
  assert.doesNotMatch(workflow, /bootstrap_v0_approved/);
  assert.match(workflow, /GITHUB_EVENT_NAME.*workflow_dispatch[\s\S]*MANUAL_BOOTSTRAP_GATE.*bootstrap_v0_pending_approval[\s\S]*exit 1/);
  assert.doesNotMatch(workflow, /bootstrap-source-sha|workflow_dispatch:\n\s+inputs:/);
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
    "Generate bound enrichment",
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
  assert.match(workflow, /generate-translations\.mjs --facts[\s\S]*--events[\s\S]*--enrichment-index-out[\s\S]*--output-root[\s\S]*--prior-heads[\s\S]*--parent-evidence[\s\S]*--parent-database/);
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
  assert.match(workflow, /generate-translations\.mjs[^\n]*--parent-database "\$PARENT_DATABASE"/);
  assert.match(workflow, /record_repository_observations\.py[^\n]*--parent-database "\$PARENT_DATABASE"/);
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
  assert.doesNotMatch(workflow, /SOURCE_SHA="\$ORIGINAL_SHA"/);
  assert.match(workflow, /verify-refresh-chain\.mjs|probe-production\.mjs/);
});

test("Pages jobs retain pinned least privilege and recovery", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /build:\n(?:[\s\S]*?)    permissions:\n      contents: write/);
  assert.match(workflow, /deploy:\n(?:[\s\S]*?)    permissions:\n      pages: write\n      id-token: write/);
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) {
    assert.match(match[2], /^[0-9a-f]{40}$/, `${match[1]} must be pinned by commit`);
  }
  assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9/);
  assert.match(workflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128/);
  assert.match(workflow, /needs\.verify\.result == 'failure'/);
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
  assert.match(state, /build-pages-artifact\.mjs --inspect-manifest "\$MANIFEST_FILE" --http-status "\$HTTP_STATUS" --fallback-source-sha "\$ORIGINAL_SHA"/);
  assert.match(state, /PRODUCTION_MANIFEST_STATUS/);
  assert.match(state, /verified_404[\s\S]*--bootstrap-preflight-sha/);
  assert.match(state, /verified_v0[\s\S]*--legacy-recovery-sha/);
  assert.doesNotMatch(state, /\[ "\$HTTP_STATUS" = "200" \] \|\|/);
});

test("the separate legacy writer workflow is removed", async () => {
  await assert.rejects(access(".github/workflows/update-star-history.yml"), /ENOENT/);
});
