import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonStrict } from "./build-pages-artifact.mjs";
import { validateFrozenFactsPayload } from "./collect-repository-events.mjs";
import { completeCodexEnrichmentPlan, createCodexEnrichmentPlan } from "./generate-translations.mjs";

function parseArgs(argv, keys) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!keys.includes(key) || !value || Object.hasOwn(values, key)) throw new Error("Invalid Codex adapter arguments");
    values[key] = value;
  }
  if (Object.keys(values).length !== keys.length) throw new Error("Invalid Codex adapter arguments");
  return values;
}

function itemFromFacts(facts, slug) {
  const repository = facts.repositories.find(value => value.slug === slug);
  if (!repository) throw new Error("Codex adapter repository is not active");
  const readme = facts.readmes[slug.toLowerCase()];
  const metadataOnly = repository.readme_status === "absent";
  if (metadataOnly) throw new Error("Codex adapter requires a canonical README");
  return {
    ...repository,
    markdown: readme.markdown,
    readme_blob_sha: readme.blobSha,
    readme_content_sha256: readme.contentSha256,
    frozen_source_kind: "readme",
  };
}

async function readFacts(file) {
  return validateFrozenFactsPayload(parseJsonStrict(await readFile(path.resolve(file)), "frozen facts", 64 * 1024 * 1024));
}

async function prepare(argv) {
  const args = parseArgs(argv, ["--facts", "--slug", "--out-dir"]);
  const facts = await readFacts(args["--facts"]);
  const item = itemFromFacts(facts, args["--slug"]);
  const plan = createCodexEnrichmentPlan(item);
  const outputRoot = path.resolve(args["--out-dir"]);
  await mkdir(outputRoot, { recursive: false });
  await writeFile(path.join(outputRoot, "plan.json"), `${JSON.stringify(plan)}\n`, { encoding: "utf8", flag: "wx" });
  for (const [index, request] of plan.requests.entries()) {
    const suffix = String(index).padStart(3, "0");
    await writeFile(path.join(outputRoot, `request-${suffix}-prompt.txt`), request.prompt, { encoding: "utf8", flag: "wx" });
    await writeFile(path.join(outputRoot, `request-${suffix}-schema.json`), `${JSON.stringify(request.schema, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  return {
    slug: item.slug,
    requests: plan.requests.length,
    source_bytes: Buffer.byteLength(item.markdown),
    prompt_bytes: plan.requests.reduce((total, request) => total + Buffer.byteLength(request.prompt), 0),
  };
}

async function complete(argv) {
  const args = parseArgs(argv, ["--facts", "--plan", "--responses-dir", "--out"]);
  const facts = await readFacts(args["--facts"]);
  const plan = parseJsonStrict(await readFile(path.resolve(args["--plan"])), "Codex enrichment plan", 64 * 1024 * 1024);
  const item = itemFromFacts(facts, plan.slug);
  const responses = await Promise.all(plan.requests.map((_, index) => readFile(
    path.join(path.resolve(args["--responses-dir"]), `response-${String(index).padStart(3, "0")}.json`),
  ).then(bytes => parseJsonStrict(bytes, "Codex response", 4 * 1024 * 1024))));
  const completed = completeCodexEnrichmentPlan(item, plan, responses);
  const output = {
    version: 1,
    facts_sha256: facts.factsSha256,
    model: "codex-cli/gpt-5.6-sol",
    repositories: {
      [item.slug]: {
        summary: completed.summary,
        translation: completed.translation,
        translation_bindings: completed.translation_bindings,
      },
    },
  };
  await writeFile(path.resolve(args["--out"]), `${JSON.stringify(output)}\n`, { encoding: "utf8", flag: "wx" });
  return { slug: item.slug, requests: responses.length, translation_bytes: Buffer.byteLength(completed.translation) };
}

export async function runCodexEnrichmentAdapter(argv) {
  const [command, ...args] = argv;
  if (command === "prepare") return prepare(args);
  if (command === "complete") return complete(args);
  throw new Error("Codex adapter command must be prepare or complete");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCodexEnrichmentAdapter(process.argv.slice(2))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error instanceof Error ? error.message : "Codex enrichment adapter failed");
      process.exitCode = 1;
    });
}
