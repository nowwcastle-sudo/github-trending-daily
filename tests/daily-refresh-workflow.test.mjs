import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflowPath = ".github/workflows/daily-refresh.yml";
const recoveryPath = ".github/workflows/update-star-history.yml";
const allowedOutputs = [
  "index.html",
  "data/repo-summaries.json",
  "data/star-observations.sqlite",
  "star-history.json",
  "data/latest.json",
  "data/translation-sources.json",
  "translations/eu-country.json",
];

function stepScript(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing ${name} step`);
  const end = workflow.indexOf("\n      - ", start + 1);
  const section = workflow.slice(start, end < 0 ? workflow.length : end);
  const marker = "        run: |\n";
  const run = section.indexOf(marker);
  assert.ok(run >= 0, `missing ${name} script`);
  return section.slice(run + marker.length).replace(/^ {10}/gm, "").trimEnd();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function bashPath() {
  if (process.platform !== "win32") return "bash";
  return "C:\\Program Files\\Git\\bin\\bash.exe";
}

async function initializeRepository() {
  const directory = await mkdtemp(join(tmpdir(), "daily-refresh-workflow-"));
  await mkdir(join(directory, "data"));
  await writeFile(join(directory, ".gitignore"), "bin/\npublish.sh\npush.log\n");
  for (const file of allowedOutputs) {
    const filePath = join(directory, file);
    mkdirSync(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, `${file} baseline\n`);
  }
  assert.equal(run("git", ["init", "-q"], { cwd: directory }).status, 0);
  assert.equal(run("git", ["config", "user.name", "test"], { cwd: directory }).status, 0);
  assert.equal(run("git", ["config", "user.email", "test@example.invalid"], { cwd: directory }).status, 0);
  assert.equal(run("git", ["add", "."], { cwd: directory }).status, 0);
  assert.equal(run("git", ["commit", "-qm", "baseline"], { cwd: directory }).status, 0);
  return directory;
}

async function installGitWrapper(directory) {
  const bin = join(directory, "bin");
  await mkdir(bin);
  const wrapper = join(bin, "git");
  await writeFile(wrapper, `#!/usr/bin/env bash
if [ "$1" = "grep" ] && [ "${"$"}SCAN_MODE" = "error" ]; then exit 2; fi
if [ "$1" = "push" ]; then printf '%s\\n' "$*" >> "${"$"}GIT_LOG"; exit 0; fi
exec "${"$"}REAL_GIT" "$@"
`);
  await chmod(wrapper, 0o755);
}

function runBashScript(directory, filename, environment = {}) {
  const command = [
    'REAL_GIT="$(command -v git)"',
    "export REAL_GIT",
    'export PATH="$PWD/bin:$PATH"',
    `bash ${filename}`,
  ].join("; ");
  return run(bashPath(), ["-c", command], {
    cwd: directory,
    env: { ...process.env, ...environment },
  });
}

test("primary and recovery workflows have exact safe scheduling and runtime contracts", async () => {
  const [workflow, recovery, attributes] = await Promise.all([
    readFile(workflowPath, "utf8").then(s => s.replace(/\r\n/g, "\n")),
    readFile(recoveryPath, "utf8").then(s => s.replace(/\r\n/g, "\n")),
    readFile(".gitattributes", "utf8"),
  ]);
  const onBlock = /^on:\n([ \t].*\n?)+/m.exec(workflow)?.[0] ?? "";
  const permissionsBlock = /^permissions:\n([ \t].*\n?)+/m.exec(workflow)?.[0] ?? "";
  const concurrencyBlock = /^concurrency:\n([ \t].*\n?)+/m.exec(workflow)?.[0] ?? "";

  assert.match(onBlock, /^on:\n  schedule:\n    - cron: "7 \*\/2 \* \* \*"\n  workflow_dispatch:\s*$/);
  assert.doesNotMatch(onBlock, /^  push:/m);
  assert.match(permissionsBlock, /^permissions:\n  contents: write\s*$/);
  assert.match(concurrencyBlock, /^concurrency:\n  group: daily-refresh\n  cancel-in-progress: false\s*$/);
  assert.match(recovery, /^concurrency:\n  group: daily-refresh\n  cancel-in-progress: false\s*$/m);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /python-version: "3\.13"/);
  for (const source of [workflow, recovery]) {
    assert.doesNotMatch(source, /uses:\s+actions\/(?:checkout|setup-node|setup-python)@v\d/);
    for (const match of source.matchAll(/uses:\s+actions\/(?:checkout|setup-node|setup-python)@([^\s#]+)/g)) {
      assert.match(match[1], /^[0-9a-f]{40}$/);
    }
  }
  assert.match(workflow, /node-version: "24"[\s\S]*?run: npm ci[\s\S]*?run: npm test/);
  assert.match(recovery, /node-version: "24"[\s\S]*?run: npm ci[\s\S]*?run: npm test/);
  assert.equal(attributes.trim(), ".github/workflows/*.yml text eol=lf");
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(match => match[1]), ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
  assert.doesNotMatch(workflow, /continue-on-error|force(?:-with-lease)?|rebase|git push[^\n]*--force|pull-requests:\s*write|actions:\s*write/);
});

test("tests and complete validation surround the exact production order", async () => {
  const workflow = await readFile(workflowPath, "utf8").then(s => s.replace(/\r\n/g, "\n"));
  const fragments = [
    "npm ci",
    "npm test",
    "node scripts/update-trending.mjs",
    "node scripts/generate-translations.mjs",
    "python scripts/record_star_observations.py",
    "node scripts/update-latest-feed.mjs",
    "node scripts/update-star-history.mjs",
    "StarHistory.normalizeCache",
    "validate_canonical_legacy_baseline",
    "PRAGMA integrity_check",
    "PRAGMA foreign_key_check",
    "star-observations.sqlite-journal",
    "npm test",
    "git diff --check --",
    "git add -- index.html data/repo-summaries.json data/star-observations.sqlite star-history.json",
    "git grep --cached -qE",
    "git commit -m \"chore: refresh trending snapshot\"",
    "git push origin HEAD:main",
  ];
  const positions = [];
  let from = 0;
  for (const fragment of fragments) {
    const position = workflow.indexOf(fragment, from);
    assert.ok(position >= 0, `missing or out-of-order workflow fragment: ${fragment}`);
    positions.push(position);
    from = position + fragment.length;
  }
  assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position));
  assert.match(workflow, /case "\$path" in[\s\S]*?translations\/\*\.json\) ;;/);
  assert.doesNotMatch(workflow, /git add (?:\.|-A|--all)/);
});

test("generation shell stops after an upstream failure", async t => {
  const workflow = await readFile(workflowPath, "utf8").then(s => s.replace(/\r\n/g, "\n"));
  const directory = await mkdtemp(join(tmpdir(), "daily-generation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "generate.sh"), `${stepScript(workflow, "Generate complete trending snapshot")}\n`);
  await writeFile(join(directory, "bin", "node"), "#!/usr/bin/env bash\necho node:$* >> commands.log\nexit 17\n");
  await writeFile(join(directory, "bin", "python"), "#!/usr/bin/env bash\necho python:$* >> commands.log\n");
  await chmod(join(directory, "bin", "node"), 0o755);
  await chmod(join(directory, "bin", "python"), 0o755);

  const result = run(bashPath(), ["generate.sh"], {
    cwd: directory,
    env: { ...process.env, PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 17);
  assert.equal(await readFile(join(directory, "commands.log"), "utf8"), "node:scripts/update-trending.mjs\n");
});

test("recovery validation shell stops before diff and publication after Node failure", async t => {
  const recovery = await readFile(recoveryPath, "utf8").then(s => s.replace(/\r\n/g, "\n"));
  assert.match(stepScript(recovery, "Validate generated cache"), /^set -euo pipefail\n/);
  assert.ok(recovery.indexOf("Validate generated cache") < recovery.indexOf("Commit changed cache"));
  assert.doesNotMatch(recovery, /continue-on-error/);
  const directory = await mkdtemp(join(tmpdir(), "star-recovery-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "validate.sh"), `${stepScript(recovery, "Validate generated cache")}\n`);
  await writeFile(join(directory, "bin", "node"), "#!/usr/bin/env bash\necho node >> commands.log\nexit 23\n");
  await writeFile(join(directory, "bin", "git"), "#!/usr/bin/env bash\necho git >> commands.log\n");
  await chmod(join(directory, "bin", "node"), 0o755);
  await chmod(join(directory, "bin", "git"), 0o755);

  const result = run(bashPath(), ["validate.sh"], {
    cwd: directory,
    env: { ...process.env, PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 23);
  assert.equal(await readFile(join(directory, "commands.log"), "utf8"), "node\n");
});

test("publication shell handles no-change and commits only an exact DB-only change", async t => {
  const workflow = await readFile(workflowPath, "utf8").then(s => s.replace(/\r\n/g, "\n"));
  const script = `${stepScript(workflow, "Publish validated snapshot")}\n`;
  const directory = await initializeRepository();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await installGitWrapper(directory);
  await writeFile(join(directory, "publish.sh"), script);
  const log = join(directory, "push.log");
  const before = run("git", ["rev-parse", "HEAD"], { cwd: directory }).stdout.trim();

  const noChange = runBashScript(directory, "publish.sh", { GIT_LOG: log });
  assert.equal(noChange.status, 0, noChange.stderr);
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: directory }).stdout.trim(), before);

  await writeFile(join(directory, "data", "star-observations.sqlite"), "new Seoul day\n");
  const changed = runBashScript(directory, "publish.sh", { GIT_LOG: log });
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(
    run("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd: directory }).stdout.trim(),
    "data/star-observations.sqlite",
  );
  assert.equal((await readFile(log, "utf8")).trim(), "push origin HEAD:main");
});

test("publication fails closed on a secret match, scanner error, or unexpected output", async t => {
  const workflow = await readFile(workflowPath, "utf8").then(s => s.replace(/\r\n/g, "\n"));
  const script = `${stepScript(workflow, "Publish validated snapshot")}\n`;

  for (const scenario of ["secret", "scanner", "unexpected"]) {
    const directory = await initializeRepository();
    t.after(() => rm(directory, { recursive: true, force: true }));
    await installGitWrapper(directory);
    await writeFile(join(directory, "publish.sh"), script);
    const log = join(directory, "push.log");
    const before = run("git", ["rev-parse", "HEAD"], { cwd: directory }).stdout.trim();
    if (scenario === "secret") {
      await writeFile(join(directory, "star-history.json"), `github_pat_${"A".repeat(30)}\n`);
    } else if (scenario === "scanner") {
      await writeFile(join(directory, "index.html"), "changed\n");
    } else {
      await writeFile(join(directory, "unexpected.txt"), "not allowed\n");
    }

    const result = runBashScript(directory, "publish.sh", {
      GIT_LOG: log,
      SCAN_MODE: scenario === "scanner" ? "error" : "",
    });
    assert.notEqual(result.status, 0, `${scenario} should fail`);
    assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: directory }).stdout.trim(), before);
    await assert.rejects(readFile(log, "utf8"));
  }
});

test("READMEs retain only the three requested sections and document the Seoul refresh", async () => {
  for (const file of ["README.md", "README.en.md"]) {
    const value = await readFile(file, "utf8");
    const headings = [...value.matchAll(/^## (.+)$/gm)].map(match => match[1]);
    assert.equal(headings.length, 3, `${file} must keep exactly three content sections`);
    assert.match(value, /(?:2시간|two hours)/i);
    assert.match(value, /07/);
    assert.match(value, /(?:Asia\/Seoul|서울|Seoul)/);
  }
});
