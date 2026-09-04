import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the tests workflow runs npm ci and npm test on pull requests and pushes to main with pinned least privilege", async () => {
  const workflow = (await readFile(".github/workflows/tests.yml", "utf8")).replace(/\r\n/g, "\n");
  assert.match(workflow, /^name: Tests$/m);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /^permissions:\n\s+contents: read$/m);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /timeout-minutes: \d+/);

  const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(match => match[1]);
  assert.deepEqual(actions, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
  ]);
  assert.ok(actions.every(action => /@[a-f0-9]{40}$/.test(action)), "every action must be pinned to a 40-hex commit SHA");
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /cache: npm/);
  assert.match(workflow, /python-version: "3\.13"/);

  // setup-python must appear before the step that runs the test suite, so `python` is on PATH.
  const setupPythonIndex = workflow.indexOf("actions/setup-python");
  const npmTestIndex = workflow.indexOf("run: npm test");
  assert.ok(setupPythonIndex !== -1 && npmTestIndex !== -1 && setupPythonIndex < npmTestIndex);

  const runs = [...workflow.matchAll(/run: (npm .+)/g)].map(match => match[1]);
  assert.deepEqual(runs, ["npm ci", "npm test"]);
  assert.doesNotMatch(workflow, /test:rules/, "the Firestore rules suite needs the emulator and stays out of CI");
});
