import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The guard in daily-refresh.yml only does anything during an outage, so a green pipeline never
// executes the lines that matter: the cancellation, the retries, the state test, the refusals.
// Every other workflow test in this suite asserts the file's text, which passes identically
// whether that script works or not. These run the script itself against a stubbed gh.

const workflowPath = ".github/workflows/daily-refresh.yml";
const ENRICH_JOB_NAME = "Generate source-bound summaries";
const BLOCK_INDENT = " ".repeat(10);

async function guardScript() {
  const workflow = (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");
  const jobStart = workflow.indexOf("\n  queue-guard:\n");
  const nextJob = workflow.indexOf("\n  enrich:\n");
  assert.ok(jobStart >= 0, "the queue-guard job is missing");
  assert.ok(nextJob > jobStart, "the queue-guard job no longer precedes enrich");
  const marker = "\n        run: |\n";
  const runStart = workflow.indexOf(marker, jobStart);
  assert.ok(runStart >= 0 && runStart < nextJob, "the queue-guard step has no run block");
  const lines = [];
  for (const line of workflow.slice(runStart + marker.length, nextJob).split("\n")) {
    if (line.trim() === "") { lines.push(""); continue; }
    if (!line.startsWith(BLOCK_INDENT)) break;
    lines.push(line.slice(BLOCK_INDENT.length));
  }
  const script = lines.join("\n");
  assert.match(script, /gh run cancel/, "the extracted block is not the guard script");
  return script;
}

// gh and sleep are shell functions rather than files on PATH: bash resolves a function before any
// executable of the same name, so the stubs need no temporary directory, no chmod and no PATH
// juggling, and they can keep their counters in the same shell the guard runs in.
const STUBS = `
statuses=( $T_JOB_STATUSES )
cancel_results=( $T_CANCEL_RESULTS )
poll=0
cancels=0
cancel_without_repo=0
run_status_reads=0

trap 'printf "HARNESS polls=%d cancels=%d cancel_without_repo=%d run_status_reads=%d\\n" "$poll" "$cancels" "$cancel_without_repo" "$run_status_reads"' EXIT

gh() {
  if [ "$1" = "api" ]; then
    case "$2" in
      */jobs\\?*)
        local token="\${statuses[$poll]:-\${statuses[\${#statuses[@]}-1]}}"
        poll=$(( poll + 1 ))
        case "$token" in
          FAIL) return 1 ;;
          ABSENT) printf '{"jobs":[{"name":"Some other job","status":"queued"}]}\\n' ;;
          MALFORMED) printf 'this is not json\\n' ;;
          *) printf '{"jobs":[{"name":"${ENRICH_JOB_NAME}","status":"%s"}]}\\n' "$token" ;;
        esac
        return 0
        ;;
      *)
        run_status_reads=$(( run_status_reads + 1 ))
        [ "$T_RUN_STATUS" = "FAIL" ] && return 1
        printf '%s\\n' "$T_RUN_STATUS"
        return 0
        ;;
    esac
  fi
  if [ "$1" = "run" ] && [ "$2" = "cancel" ]; then
    local token="\${cancel_results[$cancels]:-\${cancel_results[\${#cancel_results[@]}-1]}}"
    cancels=$(( cancels + 1 ))
    case "$*" in
      *"--repo $GITHUB_REPOSITORY"*) ;;
      *) cancel_without_repo=1 ;;
    esac
    [ "$token" = "ok" ] && return 0
    return 1
  fi
  return 64
}

sleep() { :; }
`;

const bashAvailable = spawnSync("bash", ["-c", 'command -v jq >/dev/null && [ -n "${EPOCHREALTIME:-}" ] && echo ready'], { encoding: "utf8" });
const ready = bashAvailable.status === 0 && bashAvailable.stdout.trim() === "ready";

function runGuard(script, { statuses, cancels = "ok", runStatus = "in_progress", deadlineOffsetMs = -1000, deadline }) {
  const result = spawnSync("bash", ["-c", `${STUBS}\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      T_JOB_STATUSES: statuses,
      T_CANCEL_RESULTS: cancels,
      T_RUN_STATUS: runStatus,
      RUNNER_TEMP: process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "4242",
      ENRICH_JOB_NAME,
      ENRICHMENT_DEADLINE_EPOCH_MS: deadline ?? String(Date.now() + deadlineOffsetMs),
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const counters = /HARNESS polls=(\d+) cancels=(\d+) cancel_without_repo=(\d+) run_status_reads=(\d+)/.exec(output);
  assert.ok(counters, `the harness never reported its counters:\n${output}`);
  return {
    status: result.status,
    output,
    polls: Number(counters[1]),
    cancels: Number(counters[2]),
    cancelWithoutRepo: Number(counters[3]),
    runStatusReads: Number(counters[4]),
  };
}

// A past deadline makes the loop take exactly one poll - the deadline is checked after the status
// is read - so every "deadline reached" case is deterministic without waiting for anything.
const REACHED = -1000;
const AHEAD = 600000;

test("the guard cancels a run whose enrichment is still queued at its deadline", { skip: ready ? false : "bash with jq and EPOCHREALTIME is unavailable" }, async () => {
  const script = await guardScript();
  const run = runGuard(script, { statuses: "queued", deadlineOffsetMs: REACHED });
  assert.equal(run.status, 0);
  assert.equal(run.cancels, 1);
  assert.equal(run.cancelWithoutRepo, 0, "the cancellation must name the repository; this job has no checkout for gh to infer one from");
  assert.match(run.output, /still queued at its own deadline/);
});

test("only a state that proves execution began stands the guard down", { skip: ready ? false : "bash with jq and EPOCHREALTIME is unavailable" }, async () => {
  const script = await guardScript();
  for (const statuses of ["in_progress", "completed"]) {
    const run = runGuard(script, { statuses, deadlineOffsetMs: AHEAD });
    assert.equal(run.status, 0);
    assert.equal(run.cancels, 0, `${statuses} must retire the guard without cancelling`);
    assert.match(run.output, /guard stands down/);
  }
  // queued is not the only nonterminal state a workflow job reports. waiting, requested and pending
  // are in the schema too, and reading any of them as "a runner has it" would retire the guard
  // while the stall it exists for is still ahead of it.
  const waited = runGuard(script, { statuses: "waiting requested pending in_progress", deadlineOffsetMs: AHEAD });
  assert.equal(waited.status, 0);
  assert.equal(waited.cancels, 0);
  assert.equal(waited.polls, 4, "waiting, requested and pending must each be polled through, not treated as running");
  // and at the deadline they are cancelled exactly like queued, because none of them ran.
  const stalled = runGuard(script, { statuses: "pending", deadlineOffsetMs: REACHED });
  assert.equal(stalled.status, 0);
  assert.equal(stalled.cancels, 1);
});

test("a failed or unreadable poll is a poll, not a verdict", { skip: ready ? false : "bash with jq and EPOCHREALTIME is unavailable" }, async () => {
  const script = await guardScript();
  // One transient fault used to end the guard through set -e, leaving the run holding the
  // concurrency group for hours - the exact stall being bounded.
  const transient = runGuard(script, { statuses: "FAIL FAIL queued in_progress", deadlineOffsetMs: AHEAD });
  assert.equal(transient.status, 0);
  assert.equal(transient.cancels, 0);
  assert.equal(transient.polls, 4);
  const malformed = runGuard(script, { statuses: "MALFORMED queued in_progress", deadlineOffsetMs: AHEAD });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.polls, 3);
  assert.match(malformed.output, /unreadable/);
});

test("the guard refuses to cancel on no evidence, and says which kind it lacks", { skip: ready ? false : "bash with jq and EPOCHREALTIME is unavailable" }, async () => {
  const script = await guardScript();
  const unread = runGuard(script, { statuses: "FAIL", deadlineOffsetMs: REACHED });
  assert.equal(unread.status, 1);
  assert.equal(unread.cancels, 0);
  assert.match(unread.output, /never read; cancelling on no evidence is not safe/);
  // A job list that was read and never carried this job is what a rename looks like, and a rename
  // must stop the guard rather than turn it on every refresh.
  const renamed = runGuard(script, { statuses: "ABSENT", deadlineOffsetMs: REACHED });
  assert.equal(renamed.status, 1);
  assert.equal(renamed.cancels, 0);
  assert.match(renamed.output, /guard is stale/);
});

test("the cancellation is retried, and a run that already finished is read rather than retried at", { skip: ready ? false : "bash with jq and EPOCHREALTIME is unavailable" }, async () => {
  const script = await guardScript();
  const retried = runGuard(script, { statuses: "queued", cancels: "fail fail ok", deadlineOffsetMs: REACHED });
  assert.equal(retried.status, 0);
  assert.equal(retried.cancels, 3);
  assert.match(retried.output, /cancellation accepted on attempt 3/);
  // gh refuses to cancel a finished run, so retrying that request four more times could only fail.
  const finished = runGuard(script, { statuses: "queued", cancels: "fail", runStatus: "completed", deadlineOffsetMs: REACHED });
  assert.equal(finished.status, 0);
  assert.equal(finished.cancels, 1);
  assert.match(finished.output, /finished on its own/);
  // An unreadable run status is not proof the run finished, so the retries continue.
  const unknown = runGuard(script, { statuses: "queued", cancels: "fail fail ok", runStatus: "FAIL", deadlineOffsetMs: REACHED });
  assert.equal(unknown.status, 0);
  assert.equal(unknown.cancels, 3);
  // A cancellation that never lands is reported, not swallowed: the queue wait is unbounded again.
  const lost = runGuard(script, { statuses: "queued", cancels: "fail", deadlineOffsetMs: REACHED });
  assert.equal(lost.status, 1);
  assert.equal(lost.cancels, 5);
  assert.match(lost.output, /still uncancelled after 5 attempts/);
});

test("a deadline that is not an epoch stops the guard before it reads anything", { skip: ready ? false : "bash with jq and EPOCHREALTIME is unavailable" }, async () => {
  const script = await guardScript();
  for (const deadline of ["", "not-a-number", "123abc", "-1"]) {
    const run = runGuard(script, { statuses: "queued", deadline });
    assert.equal(run.status, 1, `deadline ${JSON.stringify(deadline)} must be rejected`);
    assert.equal(run.polls, 0);
    assert.equal(run.cancels, 0);
    assert.match(run.output, /not an epoch in milliseconds/);
  }
});
