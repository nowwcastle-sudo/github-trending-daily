import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the observation database pre-flight workflow is dispatch-only, uses the Actions token once, and deletes its throwaway release", async () => {
  const workflow = (await readFile(".github/workflows/observation-db-preflight.yml", "utf8")).replaceAll("\r\n", "\n");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:/m);
  assert.doesNotMatch(workflow, /^  (?:schedule|push|pull_request):/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^    permissions:\n      contents: write$/m);
  // restore downloads the artifact of a *different* run, which the Actions API serves only to a
  // token that can read Actions.
  assert.match(workflow, /^      actions: read$/m);
  assert.equal((workflow.match(/GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/g) ?? []).length, 1);
  assert.match(workflow, /observation-db-store\.mjs publish --database[\s\S]*--snapshot-id "\$SNAPSHOT_ID"/);
  assert.match(workflow, /observation-db-store\.mjs resolve --source-sha "\$PROOF_SHA" --expect-snapshot-id "\$SNAPSHOT_ID" --git-root "\$PROOF" --out/);
  assert.match(workflow, /cmp "\$DATABASE" "\$WORK\/resolved\.sqlite"/);
  assert.match(workflow, /gh release delete "\$TEST_TAG" --cleanup-tag --yes/);
  assert.match(workflow, /if \[ "\$MODE" = "restore" \]; then/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  // A release asset name can never be reused, so restore must match the artifact against the
  // committed pointer BEFORE publish uploads: a mismatch found afterwards cannot be undone.
  const preUploadCheck = workflow.indexOf("::error::artifact does not match the committed pointer");
  const restorePublish = workflow.indexOf('--pointer-out "$WORK/republished-pointer.json"');
  assert.ok(preUploadCheck > 0, "restore must check the artifact against the committed pointer");
  assert.ok(restorePublish > 0);
  assert.ok(preUploadCheck < restorePublish, "the pointer check must run before the restore publish uploads");
  const preUploadStep = workflow.slice(workflow.lastIndexOf("\n", preUploadCheck - 900) + 1, preUploadCheck);
  assert.match(preUploadStep, /receipt\.databaseSha256/);
  assert.match(preUploadStep, /pointer\.database\?\.sha256/);
  assert.match(preUploadStep, /pointer\.snapshotId/);
  assert.match(preUploadStep, /"\$SNAPSHOT_ID"/);
  // both git show reads of the committed state fail with a message, not a bare git fatal.
  assert.equal((workflow.match(/committed pointer or latest\.json is unavailable at HEAD/g) ?? []).length, 2);
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) assert.match(match[2], /^[0-9a-f]{40}$/, `${match[1]} must be pinned by commit`);
});
