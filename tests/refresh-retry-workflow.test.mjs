import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const retryPath = ".github/workflows/refresh-retry.yml";
const refreshPath = ".github/workflows/daily-refresh.yml";

const read = async path => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

test("the retry workflow watches the refresh workflow and asks for no permission it does not use", async () => {
  const workflow = await read(retryPath);
  assert.match(workflow, /^name: Retry an unacquired refresh$/m);
  assert.match(workflow, /^on:\n  workflow_run:\n    workflows: \["Trending refresh \(every 6 hours\)"\]\n    types: \[completed\]$/m);
  // No schedule and no push: this workflow exists only to answer another workflow's outcome.
  assert.doesNotMatch(workflow, /^  (?:schedule|push|pull_request):/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  // actions: write is what dispatches the replacement; nothing else is granted.
  assert.match(workflow, /^    permissions:\n      actions: write$/m);
  assert.doesNotMatch(workflow, /^      (?:contents|pages|id-token|packages|deployments): write$/m);
  assert.match(workflow, /^    timeout-minutes: 10$/m);
  assert.match(workflow, /^concurrency:\n  group: refresh-retry\n  cancel-in-progress: false$/m);
});

test("only a failed scheduled cycle is retried, so a retry can never trigger another retry", async () => {
  const workflow = await read(retryPath);
  assert.match(
    workflow,
    /if: \$\{\{ github\.event\.workflow_run\.conclusion == 'failure' && github\.event\.workflow_run\.event == 'schedule' \}\}/,
  );
  // The replacement is dispatched, and a workflow_dispatch run cannot satisfy the condition above.
  assert.match(workflow, /gh workflow run daily-refresh\.yml --ref "\$TARGET_REF"/);
  assert.doesNotMatch(workflow, /gh run rerun/);
});

test("the retry fires only for a job that was never acquired, and stays silent on every real failure", async () => {
  const workflow = await read(retryPath);
  // All three conditions are read from the failed run itself, not assumed.
  assert.match(workflow, /conclusion=\$\(printf '%s' "\$enrich" \| jq -r '\.conclusion \/\/ ""'\)/);
  assert.match(workflow, /runner_name=\$\(printf '%s' "\$enrich" \| jq -r '\.runner_name \/\/ ""'\)/);
  assert.match(workflow, /started_steps=\$\(printf '%s' "\$enrich" \| jq '\[\.steps\[\]\? \| select\(\.status != "queued" and \.status != "pending"\)\] \| length'\)/);
  assert.match(
    workflow,
    /if \[ "\$conclusion" != "cancelled" \] \|\| \[ -n "\$runner_name" \] \|\| \[ "\$started_steps" -ne 0 \]; then\n\s+echo "::notice::[^\n]*leaving it failed to be read"\n\s+exit 0\n\s+fi/,
  );
  assert.match(workflow, /^          set -euo pipefail$/m);
});

test("a missing enrichment job stops the retry loudly instead of dispatching blind", async () => {
  const workflow = await read(retryPath);
  assert.match(workflow, /if \[ -z "\$enrich" \]; then\n\s+echo "::error::[^\n]*the guard is stale[^\n]*"\n\s+exit 1\n\s+fi/);
});

test("the job name the guard matches is the one the refresh workflow actually ships", async () => {
  const [retry, refresh] = await Promise.all([read(retryPath), read(refreshPath)]);
  const guarded = retry.match(/^          ENRICH_JOB_NAME: (.+)$/m);
  assert.ok(guarded, "the retry workflow must name the job it inspects");
  const jobName = guarded[1].trim();
  // A rename on either side breaks the guard silently in production; it must break here first.
  assert.ok(
    refresh.includes(`    name: ${jobName}\n`),
    `daily-refresh.yml must still declare a job named "${jobName}"`,
  );
  assert.match(refresh, /^name: Trending refresh \(every 6 hours\)$/m);
  assert.ok(
    retry.includes('workflows: ["Trending refresh (every 6 hours)"]'),
    "the watched workflow name must match daily-refresh.yml's own name",
  );
});

test("the retry workflow runs no refresh work of its own and names no provider", async () => {
  const workflow = await read(retryPath);
  assert.doesNotMatch(workflow, /actions\/checkout|actions\/setup-node|actions\/upload-pages-artifact|actions\/deploy-pages/);
  assert.doesNotMatch(workflow, /update-trending|generate-summary-bundles|build-pages-artifact|observation-db-store|probe-production/);
  assert.doesNotMatch(workflow, /ANTHROPIC|CLAUDE|CODEX|OAUTH/i);
  // It must never occupy the self-hosted runner: the runner is exactly what is unreachable when
  // this workflow is needed. Prose about that runner is fine; a runs-on pointing at it is not.
  assert.match(workflow, /^    runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(workflow, /^\s*runs-on:.*self-hosted/m);
});
