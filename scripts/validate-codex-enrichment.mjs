import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonStrict } from "./build-pages-artifact.mjs";
import { parseFrozenFactsBytes } from "./collect-repository-events.mjs";
import { validatePreparedCodexEnrichment } from "./generate-translations.mjs";

function parseArgs(argv) {
  const partial = argv.includes("--partial");
  const positional = argv.filter(value => value !== "--partial");
  if (positional.length !== 4 || positional[0] !== "--facts" || positional[2] !== "--prepared") {
    throw new Error("Usage: validate-codex-enrichment --facts <path> --prepared <path> [--partial]");
  }
  return { factsPath: positional[1], preparedPath: positional[3], partial };
}

export async function validateCodexEnrichmentFiles(argv) {
  const args = parseArgs(argv);
  const [factsBytes, preparedBytes] = await Promise.all([
    readFile(path.resolve(args.factsPath)),
    readFile(path.resolve(args.preparedPath)),
  ]);
  return validatePreparedCodexEnrichment(
    parseJsonStrict(preparedBytes, "prepared Codex enrichment", 64 * 1024 * 1024),
    parseFrozenFactsBytes(factsBytes),
    { complete: !args.partial },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateCodexEnrichmentFiles(process.argv.slice(2))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error instanceof Error ? error.message : "Codex enrichment validation failed");
      process.exitCode = 1;
    });
}
