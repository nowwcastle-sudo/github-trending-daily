import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseJsonStrict } from "./build-pages-artifact.mjs";
import { parseFrozenFactsBytes } from "./collect-repository-events.mjs";
import { extractReposFromIndex } from "./generate-translations.mjs";
import {
  SUMMARY_BUNDLE_SCHEMA_VERSION,
  SUMMARY_PROMPT_SCHEMA_VERSION,
  validateStoredSummaryBundleEnvelope,
} from "./generate-summary-bundles.mjs";
import { isSupportedSummaryProducer } from "./enrichment-models.mjs";

const SOURCE_KEYS = ["kind", "slug", "path", "blob_sha", "content_sha256", "provider", "interface", "cli_version", "auth_method", "api_provider", "model", "schema_version", "prompt_schema_version", "translation_applicable"];
const SUMMARY_PRODUCER_KEYS = ["provider", "interface", "cli_version", "auth_method", "api_provider", "model"];

function exactKeys(value, keys) {
  return value && !Array.isArray(value) && typeof value === "object"
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseArgs(args) {
  let root = null;
  let facts = null;
  let jsonCounts = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && index + 1 < args.length) root = path.resolve(args[++index]);
    else if (args[index] === "--facts" && index + 1 < args.length) facts = path.resolve(args[++index]);
    else if (args[index] === "--json-counts") jsonCounts = true;
    else throw new Error("Usage: validate-enrichment-coverage.mjs --root DIR --facts FILE --json-counts");
  }
  if (!root || !facts || !jsonCounts) throw new Error("Usage: validate-enrichment-coverage.mjs --root DIR --facts FILE --json-counts");
  return { root, facts };
}

function expectedSource(repository, readme, actual) {
  return {
    kind: "readme",
    slug: repository.slug.toLowerCase(),
    path: readme.path,
    blob_sha: readme.blobSha,
    content_sha256: readme.contentSha256,
    ...Object.fromEntries(SUMMARY_PRODUCER_KEYS.map(key => [key, actual[key]])),
    schema_version: SUMMARY_BUNDLE_SCHEMA_VERSION,
    prompt_schema_version: SUMMARY_PROMPT_SCHEMA_VERSION,
    translation_applicable: false,
  };
}

export async function validateEnrichmentRoot(root, { factsPath } = {}) {
  if (!factsPath) throw new Error("Frozen facts are required for source-bound coverage validation");
  const [page, cacheBytes, sourcesBytes, factsBytes, translationFiles] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "data", "repo-summaries.json")),
    readFile(path.join(root, "data", "translation-sources.json")),
    readFile(factsPath),
    readdir(path.join(root, "translations"), { withFileTypes: true }).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    }),
  ]);
  if (translationFiles.length !== 0) throw new Error("Retired README translation residue is present");
  const active = extractReposFromIndex(page);
  const cache = parseJsonStrict(cacheBytes, "summary cache", 32 * 1024 * 1024);
  const sources = parseJsonStrict(sourcesBytes, "summary sources", 32 * 1024 * 1024);
  const facts = parseFrozenFactsBytes(factsBytes);
  if (!exactKeys(sources, ["version", "sources"]) || sources.version !== SUMMARY_BUNDLE_SCHEMA_VERSION
      || !sources.sources || Array.isArray(sources.sources) || typeof sources.sources !== "object") {
    throw new Error("Summary source registry is invalid");
  }
  const activeMap = new Map(active.map(repo => [repo.slug.toLowerCase(), repo]));
  const factMap = new Map(facts.repositories.map(repository => [repository.slug.toLowerCase(), repository]));
  const cacheMap = new Map(Object.entries(cache).map(([slug, value]) => [slug.toLowerCase(), { slug, value }]));
  const sourceMap = new Map(Object.entries(sources.sources).map(([slug, value]) => [slug.toLowerCase(), { slug, value }]));
  const slugs = [...activeMap.keys()];
  // Held repositories are published without a summary: they must be absent from
  // the cache and the source registry, and every other active repository must be exact.
  const heldSlugs = slugs.filter(slug => activeMap.get(slug).summary_status === "held");
  const summarizedSlugs = slugs.filter(slug => activeMap.get(slug).summary_status !== "held");
  if (heldSlugs.length * 2 > slugs.length) {
    throw new Error(`Held ratio exceeds 50% of the active set (${heldSlugs.length}/${slugs.length})`);
  }
  if (factMap.size !== slugs.length || slugs.some(slug => !factMap.has(slug))) {
    throw new Error("Summary bundle active set is not exact");
  }
  for (const slug of heldSlugs) {
    const pageRepo = activeMap.get(slug);
    if (cacheMap.has(slug) || sourceMap.has(slug) || pageRepo.summary !== null || pageRepo.summaries !== null) {
      throw new Error(`Held repository must not carry a summary: ${pageRepo.slug}`);
    }
  }
  if ([cacheMap, sourceMap].some(map => map.size !== summarizedSlugs.length || summarizedSlugs.some(slug => !map.has(slug)))) {
    throw new Error("Summary bundle active set is not exact");
  }
  for (const slug of summarizedSlugs) {
    const repository = factMap.get(slug);
    const readme = facts.readmes[slug];
    const entry = cacheMap.get(slug).value;
    const pageRepo = activeMap.get(slug);
    if (repository.readme_status !== "present" || !readme?.markdown
        || !exactKeys(entry, ["content", "summaries", "evidence", "invariants", "inference_fields", "source"])
        || !exactKeys(entry.source, SOURCE_KEYS)
        || !/^\d+\.\d+\.\d+$/.test(entry.source.cli_version)
        || !isSupportedSummaryProducer(Object.fromEntries(SUMMARY_PRODUCER_KEYS.map(key => [key, entry.source[key]])))
        || JSON.stringify(entry.source) !== JSON.stringify(expectedSource(repository, readme, entry.source))
        || JSON.stringify(sourceMap.get(slug).value) !== JSON.stringify(entry.source)) {
      throw new Error(`Summary bundle source coverage is invalid for ${repository.slug}`);
    }
    const checked = validateStoredSummaryBundleEnvelope({
      summaries: entry.summaries,
      evidence: entry.evidence,
      invariants: entry.invariants,
      inference_fields: entry.inference_fields,
    }, {
      slug: repository.slug,
      readme_path: readme.path,
      readme_blob_sha: readme.blobSha,
      readme_content_sha256: readme.contentSha256,
      default_branch_head_sha: repository.default_branch_head_sha,
      markdown: readme.markdown,
    });
    if (JSON.stringify(entry.content) !== JSON.stringify(checked.summaries.en)
        || JSON.stringify(pageRepo.summary) !== JSON.stringify(checked.summaries.en)
        || JSON.stringify(pageRepo.summaries) !== JSON.stringify(checked.summaries)) {
      throw new Error(`Rendered summary bundle is stale for ${repository.slug}`);
    }
  }
  return {
    valid: true,
    counts: {
      repository: slugs.length,
      valid: summarizedSlugs.length,
      locales: summarizedSlugs.length * 5,
      missing: 0,
      stale: 0,
      insufficient_source: 0,
      held: heldSlugs.length,
      translations: 0,
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await validateEnrichmentRoot(args.root, { factsPath: args.facts });
    process.stdout.write(`${JSON.stringify(result.counts)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ repository: 0, valid: 0, locales: 0, missing: 0, stale: 1, insufficient_source: 0, held: 0, translations: 0 })}\n`);
    process.exitCode = 1;
  }
}
