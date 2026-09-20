import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SUMMARY_QUALITY_FIELDS,
  SUMMARY_QUALITY_QUESTIONS,
  SUMMARY_QUALITY_QUESTION_IDS,
  SUMMARY_QUALITY_THRESHOLD,
  buildSummaryQualityState,
  judgeSummaryQuality,
  summaryQualityConfigured,
  summaryQualityFindings,
} from "../scripts/summary-quality.mjs";

const source = await readFile(new URL("../scripts/summary-quality.mjs", import.meta.url), "utf8");
const fields = { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" };
const answering = (values = {}) => async (url, init) => {
  const answers = Object.fromEntries(SUMMARY_QUALITY_QUESTION_IDS
    .map(id => [id, { type: "noul", noul: values[id] ?? 0.01 }]));
  return new Response(JSON.stringify({ answers, model: "jev-1.13.0" }), { status: 200 });
};
const judge = (options) => judgeSummaryQuality("owner/repo", fields, { environment: { TYPESAFE_API_KEY: "k" }, ...options });

test("the SDK is never reachable from the enrichment runner's module graph", () => {
  // generate-summary-bundles.mjs runs on a self-hosted runner that checks the
  // repository out without installing dependencies. An import of @typesafe-ai/sdk
  // here -- static or dynamic -- fails that runner with ERR_MODULE_NOT_FOUND, which
  // is exactly how refresh run 186 died.
  assert.doesNotMatch(source, /^import\s[^\n]*@typesafe-ai\/sdk/m,
    "speak the HTTP API with built-in fetch; the runner has no node_modules");
  assert.doesNotMatch(source, /\bimport\s*\(\s*["']@typesafe-ai\/sdk["']/,
    "a dynamic import fails on the runner just as a static one does");
  assert.doesNotMatch(source, /\brequire\s*\(\s*["']@typesafe-ai\/sdk["']/,
    "a require fails on the runner just as an import does");
});

test("the request is the one the SDK sends", async () => {
  // Pinned against @typesafe-ai/sdk 0.6.0: POST /v1/systemone, bearer auth, and a
  // body of state, questions and model. A drift here is a silent 4xx at refresh time.
  let sent = null;
  await judge({ fetchImpl: async (url, init) => { sent = { url, init }; return answering()(url, init); } });
  assert.equal(sent.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.headers.Authorization, "Bearer k");
  assert.equal(sent.init.headers["Content-Type"], "application/json");
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), SUMMARY_QUALITY_QUESTION_IDS);
  assert.deepEqual(body.state.summary, fields);
});

test("every question states both outcomes under the keys the service reads", () => {
  // The service ignores unknown criteria keys without complaining, so a "yes"/"no"
  // spelling silently drops the exclusion half of every judgment.
  for (const [id, question] of Object.entries(SUMMARY_QUALITY_QUESTIONS)) {
    assert.equal(question.type, "noul", `${id} must be a noul`);
    assert.deepEqual(Object.keys(question.criteria).sort(), ["false", "true"], `${id} criteria keys`);
    assert.ok(question.instructions.length > 40, `${id} needs instructions that carry the judgment`);
    assert.ok(question.criteria.true.length > 40, `${id} needs a true criterion`);
    assert.ok(question.criteria.false.length > 40, `${id} needs a false criterion`);
  }
});

test("state rejects input the generator should never produce", () => {
  assert.throws(() => buildSummaryQualityState("", fields), /requires a slug/);
  assert.throws(() => buildSummaryQualityState("owner/repo", { ...fields, cons: undefined }), /requires a cons string/);
});

test("a missing key is reported as unavailable rather than thrown", async () => {
  const outcome = await judgeSummaryQuality("owner/repo", fields, { environment: {} });
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.reason, /TYPESAFE_API_KEY/);
  assert.equal(summaryQualityConfigured({}), false);
  assert.equal(summaryQualityConfigured({ TYPESAFE_API_KEY: " " }), false);
  assert.equal(summaryQualityConfigured({ TYPESAFE_API_KEY: "k" }), true);
});

test("an outage is an outcome, never an exception that fails the refresh", async () => {
  // Holding every repository on a TypeSafe outage would breach the held-ratio
  // invariant and void the whole publication. The deterministic phrase checks the
  // generator already ran stay as the floor.
  for (const [label, fetchImpl] of [
    ["network", async () => { throw new Error("connect ECONNREFUSED"); }],
    ["http", async () => new Response("nope", { status: 503 })],
    ["garbage", async () => new Response("not json", { status: 200 })],
  ]) {
    const outcome = await judge({ fetchImpl });
    assert.equal(outcome.status, "unavailable", label);
    assert.ok(outcome.reason, `${label} needs a reason`);
  }
});

test("a partial answer set is unavailable, not a pass", async () => {
  // Acting on a partial set would pass a field nothing judged, which is the silent
  // failure this replaces.
  const partial = async () => new Response(JSON.stringify({
    answers: { defers_goal: { type: "noul", noul: 0.9 } }, model: "jev-1.13.0",
  }), { status: 200 });
  const outcome = await judge({ fetchImpl: partial });
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.reason, /defers_usage|probability/);
  for (const bad of [1.4, -0.1, Number.NaN, "0.5", null]) {
    const answers = Object.fromEntries(SUMMARY_QUALITY_QUESTION_IDS.map(id => [id, { type: "noul", noul: 0.01 }]));
    answers.usage_role = { type: "noul", noul: bad };
    const outcome = await judge({ fetchImpl: async () => new Response(JSON.stringify({ answers }), { status: 200 }) });
    assert.equal(outcome.status, "unavailable", `noul ${String(bad)} must not pass`);
  }
});

test("a deferring field becomes the defect the repair loop already understands", async () => {
  // generate-summary-bundles.mjs routes its rewrite guidance off this exact message,
  // so the wording is load-bearing, not decorative.
  const outcome = await judge({ fetchImpl: answering({ defers_cons: 0.97, usage_role: 0.99 }) });
  const { defects, warnings } = summaryQualityFindings(outcome.probabilities);
  assert.equal(defects.length, 1);
  assert.equal(defects[0].code, "GENERIC_OR_PLACEHOLDER");
  assert.equal(defects[0].message, "Summary bundle contains a generic or placeholder en.cons");
  assert.equal(defects[0].locale, "en");
  assert.equal(defects[0].field, "cons");
  assert.equal(defects[0].judgment.probability, 0.97);
  assert.deepEqual(warnings, []);
});

test("hedging is only required of the fields the bundle declares as inferences", async () => {
  const outcome = await judge({ fetchImpl: answering({ usage_role: 0.99 }) });
  assert.deepEqual(summaryQualityFindings(outcome.probabilities, { inferenceFields: [] }).warnings, []);
  assert.deepEqual(summaryQualityFindings(outcome.probabilities, { inferenceFields: ["fit", "cons"] }).warnings, [
    { code: "INFERENCE_HEDGE", locale: "en", field: "cons" },
    { code: "INFERENCE_HEDGE", locale: "en", field: "fit" },
  ]);
});

test("a usage field that restates the purpose warns without holding the repository", async () => {
  // A new blocking rule has to be measured on real output before it can hold a
  // repository, so this ships as a warning and the enrichment index records it.
  const outcome = await judge({ fetchImpl: answering({ usage_role: 0.02 }) });
  const { defects, warnings } = summaryQualityFindings(outcome.probabilities);
  assert.deepEqual(defects, []);
  assert.deepEqual(warnings, [{ code: "USAGE_ROLE", locale: "en", field: "usage" }]);
});

test("the threshold is policy and is applied at the boundary", async () => {
  const outcome = await judge({ fetchImpl: answering({ defers_goal: SUMMARY_QUALITY_THRESHOLD, usage_role: 0.99 }) });
  assert.equal(summaryQualityFindings(outcome.probabilities).defects.length, 1);
  assert.equal(summaryQualityFindings(outcome.probabilities, { threshold: 0.75 }).defects.length, 0);
  for (const threshold of [0, 1, -0.1, 1.2]) {
    assert.throws(() => summaryQualityFindings(outcome.probabilities, { threshold }), /threshold/);
  }
});

test("the judged fields are the published summary fields", () => {
  assert.deepEqual([...SUMMARY_QUALITY_FIELDS], ["goal", "usage", "pros", "cons", "fit"]);
});
