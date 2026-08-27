import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[a-f0-9]{40}$/;
export const MUTABLE_GENERATED_PATHS = Object.freeze([
  "changes.xml",
  "data/latest.json",
  "data/membership-status.json",
  "data/repo-summaries.json",
  "data/star-observations.sqlite",
  "data/translation-sources.json",
  "data/trending-membership.sqlite",
  "feed.xml",
  "index.html",
  "star-history.json",
  "translations",
]);

function git(root, args, options = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: options.encoding ?? "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error?.stderr?.toString().trim();
    throw new Error(message || "git command failed");
  }
}

function normalizeGitPath(value) {
  if (typeof value !== "string" || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("unsafe Git path");
  }
  return value;
}

function safePath(root, relative) {
  normalizeGitPath(relative);
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("unsafe candidate path");
  return target;
}

function treeEntries(root, sha, pathspec = []) {
  const output = git(root, ["ls-tree", "-r", "-z", sha, "--", ...pathspec], { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|tree) ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw new Error("invalid Git tree entry");
    return { mode: match[1], type: match[2], oid: match[3], path: normalizeGitPath(match[4]) };
  });
}

async function rejectLinksAndForbidden(root) {
  async function visit(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git" || entry.name === "node_modules") throw new Error(`forbidden candidate path: ${childRelative}`);
      const child = path.join(directory, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error(`candidate symlink rejected: ${childRelative}`);
      if (info.isDirectory()) await visit(child, childRelative);
      else if (!info.isFile()) throw new Error(`candidate non-file rejected: ${childRelative}`);
    }
  }
  await visit(root);
}

async function writeBlob(checkoutRoot, sha, relative, outDir) {
  const bytes = git(checkoutRoot, ["show", `${sha}:${relative}`], { encoding: "buffer" });
  const destination = safePath(outDir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

export async function prepareRefreshCandidate({ checkoutRoot, outDir, lastGoodSha }) {
  const checkout = path.resolve(checkoutRoot);
  const output = path.resolve(outDir);
  if (output === checkout || output.startsWith(`${checkout}${path.sep}`)) throw new Error("candidate output must be outside the checkout");
  if (!SHA_RE.test(lastGoodSha)) throw new Error("last-good-sha must be a 40-hex commit");
  const originalSha = git(checkout, ["rev-parse", "HEAD"]).trim();
  if (!SHA_RE.test(originalSha)) throw new Error("checkout HEAD is not a commit");
  try { git(checkout, ["merge-base", "--is-ancestor", lastGoodSha, originalSha]); } catch {
    throw new Error("last-good-sha is not an ancestor of checkout HEAD");
  }

  const originalEntries = treeEntries(checkout, originalSha);
  const productionEntries = treeEntries(checkout, lastGoodSha, MUTABLE_GENERATED_PATHS);
  for (const entry of [...originalEntries, ...productionEntries]) {
    if (entry.type !== "blob" || entry.mode === "120000") throw new Error(`Git symlink or non-blob rejected: ${entry.path}`);
    if (entry.path === ".git" || entry.path.startsWith(".git/") || entry.path === "node_modules" || entry.path.startsWith("node_modules/")) {
      throw new Error(`forbidden Git path: ${entry.path}`);
    }
  }

  await mkdir(output, { recursive: false });
  const archive = git(checkout, ["archive", "--format=tar", originalSha], { encoding: "buffer" });
  const extracted = spawnSync("tar", ["-x", "-f", "-", "-C", output], { input: archive, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  if (extracted.error || extracted.status !== 0) throw new Error(extracted.stderr?.toString().trim() || "candidate archive extraction failed");
  // Windows tar can apply checkout-style newline conversion. Reinstall each tracked
  // blob from Git so the candidate is byte-for-byte the committed tree.
  for (const entry of originalEntries) await writeBlob(checkout, originalSha, entry.path, output);

  for (const generated of MUTABLE_GENERATED_PATHS) await rm(safePath(output, generated), { recursive: true, force: true });
  for (const entry of productionEntries) await writeBlob(checkout, lastGoodSha, entry.path, output);
  await rejectLinksAndForbidden(output);

  const actual = [];
  async function list(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await list(path.join(directory, entry.name), child);
      else actual.push(child);
    }
  }
  await list(output);
  const expected = new Set(originalEntries.map(entry => entry.path));
  for (const generated of MUTABLE_GENERATED_PATHS) {
    for (const file of [...expected]) if (file === generated || file.startsWith(`${generated}/`)) expected.delete(file);
  }
  for (const entry of productionEntries) expected.add(entry.path);
  if (actual.sort().join("\0") !== [...expected].sort().join("\0")) throw new Error("candidate contains untracked residue or missing tracked files");
  return { originalSha, lastGoodSha, files: actual.length };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    const key = argv[index].slice(2);
    if (Object.hasOwn(values, key)) throw new Error("invalid arguments");
    values[key] = argv[index + 1];
  }
  if (Object.keys(values).sort().join("\0") !== ["checkout", "last-good-sha", "out"].sort().join("\0")) throw new Error("invalid arguments");
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareRefreshCandidate({ checkoutRoot: args.checkout, outDir: args.out, lastGoodSha: args["last-good-sha"] });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "candidate preparation failed"); process.exitCode = 1; });
}
