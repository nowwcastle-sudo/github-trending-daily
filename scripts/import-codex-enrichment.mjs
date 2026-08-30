import { fileURLToPath } from "node:url";
import path from "node:path";

import { runFrozenEnrichmentPipeline } from "./generate-translations.mjs";

function parseArgs(argv) {
  const allowed = new Set([
    "--facts",
    "--events",
    "--prepared",
    "--enrichment-index-out",
    "--source-root",
    "--output-root",
    "--parent-evidence",
    "--prior-heads",
    "--parent-database",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || Object.hasOwn(values, key)) {
      throw new Error("Invalid Codex enrichment import arguments");
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== allowed.size) throw new Error("Invalid Codex enrichment import arguments");
  return values;
}

export async function importCodexEnrichment(argv) {
  const args = parseArgs(argv);
  return runFrozenEnrichmentPipeline({
    factsPath: args["--facts"],
    eventsPath: args["--events"],
    preparedPath: args["--prepared"],
    enrichmentIndexOut: args["--enrichment-index-out"],
    sourceRoot: args["--source-root"],
    outputRoot: args["--output-root"],
    parentEvidencePath: args["--parent-evidence"],
    priorHeadsPath: args["--prior-heads"],
    parentDatabasePath: args["--parent-database"],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  importCodexEnrichment(process.argv.slice(2))
    .then(result => console.log(JSON.stringify({ repositories: result.repositories, pending: result.pending, usage: result.usage })))
    .catch(error => {
      console.error(error instanceof Error ? error.message : "Codex enrichment import failed");
      process.exitCode = 1;
    });
}
