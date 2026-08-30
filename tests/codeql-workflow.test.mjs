import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CodeQL advanced setup analyzes both source languages with pinned least privilege", async () => {
  const workflow = (await readFile(".github/workflows/codeql.yml", "utf8")).replace(/\r\n/g, "\n");
  assert.match(workflow, /^name: CodeQL$/m);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /language: \[javascript-typescript, python\]/);
  assert.match(workflow, /security-events: write/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(match => match[1]);
  assert.deepEqual(actions, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "github/codeql-action/init@cdf488f595d80d6e07e03d4674febd5ab45fa938",
    "github/codeql-action/analyze@cdf488f595d80d6e07e03d4674febd5ab45fa938",
  ]);
  assert.ok(actions.every(action => /@[a-f0-9]{40}$/.test(action)));
});
