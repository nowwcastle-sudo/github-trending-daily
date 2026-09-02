import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJsonStrict } from "./build-pages-artifact.mjs";

export const TAG_RULE_VERSION = 1;
export const FIELD_TAG_IDS = Object.freeze([
  "ai-ml", "web-app", "dev-tools", "data", "devops", "security", "productivity", "systems", "learning",
]);
export const FORM_TAG_IDS = Object.freeze([
  "agent", "mcp", "plugin-skill", "ide", "library", "framework", "cli",
]);

const DEFAULT_EXPORT = fileURLToPath(new URL("../repository-snapshot-export.json", import.meta.url));
const TRACKED_LATEST = fileURLToPath(new URL("../data/latest.json", import.meta.url));
const SNAPSHOT_KEYS = ["version", "snapshotId", "generatedAt", "statsDate", "repositories"];
const REPOSITORY_KEYS = [
  "slug", "name", "description", "lang", "topics", "stars", "forks", "issues", "contributors",
  "gains", "signal", "summary", "summary_status", "tag_rule_version", "field_tags", "form_tags",
];
const SUMMARY_STATUSES = ["verified", "retained", "held"];
const SUMMARY_KEYS = ["goal", "usage", "pros", "cons", "fit"];
const GAIN_KEYS = ["daily", "weekly", "monthly"];
const SIGNAL_KEYS = ["streakDays", "starsChange"];
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_ID_RE = /^\d{14}-[a-f0-9]{16}$/;

function fail() {
  throw new Error("snapshot export is invalid");
}

function candidateFail() {
  throw new Error("latest output must be an explicit candidate path");
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function canonicalOutputPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code !== "ENOENT") candidateFail();
  }
  try {
    return resolve(await realpath(dirname(path)), basename(path));
  } catch {
    candidateFail();
  }
}

async function validateCandidatePath(path) {
  if (typeof path !== "string" || !path) candidateFail();
  const absolute = resolve(path);
  let candidate;
  let tracked;
  try {
    [candidate, tracked] = await Promise.all([canonicalOutputPath(absolute), realpath(TRACKED_LATEST)]);
  } catch {
    candidateFail();
  }
  if (samePath(candidate, tracked)) candidateFail();
  return candidate;
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCalendar(value, pattern, suffix = "") {
  if (typeof value !== "string" || !pattern.test(value)) return false;
  const parsed = Date.parse(`${value}${suffix}`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validateOrderedTags(value, allowed, { field = false } = {}) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) fail();
  if (new Set(value).size !== value.length) fail();
  if (field && value.length === 1 && value[0] === "unclassified") return;
  if (field && (value.length === 0 || value.includes("unclassified"))) fail();
  if (value.some(item => !allowed.includes(item))) fail();
  if (value.some((item, index) => index > 0 && allowed.indexOf(value[index - 1]) >= allowed.indexOf(item))) fail();
}

function validateRepository(value) {
  if (!exactKeys(value, REPOSITORY_KEYS) || !SLUG_RE.test(value.slug)) fail();
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 300) fail();
  if (typeof value.description !== "string" || value.description.length > 10_000) fail();
  if (!(value.lang === null || (typeof value.lang === "string" && value.lang.length <= 200))) fail();
  if (!Array.isArray(value.topics) || value.topics.some(topic => typeof topic !== "string")
    || new Set(value.topics).size !== value.topics.length
    || value.topics.some((topic, index) => index > 0 && value.topics[index - 1] >= topic)) fail();
  for (const field of ["stars", "forks", "issues", "contributors"]) {
    if (!safeNonnegative(value[field])) fail();
  }
  if (!exactKeys(value.gains, GAIN_KEYS)
    || GAIN_KEYS.some(key => value.gains[key] !== null && !safeNonnegative(value.gains[key]))) fail();
  if (value.signal !== null) {
    if (!exactKeys(value.signal, SIGNAL_KEYS) || !safeNonnegative(value.signal.streakDays)
      || (value.signal.starsChange !== null && !Number.isSafeInteger(value.signal.starsChange))) fail();
  }
  if (!SUMMARY_STATUSES.includes(value.summary_status)) fail();
  if (value.summary_status === "held") {
    if (value.summary !== null) fail();
  } else if (!exactKeys(value.summary, SUMMARY_KEYS)
    || SUMMARY_KEYS.some(key => typeof value.summary[key] !== "string" || !value.summary[key].trim())) fail();
  if (value.tag_rule_version !== TAG_RULE_VERSION) fail();
  validateOrderedTags(value.field_tags, FIELD_TAG_IDS, { field: true });
  validateOrderedTags(value.form_tags, FORM_TAG_IDS);
}

export function validateSnapshotExport(value) {
  if (!exactKeys(value, SNAPSHOT_KEYS) || value.version !== 1) fail();
  if (!UTC_RE.test(value.generatedAt) || new Date(value.generatedAt).toISOString() !== value.generatedAt) fail();
  if (!validCalendar(value.statsDate, DATE_RE, "T00:00:00Z")) fail();
  if (new Date(Date.parse(value.generatedAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) !== value.statsDate) fail();
  if (!SNAPSHOT_ID_RE.test(value.snapshotId)) fail();
  const digits = value.generatedAt.replace(/\D/g, "").slice(0, 14);
  const digest = createHash("sha256").update(`${value.generatedAt}|run-context-v1`).digest("hex").slice(0, 16);
  if (value.snapshotId !== `${digits}-${digest}`) fail();
  if (!Array.isArray(value.repositories) || value.repositories.length < 1 || value.repositories.length > 75) fail();
  const seen = new Set();
  for (const repository of value.repositories) {
    validateRepository(repository);
    const folded = repository.slug.toLowerCase();
    if (seen.has(folded)) fail();
    seen.add(folded);
  }
  return value;
}

export function buildLatestFeed(snapshotExport) {
  const value = validateSnapshotExport(snapshotExport);
  return {
    snapshotId: value.snapshotId,
    generatedAt: value.generatedAt,
    statsDate: value.statsDate,
    count: value.repositories.length,
    repos: value.repositories.map(repository => ({
      slug: repository.slug,
      name: repository.name,
      description: repository.description,
      lang: repository.lang,
      topics: [...repository.topics],
      stars: repository.stars,
      forks: repository.forks,
      issues: repository.issues,
      contributors: repository.contributors,
      gains: { ...repository.gains },
      signal: repository.signal === null ? null : { ...repository.signal },
      summary: repository.summary === null ? null : { ...repository.summary },
      summary_status: repository.summary_status,
      tag_rule_version: repository.tag_rule_version,
      field_tags: [...repository.field_tags],
      form_tags: [...repository.form_tags],
    })),
  };
}

export async function writeLatestFeed(path, feed) {
  path = await validateCandidatePath(path);
  await mkdir(dirname(path), { recursive: true });
  try {
    const prior = JSON.parse(await readFile(path, "utf8"));
    if (JSON.stringify(prior) === JSON.stringify(feed)) return false;
  } catch {
    // A missing or malformed candidate output is replaced atomically.
  }
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(pending, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
  return true;
}

export async function updateLatestFeed({ exportPath = DEFAULT_EXPORT, latestPath } = {}) {
  latestPath = await validateCandidatePath(latestPath);
  let snapshotExport;
  try {
    snapshotExport = parseJsonStrict(await readFile(exportPath), "snapshot export", 16 * 1024 * 1024);
  } catch {
    fail();
  }
  const feed = buildLatestFeed(snapshotExport);
  const changed = await writeLatestFeed(latestPath, feed);
  return { changed, count: feed.count, snapshotId: feed.snapshotId };
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--snapshot-export" || argv[2] !== "--latest") fail();
  return { exportPath: resolve(argv[1]), latestPath: resolve(argv[3]) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  updateLatestFeed(parseArguments(process.argv.slice(2))).then(result => {
    console.log(`latest_changed=${String(result.changed).toLowerCase()} count=${result.count}`);
  }).catch(error => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
