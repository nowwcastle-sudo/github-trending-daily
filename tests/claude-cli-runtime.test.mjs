import assert from "node:assert/strict";
import test from "node:test";

import {
  runBoundedClaudeProcess,
  runClaudeOAuthPreflight,
  runClaudeStructuredRequest,
} from "../scripts/claude-cli-runtime.mjs";

const forbiddenEnvironment = {
  ANTHROPIC_API_KEY: "api-key-must-not-reach-child",
  ANTHROPIC_AUTH_TOKEN: "auth-token-must-not-reach-child",
  ANTHROPIC_BASE_URL: "https://example.invalid",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  GITHUB_TOKEN: "github-token-must-not-reach-child",
  GH_TOKEN: "gh-token-must-not-reach-child",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-subscription-token-required-by-child",
  OPENAI_API_KEY: "unrelated-secret-must-not-reach-child",
  NPM_TOKEN: "package-secret-must-not-reach-child",
  AWS_SECRET_ACCESS_KEY: "cloud-secret-must-not-reach-child",
  PATH: "test-path",
};

test("Claude CLI preflight requires a current first-party OAuth session and strips provider secrets", async () => {
  const calls = [];
  const runProcess = async input => {
    calls.push(input);
    if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.241 (Claude Code)\n", stderr: "", timedOut: false };
    return {
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }),
      stderr: "",
      timedOut: false,
    };
  };

  assert.deepEqual(await runClaudeOAuthPreflight({ runProcess, environment: forbiddenEnvironment }), {
    version: "2.1.241",
    authMethod: "oauth_token",
    apiProvider: "firstParty",
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.environment.PATH, "test-path");
    assert.equal(call.environment.CLAUDE_CODE_OAUTH_TOKEN, "oauth-subscription-token-required-by-child");
    for (const name of Object.keys(forbiddenEnvironment).filter(name => !["PATH", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name))) {
      assert.equal(Object.hasOwn(call.environment, name), false, name);
    }
  }
});

test("production process boundary forcibly settles a non-closing child after timeout", async () => {
  const started = Date.now();
  const result = await runBoundedClaudeProcess({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    environment: process.env,
    timeoutMs: 50,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 7_000);
});

test("Claude CLI preflight rejects API-key or third-party authentication before a model call", async () => {
  let calls = 0;
  const runProcess = async input => {
    calls += 1;
    if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.241\n", stderr: "", timedOut: false };
    return {
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }),
      stderr: "",
      timedOut: false,
    };
  };
  await assert.rejects(runClaudeOAuthPreflight({ runProcess, environment: {} }), /OAuth|first-party/i);
  assert.equal(calls, 2);
});

test("Claude CLI structured requests pipe untrusted input with no tools and return only validated structured output usage", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  };
  let invocation;
  const result = await runClaudeStructuredRequest({
    prompt: "UNTRUSTED README DATA",
    schema,
    model: "claude-sonnet-5",
    environment: forbiddenEnvironment,
    timeoutMs: 1_000,
    runProcess: async input => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { answer: "source-bound" },
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
            output_tokens: 30,
          },
          total_cost_usd: 99,
        }),
        stderr: "",
        timedOut: false,
      };
    },
  });

  assert.equal(invocation.input, "UNTRUSTED README DATA");
  assert.equal(invocation.args.includes("UNTRUSTED README DATA"), false);
  assert.deepEqual(invocation.args.slice(0, 2), ["-p", "--safe-mode"]);
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "claude-sonnet-5");
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
  assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(invocation.args.includes("--no-session-persistence"));
  assert.ok(invocation.args.includes("--disable-slash-commands"));
  assert.deepEqual(JSON.parse(invocation.args[invocation.args.indexOf("--json-schema") + 1]), schema);
  assert.equal(Object.hasOwn(invocation.environment, "ANTHROPIC_API_KEY"), false);
  assert.deepEqual(result, {
    structuredOutput: { answer: "source-bound" },
    usage: { inputTokens: 130, outputTokens: 30 },
  });
  assert.equal(Object.hasOwn(result, "totalCostUsd"), false);
});

test("Claude CLI structured requests fail closed on timeout and missing structured output", async () => {
  const schema = { type: "object" };
  await assert.rejects(
    runClaudeStructuredRequest({
      prompt: "input",
      schema,
      model: "claude-sonnet-5",
      environment: {},
      timeoutMs: 1,
      runProcess: async () => ({ exitCode: null, stdout: "", stderr: "sensitive diagnostic", timedOut: true }),
    }),
    error => error?.retryable === true
      && error?.failureCode === "CLAUDE_TIMEOUT"
      && !String(error.message).includes("sensitive diagnostic"),
  );
  await assert.rejects(
    runClaudeStructuredRequest({
      prompt: "input",
      schema,
      model: "claude-sonnet-5",
      environment: {},
      timeoutMs: 1,
      runProcess: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }),
        stderr: "",
        timedOut: false,
      }),
    }),
    /structured output/i,
  );
});

test("Claude CLI request failures expose only bounded diagnostic codes", async () => {
  const schema = { type: "object" };
  const request = stderr => runClaudeStructuredRequest({
    prompt: "input",
    schema,
    model: "claude-sonnet-5",
    environment: {},
    timeoutMs: 1_000,
    runProcess: async () => ({ exitCode: 1, stdout: "", stderr, timedOut: false }),
  });

  const cases = [
    ["Invalid JSON schema for --json-schema: secret diagnostic", "CLAUDE_SCHEMA_INVALID", false],
    ["OAuth token expired: secret diagnostic", "CLAUDE_AUTH_FAILED", false],
    ["HTTP 429 rate limit: secret diagnostic", "CLAUDE_RATE_LIMITED", true],
    ["HTTP 503 server error: secret diagnostic", "CLAUDE_TRANSIENT_PROVIDER_FAILURE", true],
    ["opaque secret diagnostic", "CLAUDE_REQUEST_FAILED", false],
  ];
  for (const [diagnostic, failureCode, retryable] of cases) {
    await assert.rejects(
      request(diagnostic),
      error => error?.failureCode === failureCode
        && error?.retryable === retryable
        && error.message === "Claude CLI request failed"
        && !JSON.stringify(error).includes("secret diagnostic"),
    );
  }
});
