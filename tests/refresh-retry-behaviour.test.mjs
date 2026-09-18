import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The retry only acts after a failed refresh, and only for failures where the enrichment job ran no
// step - so a green pipeline never reaches its dispatch line. Until 2026-09-18 that line could not
// have worked at all: this job has no checkout, and without --repo gh exits "not a git repository".
// Nothing showed it, because no run had ever reached the line. These run the script itself.

const retryPath = ".github/workflows/refresh-retry.yml";
const ENRICH_JOB_NAME = "Generate source-bound summaries";
const BLOCK_INDENT = " ".repeat(10);

async function retryScript() {
  const workflow = (await readFile(retryPath, "utf8")).replace(/\r\n/g, "\n");
  const marker = "\n        run: |\n";
  const runStart = workflow.indexOf(marker);
  assert.ok(runStart >= 0, "the retry step has no run block");
  const lines = [];
  for (const line of workflow.slice(runStart + marker.length).split("\n")) {
    if (line.trim() === "") { lines.push(""); continue; }
    if (!line.startsWith(BLOCK_INDENT)) break;
    lines.push(line.slice(BLOCK_INDENT.length));
  }
  const script = lines.join("\n");
  assert.match(script, /gh workflow run daily-refresh\.yml/, "the extracted block is not the retry script");
  return script;
}

// gh is a shell function: bash resolves it before any executable, so the stub needs no temporary
// files, and it keeps its counters in the shell the script runs in. jq stays real, because the
// script's own jq expressions are part of what is under test.
const STUBS = `
dispatches=0
dispatch_without_repo=0
unexpected_gh=0
trap 'printf "HARNESS dispatches=%d dispatch_without_repo=%d unexpected_gh=%d\\n" "$dispatches" "$dispatch_without_repo" "$unexpected_gh"' EXIT

gh() {
  if [ "$1" = "api" ] && [ "$2" = "repos/$GITHUB_REPOSITORY/actions/runs/$FAILED_RUN_ID/jobs?per_page=100" ]; then
    printf '%s\\n' "$T_JOBS_JSON"
    return 0
  fi
  if [ "$1" = "workflow" ] && [ "$2" = "run" ] && [ "$3" = "daily-refresh.yml" ]; then
    dispatches=$(( dispatches + 1 ))
    case "$*" in
      *"--ref $TARGET_REF"*"--repo $GITHUB_REPOSITORY"*) ;;
      *) dispatch_without_repo=1 ;;
    esac
    return 0
  fi
  unexpected_gh=$(( unexpected_gh + 1 ))
  return 64
}
`;

const toolsReady = (() => {
  const probe = spawnSync("bash", ["-c", "command -v jq >/dev/null && echo ready"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "ready";
})();
const skip = toolsReady ? false : "bash with jq is unavailable";

function enrichJob({ conclusion, runner = "", steps = [] }) {
  return { name: ENRICH_JOB_NAME, status: "completed", conclusion, runner_name: runner, steps };
}

function runRetry(script, jobs) {
  const result = spawnSync("bash", ["-c", `${STUBS}\n${script}`], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      T_JOBS_JSON: JSON.stringify({ jobs }),
      RUNNER_TEMP: process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
      GITHUB_REPOSITORY: "owner/repo",
      FAILED_RUN_ID: "4242",
      TARGET_REF: "main",
      ENRICH_JOB_NAME,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.signal, null, `the retry script did not finish:\n${output}`);
  const counters = /HARNESS dispatches=(\d+) dispatch_without_repo=(\d+) unexpected_gh=(\d+)/.exec(output);
  assert.ok(counters, `the harness never reported its counters:\n${output}`);
  assert.equal(Number(counters[3]), 0, `the retry called gh in a way the stub does not expect:\n${output}`);
  return { status: result.status, output, dispatches: Number(counters[1]), withoutRepo: Number(counters[2]) };
}

const RAN_A_STEP = [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }];
const NEVER_STARTED = [{ number: 1, name: "Set up job", status: "queued", conclusion: null }];

test("a job that was never acquired is retried once, naming the repository", { skip }, async () => {
  const run = runRetry(await retryScript(), [enrichJob({ conclusion: "cancelled" })]);
  assert.equal(run.status, 0);
  assert.equal(run.dispatches, 1);
  assert.equal(run.withoutRepo, 0, "the dispatch must name the repository; this job has no checkout for gh to infer one from");
  assert.match(run.output, /lost its job before any step ran/);
});

// The shape of both 2026-09-17 failures: GitHub recorded the runner, the runner killed its own
// worker before handing it the job, and the job reported failure with no step on record.
test("a job whose runner was lost before any step ran is retried once, naming the repository", { skip }, async () => {
  const script = await retryScript();
  for (const steps of [[], NEVER_STARTED]) {
    const run = runRetry(script, [enrichJob({ conclusion: "failure", runner: "nasca-gh-trending-claude", steps })]);
    assert.equal(run.status, 0);
    assert.equal(run.dispatches, 1, `a lost runner with steps ${JSON.stringify(steps)} must be retried`);
    assert.equal(run.withoutRepo, 0);
    assert.match(run.output, /lost runner nasca-gh-trending-claude before any step ran/);
  }
});

test("a failure in which the enrichment job ran a step is the refresh's own and is left to be read", { skip }, async () => {
  const script = await retryScript();
  for (const job of [
    enrichJob({ conclusion: "failure", runner: "nasca-gh-trending-claude", steps: RAN_A_STEP }),
    enrichJob({ conclusion: "cancelled", runner: "nasca-gh-trending-claude", steps: RAN_A_STEP }),
  ]) {
    const run = runRetry(script, [job]);
    assert.equal(run.status, 0);
    assert.equal(run.dispatches, 0, `${job.conclusion} after a step ran must not be retried`);
    assert.match(run.output, /after the enrichment job ran a step; leaving it failed to be read/);
  }
});

test("a shape with no step run but no known cause is left alone rather than guessed at", { skip }, async () => {
  const script = await retryScript();
  for (const job of [
    // prepare failed, so enrichment never became eligible: a real failure upstream.
    enrichJob({ conclusion: "skipped" }),
    // the two combinations neither known shape produces.
    enrichJob({ conclusion: "cancelled", runner: "nasca-gh-trending-claude" }),
    enrichJob({ conclusion: "failure" }),
  ]) {
    const run = runRetry(script, [job]);
    assert.equal(run.status, 0);
    assert.equal(run.dispatches, 0, `${job.conclusion} on runner [${job.runner_name}] must not be retried`);
    assert.match(run.output, /not a shape this retries/);
  }
});

test("a missing enrichment job stops the retry instead of dispatching blind", { skip }, async () => {
  const run = runRetry(await retryScript(), [{ name: "Some other job", status: "completed", conclusion: "failure", runner_name: "", steps: [] }]);
  assert.equal(run.status, 1);
  assert.equal(run.dispatches, 0);
  assert.match(run.output, /the guard is stale/);
});
