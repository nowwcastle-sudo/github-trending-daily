import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = ".github/workflows/deploy-current-pages.yml";

test("deployment-only workflow publishes one committed legacy artifact without refresh or LLM work", async () => {
  const workflow = (await readFile(workflowPath, "utf8")).replaceAll("\r\n", "\n");
  assert.match(workflow, /^name: Deploy current Pages artifact$/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (?:schedule|push):/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^      contents: read\n      pages: write\n      id-token: write$/m);
  assert.match(workflow, /git fetch origin main[\s\S]*git rev-parse HEAD[\s\S]*refs\/remotes\/origin\/main/);
  assert.match(workflow, /build-pages-artifact\.mjs --mode legacy[\s\S]*--source "\."[\s\S]*--source-sha "\$SOURCE_SHA"/);
  assert.match(workflow, /probe-production\.mjs --artifact-dir[\s\S]*--legacy-recovery-sha "\$SOURCE_SHA"/);
  assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9/);
  assert.match(workflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128/);
  assert.match(workflow, /probe-production\.mjs --base-url[\s\S]*--legacy-recovery-sha/);
  assert.doesNotMatch(workflow, /ANTHROPIC|update-trending|generate-translations|collect-repository-events|record_(?:star|repository|trending)|generate_atom_feeds/);
});
