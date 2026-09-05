import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LEGACY_BASE_PATHS,
  OVERLAY_PATHS,
  expectedVersion1Paths,
  parseEmbeddedRepos,
  parseJsonStrict,
  validateDeploymentManifest,
} from "./build-pages-artifact.mjs";
import { slugToFile } from "./generate-translations.mjs";

const SHA_RE = /^[a-f0-9]{40}$/;
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const FETCH_RETRY_DELAYS_MS = Object.freeze([250, 1_000]);

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The snapshot lives in a release asset, not in the tree, so the store resolves it from the
// pointer at sourceSha (spec 2026-09-05 §6.3). The script is injectable for tests the same way
// GIT_SCRIPT is, and refused inside Actions for the same reason the store refuses its overrides.
function resolveObservationDatabase(sourceSha, snapshotId, destination, gitRoot, deadline) {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("production probe deadline exceeded");
  const override = process.env.OBSERVATION_DB_RESOLVER_SCRIPT;
  if (override && process.env.GITHUB_ACTIONS === "true") throw new Error("observation database resolver override is refused inside GitHub Actions");
  const script = override || fileURLToPath(new URL("./observation-db-store.mjs", import.meta.url));
  try {
    execFileSync(process.execPath, [script, "resolve", "--source-sha", sourceSha, "--expect-snapshot-id", snapshotId, "--git-root", gitRoot, "--out", destination], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: Math.max(1, Math.min(600_000, Math.ceil(remaining))), stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // The store scrubs its own stderr before it leaves the child, so it is safe to surface here, and
    // on the two contract-less production paths it is the only thing that tells a 404 from a hash
    // mismatch. The fixed phrase stays in front so callers matching on it keep matching.
    const detail = String(error.stderr ?? "").trim().slice(0, 500);
    throw new Error(detail ? `Git repository observation database is unavailable: ${detail}` : "Git repository observation database is unavailable");
  }
}

async function artifactContractFromGit(sourceSha, snapshotId, gitRoot, deadline) {
  const temporary = await mkdtemp(path.join(tmpdir(), "repository-artifact-contract-"));
  try {
    const database = path.join(temporary, "repository-observations.sqlite");
    const contract = path.join(temporary, "artifact-contract.json");
    resolveObservationDatabase(sourceSha, snapshotId, database, gitRoot, deadline);
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("production probe deadline exceeded");
    const script = fileURLToPath(new URL("./derive_repository_artifacts.py", import.meta.url));
    try {
      execFileSync(process.env.PYTHON_BIN || "python", [script, "export-contract", "--database", database, "--snapshot-id", snapshotId, "--contract-out", contract], {
        encoding: "utf8", maxBuffer: 1024 * 1024, timeout: Math.max(1, Math.min(30_000, Math.ceil(remaining))), stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("Git repository observation artifact contract is invalid");
    }
    return parseJsonStrict(await readFile(contract), "Git repository observation artifact contract", 16 * 1024 * 1024);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function validateArtifactContract(contract, snapshotId, expectedPaths, bodies) {
  if (!exactKeys(contract, ["version", "snapshotId", "artifacts"]) || contract.version !== 1
      || contract.snapshotId !== snapshotId || !Array.isArray(contract.artifacts)) {
    throw new Error("invalid repository observation artifact contract");
  }
  const rows = contract.artifacts;
  if (rows.map(row => row?.artifact_path).join("\0") !== expectedPaths.join("\0")) {
    throw new Error("repository observation artifact path set does not match Pages");
  }
  for (const row of rows) {
    if (!exactKeys(row, ["artifact_path", "sha256", "byte_size"]) || !/^[a-f0-9]{64}$/.test(row.sha256)
        || !Number.isSafeInteger(row.byte_size) || row.byte_size < 0) throw new Error("invalid repository observation artifact contract");
    const bytes = bodies.get(row.artifact_path);
    if (!bytes || hash(bytes) !== row.sha256) throw new Error(`repository observation artifact hash mismatch: ${row.artifact_path}`);
    if (bytes.length !== row.byte_size) throw new Error(`repository observation artifact size mismatch: ${row.artifact_path}`);
  }
}

function gitBytes(sha, relative, gitRoot = process.cwd(), deadline = Date.now() + 30_000) {
  try {
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("production probe deadline exceeded");
    const args = ["-C", gitRoot, "show", `${sha}:${relative}`];
    return execFileSync(process.env.GIT_BIN || "git", process.env.GIT_SCRIPT ? [process.env.GIT_SCRIPT, ...args] : args, {
      encoding: null, maxBuffer: 64 * 1024 * 1024, timeout: Math.max(1, Math.min(30_000, Math.ceil(remaining))), stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = new Error(`Git tree path unavailable: ${relative}`);
    failure.code = error.status;
    throw failure;
  }
}

function gitTreeRows(sha, pathspec, label, gitRoot = process.cwd(), deadline = Date.now() + 30_000) {
  let output;
  try {
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("production probe deadline exceeded");
    const args = ["-C", gitRoot, "ls-tree", "-r", "-z", "--full-tree", sha, "--", ...pathspec];
    output = execFileSync(process.env.GIT_BIN || "git", process.env.GIT_SCRIPT ? [process.env.GIT_SCRIPT, ...args] : args, {
      encoding: null, maxBuffer: 16 * 1024 * 1024, timeout: Math.max(1, Math.min(30_000, Math.ceil(remaining))), stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.message === "production probe deadline exceeded") throw error;
    throw new Error(`Git tree ${label} listing unavailable`);
  }
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error("malformed Git ls-tree output");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(output.subarray(0, -1)); } catch { throw new Error("malformed Git ls-tree output"); }
  const rows = [];
  for (const row of text.split("\0")) {
    const match = /^([0-7]{6}) (blob|tree) ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) throw new Error("malformed Git ls-tree output");
    const [, mode, type, , relative] = match;
    rows.push({ mode, type, relative });
  }
  return rows;
}

function gitTrackedLegacyBasePaths(sha, gitRoot, deadline) {
  const allowed = new Set(LEGACY_BASE_PATHS);
  const paths = [];
  for (const { mode, type, relative } of gitTreeRows(sha, LEGACY_BASE_PATHS, "legacy base", gitRoot, deadline)) {
    if (!allowed.has(relative)) throw new Error(`legacy base path is not canonical: ${relative}`);
    if (mode === "120000") throw new Error(`legacy base symlink rejected: ${relative}`);
    if ((mode !== "100644" && mode !== "100755") || type !== "blob") throw new Error(`legacy base is not a regular file: ${relative}`);
    paths.push(relative);
  }
  if (new Set(paths).size !== paths.length || new Set(paths.map(value => value.toLowerCase())).size !== paths.length) {
    throw new Error("legacy base contains a duplicate or case-fold path");
  }
  return paths.sort();
}

function gitTrackedLegacyCachePaths(sha, directory, extension, gitRoot = process.cwd(), deadline = Date.now() + 30_000) {
  const paths = [];
  const folded = new Set();
  for (const { mode, type, relative } of gitTreeRows(sha, [directory], directory, gitRoot, deadline)) {
    if (mode === "120000") throw new Error(`legacy cache symlink rejected: ${relative}`);
    if ((mode !== "100644" && mode !== "100755") || type !== "blob") throw new Error(`legacy cache is not a regular file: ${relative}`);
    const expected = directory === "readmes"
      ? /^readmes\/[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+\.md$/
      : /^translations\/[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+\.json$/;
    if (!expected.test(relative) || !relative.endsWith(extension)) throw new Error(`legacy cache path is not canonical: ${relative}`);
    const key = relative.toLowerCase();
    if (folded.has(key)) throw new Error(`legacy cache has a duplicate case-fold path: ${relative}`);
    folded.add(key);
    paths.push(relative);
  }
  return paths.sort();
}

function activeReposFromPage(page) {
  return parseEmbeddedRepos(page, "published page REPOS");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

async function fetchBytes(url, { expectedStatus = 200, deadline = Date.now() + 120_000 } = {}) {
  for (let attempt = 0; attempt <= FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("production probe deadline exceeded");
      const response = await fetch(url, { redirect: "error", cache: "no-store", headers: { connection: "close" }, signal: AbortSignal.timeout(Math.min(15_000, remaining)) });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 16 * 1024 * 1024) throw new Error(`response body too large for ${new URL(url).pathname}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new Error(`response body too large for ${new URL(url).pathname}`);
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (response.status !== expectedStatus) {
        const error = new Error(`unexpected HTTP status for ${new URL(url).pathname}: ${response.status}`);
        error.transient = TRANSIENT_HTTP_STATUSES.has(response.status);
        throw error;
      }
      return { bytes, contentType: response.headers.get("content-type") ?? "", status: response.status };
    } catch (error) {
      const transport = ["AbortError", "TimeoutError", "TypeError"].includes(error?.name);
      if (attempt >= FETCH_RETRY_DELAYS_MS.length || (error?.transient !== true && !transport)) throw error;
      const delay = FETCH_RETRY_DELAYS_MS[attempt];
      if (deadline - Date.now() <= delay) throw new Error("production probe deadline exceeded");
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("production probe failed");
}

function withProbe(baseUrl, relative, snapshotId) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(relative, base);
  if (snapshotId !== null) url.searchParams.set("probe", snapshotId);
  return url.href;
}

function assertMime(relative, contentType, bytes) {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const expected = relative.endsWith(".html") ? "text/html"
    : relative.endsWith(".js") ? "application/javascript"
      : relative.endsWith(".json") ? "application/json"
        : relative.endsWith(".xml") ? "application/xml"
          : relative.endsWith(".md") ? "text/markdown" : "application/octet-stream";
  if (mediaType !== expected) throw new Error(`wrong MIME-critical payload: ${relative}`);
  if (relative === "index.html" && !bytes.toString("utf8").includes("<")) throw new Error("wrong MIME-critical HTML payload");
}

function atomEntries(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => match[1]);
  for (const entry of entries) {
    const summary = /<summary\s+type="text">([\s\S]*?)<\/summary>/.exec(entry)?.[1]?.trim();
    if (!summary) throw new Error("Atom entry has an empty summary");
  }
  return entries;
}

function atomSlugs(xml) {
  return atomEntries(xml).map(entry => {
    const id = /<id>https:\/\/github\.com\/([^<]+)<\/id>/.exec(entry)?.[1];
    if (!id) throw new Error("invalid current Atom entry identity");
    return id;
  });
}

function oneMatch(value, pattern, label) {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`invalid ${label}`);
  return matches[0][1];
}

function canonicalUtc(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function validateAtomHeader(xml, { kind, generatedAt, snapshotId, statsDate }) {
  if ((xml.match(/<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/g) ?? []).length !== 1 || (xml.match(/<\/feed>/g) ?? []).length !== 1) throw new Error(`invalid ${kind} Atom root`);
  const updated = oneMatch(xml, /<feed[\s\S]*?<updated>([^<]+)<\/updated>/g, `${kind} Atom updated`);
  if (updated !== generatedAt || !canonicalUtc(updated)) throw new Error(`stale ${kind} Atom updated`);
  const entryStart = xml.indexOf("<entry>");
  const header = xml.slice(0, entryStart >= 0 ? entryStart : xml.indexOf("</feed>"));
  const expectedId = `https://nowwcastle-sudo.github.io/github-trending-daily/${kind === "current" ? "feed.xml" : "changes.xml"}`;
  const expectedTitle = kind === "current"
    ? "GITHUB INSIGHT — Current repositories"
    : "GITHUB INSIGHT — New and re-entered repositories";
  if (oneMatch(header, /<id>([^<]+)<\/id>/g, `${kind} Atom id`) !== expectedId
      || oneMatch(header, /<title>([^<]+)<\/title>/g, `${kind} Atom title`) !== expectedTitle
      || !header.includes(`<link rel="self" type="application/atom+xml" href="${expectedId}" />`)
      || !header.includes('<link rel="alternate" type="text/html" href="https://nowwcastle-sudo.github.io/github-trending-daily/" />')) throw new Error(`invalid ${kind} Atom header`);
  const categories = [...header.matchAll(/<category scheme="([^"]+)" term="([^"]+)" \/>/g)].map(match => [match[1], match[2]]);
  const expected = [
    ["https://nowwcastle-sudo.github.io/github-trending-daily/snapshot", snapshotId],
    ["https://nowwcastle-sudo.github.io/github-trending-daily/stats-date", statsDate],
  ];
  if (JSON.stringify(categories.sort()) !== JSON.stringify(expected.sort())) throw new Error(`invalid ${kind} Atom run identity`);
}

export function validateCurrentAtom(xml, latest) {
  validateAtomHeader(xml, { kind: "current", generatedAt: latest.generatedAt, snapshotId: latest.snapshotId, statsDate: latest.statsDate });
  const entries = atomEntries(xml);
  if (entries.length !== latest.repos.length) throw new Error("current Atom entry count mismatch");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const slug = latest.repos[index].slug;
    const repositoryUrl = `https://github.com/${slug}`;
    const stableRepositoryId = `https://github.com/${slug.toLowerCase()}`;
    if (oneMatch(entry, /<id>([^<]+)<\/id>/g, "current Atom id") !== stableRepositoryId
        || oneMatch(entry, /<title>([^<]+)<\/title>/g, "current Atom title") !== slug
        || oneMatch(entry, /<updated>([^<]+)<\/updated>/g, "current Atom timestamp") !== latest.generatedAt
        || !entry.includes(`<link rel="alternate" type="text/html" href="${repositoryUrl}" />`)) throw new Error("current Atom entry identity mismatch");
  }
  return entries;
}

export function validateChangesAtom(xml, latest) {
  validateAtomHeader(xml, { kind: "changes", generatedAt: latest.generatedAt, snapshotId: latest.snapshotId, statsDate: latest.statsDate });
  const entries = atomEntries(xml);
  const ids = new Set();
  const identities = new Set();
  const normalized = [];
  for (const entry of entries) {
    const id = oneMatch(entry, /<id>([^<]+)<\/id>/g, "change Atom id");
    const title = oneMatch(entry, /<title>([^<]+)<\/title>/g, "change Atom title");
    const updated = oneMatch(entry, /<updated>([^<]+)<\/updated>/g, "change Atom timestamp");
    const link = oneMatch(entry, /<link rel="alternate" type="text\/html" href="([^"]+)" \/>/g, "change Atom link");
    const status = oneMatch(entry, /<category term="(new|reentered)" \/>/g, "change Atom category");
    const slug = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(link)?.[1];
    const eventIdentity = `${updated}\0${slug?.toLowerCase()}\0${status}`;
    if (ids.has(id) || !canonicalUtc(updated) || Date.parse(updated) > Date.parse(latest.generatedAt)
        || !slug || identities.has(eventIdentity)
        || title !== `${slug} ${status === "new" ? "신규" : "재진입"}`
        || id !== `https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml#${encodeURIComponent(`${updated}|${status}|${slug.toLowerCase()}`)}`) {
      throw new Error("change Atom entry provenance mismatch");
    }
    ids.add(id);
    identities.add(eventIdentity);
    normalized.push({ slug: slug.toLowerCase(), status, updated });
  }
  return normalized;
}

function normalizeSlugList(values) {
  return values.map(value => value.toLowerCase()).sort();
}

async function verifyVersion1Payload({ baseUrl, manifest, manifestBytes, gitRoot, deadline, artifactContract }) {
  const bodies = new Map();
  for (const [relative, expectedHash] of Object.entries(manifest.files)) {
    const { bytes, contentType } = await fetchBytes(withProbe(baseUrl, relative, manifest.snapshotId), { deadline });
    if (hash(bytes) !== expectedHash) throw new Error(`published file hash mismatch: ${relative}`);
    assertMime(relative, contentType, bytes);
    bodies.set(relative, bytes);
  }
  const required = ["index.html", "data/latest.json", "data/membership-status.json", "feed.xml", "changes.xml"];
  for (const relative of required) if (!bodies.has(relative)) throw new Error(`missing required probe input: ${relative}`);
  const page = bodies.get("index.html").toString("utf8");
  const latest = parseJsonStrict(bodies.get("data/latest.json"), "latest JSON");
  const membership = parseJsonStrict(bodies.get("data/membership-status.json"), "membership JSON");
  const sources = parseJsonStrict(gitBytes(manifest.sourceSha, "data/translation-sources.json", gitRoot, deadline), "translation sources");
  const expectedPaths = expectedVersion1Paths(latest, sources);
  // Contract paths are checked against the snapshot contract below; overlay paths
  // (star-history.json) are only checked against the manifest's own hash above.
  const expectedManifestPaths = [...expectedPaths, ...OVERLAY_PATHS].sort();
  if (Object.keys(manifest.files).sort().join("\0") !== expectedManifestPaths.join("\0")) throw new Error("manifest contains missing or stale extra artifact paths");
  const contract = artifactContract ?? await artifactContractFromGit(manifest.sourceSha, manifest.snapshotId, gitRoot, deadline);
  validateArtifactContract(contract, manifest.snapshotId, expectedPaths, bodies);
  if (!exactKeys(latest, ["snapshotId", "generatedAt", "statsDate", "count", "repos"]) || latest.snapshotId !== manifest.snapshotId
      || !canonicalUtc(latest.generatedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(latest.statsDate) || latest.count !== latest.repos?.length) throw new Error("latest identity/count mismatch");
  const pageRepos = activeReposFromPage(page);
  if (pageRepos.some(repo => repo._snapshot_id !== manifest.snapshotId || repo._generated_at !== latest.generatedAt || repo._stats_date !== latest.statsDate)) throw new Error("page run identity mismatch");
  const latestSlugs = latest.repos.map(repo => repo.slug);
  const pageSlugs = pageRepos.map(repo => repo.slug);
  if (!exactKeys(membership, ["schemaVersion", "generatedAt", "statsDate", "baseline", "current", "exited"]) || membership.schemaVersion !== 1
      || membership.generatedAt !== latest.generatedAt || membership.statsDate !== latest.statsDate || typeof membership.baseline !== "boolean"
      || !Array.isArray(membership.current) || !Array.isArray(membership.exited)) throw new Error("membership run identity mismatch");
  const allowedStatuses = membership.baseline ? ["baseline"] : ["new", "reentered", "stayed"];
  const currentIdentities = new Set();
  for (const item of membership.current) {
    const folded = item?.slug?.toLowerCase();
    if (!exactKeys(item, ["slug", "status"]) || !SLUG_RE.test(item.slug) || !allowedStatuses.includes(item.status) || currentIdentities.has(folded)) {
      throw new Error("invalid or duplicate current membership entry");
    }
    currentIdentities.add(folded);
  }
  const exitedIdentities = new Set();
  for (const item of membership.exited) {
    const folded = item?.slug?.toLowerCase();
    if (!exactKeys(item, ["slug", "lastSeenAt", "exitedAt"]) || !SLUG_RE.test(item.slug) || exitedIdentities.has(folded)
        || currentIdentities.has(folded) || !canonicalUtc(item.lastSeenAt)
        || Date.parse(item.lastSeenAt) > Date.parse(latest.generatedAt) || item.exitedAt !== latest.generatedAt) {
      throw new Error("invalid, duplicate, or overlapping exited membership entry");
    }
    exitedIdentities.add(folded);
  }
  const membershipSlugs = membership.current.map(repo => repo.slug);
  const currentEntries = validateCurrentAtom(bodies.get("feed.xml").toString("utf8"), latest);
  const feedSlugs = atomSlugs(bodies.get("feed.xml").toString("utf8"));
  const expectedSlugs = normalizeSlugList(latestSlugs);
  for (const [label, slugs] of [["page", pageSlugs], ["membership", membershipSlugs], ["feed", feedSlugs]]) {
    if (normalizeSlugList(slugs).join("\0") !== expectedSlugs.join("\0")) throw new Error(`${label} active repository count/identity mismatch`);
  }
  const changes = validateChangesAtom(bodies.get("changes.xml").toString("utf8"), latest)
    .filter(change => change.updated === latest.generatedAt);
  const expectedChanges = membership.current
    .filter(repo => repo.status === "new" || repo.status === "reentered")
    .map(repo => ({ slug: repo.slug.toLowerCase(), status: repo.status }));
  const identity = rows => rows.map(row => `${row.slug}\0${row.status}`).sort().join("\n");
  if (identity(changes) !== identity(expectedChanges)) throw new Error("change Atom and membership exact multiset mismatch");

  const sourcesByLower = new Map(Object.entries(sources.sources).map(([slug, source]) => [slug.toLowerCase(), source]));
  for (const slug of latestSlugs) {
    const source = sourcesByLower.get(slug.toLowerCase());
    if (source?.translation_applicable !== true) continue;
    const relative = `translations/${slugToFile(slug)}`;
    const payload = parseJsonStrict(bodies.get(relative) ?? Buffer.from("null"), "translation envelope");
    if (!exactKeys(payload, ["markdown", "source"]) || typeof payload.markdown !== "string" || !payload.markdown.trim() || JSON.stringify(payload.source) !== JSON.stringify(source)) {
      throw new Error(`translation envelope/provenance mismatch: ${slug}`);
    }
  }
  return { sourceSha: manifest.sourceSha, snapshotId: manifest.snapshotId, manifestSha256: hash(manifestBytes), files: Object.keys(manifest.files).length };
}

function legacyContract(sha, gitRoot, deadline) {
  const page = gitBytes(sha, "index.html", gitRoot, deadline).toString("utf8");
  const paths = gitTrackedLegacyBasePaths(sha, gitRoot, deadline);
  const repos = activeReposFromPage(page);
  const desired = [
    ...repos.map(repo => `readmes/${repo.slug.replaceAll("/", "__")}.md`),
    ...repos.map(repo => `translations/${repo.slug.replaceAll("/", "__")}.json`),
  ];
  if (new Set(desired).size !== desired.length || new Set(desired.map(value => value.toLowerCase())).size !== desired.length) {
    throw new Error("active legacy cache paths contain a duplicate or case-fold identity");
  }
  const trackedCaches = [
    ...gitTrackedLegacyCachePaths(sha, "readmes", ".md", gitRoot, deadline),
    ...gitTrackedLegacyCachePaths(sha, "translations", ".json", gitRoot, deadline),
  ];
  const tracked = new Set(trackedCaches);
  const trackedFolded = new Map(trackedCaches.map(value => [value.toLowerCase(), value]));
  const missingActiveCaches = [];
  for (const relative of desired) {
    if (tracked.has(relative)) paths.push(relative);
    else if (trackedFolded.has(relative.toLowerCase())) throw new Error(`legacy cache exact-case identity mismatch: ${relative}`);
    else missingActiveCaches.push(relative);
  }
  return { paths: paths.sort(), missingActiveCaches: missingActiveCaches.sort() };
}

async function verifyLegacy({ baseUrl, sourceSha, manifest = null, gitRoot, deadline, probeToken }) {
  const { paths, missingActiveCaches } = legacyContract(sourceSha, gitRoot, deadline);
  if (manifest && Object.keys(manifest.files).sort().join("\0") !== paths.join("\0")) throw new Error("legacy manifest allowlist mismatch");
  for (const relative of paths) {
    const expected = gitBytes(sourceSha, relative, gitRoot, deadline);
    const { bytes } = await fetchBytes(withProbe(baseUrl, relative, probeToken), { deadline });
    if (hash(bytes) !== hash(expected) || (manifest && manifest.files[relative] !== hash(expected))) throw new Error(`legacy file mismatch: ${relative}`);
  }
  for (const relative of missingActiveCaches) {
    await fetchBytes(withProbe(baseUrl, relative, probeToken), { expectedStatus: 404, deadline });
  }
  return { sourceSha, snapshotId: null, files: paths.length };
}

export async function probeProduction({ baseUrl, sourceSha = null, snapshotId = null, bootstrapPreflightSha = null, legacyRecoverySha = null, artifactContract = null, gitRoot = process.cwd(), deadline = Date.now() + 120_000 }) {
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("production probe deadline exceeded");
  const legacyProbeToken = bootstrapPreflightSha || legacyRecoverySha ? randomUUID() : null;
  const manifestUrl = withProbe(baseUrl, "deployment-manifest.json", legacyProbeToken ?? snapshotId);
  if (bootstrapPreflightSha) {
    if (!SHA_RE.test(bootstrapPreflightSha)) throw new Error("invalid bootstrap preflight SHA");
    await fetchBytes(manifestUrl, { expectedStatus: 404, deadline });
    return verifyLegacy({ baseUrl, sourceSha: bootstrapPreflightSha, gitRoot, deadline, probeToken: legacyProbeToken });
  }
  const { bytes: manifestBytes } = await fetchBytes(manifestUrl, { deadline });
  const parsed = parseJsonStrict(manifestBytes, "deployment manifest", 1024 * 1024);
  if (legacyRecoverySha) {
    if (!SHA_RE.test(legacyRecoverySha)) throw new Error("invalid legacy recovery SHA");
    const manifest = validateDeploymentManifest(parsed, { version: 0 });
    if (manifest.sourceSha !== legacyRecoverySha) throw new Error("legacy source SHA mismatch");
    return verifyLegacy({ baseUrl, sourceSha: legacyRecoverySha, manifest, gitRoot, deadline, probeToken: legacyProbeToken });
  }
  if (!SHA_RE.test(sourceSha) || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid production probe identity");
  const manifest = validateDeploymentManifest(parsed);
  if (manifest.sourceSha !== sourceSha || manifest.snapshotId !== snapshotId) throw new Error("production manifest identity mismatch");
  return verifyVersion1Payload({ baseUrl, manifest, manifestBytes, gitRoot, deadline, artifactContract });
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (file.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

export async function probeArtifactDirectory({ artifactDir, sourceSha = null, snapshotId = null, legacyRecoverySha = null, artifactContract = null, gitRoot = process.cwd() }) {
  const root = path.resolve(artifactDir);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!decoded || decoded.includes("\\") || decoded.split("/").some(part => !part || part === "." || part === "..")) { response.writeHead(404); response.end(); return; }
      const target = path.resolve(root, ...decoded.split("/"));
      if (!target.startsWith(`${root}${path.sep}`)) { response.writeHead(404); response.end(); return; }
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": contentType(decoded), "content-length": info.size });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    return await probeProduction({ baseUrl: `http://127.0.0.1:${address.port}/`, sourceSha, snapshotId, legacyRecoverySha, artifactContract, gitRoot });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    const key = argv[index].slice(2);
    if (Object.hasOwn(values, key)) throw new Error("invalid arguments");
    values[key] = argv[index + 1];
  }
  const actual = Object.keys(values).sort().join("\0");
  const validShapes = [
    ["artifact-dir", "legacy-recovery-sha"],
    ["artifact-dir", "snapshot-id", "source-sha"],
    ["base-url", "bootstrap-preflight-sha"],
    ["base-url", "legacy-recovery-sha"],
    ["base-url", "snapshot-id", "source-sha"],
    ["artifact-contract", "artifact-dir", "snapshot-id", "source-sha"],
    ["artifact-contract", "base-url", "snapshot-id", "source-sha"],
  ].map(keys => keys.sort().join("\0"));
  if (!validShapes.includes(actual) || Object.values(values).some(value => !value)) throw new Error("invalid arguments");
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactContract = args["artifact-contract"] ? parseJsonStrict(await readFile(path.resolve(args["artifact-contract"])), "artifact contract", 16 * 1024 * 1024) : null;
  const options = { sourceSha: args["source-sha"], snapshotId: args["snapshot-id"], bootstrapPreflightSha: args["bootstrap-preflight-sha"], legacyRecoverySha: args["legacy-recovery-sha"], artifactContract };
  const result = args["artifact-dir"]
    ? await probeArtifactDirectory({ artifactDir: args["artifact-dir"], sourceSha: options.sourceSha, snapshotId: options.snapshotId, legacyRecoverySha: options.legacyRecoverySha, artifactContract })
    : await probeProduction({ baseUrl: args["base-url"], ...options });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "production probe failed"); process.exitCode = 1; });
}
