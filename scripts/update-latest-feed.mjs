import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePageRepos } from "./update-trending.mjs";
import { readRunContext, validateRunContext } from "./run-context.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_ID_RE = /^\d{14}-[a-f0-9]{16}$/;

function dayNumber(value) {
  if (!DATE_RE.test(value)) throw new Error(`invalid observation date: ${String(value)}`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid observation date: ${value}`);
  return timestamp / 86_400_000;
}

export function computeSignals(rows) {
  if (!Array.isArray(rows)) throw new Error("observation rows must be an array");
  const bySlug = new Map();
  for (const row of rows) {
    if (!REPO_RE.test(row?.slug ?? "")) throw new Error(`invalid observation slug: ${String(row?.slug)}`);
    if (!Number.isSafeInteger(row.stars_total) || row.stars_total < 0) {
      throw new Error(`invalid observation stars: ${row.slug}`);
    }
    dayNumber(row.observed_date);
    const key = row.slug.toLowerCase();
    const history = bySlug.get(key) ?? new Map();
    history.set(row.observed_date, Math.max(history.get(row.observed_date) ?? 0, row.stars_total));
    bySlug.set(key, history);
  }

  const signals = new Map();
  for (const [slug, byDate] of bySlug) {
    const history = [...byDate].sort(([left], [right]) => left.localeCompare(right));
    let streakDays = history.length ? 1 : 0;
    for (let index = history.length - 1; index > 0; index -= 1) {
      if (dayNumber(history[index][0]) - dayNumber(history[index - 1][0]) !== 1) break;
      streakDays += 1;
    }
    const latest = history.at(-1)?.[1] ?? null;
    const previous = history.at(-2)?.[1] ?? null;
    signals.set(slug, {
      streakDays,
      starsChange: previous === null ? null : latest - previous,
    });
  }
  return signals;
}

export function buildLatestFeed({ repos, snapshotId, statsDate, generatedAt, signals }) {
  if (!Array.isArray(repos) || !repos.length) throw new Error("repositories are required");
  if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error("snapshotId must be a valid run snapshot id");
  if (!DATE_RE.test(statsDate)) throw new Error("statsDate must be YYYY-MM-DD");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generatedAt must be an ISO timestamp");
  if (!(signals instanceof Map)) throw new Error("signals must be a Map");
  if (snapshotId.slice(0, 14) !== generatedAt.replace(/\D/g, "").slice(0, 14)) {
    throw new Error("snapshotId must match generatedAt");
  }
  return {
    snapshotId,
    generatedAt,
    statsDate,
    count: repos.length,
    repos: repos.map(({ slug, name, desc, lang, topics, stars, forks, issues, contributors,
      stars_daily, stars_weekly, stars_monthly, summary }) => {
      if (typeof desc !== "string" || !desc.trim()) throw new Error(`repository description is required: ${slug}`);
      return {
        slug, name, description: desc, lang, topics, stars, forks, issues, contributors,
        gains: { daily: stars_daily ?? null, weekly: stars_weekly ?? null, monthly: stars_monthly ?? null },
        signal: signals.get(slug.toLowerCase()) ?? null,
        summary,
      };
    }),
  };
}

export async function writeLatestFeed(path, feed) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const prior = JSON.parse(await readFile(path, "utf8"));
    if (JSON.stringify(prior) === JSON.stringify(feed)) return false;
  } catch {
    // A missing or malformed prior feed is replaced by the validated snapshot.
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

export async function updateLatestFeed({ context }) {
  validateRunContext(context);
  const pagePath = fileURLToPath(new URL("../index.html", import.meta.url));
  const feedPath = fileURLToPath(new URL("../data/latest.json", import.meta.url));
  const databasePath = fileURLToPath(new URL("../data/star-observations.sqlite", import.meta.url));
  const repos = parsePageRepos(await readFile(pagePath, "utf8"));
  const dates = new Set(repos.map(repo => repo._stats_date));
  if (dates.size !== 1 || !dates.has(context.statsDateKst)) {
    throw new Error("published repositories must share the run context stats date");
  }

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let rows;
  try {
    rows = database.prepare(
      "SELECT slug, observed_date, stars_total FROM star_observations "
      + "WHERE source = 'github_rest' ORDER BY slug COLLATE NOCASE, observed_date",
    ).all();
  } finally {
    database.close();
  }
  const signals = computeSignals(rows);
  const feed = buildLatestFeed({
    repos,
    snapshotId: context.snapshotId,
    statsDate: context.statsDateKst,
    generatedAt: context.observedAtUtc,
    signals,
  });
  const changed = await writeLatestFeed(feedPath, feed);
  console.log(`JSON feed ${changed ? "updated" : "unchanged"}: data/latest.json (${feed.count} repos)`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  updateLatestFeed({ context: readRunContext(process.env) }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
