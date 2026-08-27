import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  extractReposFromIndex,
  parseTranslationPayload,
  sameSource,
  slugToFile,
  validateActiveEnrichment,
} from "./generate-translations.mjs";

function parseArgs(args) {
  let root = null;
  let jsonCounts = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && index + 1 < args.length) {
      root = path.resolve(args[index + 1]);
      index += 1;
    } else if (args[index] === "--json-counts") {
      jsonCounts = true;
    } else {
      throw new Error("Usage: validate-enrichment-coverage.mjs --root DIR --json-counts");
    }
  }
  if (!root || !jsonCounts) throw new Error("Usage: validate-enrichment-coverage.mjs --root DIR --json-counts");
  return root;
}

export async function validateEnrichmentRoot(root) {
  const [page, cacheText, sourcesText, files] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "data", "repo-summaries.json"), "utf8"),
    readFile(path.join(root, "data", "translation-sources.json"), "utf8"),
    readdir(path.join(root, "translations"), { withFileTypes: true }),
  ]);
  const active = extractReposFromIndex(page);
  const sources = JSON.parse(sourcesText);
  const wanted = new Set(active.map(repo => slugToFile(repo.slug).toLowerCase()));
  const translations = {};
  for (const file of files) {
    if (!file.isFile() || !wanted.has(file.name.toLowerCase())) continue;
    const value = parseTranslationPayload(JSON.parse(await readFile(path.join(root, "translations", file.name), "utf8")));
    const repo = active.find(candidate => slugToFile(candidate.slug).toLowerCase() === file.name.toLowerCase());
    const source = Object.entries(sources?.sources ?? {})
      .find(([slug]) => slug.toLowerCase() === repo?.slug.toLowerCase())?.[1];
    if (!repo || !value || !sameSource(value.source, source)) {
      throw new Error("Translation does not match its exact source envelope");
    }
    translations[repo.slug] = value.markdown;
  }
  return validateActiveEnrichment(
    active,
    translations,
    JSON.parse(cacheText),
    sources,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const root = parseArgs(process.argv.slice(2));
    const result = await validateEnrichmentRoot(root);
    process.stdout.write(`${JSON.stringify(result.counts)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      repository: 0,
      valid: 0,
      compact: 0,
      placeholder: 0,
      applicable: 0,
      "N/A": 0,
      missing: 0,
      stale: 1,
    })}\n`);
    process.exitCode = 1;
  }
}
