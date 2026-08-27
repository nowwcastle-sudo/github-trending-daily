import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LEGACY_BASE_PATHS,
  expectedVersion1Paths,
  validateDeploymentManifest,
} from "./build-pages-artifact.mjs";
import { slugToFile } from "./generate-translations.mjs";

const SHA_RE = /^[a-f0-9]{40}$/;
const SNAPSHOT_RE = /^[0-9]{14}-[a-f0-9]{16}$/;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBytes(sha, relative, gitRoot = process.cwd()) {
  try {
    return execFileSync(process.env.GIT_BIN || "git", ["-C", gitRoot, "show", `${sha}:${relative}`], { encoding: null, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failure = new Error(`Git tree path unavailable: ${relative}`);
    failure.code = error.status;
    throw failure;
  }
}

function activeReposFromPage(page) {
  const matches = [...page.matchAll(/(?:^|\n)const REPOS = (\[[^\n]+\]);/g)];
  if (matches.length !== 1) throw new Error("invalid page repository region");
  const repos = JSON.parse(matches[0][1]);
  if (!Array.isArray(repos)) throw new Error("invalid page repository region");
  return repos;
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

async function fetchBytes(url, { expectedStatus = 200 } = {}) {
  const response = await fetch(url, { redirect: "error", cache: "no-store" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== expectedStatus) throw new Error(`unexpected HTTP status for ${new URL(url).pathname}: ${response.status}`);
  return { bytes, contentType: response.headers.get("content-type") ?? "", status: response.status };
}

function withProbe(baseUrl, relative, snapshotId) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(relative, base);
  if (snapshotId !== null) url.searchParams.set("probe", snapshotId);
  return url.href;
}

function assertMime(relative, contentType, bytes) {
  if (relative === "index.html" && (!/text\/html/i.test(contentType) || !bytes.toString("utf8").includes("<"))) throw new Error("wrong MIME-critical HTML payload");
  if (relative.endsWith(".js") && !/(?:javascript|text\/plain)/i.test(contentType)) throw new Error(`wrong MIME-critical JavaScript payload: ${relative}`);
  if (relative.endsWith(".json") && !/(?:application\/json|text\/plain|octet-stream)/i.test(contentType)) throw new Error(`wrong MIME-critical JSON payload: ${relative}`);
  if (relative.endsWith(".xml") && !/(?:xml|text\/plain|octet-stream)/i.test(contentType)) throw new Error(`wrong MIME-critical XML payload: ${relative}`);
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

function normalizeSlugList(values) {
  return values.map(value => value.toLowerCase()).sort();
}

async function verifyVersion1Payload({ baseUrl, manifest, manifestBytes, gitRoot }) {
  const bodies = new Map();
  for (const [relative, expectedHash] of Object.entries(manifest.files)) {
    const { bytes, contentType } = await fetchBytes(withProbe(baseUrl, relative, manifest.snapshotId));
    if (hash(bytes) !== expectedHash) throw new Error(`published file hash mismatch: ${relative}`);
    assertMime(relative, contentType, bytes);
    bodies.set(relative, bytes);
  }
  const required = ["index.html", "data/latest.json", "data/membership-status.json", "feed.xml", "changes.xml"];
  for (const relative of required) if (!bodies.has(relative)) throw new Error(`missing required probe input: ${relative}`);
  const page = bodies.get("index.html").toString("utf8");
  const latest = JSON.parse(bodies.get("data/latest.json").toString("utf8"));
  const membership = JSON.parse(bodies.get("data/membership-status.json").toString("utf8"));
  const sources = JSON.parse(gitBytes(manifest.sourceSha, "data/translation-sources.json", gitRoot).toString("utf8"));
  const expectedPaths = expectedVersion1Paths(latest, sources);
  if (Object.keys(manifest.files).sort().join("\0") !== expectedPaths.join("\0")) throw new Error("manifest contains missing or stale extra artifact paths");
  if (latest.snapshotId !== manifest.snapshotId || latest.count !== latest.repos?.length) throw new Error("latest identity/count mismatch");
  const pageRepos = activeReposFromPage(page);
  if (pageRepos.some(repo => repo._snapshot_id !== manifest.snapshotId || repo._generated_at !== latest.generatedAt || repo._stats_date !== latest.statsDate)) throw new Error("page run identity mismatch");
  const latestSlugs = latest.repos.map(repo => repo.slug);
  const pageSlugs = pageRepos.map(repo => repo.slug);
  const membershipSlugs = membership.current?.map(repo => repo.slug) ?? [];
  const feedSlugs = atomSlugs(bodies.get("feed.xml").toString("utf8"));
  const expectedSlugs = normalizeSlugList(latestSlugs);
  for (const [label, slugs] of [["page", pageSlugs], ["membership", membershipSlugs], ["feed", feedSlugs]]) {
    if (normalizeSlugList(slugs).join("\0") !== expectedSlugs.join("\0")) throw new Error(`${label} active repository count/identity mismatch`);
  }
  const changes = atomEntries(bodies.get("changes.xml").toString("utf8"));
  const expectedChanges = membership.current.filter(repo => repo.status === "new" || repo.status === "reentered").length;
  if (changes.length !== expectedChanges) throw new Error("applicable change count mismatch");

  const sourcesByLower = new Map(Object.entries(sources.sources).map(([slug, source]) => [slug.toLowerCase(), source]));
  for (const slug of latestSlugs) {
    const source = sourcesByLower.get(slug.toLowerCase());
    if (source?.translation_applicable !== true) continue;
    const relative = `translations/${slugToFile(slug)}`;
    const payload = JSON.parse(bodies.get(relative)?.toString("utf8") ?? "null");
    if (!exactKeys(payload, ["markdown", "source"]) || typeof payload.markdown !== "string" || !payload.markdown.trim() || JSON.stringify(payload.source) !== JSON.stringify(source)) {
      throw new Error(`translation envelope/provenance mismatch: ${slug}`);
    }
  }
  return { sourceSha: manifest.sourceSha, snapshotId: manifest.snapshotId, manifestSha256: hash(manifestBytes), files: Object.keys(manifest.files).length };
}

function legacyPaths(sha, gitRoot) {
  const page = gitBytes(sha, "index.html", gitRoot).toString("utf8");
  const paths = [];
  for (const relative of LEGACY_BASE_PATHS) {
    try { gitBytes(sha, relative, gitRoot); paths.push(relative); } catch { /* paths introduced later are absent */ }
  }
  for (const repo of activeReposFromPage(page)) paths.push(`readmes/${repo.slug.replaceAll("/", "__")}.md`);
  return paths.sort();
}

async function verifyLegacy({ baseUrl, sourceSha, manifest = null, gitRoot }) {
  const paths = legacyPaths(sourceSha, gitRoot);
  if (manifest && Object.keys(manifest.files).sort().join("\0") !== paths.join("\0")) throw new Error("legacy manifest allowlist mismatch");
  for (const relative of paths) {
    const expected = gitBytes(sourceSha, relative, gitRoot);
    const { bytes } = await fetchBytes(withProbe(baseUrl, relative, null));
    if (hash(bytes) !== hash(expected) || (manifest && manifest.files[relative] !== hash(expected))) throw new Error(`legacy file mismatch: ${relative}`);
  }
  return { sourceSha, snapshotId: null, files: paths.length };
}

export async function probeProduction({ baseUrl, sourceSha = null, snapshotId = null, bootstrapPreflightSha = null, legacyRecoverySha = null, gitRoot = process.cwd() }) {
  const manifestUrl = withProbe(baseUrl, "deployment-manifest.json", snapshotId);
  if (bootstrapPreflightSha) {
    if (!SHA_RE.test(bootstrapPreflightSha)) throw new Error("invalid bootstrap preflight SHA");
    await fetchBytes(manifestUrl, { expectedStatus: 404 });
    return verifyLegacy({ baseUrl, sourceSha: bootstrapPreflightSha, gitRoot });
  }
  const { bytes: manifestBytes } = await fetchBytes(manifestUrl);
  const parsed = JSON.parse(manifestBytes.toString("utf8"));
  if (legacyRecoverySha) {
    if (!SHA_RE.test(legacyRecoverySha)) throw new Error("invalid legacy recovery SHA");
    const manifest = validateDeploymentManifest(parsed, { version: 0 });
    if (manifest.sourceSha !== legacyRecoverySha) throw new Error("legacy source SHA mismatch");
    return verifyLegacy({ baseUrl, sourceSha: legacyRecoverySha, manifest, gitRoot });
  }
  if (!SHA_RE.test(sourceSha) || !SNAPSHOT_RE.test(snapshotId)) throw new Error("invalid production probe identity");
  const manifest = validateDeploymentManifest(parsed);
  if (manifest.sourceSha !== sourceSha || manifest.snapshotId !== snapshotId) throw new Error("production manifest identity mismatch");
  return verifyVersion1Payload({ baseUrl, manifest, manifestBytes, gitRoot });
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (file.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

export async function probeArtifactDirectory({ artifactDir, sourceSha = null, snapshotId = null, legacyRecoverySha = null, gitRoot = process.cwd() }) {
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
    return await probeProduction({ baseUrl: `http://127.0.0.1:${address.port}/`, sourceSha, snapshotId, legacyRecoverySha, gitRoot });
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
  ].map(keys => keys.sort().join("\0"));
  if (!validShapes.includes(actual) || Object.values(values).some(value => !value)) throw new Error("invalid arguments");
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = { sourceSha: args["source-sha"], snapshotId: args["snapshot-id"], bootstrapPreflightSha: args["bootstrap-preflight-sha"], legacyRecoverySha: args["legacy-recovery-sha"] };
  const result = args["artifact-dir"]
    ? await probeArtifactDirectory({ artifactDir: args["artifact-dir"], sourceSha: options.sourceSha, snapshotId: options.snapshotId, legacyRecoverySha: options.legacyRecoverySha })
    : await probeProduction({ baseUrl: args["base-url"], ...options });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error?.message || "production probe failed"); process.exitCode = 1; });
}
