import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ENRICHMENT_MODEL, slugToFile } from "./generate-translations.mjs";

const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;
const SOURCE_KEYS = ["blob_sha", "content_sha256", "model", "schema_version", "translation_applicable"];

export const VERSION_1_BASE_PATHS = Object.freeze([
  "changes.xml",
  "current-view-export.js",
  "data/latest.json",
  "data/membership-status.json",
  "favorite-sync.js",
  "favorites.js",
  "feed.xml",
  "firebase-client.js",
  "firebase-config.json",
  "hidden-repos.js",
  "index.html",
  "membership-history.js",
  "readme-markdown.js",
  "refresh-schedule.js",
  "repo-filters.js",
  "star-history.js",
  "star-history.json",
  "ui-motion.js",
].sort());

export const LEGACY_BASE_PATHS = Object.freeze(
  VERSION_1_BASE_PATHS.filter(value => value !== "readme-markdown.js"),
);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validSource(value) {
  return exactKeys(value, SOURCE_KEYS)
    && /^[a-f0-9]{40}$/.test(value.blob_sha)
    && /^[a-f0-9]{64}$/.test(value.content_sha256)
    && value.model === ENRICHMENT_MODEL
    && value.schema_version === 2
    && typeof value.translation_applicable === "boolean";
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeLatest(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.repos)) throw new Error("invalid latest document");
  const seen = new Set();
  for (const repo of value.repos) {
    if (!repo || typeof repo.slug !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.slug)) {
      throw new Error("invalid latest repository");
    }
    const key = repo.slug.toLowerCase();
    if (seen.has(key)) throw new Error("duplicate latest repository");
    seen.add(key);
  }
  return value;
}

function normalizeSources(value) {
  if (!exactKeys(value, ["version", "sources"]) || value.version !== 2 || !value.sources || typeof value.sources !== "object" || Array.isArray(value.sources)) {
    throw new Error("invalid translation sources");
  }
  const entries = new Map();
  for (const [slug, source] of Object.entries(value.sources)) {
    const key = slug.toLowerCase();
    if (entries.has(key) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
      throw new Error("invalid translation sources");
    }
    entries.set(key, { slug, source });
  }
  return entries;
}

export function expectedVersion1Paths(latestValue, sourcesValue) {
  const latest = normalizeLatest(latestValue);
  const sources = normalizeSources(sourcesValue);
  const translations = [];
  for (const repo of latest.repos) {
    const entry = sources.get(repo.slug.toLowerCase());
    if (entry?.source.translation_applicable === true) {
      if (!validSource(entry.source)) throw new Error(`invalid active translation source: ${repo.slug}`);
      translations.push(`translations/${slugToFile(repo.slug)}`);
    }
  }
  return [...VERSION_1_BASE_PATHS, ...translations].sort();
}

function safeTarget(root, relative) {
  if (relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("artifact path escape");
  }
  const target = path.resolve(root, ...relative.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error("artifact path escape");
  return target;
}

async function readRegularFile(root, relative) {
  const target = safeTarget(root, relative);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error(`artifact path escape: ${relative}`);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`artifact input is not a regular file: ${relative}`);
  return readFile(target);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateDeploymentManifest(value, { version = 1 } = {}) {
  const keys = version === 1 ? ["version", "sourceSha", "snapshotId", "files"] : ["version", "legacyBootstrap", "sourceSha", "snapshotId", "files"];
  if (!exactKeys(value, keys) || value.version !== version || !SHA_RE.test(value.sourceSha) || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error("invalid deployment manifest");
  }
  if (version === 1) {
    if (!SNAPSHOT_RE.test(value.snapshotId)) throw new Error("invalid deployment manifest");
  } else if (value.legacyBootstrap !== true || value.snapshotId !== null) {
    throw new Error("invalid deployment manifest");
  }
  const paths = Object.keys(value.files);
  if (paths.length === 0 || paths.some(file => !SHA256_RE.test(value.files[file]))) throw new Error("invalid deployment manifest");
  for (const file of paths) safeTarget("/artifact-root", file);
  return value;
}

async function installArtifact({ sourceRoot, outDir, paths, manifest }) {
  await mkdir(outDir, { recursive: false });
  const files = {};
  for (const relative of [...paths].sort()) {
    const bytes = await readRegularFile(sourceRoot, relative);
    const destination = safeTarget(outDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(safeTarget(sourceRoot, relative), destination);
    files[relative] = hash(bytes);
  }
  const value = { ...manifest, files };
  validateDeploymentManifest(value, { version: value.version });
  await writeFile(path.join(outDir, "deployment-manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export async function buildPagesArtifact({ sourceRoot, outDir, sourceSha, snapshotId }) {
  if (!SHA_RE.test(sourceSha) || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid artifact identity");
  const [latest, sources] = await Promise.all([
    readFile(path.join(sourceRoot, "data", "latest.json"), "utf8").then(JSON.parse),
    readFile(path.join(sourceRoot, "data", "translation-sources.json"), "utf8").then(JSON.parse),
  ]);
  const paths = expectedVersion1Paths(latest, sources);
  const sourcesBySlug = normalizeSources(sources);
  for (const repo of latest.repos) {
    const source = sourcesBySlug.get(repo.slug.toLowerCase())?.source;
    if (source?.translation_applicable !== true) continue;
    const file = `translations/${slugToFile(repo.slug)}`;
    const payload = JSON.parse((await readRegularFile(sourceRoot, file)).toString("utf8"));
    if (!exactKeys(payload, ["markdown", "source"]) || typeof payload.markdown !== "string" || !payload.markdown.trim() || !equalJson(payload.source, source)) {
      throw new Error(`invalid translation envelope: ${repo.slug}`);
    }
  }
  return installArtifact({ sourceRoot, outDir, paths, manifest: { version: 1, sourceSha, snapshotId } });
}

function activeLegacySlugs(page) {
  const match = /(?:^|\n)const REPOS = (\[[^\n]+\]);/.exec(page);
  if (!match) throw new Error("invalid legacy page repository data");
  const repos = JSON.parse(match[1]);
  if (!Array.isArray(repos)) throw new Error("invalid legacy page repository data");
  return repos.map(repo => repo?.slug).filter(slug => typeof slug === "string");
}

export async function buildLegacyRecoveryArtifact({ sourceRoot, outDir, sourceSha }) {
  if (!SHA_RE.test(sourceSha)) throw new Error("invalid artifact identity");
  const page = await readFile(path.join(sourceRoot, "index.html"), "utf8");
  const base = [];
  for (const relative of LEGACY_BASE_PATHS) {
    try { await readRegularFile(sourceRoot, relative); base.push(relative); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const readmes = activeLegacySlugs(page).map(slug => `readmes/${slug.replaceAll("/", "__")}.md`);
  return installArtifact({
    sourceRoot,
    outDir,
    paths: [...base, ...readmes],
    manifest: { version: 0, legacyBootstrap: true, sourceSha, snapshotId: null },
  });
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("invalid arguments");
    const key = name.slice(2);
    if (Object.hasOwn(values, key)) throw new Error("invalid arguments");
    values[key] = value;
  }
  const expected = values.mode === "legacy"
    ? ["mode", "out", "source", "source-sha"]
    : ["out", "snapshot-id", "source", "source-sha"];
  if (values.mode && values.mode !== "legacy") throw new Error("invalid arguments");
  if (Object.keys(values).sort().join("\0") !== expected.sort().join("\0") || expected.some(key => !values[key])) throw new Error("invalid arguments");
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = args.mode === "legacy"
    ? await buildLegacyRecoveryArtifact({ sourceRoot: path.resolve(args.source), outDir: path.resolve(args.out), sourceSha: args["source-sha"] })
    : await buildPagesArtifact({ sourceRoot: path.resolve(args.source), outDir: path.resolve(args.out), sourceSha: args["source-sha"], snapshotId: args["snapshot-id"] });
  console.log(JSON.stringify(manifest));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "artifact build failed"); process.exitCode = 1; });
}
