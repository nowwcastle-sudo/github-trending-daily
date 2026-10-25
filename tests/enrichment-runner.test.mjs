import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("the Windows enrichment wrapper preserves the official runner lifecycle and sanitized environment", {
  skip: process.platform !== "win32",
}, t => {
  const root = mkdtempSync(join(tmpdir(), "trending runner lifecycle "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const variables = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_VERTEX",
  ];
  copyFileSync(new URL("../scripts/run-enrichment-runner.ps1", import.meta.url), join(root, "run-sanitized.ps1"));
  writeFileSync(join(root, "run.cmd"), [
    "@echo off",
    ...variables.map(name => `if defined ${name} exit /b 11`),
    'if not "%GITHUB_ACTIONS_RUNNER_CHANNEL_TIMEOUT%"=="300" exit /b 12',
    "echo official-runner-launcher-invoked",
    "exit /b 7",
  ].join("\r\n"));
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", join(root, "run-sanitized.ps1")], {
    env: { ...process.env, ...Object.fromEntries(variables.map(name => [name, "test-sentinel"])) },
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /official-runner-launcher-invoked/);
});
