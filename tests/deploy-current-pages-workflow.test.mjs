import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/deploy-current-pages.yml";

test("finalized artifact redeploy workflow publishes one committed v0 or v1 artifact without refresh or LLM work", async () => {
  const workflow = (await readFile(workflowPath, "utf8")).replaceAll("\r\n", "\n");
  assert.match(workflow, /^name: Redeploy finalized Pages artifact$/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (?:schedule|push):/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^      contents: read\n      pages: write\n      id-token: write$/m);
  assert.match(workflow, /git fetch origin main[\s\S]*git rev-parse HEAD[\s\S]*refs\/remotes\/origin\/main/);
  // Fail closed on the check: only exit 3 (nothing tracked at this commit) may reach the legacy v0
  // build. Any other non-zero status - both paths tracked, a corrupt pointer, git failing - stops
  // the deploy instead of silently publishing the legacy artifact over a broken database.
  assert.doesNotMatch(workflow, /if node scripts\/observation-db-store\.mjs resolve[^\n]*--check; then/);
  assert.match(workflow, /set \+e\n\s+node scripts\/observation-db-store\.mjs resolve --source-sha "\$SOURCE_SHA" --check\n\s+CHECK_STATUS=\$\?\n\s+set -e\n\s+case "\$CHECK_STATUS" in/);
  assert.match(workflow, /case "\$CHECK_STATUS" in\n\s+0\)\n[\s\S]*DEPLOYMENT_MODE=v1[\s\S]*\n\s+3\)\n\s+node scripts\/build-pages-artifact\.mjs --mode legacy[\s\S]*DEPLOYMENT_MODE=v0[\s\S]*\n\s+\*\)\n\s+echo "::error::observation database check failed \(exit \$CHECK_STATUS\)"\n\s+exit 1\n\s+;;\n\s+esac/);
  assert.match(workflow, /derive_repository_artifacts\.py export-contract[\s\S]*--snapshot-id "\$SNAPSHOT_ID"/);
  assert.match(workflow, /export-contract --database "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"/);
  assert.match(workflow, /observation-db-store\.mjs resolve --source-sha "\$SOURCE_SHA" --expect-snapshot-id "\$SNAPSHOT_ID" --out "\$\{RUNNER_TEMP\}\/repository-observations\.sqlite"/);
  assert.doesNotMatch(workflow, /GH_TOKEN:/);
  assert.match(workflow, /build-pages-artifact\.mjs --source "\."[\s\S]*--snapshot-id "\$SNAPSHOT_ID"[\s\S]*--artifact-contract "\$ARTIFACT_CONTRACT"/);
  assert.match(workflow, /build-pages-artifact\.mjs --mode legacy[\s\S]*--source "\."[\s\S]*--source-sha "\$SOURCE_SHA"/);
  assert.match(workflow, /probe-production\.mjs --artifact-dir[\s\S]*--source-sha "\$SOURCE_SHA"[\s\S]*--snapshot-id "\$SNAPSHOT_ID"/);
  assert.match(workflow, /- name: Build committed Pages artifact[\s\S]*- name: Upload Pages artifact/);
  assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9/);
  assert.match(workflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128/);
  assert.match(workflow, /probe-production\.mjs --base-url[\s\S]*--source-sha "\$SOURCE_SHA"[\s\S]*--snapshot-id "\$SNAPSHOT_ID"/);
  assert.match(workflow, /probe-production\.mjs --base-url[\s\S]*--legacy-recovery-sha "\$SOURCE_SHA"/);
  assert.doesNotMatch(workflow, /ANTHROPIC|CLAUDE|CODEX|update-trending|generate-translations|generate-summary-bundles|collect-repository-events|record_(?:star|repository|trending)|generate_atom_feeds/i);
});
