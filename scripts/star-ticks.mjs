import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseJsonStrict } from "./build-pages-artifact.mjs";

// Star ticks (2026-09-03 design §4.3): the star-ticks workflow observes exact
// total stars from the GitHub REST API. Tier A (published repositories) is
// observed every run and written to append-only monthly tick ledgers; Tier B
// (every repository ever published, within the cap) is observed once a day and
// written straight to the daily ledger. star-history.json v2 is derived from
// both ledgers plus the W1 gain anchors and only covers published repositories.

const API_BASE = "https://api.github.com";
const DAY_MS = 86_400_000;
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MONTH_FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;
const RETRY_DELAYS_MS = Object.freeze([2000, 8000]);
const UNAVAILABLE_STATUSES = new Set([404, 451]);
const ANCHOR_SOURCES = new Set(["github_created_at", "github_trending_gain_daily", "github_trending_gain_weekly", "github_trending_gain_monthly"]);

export const DAILY_LEDGER_HEADER = '{"version":1}';
export const DEFAULT_WATCH_CAP = 500;
// Reserve kept on the shared GITHUB_TOKEN bucket (1,000 requests/hour) before a run
// starts: Tier A needs at most 75 repository calls plus the gate, Tier B adds up to
// 425 archive repositories. A single reserve of 500 would have skipped every Tier A
// tick in the hour after a refresh (2026-09-03 review L3).
export const RATE_LIMIT_RESERVE = Object.freeze({ a: 100, ab: 550 });
export const TICK_WINDOW_DAYS = 14;
export const GAIN_WINDOW_DAYS = 7;
export const MAX_OBSERVED_POINTS = 2000;
export const MAX_ANCHOR_POINTS = 4;
// Tier B belongs to the :35 slot of odd UTC hours; the scheduler may start a run
// up to ~15 minutes late, so the slot is recognised from minute 20 onwards.
export const TIER_B_SLOT_MINUTE = 20;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validTime(value) {
  if (typeof value !== "string" || !TIME_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && isoSeconds(parsed) === value;
}

const validStars = value => Number.isSafeInteger(value) && value >= 0;
const isoSeconds = milliseconds => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
const isoDate = milliseconds => new Date(milliseconds).toISOString().slice(0, 10);
const lower = slug => slug.toLowerCase();

function parseLine(line, label) {
  let value;
  try { value = JSON.parse(line); } catch { throw new Error(`${label} line is not JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} line is not an object`);
  return value;
}

function ledgerLines(text, label) {
  const lines = String(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some(line => line === "")) throw new Error(`${label} contains an empty line`);
  return lines;
}

export function parseDailyLedger(text) {
  const lines = ledgerLines(text, "daily ledger");
  if (lines[0] !== DAILY_LEDGER_HEADER) throw new Error("daily ledger header is invalid");
  const rows = new Map();
  for (const line of lines.slice(1)) {
    const value = parseLine(line, "daily ledger");
    const unavailable = exactKeys(value, ["date", "slug", "unavailable", "tier"]);
    if ((!unavailable && !exactKeys(value, ["date", "slug", "stars", "tier"]))
        || !validDate(value.date) || typeof value.slug !== "string" || !SLUG_RE.test(value.slug)
        || !["A", "B"].includes(value.tier)
        || (unavailable ? value.unavailable !== true : !validStars(value.stars))) {
      throw new Error("daily ledger row is invalid");
    }
    const key = lower(value.slug);
    const list = rows.get(key) ?? [];
    if (list.length > 0 && list.at(-1).date > value.date) throw new Error(`daily ledger rows are out of order: ${value.slug}`);
    list.push({ date: value.date, slug: value.slug, stars: unavailable ? null : value.stars, tier: value.tier, unavailable });
    rows.set(key, list);
  }
  return rows;
}

export function parseTickLedger(text) {
  const lines = ledgerLines(text, "tick ledger");
  const runs = [];
  for (const line of lines) {
    const value = parseLine(line, "tick ledger");
    if (exactKeys(value, ["at", "run_id"])) {
      if (!validTime(value.at) || typeof value.run_id !== "string" || !value.run_id) throw new Error("tick ledger run header is invalid");
      if (runs.length > 0 && runs.at(-1).at >= value.at) throw new Error("tick ledger runs are out of order");
      runs.push({ at: value.at, run_id: value.run_id, ticks: [] });
      continue;
    }
    if (runs.length === 0) throw new Error("tick ledger is missing its run header");
    const unavailable = exactKeys(value, ["slug", "unavailable"]);
    if ((!unavailable && !exactKeys(value, ["slug", "stars"])) || typeof value.slug !== "string" || !SLUG_RE.test(value.slug)
        || (unavailable ? value.unavailable !== true : !validStars(value.stars))) {
      throw new Error("tick ledger tick line is invalid");
    }
    runs.at(-1).ticks.push(unavailable ? { slug: value.slug, unavailable: true } : { slug: value.slug, stars: value.stars });
  }
  return runs;
}

function assertSlugs(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  for (const slug of values) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new Error(`${label} slug is invalid`);
    if (seen.has(lower(slug))) throw new Error(`${label} slug is duplicated: ${slug}`);
    seen.add(lower(slug));
  }
  return seen;
}

// Continuous top-N: published repositories are always watched; the remaining
// capacity goes to the ever-published repositories with the largest 7-day gain.
export function selectWatchSet({ published, dailyRows, cap = DEFAULT_WATCH_CAP, today }) {
  const tierAKeys = assertSlugs(published, "published");
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("watch cap is invalid");
  if (!validDate(today)) throw new Error("today is invalid");
  const windowStart = isoDate(Date.parse(`${today}T00:00:00Z`) - GAIN_WINDOW_DAYS * DAY_MS);
  const candidates = [];
  for (const [key, rows] of dailyRows) {
    if (tierAKeys.has(key)) continue;
    const recent = rows.slice(-3);
    if (recent.length === 3 && recent.every(row => row.unavailable)) continue;
    const observed = rows.filter(row => !row.unavailable);
    if (observed.length === 0) continue;
    const latest = observed.at(-1);
    const baseline = [...observed].reverse().find(row => row.date <= windowStart) ?? observed[0];
    const lastTierA = rows.filter(row => row.tier === "A").at(-1)?.date ?? "";
    candidates.push({ key, slug: latest.slug, gain: latest.stars - baseline.stars, lastTierA });
  }
  candidates.sort((left, right) => right.gain - left.gain
    || (right.lastTierA > left.lastTierA ? 1 : right.lastTierA < left.lastTierA ? -1 : 0)
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const room = Math.max(0, cap - published.length);
  return { tierA: [...published], tierB: candidates.slice(0, room).map(candidate => candidate.slug) };
}

export function resolveTier({ nowMs, event, requested = "" }) {
  if (event === "workflow_dispatch") {
    if (requested === "" || requested === "a") return "a";
    if (requested === "ab") return "ab";
    throw new Error("requested tier must be a or ab");
  }
  const date = new Date(nowMs);
  return date.getUTCHours() % 2 === 1 && date.getUTCMinutes() >= TIER_B_SLOT_MINUTE ? "ab" : "a";
}

export function assertAppendOnly(existingBytes, newBytes) {
  if (newBytes.length < existingBytes.length || !newBytes.subarray(0, existingBytes.length).equals(existingBytes)) {
    throw new Error("ledger is not append-only: existing bytes changed");
  }
}

export function appendLedger({ existingBytes, lines }) {
  if (existingBytes.length > 0 && existingBytes[existingBytes.length - 1] !== 0x0a) throw new Error("ledger is not newline-terminated");
  if (!Array.isArray(lines) || lines.some(line => typeof line !== "string" || line === "" || line.includes("\n"))) throw new Error("ledger lines are invalid");
  return Buffer.concat([existingBytes, Buffer.from(lines.map(line => `${line}\n`).join(""), "utf8")]);
}

export function rollupDaily(runs, date) {
  const result = new Map();
  for (const run of runs) {
    if (run.at.slice(0, 10) !== date) continue;
    for (const tick of run.ticks) if (!tick.unavailable) result.set(lower(tick.slug), { slug: tick.slug, stars: tick.stars });
  }
  return result;
}

function validateAnchors(value) {
  if (!exactKeys(value, ["version", "generatedAt", "anchors", "warnings"]) || value.version !== 1
      || (value.generatedAt !== null && typeof value.generatedAt !== "string")
      || !value.anchors || typeof value.anchors !== "object" || Array.isArray(value.anchors) || !Array.isArray(value.warnings)) {
    throw new Error("star anchors envelope is invalid");
  }
  const byKey = new Map();
  for (const [slug, points] of Object.entries(value.anchors)) {
    if (!SLUG_RE.test(slug) || !Array.isArray(points) || points.length > MAX_ANCHOR_POINTS || byKey.has(lower(slug))) throw new Error("star anchors entry is invalid");
    for (const point of points) {
      if (!exactKeys(point, ["at", "stars", "source"]) || !validTime(point.at) || !validStars(point.stars) || !ANCHOR_SOURCES.has(point.source)) {
        throw new Error("star anchor point is invalid");
      }
    }
    byKey.set(lower(slug), points.map(point => ({ at: point.at, stars: point.stars, source: point.source })));
  }
  return byKey;
}

export function deriveStarHistoryV2({ published, tickRuns, dailyRows, anchors, now }) {
  assertSlugs(published, "published");
  if (!validTime(now)) throw new Error("now is invalid");
  const anchorsByKey = validateAnchors(anchors);
  const cutoffMs = Date.parse(now) - TICK_WINDOW_DAYS * DAY_MS;
  const repositories = published.map(slug => {
    const key = lower(slug);
    const byAt = new Map();
    for (const run of tickRuns) {
      if (Date.parse(run.at) < cutoffMs) continue;
      const tick = run.ticks.find(candidate => lower(candidate.slug) === key && !candidate.unavailable);
      if (tick) byAt.set(run.at, { at: run.at, stars: tick.stars, source: "github_rest" });
    }
    const tickDates = new Set([...byAt.keys()].map(at => at.slice(0, 10)));
    for (const row of dailyRows.get(key) ?? []) {
      if (row.unavailable || tickDates.has(row.date)) continue;
      const at = `${row.date}T23:59:59Z`;
      if (!byAt.has(at)) byAt.set(at, { at, stars: row.stars, source: "github_rest" });
    }
    const observed = [...byAt.values()].sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0)).slice(-MAX_OBSERVED_POINTS);
    const observedDates = new Set(observed.map(point => point.at.slice(0, 10)));
    const repositoryAnchors = (anchorsByKey.get(key) ?? [])
      .filter(point => !observedDates.has(point.at.slice(0, 10)))
      .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
    return { slug, anchors: repositoryAnchors, observed };
  });
  return { version: 2, generatedAt: now, repositories };
}

async function readLedgerBytes(pathname, { optional = false } = {}) {
  let bytes;
  try { bytes = await readFile(pathname); } catch (error) {
    if (optional && error?.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) throw new Error(`ledger is not newline-terminated: ${path.basename(pathname)}`);
  return bytes;
}

async function writeLedger(pathname, existingBytes, bytes) {
  assertAppendOnly(existingBytes, bytes);
  const pending = `${pathname}.pending-${randomUUID()}`;
  try {
    await writeFile(pending, bytes, { flag: "wx" });
    await rename(pending, pathname);
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
  assertAppendOnly(existingBytes, await readFile(pathname));
}

export async function readTickRuns(ticksDir) {
  const names = (await readdir(ticksDir)).filter(name => MONTH_FILE_RE.test(name)).sort();
  const runs = [];
  for (const name of names) {
    const fileRuns = parseTickLedger((await readLedgerBytes(path.join(ticksDir, name))).toString("utf8"));
    if (runs.length > 0 && fileRuns.length > 0 && runs.at(-1).at >= fileRuns[0].at) throw new Error("tick ledger files are out of order");
    runs.push(...fileRuns);
  }
  return runs;
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "github-trending-daily-star-ticks",
    "x-github-api-version": "2022-11-28",
  };
}

async function observeRepository({ slug, fetchImpl, token, sleep }) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let response;
    try { response = await fetchImpl(`${API_BASE}/repos/${slug}`, { headers: githubHeaders(token) }); } catch { response = null; }
    const status = response?.status ?? 0;
    if (status === 200) {
      const body = await response.json();
      if (!validStars(body?.stargazers_count)) throw new Error(`repository payload is invalid: ${slug}`);
      // A redirect (rename) or a repository recreated under the old name answers with
      // a different full_name; its stars are not this repository's history.
      if (typeof body.full_name !== "string" || lower(body.full_name) !== lower(slug)) return { unavailable: true };
      return { stars: body.stargazers_count };
    }
    if (UNAVAILABLE_STATUSES.has(status)) return { unavailable: true };
    if (status === 401) throw new Error("GitHub token was rejected");
    if (attempt < RETRY_DELAYS_MS.length && (status === 0 || status === 403 || status === 429 || status >= 500)) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    return null;
  }
  return null;
}

export async function collectStarTicks({
  tier, published, ticksDir, dailyPath, fetchImpl, token, runId,
  now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), cap = DEFAULT_WATCH_CAP,
}) {
  if (!["a", "ab"].includes(tier)) throw new Error("tier must be a or ab");
  assertSlugs(published, "published");
  if (typeof token !== "string" || !token) throw new Error("GitHub token is missing");
  if (typeof runId !== "string" || !runId) throw new Error("run id is missing");
  const nowMs = now();
  const at = isoSeconds(nowMs);
  const today = isoDate(nowMs);
  const month = at.slice(0, 7);

  const rateResponse = await fetchImpl(`${API_BASE}/rate_limit`, { headers: githubHeaders(token) });
  if (rateResponse?.status !== 200) throw new Error("rate limit request failed");
  const remaining = (await rateResponse.json())?.resources?.core?.remaining;
  if (!Number.isSafeInteger(remaining)) throw new Error("rate limit payload is invalid");
  const reserve = RATE_LIMIT_RESERVE[tier];
  if (remaining < reserve) return { skipped: true, remaining, reserve };

  const dailyBytes = await readLedgerBytes(dailyPath);
  const dailyRows = parseDailyLedger(dailyBytes.toString("utf8"));
  const runs = await readTickRuns(ticksDir);
  if (runs.length > 0 && runs.at(-1).at >= at) throw new Error("tick ledger already contains a later run");

  const counts = { observed: 0, unavailable: 0, failed: 0 };
  const observe = async slug => {
    const result = await observeRepository({ slug, fetchImpl, token, sleep });
    if (result === null) counts.failed += 1;
    else if (result.unavailable) counts.unavailable += 1;
    else counts.observed += 1;
    return result;
  };

  const tickLines = [JSON.stringify({ at, run_id: runId })];
  for (const slug of published) {
    const result = await observe(slug);
    if (result === null) continue;
    tickLines.push(JSON.stringify(result.unavailable ? { slug, unavailable: true } : { slug, stars: result.stars }));
  }
  const monthPath = path.join(ticksDir, `${month}.jsonl`);
  const monthBytes = await readLedgerBytes(monthPath, { optional: true });
  await writeLedger(monthPath, monthBytes, appendLedger({ existingBytes: monthBytes, lines: tickLines }));

  // Daily rollup: the last successful tick of each past day becomes that day's
  // Tier A row unless the ledger already has one (idempotent across reruns).
  const dailyLines = [];
  const lastDate = key => dailyRows.get(key)?.at(-1)?.date ?? "";
  const hasRow = (key, date, tier_) => (dailyRows.get(key) ?? []).some(row => row.date === date && row.tier === tier_);
  for (const date of [...new Set(runs.map(run => run.at.slice(0, 10)))].filter(value => value < today).sort()) {
    for (const [key, point] of rollupDaily(runs, date)) {
      if (hasRow(key, date, "A") || lastDate(key) > date) continue;
      dailyLines.push(JSON.stringify({ date, slug: point.slug, stars: point.stars, tier: "A" }));
    }
  }
  let tierB = [];
  if (tier === "ab") {
    tierB = selectWatchSet({ published, dailyRows, cap, today }).tierB;
    for (const slug of tierB) {
      const key = lower(slug);
      if (hasRow(key, today, "B")) continue;
      const result = await observe(slug);
      if (result === null) continue;
      dailyLines.push(JSON.stringify(result.unavailable ? { date: today, slug, unavailable: true, tier: "B" } : { date: today, slug, stars: result.stars, tier: "B" }));
    }
  }
  if (dailyLines.length > 0) await writeLedger(dailyPath, dailyBytes, appendLedger({ existingBytes: dailyBytes, lines: dailyLines }));
  return { skipped: false, tierA: published.length, tierB: tierB.length, ...counts, dailyAppended: dailyLines.length, month };
}

function publishedSlugs(latestBytes) {
  const latest = parseJsonStrict(latestBytes, "latest JSON");
  if (!Array.isArray(latest?.repos)) throw new Error("latest JSON repos are invalid");
  const slugs = latest.repos.map(repo => repo?.slug);
  assertSlugs(slugs, "published");
  return slugs;
}

function parseArgs(argv, expected) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    const key = argv[index].slice(2);
    if (Object.hasOwn(values, key)) throw new Error("invalid arguments");
    values[key] = argv[index + 1];
  }
  if (Object.keys(values).sort().join("\0") !== [...expected].sort().join("\0")) throw new Error(`usage: star-ticks.mjs ${expected.map(key => `--${key} VALUE`).join(" ")}`);
  return values;
}

export async function runStarTicksCli(argv, { environment = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const [command, ...rest] = argv;
  if (command === "collect") {
    const args = parseArgs(rest, ["token-env", "tier", "published", "ticks-dir", "daily", "run-id"]);
    const token = environment[args["token-env"]];
    if (typeof token !== "string" || !token) throw new Error(`environment variable ${args["token-env"]} is empty`);
    return collectStarTicks({
      tier: args.tier, published: publishedSlugs(await readFile(args.published)), ticksDir: path.resolve(args["ticks-dir"]),
      dailyPath: path.resolve(args.daily), fetchImpl, token, runId: args["run-id"], now,
    });
  }
  if (command === "tier") {
    const args = parseArgs(rest, ["event", "requested"]);
    return resolveTier({ nowMs: now(), event: args.event, requested: args.requested });
  }
  if (command === "derive") {
    const args = parseArgs(rest, ["published", "ticks-dir", "daily", "anchors", "out"]);
    const history = deriveStarHistoryV2({
      published: publishedSlugs(await readFile(args.published)),
      tickRuns: await readTickRuns(path.resolve(args["ticks-dir"])),
      dailyRows: parseDailyLedger((await readLedgerBytes(path.resolve(args.daily))).toString("utf8")),
      anchors: parseJsonStrict(await readFile(args.anchors), "star anchors JSON"),
      now: isoSeconds(now()),
    });
    await writeFile(path.resolve(args.out), `${JSON.stringify(history, null, 2)}\n`);
    return { repositories: history.repositories.length, observed: history.repositories.reduce((sum, repo) => sum + repo.observed.length, 0) };
  }
  throw new Error("usage: star-ticks.mjs tier|collect|derive ...");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runStarTicksCli(process.argv.slice(2))
    .then(result => console.log(typeof result === "string" ? result : JSON.stringify(result)))
    .catch(error => { console.error(error?.message || "star ticks failed"); process.exitCode = 1; });
}
