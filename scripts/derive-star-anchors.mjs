import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseFrozenFactsBytes } from "./collect-repository-events.mjs";

// GitHub Trending period gains are net new stars over the period, so the total
// star count at the start of a period is approximately `stars - gain`. These
// back-calculated anchors are approximations (unstars are ignored) and are
// recomputed from the frozen facts on every refresh (2026-09-03 design §4.4).
const DAY_MS = 86_400_000;
const CREATED_WINDOW_DAYS = 30;
const PERIODS = Object.freeze([["daily", 1], ["weekly", 7], ["monthly", 30]]);

const seconds = milliseconds => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");

function parseTime(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function validGain(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

export function deriveStarAnchors(facts) {
  const observedMs = parseTime(facts?.observedAtUtc);
  if (observedMs === null) throw new Error("frozen facts observedAtUtc is invalid");
  if (!Array.isArray(facts.repositories)) throw new Error("frozen facts repositories are invalid");
  const anchors = {};
  const warnings = [];
  const seen = new Set();
  for (const repository of facts.repositories) {
    const slug = repository?.display_slug ?? repository?.slug;
    if (typeof slug !== "string" || !slug) throw new Error("repository slug is invalid");
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate repository: ${slug}`);
    seen.add(key);
    if (!Number.isSafeInteger(repository.stars) || repository.stars < 0) throw new Error(`repository stars are invalid: ${slug}`);
    const createdMs = parseTime(repository.created_at);
    if (createdMs === null) throw new Error(`repository created_at is invalid: ${slug}`);
    const kept = [];
    // Each longer period starts earlier, so its anchor must not exceed the
    // anchor of the shorter period; violations are dropped, not adjusted.
    let ceiling = repository.stars;
    for (const [period, days] of PERIODS) {
      const gain = repository[`gain_${period}`];
      if (!validGain(gain)) throw new Error(`repository gain_${period} is invalid: ${slug}`);
      if (gain === null) continue;
      const source = `github_trending_gain_${period}`;
      const at = observedMs - days * DAY_MS;
      const stars = repository.stars - gain;
      if (stars < 0) { warnings.push({ slug, code: "negative", source }); continue; }
      if (at < createdMs) { warnings.push({ slug, code: "before_created", source }); continue; }
      if (stars > ceiling) { warnings.push({ slug, code: "non_monotonic", source }); continue; }
      ceiling = stars;
      kept.push({ at: seconds(at), stars, source });
    }
    if (observedMs - createdMs <= CREATED_WINDOW_DAYS * DAY_MS) {
      kept.push({ at: seconds(createdMs), stars: 0, source: "github_created_at" });
    }
    kept.sort((left, right) => left.at.localeCompare(right.at));
    anchors[slug] = kept;
  }
  return { version: 1, generatedAt: facts.observedAtUtc, anchors, warnings };
}

export async function runDeriveStarAnchorsCli({ factsPath, outPath, parse = parseFrozenFactsBytes }) {
  const facts = parse(await readFile(factsPath));
  const result = deriveStarAnchors(facts);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  return { repositories: Object.keys(result.anchors).length, warnings: result.warnings.length };
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--facts" || argv[2] !== "--out" || !argv[1] || !argv[3]) {
    throw new Error("usage: derive-star-anchors.mjs --facts FILE --out FILE");
  }
  return { factsPath: path.resolve(argv[1]), outPath: path.resolve(argv[3]) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runDeriveStarAnchorsCli(parseArgs(process.argv.slice(2)))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error?.message || "star anchor derivation failed"); process.exitCode = 1; });
}
