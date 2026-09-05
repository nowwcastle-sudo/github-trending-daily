import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[a-f0-9]{40}$/;
export const MUTABLE_GENERATED_PATHS = Object.freeze([
  "changes.xml",
  "data/latest.json",
  "data/membership-status.json",
  "data/observation-db.pointer.json",
  "data/readme-state.json",
  "data/repo-summaries.json",
  "data/star-anchors.json",
  "data/translation-sources.json",
  "feed.xml",
  "index.html",
  "star-history.json",
  "translations",
]);
// Written by the recorder into the candidate but never tracked by git (the snapshot
// lives in a release asset; spec 2026-09-05 §6.1). Accepted by --verify-generated,
// never reinstated from lastGoodSha.
export const CANDIDATE_ONLY_GENERATED_PATHS = Object.freeze(["data/repository-observations.sqlite"]);
const FULL_FILE_GENERATED_PATHS = [...MUTABLE_GENERATED_PATHS, ...CANDIDATE_ONLY_GENERATED_PATHS].filter(value => value !== "index.html" && value !== "translations");
const PAGE_REGIONS = Object.freeze([
  ["<!-- GENERATED:TRENDING-DATE:START -->", "<!-- GENERATED:TRENDING-DATE:END -->"],
  ["// GENERATED:TRENDING-REPOS:START", "// GENERATED:TRENDING-REPOS:END"],
]);

function regionBounds(value, start, end) {
  const firstStart = value.indexOf(start);
  const firstEnd = value.indexOf(end, firstStart + start.length);
  if (firstStart < 0 || firstEnd < 0 || value.indexOf(start, firstStart + 1) >= 0 || value.indexOf(end, firstEnd + 1) >= 0 || firstEnd < firstStart) {
    throw new Error("index.html generated markers are missing, duplicated, or out of order");
  }
  return [firstStart, firstEnd + end.length];
}

function decodeHtml(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("index.html is not valid UTF-8"); }
}

export function hydrateCompositeIndex(currentBytes, productionBytes) {
  let result = decodeHtml(currentBytes);
  const production = decodeHtml(productionBytes);
  for (const [start, end] of PAGE_REGIONS) {
    const [currentStart, currentEnd] = regionBounds(result, start, end);
    const [productionStart, productionEnd] = regionBounds(production, start, end);
    result = `${result.slice(0, currentStart)}${production.slice(productionStart, productionEnd)}${result.slice(currentEnd)}`;
  }
  return Buffer.from(result, "utf8");
}

function withoutGeneratedPageRegions(bytes) {
  let value = decodeHtml(bytes);
  for (const [start, end] of PAGE_REGIONS) {
    const [regionStart, regionEnd] = regionBounds(value, start, end);
    value = `${value.slice(0, regionStart)}${start}\n<GENERATED>\n${end}${value.slice(regionEnd)}`;
  }
  return value;
}

function approvedGeneratedFile(relative) {
  return FULL_FILE_GENERATED_PATHS.includes(relative) || /^translations\/[^/]+\.json$/.test(relative);
}

async function fileMap(root) {
  const files = new Map();
  async function visit(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`unexpected candidate residue: ${child}`);
      if (info.isFile() && info.nlink !== 1) throw new Error(`candidate hardlink rejected: ${child}`);
      if (info.isDirectory()) await visit(target, child);
      else files.set(child, await readFile(target));
    }
  }
  await visit(path.resolve(root));
  return files;
}

export async function verifyCandidateMutations({ baselineRoot, candidateRoot }) {
  const [baseline, candidate] = await Promise.all([fileMap(baselineRoot), fileMap(candidateRoot)]);
  const paths = new Set([...baseline.keys(), ...candidate.keys()]);
  for (const relative of paths) {
    if (approvedGeneratedFile(relative)) continue;
    const before = baseline.get(relative);
    const after = candidate.get(relative);
    if (!before || !after) throw new Error(`unexpected non-generated candidate residue: ${relative}`);
    if (relative === "index.html") {
      if (withoutGeneratedPageRegions(before) !== withoutGeneratedPageRegions(after)) throw new Error("non-generated index.html bytes changed");
    } else if (createHash("sha256").update(before).digest("hex") !== createHash("sha256").update(after).digest("hex")) {
      throw new Error(`non-generated candidate bytes changed: ${relative}`);
    }
  }
  const actualTranslations = [...candidate.keys()].filter(relative => relative.startsWith("translations/")).sort();
  if (actualTranslations.length !== 0) throw new Error("retired README translation residue is present");
  return { files: candidate.size };
}

function git(root, args, options = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: options.encoding ?? "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 30_000,
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

function existsAtCommit(root, sha, relative) {
  try {
    git(root, ["cat-file", "-e", `${sha}:${normalizeGitPath(relative)}`]);
    return true;
  } catch {
    return false;
  }
}

// A last-good commit can predate a generated path — the observation pointer landed after
// commits that are still valid recovery points — and reinstating nothing for it is correct.
// Prove the path really is absent rather than trusting an empty ls-tree pathspec match.
function assertReinstatementIsComplete(checkout, lastGoodSha, productionEntries) {
  for (const generated of MUTABLE_GENERATED_PATHS) {
    if (productionEntries.some(entry => entry.path === generated || entry.path.startsWith(`${generated}/`))) continue;
    if (existsAtCommit(checkout, lastGoodSha, generated)) throw new Error(`last-good generated path was not listed: ${generated}`);
  }
}

async function rejectLinksAndForbidden(root) {
  async function visit(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git" || entry.name === "node_modules") throw new Error(`forbidden candidate path: ${childRelative}`);
      const child = path.join(directory, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error(`candidate symlink rejected: ${childRelative}`);
      if (info.isFile() && info.nlink !== 1) throw new Error(`candidate hardlink rejected: ${childRelative}`);
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
  assertReinstatementIsComplete(checkout, lastGoodSha, productionEntries);
  for (const entry of [...originalEntries, ...productionEntries]) {
    if (entry.type !== "blob" || entry.mode === "120000") throw new Error(`Git symlink or non-blob rejected: ${entry.path}`);
    if (entry.path === ".git" || entry.path.startsWith(".git/") || entry.path === "node_modules" || entry.path.startsWith("node_modules/")) {
      throw new Error(`forbidden Git path: ${entry.path}`);
    }
  }

  await mkdir(output, { recursive: false });
  const archive = git(checkout, ["archive", "--format=tar", originalSha], { encoding: "buffer" });
  const extracted = spawnSync("tar", ["-x", "-f", "-", "-C", output], { input: archive, encoding: "buffer", maxBuffer: 128 * 1024 * 1024, timeout: 30_000 });
  if (extracted.error || extracted.status !== 0) throw new Error(extracted.stderr?.toString().trim() || "candidate archive extraction failed");
  // Windows tar can apply checkout-style newline conversion. Reinstall each tracked
  // blob from Git so the candidate is byte-for-byte the committed tree.
  for (const entry of originalEntries) await writeBlob(checkout, originalSha, entry.path, output);

  for (const generated of MUTABLE_GENERATED_PATHS.filter(value => value !== "index.html")) await rm(safePath(output, generated), { recursive: true, force: true });
  for (const entry of productionEntries) if (entry.path !== "index.html") await writeBlob(checkout, lastGoodSha, entry.path, output);
  const currentIndex = git(checkout, ["show", `${originalSha}:index.html`], { encoding: "buffer" });
  const productionIndex = git(checkout, ["show", `${lastGoodSha}:index.html`], { encoding: "buffer" });
  await writeFile(safePath(output, "index.html"), hydrateCompositeIndex(currentIndex, productionIndex));
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
  for (const generated of MUTABLE_GENERATED_PATHS.filter(value => value !== "index.html")) {
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
  const shape = Object.keys(values).sort().join("\0");
  if (shape !== ["checkout", "last-good-sha", "out"].sort().join("\0") && shape !== ["candidate", "verify-generated"].sort().join("\0")) throw new Error("invalid arguments");
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["verify-generated"]) {
    console.log(JSON.stringify(await verifyCandidateMutations({ baselineRoot: args["verify-generated"], candidateRoot: args.candidate })));
    return;
  }
  const result = await prepareRefreshCandidate({ checkoutRoot: args.checkout, outDir: args.out, lastGoodSha: args["last-good-sha"] });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "candidate preparation failed"); process.exitCode = 1; });
}
