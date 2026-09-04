import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("feature requests have a template and blank issues are disabled", async () => {
  const config = (await readFile(".github/ISSUE_TEMPLATE/config.yml", "utf8")).replace(/\r\n/g, "\n");
  assert.match(config, /^blank_issues_enabled: false$/m);

  const template = (await readFile(".github/ISSUE_TEMPLATE/feature_request.yml", "utf8")).replace(/\r\n/g, "\n");
  assert.match(template, /^name: Feature request$/m);
  assert.match(template, /^description: .+$/m);
  assert.match(template, /^labels: \[enhancement\]$/m);
  assert.match(template, /^body:$/m);
  for (const id of ["problem", "proposal", "alternatives"]) {
    assert.match(template, new RegExp(`id: ${id}\\n`), `${id} field must exist`);
  }
  assert.match(template, /required: true/);
});
