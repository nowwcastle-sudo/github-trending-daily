// Compare the TypeSafe judgments against the regex classifier on published data.
//
// The regex output is the baseline, not the truth: it is what the site ships today,
// so every disagreement is a case to look at by hand before changing the threshold
// or the criteria. Run against data/latest.json:
//
//   node scripts/evaluate-classification.mjs [--threshold 0.5] [--limit 10] [--json out.json]

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

import {
  DEFAULT_TAG_THRESHOLD,
  FIELD_JUDGMENTS,
  FIELD_TAG_IDS,
  FORM_JUDGMENTS,
  FORM_TAG_IDS,
  buildClassificationState,
  resolveTags,
} from "./classification-judgments.mjs";

const { values } = parseArgs({
  options: {
    threshold: { type: "string", default: String(DEFAULT_TAG_THRESHOLD) },
    limit: { type: "string" },
    json: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

const threshold = Number(values.threshold);
const concurrency = Math.max(1, Number(values.concurrency));

const questions = Object.fromEntries(
  [...FIELD_JUDGMENTS, ...FORM_JUDGMENTS].map(judgment => [judgment.id, noul(judgment.instructions, judgment.criteria)]),
);

const client = new TypeSafeClient();

async function classify(repo) {
  const state = buildClassificationState({
    slug: repo.slug,
    description: repo.description,
    primary_language: repo.lang,
    topics: repo.topics ?? [],
  });
  const { answers, usage } = await client.systemOne({ state, questions });
  const probabilities = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.noul]));
  return { probabilities, resolved: resolveTags(probabilities, { threshold }), usage };
}

// A bounded worker pool: the refresh pipeline classifies a whole page of
// repositories, so measure it the way it will actually run.
async function mapPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await worker(items[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }));
  return results;
}

const { repos } = JSON.parse(await readFile(new URL("../data/latest.json", import.meta.url), "utf8"));
const sample = values.limit ? repos.slice(0, Number(values.limit)) : repos;

const started = Date.now();
const outcomes = await mapPool(sample, classify);
const elapsed = Date.now() - started;

const rows = [];
let inputTokens = 0;
let outputTokens = 0;
let failed = 0;

for (const [index, outcome] of outcomes.entries()) {
  const repo = sample[index];
  if (!outcome.ok) {
    failed += 1;
    console.error(`! ${repo.slug}: ${outcome.error.message}`);
    continue;
  }
  const { probabilities, resolved, usage } = outcome.value;
  inputTokens += usage?.input_tokens ?? 0;
  outputTokens += usage?.output_tokens ?? 0;
  rows.push({
    slug: repo.slug,
    description: repo.description,
    topics: repo.topics ?? [],
    regex: { field_tags: repo.field_tags, form_tags: repo.form_tags },
    jev: { field_tags: resolved.field_tags, form_tags: resolved.form_tags },
    probabilities,
  });
}

const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const disagreements = rows.filter(row => !same(row.regex.field_tags, row.jev.field_tags) || !same(row.regex.form_tags, row.jev.form_tags));

const countTags = (selector, ids) => {
  const counts = Object.fromEntries(ids.map(id => [id, 0]));
  counts.unclassified = 0;
  for (const row of rows) for (const tag of selector(row)) counts[tag] = (counts[tag] ?? 0) + 1;
  return counts;
};

console.log(`\nclassified ${rows.length}/${sample.length} repositories in ${(elapsed / 1000).toFixed(1)}s`
  + ` (concurrency ${concurrency}, threshold ${threshold})`);
if (failed) console.log(`${failed} failed`);
console.log(`tokens: ${inputTokens} in, ${outputTokens} out`);
console.log(`\ndisagreements: ${disagreements.length}/${rows.length}`);

const compare = (label, selector, ids) => {
  const regexCounts = countTags(row => selector(row.regex), ids);
  const jevCounts = countTags(row => selector(row.jev), ids);
  console.log(`\n${label}  ${"regex".padStart(8)} ${"jev".padStart(6)}  delta`);
  for (const id of [...ids, "unclassified"]) {
    const before = regexCounts[id] ?? 0;
    const after = jevCounts[id] ?? 0;
    if (!before && !after) continue;
    const delta = after - before;
    console.log(`  ${id.padEnd(14)} ${String(before).padStart(5)} ${String(after).padStart(6)}  ${delta > 0 ? "+" : ""}${delta}`);
  }
};

compare("field_tags", tags => tags.field_tags, FIELD_TAG_IDS);
compare("form_tags", tags => tags.form_tags, FORM_TAG_IDS);

console.log("\n--- disagreements ---");
for (const row of disagreements) {
  console.log(`\n• ${row.slug}`);
  console.log(`  ${(row.description ?? "").slice(0, 100)}`);
  if (row.topics.length) console.log(`  topics: ${row.topics.slice(0, 8).join(", ")}`);
  if (!same(row.regex.field_tags, row.jev.field_tags)) {
    console.log(`  field: ${row.regex.field_tags.join(",")}  ->  ${row.jev.field_tags.join(",")}`);
  }
  if (!same(row.regex.form_tags, row.jev.form_tags)) {
    console.log(`  form:  ${row.regex.form_tags.join(",") || "-"}  ->  ${row.jev.form_tags.join(",") || "-"}`);
  }
}

if (values.json) {
  await writeFile(values.json, `${JSON.stringify({ threshold, elapsed, rows }, null, 2)}\n`);
  console.log(`\nwrote ${values.json}`);
}

if (failed) process.exitCode = 1;
