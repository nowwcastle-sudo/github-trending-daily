import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ENRICHMENT_MODEL, slugToFile } from "./generate-translations.mjs";

const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;
const SOURCE_KEYS = ["blob_sha", "content_sha256", "model", "schema_version", "translation_applicable"];
const TAG_RULE_VERSION = 1;
const FIELD_TAG_IDS = ["ai-ml", "web-app", "dev-tools", "data", "devops", "security", "productivity", "systems", "learning"];
const FORM_TAG_IDS = ["agent", "mcp", "plugin-skill", "ide", "library", "framework", "cli"];

export function parseJsonStrict(input, label = "JSON", maxBytes = 16 * 1024 * 1024) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`${label} size is invalid`);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`${label} is not valid UTF-8`); }
  let index = 0;
  const whitespace = () => { while ([" ", "\t", "\r", "\n"].includes(text[index])) index += 1; };
  const string = () => {
    if (text[index] !== '"') throw new Error(`${label} is invalid`);
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)); } catch { throw new Error(`${label} is invalid`); }
      }
      if (text.charCodeAt(index) < 0x20) throw new Error(`${label} is invalid`);
      index += 1;
    }
    throw new Error(`${label} is invalid`);
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index += 1; whitespace();
      const result = {};
      const keys = new Set();
      if (text[index] === "}") { index += 1; return result; }
      while (true) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error(`${label} contains a duplicate key`);
        keys.add(key); whitespace();
        if (text[index++] !== ":") throw new Error(`${label} is invalid`);
        Object.defineProperty(result, key, { value: value(), enumerable: true, configurable: true, writable: true });
        whitespace();
        if (text[index] === "}") { index += 1; return result; }
        if (text[index++] !== ",") throw new Error(`${label} is invalid`);
      }
    }
    if (text[index] === "[") {
      index += 1; whitespace();
      const result = [];
      if (text[index] === "]") { index += 1; return result; }
      while (true) {
        result.push(value()); whitespace();
        if (text[index] === "]") { index += 1; return result; }
        if (text[index++] !== ",") throw new Error(`${label} is invalid`);
      }
    }
    if (text[index] === '"') return string();
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))?.[0];
    if (!number) throw new Error(`${label} is invalid`);
    index += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
    return parsed;
  };
  const result = value(); whitespace();
  if (index !== text.length) throw new Error(`${label} is invalid`);
  return result;
}

export const VERSION_1_BASE_PATHS = Object.freeze([
  "auth-lifecycle.js",
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

function hasCanonicalTags(value, allowed, { field = false } = {}) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string") || new Set(value).size !== value.length) return false;
  if (field && value.length === 1 && value[0] === "unclassified") return true;
  if (field && (value.length === 0 || value.includes("unclassified"))) return false;
  return value.every((item, index) => allowed.includes(item)
    && (index === 0 || allowed.indexOf(value[index - 1]) < allowed.indexOf(item)));
}

function hasCanonicalClassification(value) {
  return value?.tag_rule_version === TAG_RULE_VERSION
    && hasCanonicalTags(value.field_tags, FIELD_TAG_IDS, { field: true })
    && hasCanonicalTags(value.form_tags, FORM_TAG_IDS);
}

function assertCanonicalClassification(value) {
  if (!hasCanonicalClassification(value)) throw new Error("repository classification is invalid");
}

function classification(value) {
  return {
    tag_rule_version: value.tag_rule_version,
    field_tags: value.field_tags,
    form_tags: value.form_tags,
  };
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
    assertCanonicalClassification(repo);
    seen.add(key);
  }
  return value;
}

export function parseEmbeddedRepos(pageValue, label = "page REPOS", { requireClassification = false } = {}) {
  const page = Buffer.isBuffer(pageValue) ? new TextDecoder("utf-8", { fatal: true }).decode(pageValue) : pageValue;
  if (typeof page !== "string") throw new Error(`${label} is invalid`);
  const matches = [...page.matchAll(/(?:^|\n)const REPOS = (\[[^\n]+\]);/g)];
  if (matches.length !== 1) throw new Error(`${label} region is invalid`);
  const repos = parseJsonStrict(Buffer.from(matches[0][1]), label);
  if (!Array.isArray(repos) || repos.length === 0 || repos.length > 75) throw new Error(`${label} array is invalid`);
  const seen = new Set();
  for (const repo of repos) {
    if (!repo || typeof repo !== "object" || Array.isArray(repo) || typeof repo.slug !== "string"
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.slug)) throw new Error(`${label} row shape is invalid`);
    const folded = repo.slug.toLowerCase();
    if (seen.has(folded)) throw new Error(`${label} contains a case-fold duplicate identity`);
    if (requireClassification) assertCanonicalClassification(repo);
    seen.add(folded);
  }
  return repos;
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
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`artifact input is not a regular file: ${relative}`);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error(`artifact path escape: ${relative}`);
  return readFile(target);
}

function assertUniqueArtifactPaths(paths, label = "artifact") {
  if (new Set(paths).size !== paths.length) throw new Error(`${label} contains a duplicate path`);
  if (new Set(paths.map(value => value.toLowerCase())).size !== paths.length) throw new Error(`${label} contains a duplicate case-fold path`);
}

async function materializedLegacyCachePaths(sourceRoot, directory, extension) {
  const cacheRoot = path.join(sourceRoot, directory);
  let rootInfo;
  try { rootInfo = await lstat(cacheRoot); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`legacy ${directory} path is not a regular directory`);
  const paths = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    const info = await lstat(path.join(cacheRoot, entry.name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`legacy cache is not a regular file: ${relative}`);
    const escaped = extension.replace(".", "\\.");
    if (!new RegExp(`^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+${escaped}$`).test(entry.name)) throw new Error(`legacy cache path is not canonical: ${relative}`);
    paths.push(relative);
  }
  assertUniqueArtifactPaths(paths, `legacy ${directory}`);
  return paths.sort();
}

function activeLegacyCachePaths(repos, directory, extension) {
  const paths = repos.map(repo => `${directory}/${repo.slug.replaceAll("/", "__")}${extension}`);
  assertUniqueArtifactPaths(paths, `active legacy ${directory}`);
  return paths.sort();
}

function activeTrackedIntersection(active, tracked, label) {
  const exact = new Set(tracked);
  const folded = new Map(tracked.map(value => [value.toLowerCase(), value]));
  return active.filter(relative => {
    if (exact.has(relative)) return true;
    if (folded.has(relative.toLowerCase())) throw new Error(`${label} exact-case identity mismatch: ${relative}`);
    return false;
  });
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateArtifactContract(value, snapshotId, paths) {
  if (!exactKeys(value, ["version", "snapshotId", "artifacts"]) || value.version !== 1
      || value.snapshotId !== snapshotId || !Array.isArray(value.artifacts)) {
    throw new Error("invalid finalized artifact contract");
  }
  const expected = [...paths].sort();
  const actual = [];
  for (const row of value.artifacts) {
    if (!exactKeys(row, ["artifact_path", "sha256", "byte_size"]) || typeof row.artifact_path !== "string"
        || !SHA256_RE.test(row.sha256) || !Number.isSafeInteger(row.byte_size) || row.byte_size < 0) {
      throw new Error("invalid finalized artifact contract");
    }
    safeTarget("/artifact-root", row.artifact_path);
    actual.push(row.artifact_path);
  }
  if (actual.join("\0") !== expected.join("\0")) throw new Error("finalized artifact path set does not match Pages allowlist");
  return value.artifacts;
}

async function verifyArtifactContract(sourceRoot, snapshotId, paths, contract) {
  const rows = validateArtifactContract(contract, snapshotId, paths);
  for (const row of rows) {
    const bytes = await readRegularFile(sourceRoot, row.artifact_path);
    if (hash(bytes) !== row.sha256) throw new Error(`finalized artifact hash does not match: ${row.artifact_path}`);
    if (bytes.length !== row.byte_size) throw new Error(`finalized artifact size does not match: ${row.artifact_path}`);
  }
}

export function validateDeploymentManifest(value, { version = 1 } = {}) {
  const keys = version === 1 ? ["version", "sourceSha", "snapshotId", "files"] : ["version", "legacyBootstrap", "sourceSha", "snapshotId", "files"];
  if (!exactKeys(value, keys) || value.version !== version || typeof value.sourceSha !== "string" || !SHA_RE.test(value.sourceSha) || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error("invalid deployment manifest");
  }
  if (version === 1) {
    if (typeof value.snapshotId !== "string" || !SNAPSHOT_RE.test(value.snapshotId)) throw new Error("invalid deployment manifest");
  } else if (value.legacyBootstrap !== true || value.snapshotId !== null) {
    throw new Error("invalid deployment manifest");
  }
  const paths = Object.keys(value.files);
  if (paths.length === 0 || paths.length > 100 || new Set(paths.map(file => file.toLowerCase())).size !== paths.length
      || paths.some(file => typeof value.files[file] !== "string" || !SHA256_RE.test(value.files[file]))) throw new Error("invalid deployment manifest");
  for (const file of paths) safeTarget("/artifact-root", file);
  return value;
}

export function inspectProductionState({ httpStatus, manifestBytes, fallbackSourceSha }) {
  if (!SHA_RE.test(fallbackSourceSha ?? "")) throw new Error("invalid fallback source SHA");
  if (httpStatus === "404") {
    return { manifestStatus: "verified_404", manifestSha256: null, version: 0, sourceSha: fallbackSourceSha, snapshotId: null };
  }
  if (httpStatus !== "200") throw new Error("production manifest HTTP status is invalid");
  const parsed = parseJsonStrict(manifestBytes, "production deployment manifest", 1024 * 1024);
  if (!Number.isInteger(parsed?.version) || ![0, 1].includes(parsed.version)) throw new Error("production manifest version is invalid");
  const manifest = validateDeploymentManifest(parsed, { version: parsed.version });
  return {
    manifestStatus: `verified_v${manifest.version}`,
    manifestSha256: hash(Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes)),
    version: manifest.version,
    sourceSha: manifest.sourceSha,
    snapshotId: manifest.snapshotId,
  };
}

async function installArtifact({ sourceRoot, outDir, paths, manifest }) {
  assertUniqueArtifactPaths(paths);
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

export async function buildPagesArtifact({ sourceRoot, outDir, sourceSha, snapshotId, artifactContract }) {
  if (!SHA_RE.test(sourceSha) || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid artifact identity");
  const [latest, sources] = await Promise.all([
    readFile(path.join(sourceRoot, "data", "latest.json")).then(bytes => parseJsonStrict(bytes, "latest JSON")),
    readFile(path.join(sourceRoot, "data", "translation-sources.json")).then(bytes => parseJsonStrict(bytes, "translation sources")),
  ]);
  const paths = expectedVersion1Paths(latest, sources);
  const pageRepos = parseEmbeddedRepos(await readFile(path.join(sourceRoot, "index.html")), "version-1 page REPOS", { requireClassification: true });
  if (pageRepos.map(repo => repo.slug.toLowerCase()).sort().join("\0") !== latest.repos.map(repo => repo.slug.toLowerCase()).sort().join("\0")) {
    throw new Error("version-1 page REPOS identity does not match latest");
  }
  const latestBySlug = new Map(latest.repos.map(repo => [repo.slug.toLowerCase(), repo]));
  for (const repo of pageRepos) {
    if (!equalJson(classification(repo), classification(latestBySlug.get(repo.slug.toLowerCase())))) {
      throw new Error("version-1 page REPOS classification does not match latest");
    }
  }
  const sourcesBySlug = normalizeSources(sources);
  for (const repo of latest.repos) {
    const source = sourcesBySlug.get(repo.slug.toLowerCase())?.source;
    if (source?.translation_applicable !== true) continue;
    const file = `translations/${slugToFile(repo.slug)}`;
    const payload = parseJsonStrict(await readRegularFile(sourceRoot, file), "translation envelope");
    if (!exactKeys(payload, ["markdown", "source"]) || typeof payload.markdown !== "string" || !payload.markdown.trim() || !equalJson(payload.source, source)) {
      throw new Error(`invalid translation envelope: ${repo.slug}`);
    }
  }
  await verifyArtifactContract(sourceRoot, snapshotId, paths, artifactContract);
  return installArtifact({ sourceRoot, outDir, paths, manifest: { version: 1, sourceSha, snapshotId } });
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
  const repos = parseEmbeddedRepos(page, "legacy page REPOS", { requireClassification: false });
  const activeReadmes = activeLegacyCachePaths(repos, "readmes", ".md");
  const activeTranslations = activeLegacyCachePaths(repos, "translations", ".json");
  const [trackedReadmes, trackedTranslations] = await Promise.all([
    materializedLegacyCachePaths(sourceRoot, "readmes", ".md"),
    materializedLegacyCachePaths(sourceRoot, "translations", ".json"),
  ]);
  const readmes = activeTrackedIntersection(activeReadmes, trackedReadmes, "legacy README");
  const translations = activeTrackedIntersection(activeTranslations, trackedTranslations, "legacy translation");
  return installArtifact({
    sourceRoot,
    outDir,
    paths: [...base, ...readmes, ...translations],
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
  const expected = values["inspect-manifest"] !== undefined
    ? ["fallback-source-sha", "http-status", "inspect-manifest"]
    : values.mode === "legacy"
    ? ["mode", "out", "source", "source-sha"]
    : ["artifact-contract", "out", "snapshot-id", "source", "source-sha"];
  if (values.mode && values.mode !== "legacy") throw new Error("invalid arguments");
  if (Object.keys(values).sort().join("\0") !== expected.sort().join("\0") || expected.some(key => !values[key])) throw new Error("invalid arguments");
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["inspect-manifest"] !== undefined) {
    const state = inspectProductionState({
      httpStatus: args["http-status"],
      manifestBytes: await readFile(path.resolve(args["inspect-manifest"])),
      fallbackSourceSha: args["fallback-source-sha"],
    });
    console.log(JSON.stringify(state));
    return;
  }
  const manifest = args.mode === "legacy"
    ? await buildLegacyRecoveryArtifact({ sourceRoot: path.resolve(args.source), outDir: path.resolve(args.out), sourceSha: args["source-sha"] })
    : await buildPagesArtifact({
      sourceRoot: path.resolve(args.source),
      outDir: path.resolve(args.out),
      sourceSha: args["source-sha"],
      snapshotId: args["snapshot-id"],
      artifactContract: parseJsonStrict(await readFile(path.resolve(args["artifact-contract"])), "finalized artifact contract"),
    });
  console.log(JSON.stringify(manifest));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "artifact build failed"); process.exitCode = 1; });
}
