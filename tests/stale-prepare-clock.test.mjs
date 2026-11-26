import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

// "Re-run failed jobs" keeps the prepare job's outputs. A rerun that starts after the first
// attempt's hard deadline therefore carries a deadline that is already in the past (run
// 45722454250: anchored 23:34Z, deadline 01:29Z, rerun 01:57Z, failed at 02:00Z in the publish
// step with "refresh teardown cushion reached"). The publish and enrichment jobs must say so
// before they start any work, and the old teardown-cushion check in the publish step must stay.

const workflowPath = ".github/workflows/daily-refresh.yml";
const STEP_NAME = "Stop early when a reused prepare clock has already run out";
const CUSHION_MS = 300000;
const CHILD_TIMEOUT_MS = 30000;

async function workflowText() {
  return (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");
}

function jobBlock(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `job ${job} is missing`);
  const next = workflow.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

function guardRun(block) {
  const nameAt = block.indexOf(`- name: ${STEP_NAME}`);
  assert.ok(nameAt >= 0, "the stale-clock guard step is missing");
  const marker = "\n        run: |\n";
  const runAt = block.indexOf(marker, nameAt);
  assert.ok(runAt >= 0, "the guard step has no run block");
  const lines = [];
  for (const line of block.slice(runAt + marker.length).split("\n")) {
    if (line.trim() === "") { lines.push(""); continue; }
    if (!line.startsWith(" ".repeat(10))) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

const bashReady = spawnSync("bash", ["-c", '[ -n "${EPOCHREALTIME:-}" ] && echo ready'], { encoding: "utf8" }).stdout?.trim() === "ready";
const pwshReady = spawnSync("pwsh", ["-NoProfile", "-Command", "'ready'"], { encoding: "utf8" }).stdout?.trim() === "ready";

function runBash(script, deadline, summaryPath) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, REFRESH_HARD_DEADLINE_EPOCH_MS: deadline, REFRESH_TEARDOWN_CUSHION_MS: String(CUSHION_MS), GITHUB_STEP_SUMMARY: summaryPath },
  });
}

function runPwsh(script, deadline) {
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, REFRESH_HARD_DEADLINE_EPOCH_MS: deadline, REFRESH_TEARDOWN_CUSHION_MS: String(CUSHION_MS), GITHUB_STEP_SUMMARY: "" },
  });
}

test("the guard is the first step of the enrichment and publish jobs, before any checkout or work", async () => {
  const workflow = await workflowText();
  for (const job of ["enrich", "publish"]) {
    const block = jobBlock(workflow, job);
    const steps = block.indexOf("\n    steps:\n");
    const guard = block.indexOf(`- name: ${STEP_NAME}`);
    const firstUses = block.indexOf("- uses:", steps);
    assert.ok(steps > 0 && guard > steps && guard < firstUses, `${job}: the guard must precede the first checkout`);
    assert.doesNotMatch(block.slice(steps, guard), /^\s+(?:run:|uses:)/m, `${job}: nothing may run before the guard`);
    assert.match(guardRun(block), /new full run required/, `${job}: the abort must say a new full run is required`);
  }
});

test("the publish step keeps its own teardown-cushion check", async () => {
  const workflow = await workflowText();
  assert.match(workflow, /\[ "\$NOW_MS" -lt "\$\(\( REFRESH_HARD_DEADLINE_EPOCH_MS - REFRESH_TEARDOWN_CUSHION_MS \)\)" \] \|\| \{ echo "::error::refresh teardown cushion reached"; exit 1; \}/);
});

test("publish guard: a reused prepare deadline that is past or inside the cushion stops the job early, a live one does not", { skip: !bashReady && "bash with EPOCHREALTIME is unavailable" }, async () => {
  const script = guardRun(jobBlock(await workflowText(), "publish"));
  const now = Date.now();
  const past = runBash(script, String(now - 1800000), "/dev/null");
  assert.equal(past.status, 1, past.stdout + past.stderr);
  assert.match(past.stdout, /::error::new full run required/);
  const inside = runBash(script, String(now + CUSHION_MS - 60000), "/dev/null");
  assert.equal(inside.status, 1, "less than the teardown cushion left cannot publish");
  const live = runBash(script, String(now + CUSHION_MS + 600000), "/dev/null");
  assert.equal(live.status, 0, live.stdout + live.stderr);
  assert.doesNotMatch(live.stdout, /::error::/);
  const bad = runBash(script, "not-a-number", "/dev/null");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /not an epoch in milliseconds/);
});

test("enrichment guard: same verdicts on the self-hosted PowerShell shell", { skip: !pwshReady && "pwsh is unavailable" }, async () => {
  const script = guardRun(jobBlock(await workflowText(), "enrich"));
  const now = Date.now();
  const past = runPwsh(script, String(now - 1800000));
  assert.equal(past.status, 1, past.stdout + past.stderr);
  assert.match(past.stdout, /::error::new full run required/);
  assert.equal(runPwsh(script, String(now + CUSHION_MS - 60000)).status, 1);
  const live = runPwsh(script, String(now + CUSHION_MS + 600000));
  assert.equal(live.status, 0, live.stdout + live.stderr);
  const bad = runPwsh(script, "not-a-number");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /not an epoch in milliseconds/);
});
