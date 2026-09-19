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

const trendingSource = await readFile(new URL("../scripts/update-trending.mjs", import.meta.url), "utf8");

function declaredRuleIds(name) {
  const block = trendingSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
  assert.ok(block, `${name} must still be declared in update-trending.mjs`);
  return [...block[1].matchAll(/\["([a-z-]+)",/g)].map(match => match[1]);
}

test("judgments cover the published taxonomy in its canonical order", () => {
  assert.deepEqual(FIELD_TAG_IDS, declaredRuleIds("FIELD_RULES"));
  assert.deepEqual(FORM_TAG_IDS, declaredRuleIds("FORM_RULES"));
  assert.ok(TAG_RULE_VERSION > Number(trendingSource.match(/const TAG_RULE_VERSION = (\d+);/)[1]));
});

test("every judgment states its meaning without relying on its question id", () => {
  for (const judgment of [...FIELD_JUDGMENTS, ...FORM_JUDGMENTS]) {
    assert.ok(judgment.instructions.length > 40, `${judgment.id} needs instructions that carry the judgment`);
    assert.ok(judgment.criteria.yes.length > 40, `${judgment.id} needs a yes criterion`);
    // Each no-criterion must rule something out; the regex classifier's failures were
    // all false positives from topic vocabulary, so exclusions are the point.
    assert.ok(judgment.criteria.no.length > 40, `${judgment.id} needs a no criterion`);
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
