import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { parseJsonStrict } from "./build-pages-artifact.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TRACKED_OUTPUT = fileURLToPath(new URL("../star-history.json", import.meta.url));

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  const parsed = match && new Date(`${value}T00:00:00Z`);
  return Boolean(match && !Number.isNaN(parsed.getTime())
    && parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() + 1 === Number(match[2])
    && parsed.getUTCDate() === Number(match[3]));
}

function validatePoints(points, maximum) {
  if (!Array.isArray(points) || points.length > maximum) throw new Error("star history points are invalid");
  return points.map((point, index) => {
    if (!exactKeys(point, ["date", "stars"]) || !validDate(point.date)
        || !Number.isSafeInteger(point.stars) || point.stars < 0
        || (index > 0 && points[index - 1].date >= point.date)) {
      throw new Error("star history points are invalid");
    }
    return { date: point.date, stars: point.stars };
  });
}

export function validateStarHistoryPayload(value) {
  if (!exactKeys(value, ["version", "generatedAt", "repositories"])
      || value.version !== 1 || !validDate(value.generatedAt)
      || !Array.isArray(value.repositories) || value.repositories.length > 75) {
    throw new Error("star history payload is invalid");
  }
  const seen = new Set();
  const repositories = value.repositories.map(repository => {
    if (!exactKeys(repository, ["slug", "estimated", "observed"])
        || typeof repository.slug !== "string" || !REPO_RE.test(repository.slug)) {
      throw new Error("star history repository is invalid");
    }
    const folded = repository.slug.toLowerCase();
    if (seen.has(folded)) throw new Error("star history repository identity is duplicated");
    seen.add(folded);
    return {
      slug: repository.slug,
      estimated: validatePoints(repository.estimated, 500),
      observed: validatePoints(repository.observed, 730),
    };
  });
  return { version: 1, generatedAt: value.generatedAt, repositories };
}

async function atomicWrite(outputPath, bytes) {
  const pending = `${outputPath}.pending-${randomUUID()}`;
  let handle;
  try {
    handle = await open(pending, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(pending, outputPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(pending, { force: true }).catch(() => {});
  }
}

export async function writeDerivedStarHistory(payload, outputPath) {
  if (typeof outputPath !== "string" || !outputPath || resolve(outputPath) === resolve(TRACKED_OUTPUT)) {
    throw new Error("star history output must be a candidate path");
  }
  const value = validateStarHistoryPayload(payload);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  try {
    await atomicWrite(resolve(outputPath), bytes);
  } catch {
    throw new Error("star history candidate write failed");
  }
  return { byteSize: bytes.length };
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--input" || argv[2] !== "--out" || !argv[1] || !argv[3]) {
    throw new Error("invalid arguments");
  }
  return { input: resolve(argv[1]), output: resolve(argv[3]) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.input === args.output || dirname(args.output) === dirname(TRACKED_OUTPUT)) {
    throw new Error("star history output must be a candidate path");
  }
  let payload;
  try {
    payload = parseJsonStrict(await readFile(args.input), "derived star history JSON");
  } catch {
    throw new Error("derived star history input is invalid");
  }
  const result = await writeDerivedStarHistory(payload, args.output);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    console.error("Star history candidate write failed");
    process.exitCode = 1;
  });
}
