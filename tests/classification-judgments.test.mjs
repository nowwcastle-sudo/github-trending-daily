import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_TAG_THRESHOLD,
  FIELD_JUDGMENTS,
  FIELD_TAG_IDS,
  FORM_JUDGMENTS,
  FORM_TAG_IDS,
  TAG_RULE_VERSION,
  buildClassificationQuestions,
  buildClassificationState,
  resolveTags,
} from "../scripts/classification-judgments.mjs";

const clientSource = await readFile(new URL("../scripts/typesafe-client.mjs", import.meta.url), "utf8");
const filtersSource = await readFile(new URL("../repo-filters.js", import.meta.url), "utf8");
const recorderSource = await readFile(new URL("../scripts/record_repository_observations.py", import.meta.url), "utf8");

function jsListedIds(source, name) {
  const block = source.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\n\\s*\\];`));
  assert.ok(block, `${name} must still be declared`);
  return [...block[1].matchAll(/\["([a-z-]+)",/g)].map(match => match[1]);
}

function pythonListedIds(source, name) {
  const block = source.match(new RegExp(`^${name} = \\(([^)]*)\\)`, "m"));
  assert.ok(block, `${name} must still be declared`);
  return [...block[1].matchAll(/"([a-z-]+)"/g)].map(match => match[1]);
}

// The pipeline modules import this taxonomy, so they cannot drift from it. Two copies
// cannot: repo-filters.js is a browser UMD that also carries the Korean labels, and the
// recorder is Python. Both validate published data against their own list, so a tag added
// here and not there is rejected at publish time -- by the validator, not by a reader.
test("the copies that cannot import the taxonomy still match it exactly", () => {
  assert.deepEqual(jsListedIds(filtersSource, "const FIELD_DEFINITIONS"),
    [...FIELD_TAG_IDS, "unclassified"], "repo-filters.js field definitions");
  assert.deepEqual(jsListedIds(filtersSource, "const FORM_DEFINITIONS"),
    [...FORM_TAG_IDS], "repo-filters.js form definitions");
  assert.deepEqual(pythonListedIds(recorderSource, "FIELD_TAGS"), [...FIELD_TAG_IDS],
    "record_repository_observations.py field tags");
  assert.deepEqual(pythonListedIds(recorderSource, "FORM_TAGS"), [...FORM_TAG_IDS],
    "record_repository_observations.py form tags");
  assert.equal(Number(filtersSource.match(/const TAG_RULE_VERSION = (\d+);/)[1]), TAG_RULE_VERSION,
    "repo-filters.js tag rule version");
});

test("no module keeps its own copy of the taxonomy any more", async () => {
  // update-trending.mjs classified with a regex table whose ids doubled as the taxonomy.
  // The regexes stopped deciding anything when TypeSafe took over; leaving them in place
  // left a fourth definition free to drift from the judgments that actually decide.
  const trending = await readFile(new URL("../scripts/update-trending.mjs", import.meta.url), "utf8");
  const artifact = await readFile(new URL("../scripts/build-pages-artifact.mjs", import.meta.url), "utf8");
  for (const [name, source] of [["update-trending.mjs", trending], ["build-pages-artifact.mjs", artifact]]) {
    assert.doesNotMatch(source, /const (?:FIELD|FORM)_(?:RULES|TAG_IDS) = \[/,
      `${name} must import the taxonomy, not restate it`);
    assert.doesNotMatch(source, /^const TAG_RULE_VERSION = \d+;/m,
      `${name} must import the tag rule version, not restate it`);
    assert.match(source, /from "\.\/classification-judgments\.mjs"/,
      `${name} must import from the judgments`);
  }
});

test("every judgment states its meaning without relying on its question id", () => {
  for (const judgment of [...FIELD_JUDGMENTS, ...FORM_JUDGMENTS]) {
    assert.ok(judgment.instructions.length > 40, `${judgment.id} needs instructions that carry the judgment`);
    assert.ok(judgment.criteria.true.length > 40, `${judgment.id} needs a yes criterion`);
    // Each no-criterion must rule something out; the regex classifier's failures were
    // all false positives from topic vocabulary, so exclusions are the point.
    assert.ok(judgment.criteria.false.length > 40, `${judgment.id} needs a no criterion`);
  }
});

test("questions are emitted as one Noul per tag", () => {
  const questions = buildClassificationQuestions();
  assert.equal(questions.length, FIELD_TAG_IDS.length + FORM_TAG_IDS.length);
  assert.ok(questions.every(question => question.type === "noul"));
  assert.equal(new Set(questions.map(question => question.id)).size, questions.length);
});

test("state carries the repository text the regex classifier never read", () => {
  const state = buildClassificationState({
    slug: "ankitects/anki",
    description: "Anki is a smart spaced repetition flashcard program",
    primary_language: "Rust",
    topics: [],
    readme: "x".repeat(9000),
  });
  assert.equal(state.repository.slug, "ankitects/anki");
  assert.deepEqual(state.repository.topics, []);
  assert.equal(state.repository.readme_excerpt.length, 4000);
});

test("state normalises absent fields to null rather than dropping them", () => {
  const state = buildClassificationState({ slug: "owner/name", topics: ["go"] });
  assert.equal(state.repository.description, null);
  assert.equal(state.repository.primary_language, null);
  assert.equal(state.repository.readme_excerpt, null);
});

test("state rejects input the refresh pipeline should never produce", () => {
  assert.throws(() => buildClassificationState({ topics: [] }), /requires a slug/);
  assert.throws(() => buildClassificationState({ slug: "owner/name" }), /requires a topics array/);
});

test("resolved tags keep canonical order and survive the published invariant", () => {
  const answers = Object.fromEntries([...FIELD_TAG_IDS, ...FORM_TAG_IDS].map(id => [id, 0]));
  answers["dev-tools"] = 0.91;
  answers["ai-ml"] = 0.74;
  answers["cli"] = 0.88;
  answers.agent = 0.62;
  const resolved = resolveTags(answers);
  assert.equal(resolved.tag_rule_version, TAG_RULE_VERSION);
  assert.deepEqual(resolved.field_tags, ["ai-ml", "dev-tools"]);
  assert.deepEqual(resolved.form_tags, ["agent", "cli"]);
  for (const [tags, allowed] of [[resolved.field_tags, FIELD_TAG_IDS], [resolved.form_tags, FORM_TAG_IDS]]) {
    assert.deepEqual(tags, [...tags].sort((a, b) => allowed.indexOf(a) - allowed.indexOf(b)));
  }
});

test("no field tag above threshold falls back to unclassified alone", () => {
  const answers = Object.fromEntries([...FIELD_TAG_IDS, ...FORM_TAG_IDS].map(id => [id, 0.2]));
  const resolved = resolveTags(answers);
  assert.deepEqual(resolved.field_tags, ["unclassified"]);
  assert.deepEqual(resolved.form_tags, []);
});

test("unclassified never coexists with a real field tag", () => {
  const answers = Object.fromEntries([...FIELD_TAG_IDS, ...FORM_TAG_IDS].map(id => [id, 0]));
  answers.learning = 0.97;
  assert.deepEqual(resolveTags(answers).field_tags, ["learning"]);
});

test("threshold is policy and is applied at the boundary", () => {
  const answers = Object.fromEntries([...FIELD_TAG_IDS, ...FORM_TAG_IDS].map(id => [id, 0]));
  answers.security = DEFAULT_TAG_THRESHOLD;
  assert.deepEqual(resolveTags(answers).field_tags, ["security"]);
  assert.deepEqual(resolveTags(answers, { threshold: 0.75 }).field_tags, ["unclassified"]);
  assert.throws(() => resolveTags(answers, { threshold: 0 }), /threshold/);
  assert.throws(() => resolveTags(answers, { threshold: 1 }), /threshold/);
});

test("a missing or malformed probability fails loudly instead of dropping a tag", () => {
  const answers = Object.fromEntries([...FIELD_TAG_IDS, ...FORM_TAG_IDS].map(id => [id, 0.1]));
  delete answers.systems;
  assert.throws(() => resolveTags(answers), /systems/);
  assert.throws(() => resolveTags({ ...answers, systems: 1.4 }), /systems/);
  assert.throws(() => resolveTags({ ...answers, systems: Number.NaN }), /systems/);
});

test("the SDK is never a static import of the pipeline's module graph", () => {
  // update-trending.mjs reaches the enrichment entry point through
  // generate-translations.mjs, and the self-hosted runner that generates summaries
  // checks the repository out without installing dependencies. A top-level import
  // of the SDK there fails that runner with ERR_MODULE_NOT_FOUND on a path that
  // never classifies anything, which is exactly how refresh run 186 died.
  assert.doesNotMatch(clientSource, /^import\s[^\n]*@typesafe-ai\/sdk/m,
    "load @typesafe-ai/sdk with a dynamic import() inside the call that needs it");
  assert.match(clientSource, /await import\("@typesafe-ai\/sdk"\)/,
    "the SDK must still be loaded lazily where a classification actually runs");
});
