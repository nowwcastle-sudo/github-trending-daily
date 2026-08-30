import { spawn } from "node:child_process";

import { parseJsonStrict } from "./build-pages-artifact.mjs";

export const MAX_CLAUDE_STDIN_BYTES = 8 * 1024 * 1024;

const MINIMUM_CLAUDE_VERSION = Object.freeze([2, 1, 211]);
const MAX_AUTH_OUTPUT_BYTES = 64 * 1024;
const MAX_STRUCTURED_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 5_000;
const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "APPDATA",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

function childEnvironment(environment) {
  if (!environment || Array.isArray(environment) || typeof environment !== "object") {
    throw new Error("Claude CLI environment is invalid");
  }
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => {
    return typeof value === "string" && ALLOWED_ENVIRONMENT_NAMES.has(name.toUpperCase());
  }));
}

function checkedProcessResult(value) {
  if (!value || !Number.isInteger(value.exitCode) && value.exitCode !== null
      || typeof value.stdout !== "string" || typeof value.stderr !== "string"
      || typeof value.timedOut !== "boolean") {
    throw new Error("Claude CLI process result is invalid");
  }
  return value;
}

export function runBoundedClaudeProcess({
  command = "claude",
  args,
  input = "",
  environment,
  cwd = process.cwd(),
  timeoutMs,
  maxStdoutBytes = MAX_STRUCTURED_OUTPUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
} = {}) {
  if (typeof command !== "string" || !command || !Array.isArray(args) || args.some(value => typeof value !== "string") || typeof input !== "string"
      || typeof cwd !== "string" || !cwd || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1
      || !Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 1) {
    return Promise.reject(new Error("Claude CLI process configuration is invalid"));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new Error("Claude CLI process failed to start"));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let terminating = false;
    let terminationTimer;
    function result(code) {
      return {
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputExceeded,
      };
    }
    function settle(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      resolve(result(code));
    }
    const terminateProcessTree = () => {
      if (settled || terminating) return;
      terminating = true;
      if (process.platform === "win32" && Number.isSafeInteger(child.pid)) {
        try {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            env: childEnvironment(environment), shell: false, stdio: "ignore", windowsHide: true,
          });
          killer.on("error", () => { /* hard settlement below remains authoritative */ });
        } catch { /* hard settlement below remains authoritative */ }
      } else {
        try { child.kill("SIGTERM"); } catch { /* hard settlement below remains authoritative */ }
      }
      terminationTimer ??= setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(null);
      }, TERMINATION_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree();
    }, timeoutMs);
    function collect(chunks, chunk, current, maximum) {
      if (current + chunk.length > maximum) {
        outputExceeded = true;
        terminateProcessTree();
        return current;
      }
      chunks.push(chunk);
      return current + chunk.length;
    }
    child.stdout.on("data", chunk => { stdoutBytes = collect(stdout, chunk, stdoutBytes, maxStdoutBytes); });
    child.stderr.on("data", chunk => { stderrBytes = collect(stderr, chunk, stderrBytes, maxStderrBytes); });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      reject(new Error("Claude CLI process failed to start"));
    });
    child.on("close", code => {
      settle(code);
    });
    child.stdin.on("error", error => {
      if (error?.code !== "EPIPE") terminateProcessTree();
    });
    child.stdin.end(input, "utf8");
  });
}

async function executeProcess({ runProcess, args, input = "", environment, cwd, timeoutMs, maxStdoutBytes }) {
  let result;
  try {
    result = await runProcess({
      args,
      input,
      environment: childEnvironment(environment),
      cwd,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
  } catch {
    throw new Error("Claude CLI process execution failed");
  }
  return checkedProcessResult(result);
}

function versionTuple(text) {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(text.trim());
  if (!match) throw new Error("Claude CLI version output is invalid");
  return { text: `${match[1]}.${match[2]}.${match[3]}`, values: match.slice(1).map(Number) };
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export async function runClaudeOAuthPreflight({
  runProcess = runBoundedClaudeProcess,
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  if (typeof runProcess !== "function") throw new Error("Claude CLI preflight configuration is invalid");
  const versionResult = await executeProcess({
    runProcess, args: ["--version"], environment, cwd, timeoutMs: 30_000, maxStdoutBytes: MAX_AUTH_OUTPUT_BYTES,
  });
  if (versionResult.exitCode !== 0 || versionResult.timedOut || versionResult.outputExceeded) {
    throw new Error("Claude CLI version preflight failed");
  }
  const version = versionTuple(versionResult.stdout);
  if (!atLeast(version.values, MINIMUM_CLAUDE_VERSION)) throw new Error("Claude CLI version is below the supported minimum");
  const authResult = await executeProcess({
    runProcess, args: ["auth", "status", "--json"], environment, cwd, timeoutMs: 30_000, maxStdoutBytes: MAX_AUTH_OUTPUT_BYTES,
  });
  if (authResult.exitCode !== 0 || authResult.timedOut || authResult.outputExceeded) {
    throw new Error("Claude CLI OAuth preflight failed");
  }
  const auth = parseJsonStrict(Buffer.from(authResult.stdout, "utf8"), "Claude CLI auth status", MAX_AUTH_OUTPUT_BYTES);
  if (auth?.loggedIn !== true || auth.authMethod !== "oauth_token" || auth.apiProvider !== "firstParty") {
    throw new Error("Claude CLI must use a first-party OAuth subscription session");
  }
  return { version: version.text, authMethod: auth.authMethod, apiProvider: auth.apiProvider };
}

function usageReceipt(value) {
  const usage = value?.usage;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  if (![input, output, cacheCreate, cacheRead].every(token => Number.isSafeInteger(token) && token >= 0)) {
    throw new Error("Claude CLI usage receipt is invalid");
  }
  return { inputTokens: input + cacheCreate + cacheRead, outputTokens: output };
}

function executionFailure(result) {
  if (result.timedOut) {
    const error = new Error("Claude CLI request timed out");
    error.retryable = true;
    return error;
  }
  if (result.outputExceeded) return new Error("Claude CLI output exceeds the fixed byte cap");
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  const error = new Error("Claude CLI request failed");
  error.retryable = /(?:\b429\b|rate.?limit|overload|\b50[0234]\b|server.?error|timed?.?out|connection)/i.test(diagnostic);
  return error;
}

export async function runClaudeStructuredRequest({
  prompt,
  schema,
  model,
  runProcess = runBoundedClaudeProcess,
  environment = process.env,
  cwd = process.cwd(),
  timeoutMs,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt, "utf8") > MAX_CLAUDE_STDIN_BYTES
      || !schema || Array.isArray(schema) || typeof schema !== "object"
      || typeof model !== "string" || !model || typeof runProcess !== "function"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Claude CLI structured request configuration is invalid");
  }
  const result = await executeProcess({
    runProcess,
    args: [
      "-p",
      "--safe-mode",
      "--model", model,
      "--tools", "",
      "--disable-slash-commands",
      "--permission-mode", "dontAsk",
      "--no-chrome",
      "--no-session-persistence",
      "--max-turns", "2",
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
    ],
    input: prompt,
    environment,
    cwd,
    timeoutMs,
    maxStdoutBytes: MAX_STRUCTURED_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) throw executionFailure(result);
  const value = parseJsonStrict(Buffer.from(result.stdout, "utf8"), "Claude CLI response", MAX_STRUCTURED_OUTPUT_BYTES);
  if (value?.type !== "result" || value.subtype !== "success" || value.is_error !== false
      || !Object.hasOwn(value, "structured_output")) {
    throw new Error("Claude CLI structured output is invalid");
  }
  return { structuredOutput: value.structured_output, usage: usageReceipt(value) };
}
