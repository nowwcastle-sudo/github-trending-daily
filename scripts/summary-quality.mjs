// Judge summary quality with TypeSafe rather than with phrase lists.
//
// The generator runs on the self-hosted enrichment runner, which checks the
// repository out without installing dependencies -- a dependency there is what
// killed refresh run 186. So this speaks the TypeSafe HTTP API directly with
// Node's built-in fetch and never imports the SDK. The request shape below is
// pinned against what @typesafe-ai/sdk 0.6.0 actually sends.
//
// The credential is read from the environment the same way the Claude OAuth
// token is: set on the runner's own user account, never handed to the job by
// GitHub, so it does not travel out of the machine that needs it.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 20_000;

export const SUMMARY_QUALITY_THRESHOLD = 0.5;
export const SUMMARY_QUALITY_FIELDS = Object.freeze(["goal", "usage", "pros", "cons", "fit"]);

// Node's built-in fetch ignores HTTPS_PROXY unless this is set, which turns an
// egress-proxied environment into a stream of 401s that look like a bad key.
if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

// Both criteria keys must be the strings "true" and "false". The service ignores
// any other key without complaining, so a "yes"/"no" spelling silently drops the
// half of the judgment that does the work.
const defersQuestion = field => ({
  type: "noul",
  instructions: `Does the \`${field}\` field send the reader somewhere else instead of telling them the thing itself?`,
  criteria: {
    true: "It tells the reader to consult the README, the documentation, the project site or the source for the actual answer, or it is filler with no specific content about this repository.",
    false: "It answers on its own terms. Naming or quoting the README as the source of a fact, or naming a documentation file as part of a real explanation, is not sending the reader away.",
  },
});

const qualifiedQuestion = field => ({
  type: "noul",
  instructions: `Is the claim in the \`${field}\` field presented as a cautious inference rather than as documented fact?`,
  criteria: {
    true: "It marks the claim as inferred or provisional -- it appears to, is likely, seems designed for, suggests -- so a reader can tell the project never says this outright.",
    false: "It asserts the claim flatly, as if the project documented it. A word like `may` describing an option the user has, such as a flag they may pass, is not a cautious inference.",
  },
});

const USAGE_ROLE_QUESTION = Object.freeze({
  type: "noul",
  instructions: "Does the `usage` field tell the reader how to install or run the project, rather than restating what it is for?",
  criteria: {
    true: "It gives installation or execution steps, commands, or a concrete entry point the reader can act on.",
    false: "It restates the purpose, the audience or the benefits, which belong to the other fields.",
  },
});

export const SUMMARY_QUALITY_QUESTIONS = Object.freeze({
  ...Object.fromEntries(SUMMARY_QUALITY_FIELDS.map(field => [`defers_${field}`, defersQuestion(field)])),
  ...Object.fromEntries(SUMMARY_QUALITY_FIELDS.map(field => [`qualified_${field}`, qualifiedQuestion(field)])),
  usage_role: USAGE_ROLE_QUESTION,
});

export const SUMMARY_QUALITY_QUESTION_IDS = Object.freeze(Object.keys(SUMMARY_QUALITY_QUESTIONS));

export function summaryQualityConfigured(environment = process.env) {
  return Boolean(environment.TYPESAFE_API_KEY?.trim());
}

export function buildSummaryQualityState(slug, fields) {
  if (typeof slug !== "string" || !slug) throw new Error("summary quality state requires a slug");
  const summary = {};
  for (const field of SUMMARY_QUALITY_FIELDS) {
    const value = fields?.[field];
    if (typeof value !== "string") throw new Error(`summary quality state requires a ${field} string`);
    summary[field] = value;
  }
  return { repository: slug, summary };
}

async function postSystemOne(state, { apiKey, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, questions: SUMMARY_QUALITY_QUESTIONS, model: MODEL }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TypeSafe responded ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function probabilitiesFrom(payload) {
  const answers = payload?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("TypeSafe answers are missing");
  const probabilities = {};
  for (const id of SUMMARY_QUALITY_QUESTION_IDS) {
    const value = answers[id]?.noul;
    // A partial answer set is as unusable as none: acting on it would pass a field
    // that was never judged, which is exactly the silent failure this replaces.
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`TypeSafe answer for ${id} is not a probability`);
    }
    probabilities[id] = value;
  }
  return probabilities;
}

/**
 * Judge one repository's English summary fields.
 *
 * Returns `{ status: "verified", probabilities }` or `{ status: "unavailable", reason }`.
 * An outage is never a refresh failure: the caller keeps the deterministic phrase
 * checks it already ran, which is the quality floor this raises rather than replaces.
 */
export async function judgeSummaryQuality(slug, fields, options = {}) {
  const state = buildSummaryQualityState(slug, fields);
  const apiKey = (options.environment ?? process.env).TYPESAFE_API_KEY?.trim();
  if (!apiKey) return { status: "unavailable", reason: "TYPESAFE_API_KEY is not set" };
  try {
    const payload = await postSystemOne(state, {
      apiKey,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    });
    return { status: "verified", probabilities: probabilitiesFrom(payload) };
  } catch (error) {
    return { status: "unavailable", reason: error?.message ?? String(error) };
  }
}

/**
 * Turn probabilities into the defects and warnings the generator already knows.
 *
 * `defers` is a defect: it is the phrase-list check's own job, and the repair loop
 * can fix the field. `qualified` and `usage_role` are warnings -- the first because
 * the existing hedge check is a warning too, the second because it is a new check
 * and a new blocking rule should be measured on real output before it can hold.
 */
export function summaryQualityFindings(probabilities, { inferenceFields = [], threshold = SUMMARY_QUALITY_THRESHOLD } = {}) {
  if (!(threshold > 0) || !(threshold < 1)) throw new Error("summary quality threshold must be between 0 and 1");
  const defects = [];
  const warnings = [];
  for (const field of SUMMARY_QUALITY_FIELDS) {
    if (probabilities[`defers_${field}`] >= threshold) {
      defects.push({
        code: "GENERIC_OR_PLACEHOLDER",
        // The generator routes repair guidance off this exact message.
        message: `Summary bundle contains a generic or placeholder en.${field}`,
        locale: "en",
        field,
        judgment: { question: `defers_${field}`, probability: probabilities[`defers_${field}`] },
      });
    }
    if (inferenceFields.includes(field) && probabilities[`qualified_${field}`] < threshold) {
      warnings.push({ code: "INFERENCE_HEDGE", locale: "en", field });
    }
  }
  if (probabilities.usage_role < threshold) warnings.push({ code: "USAGE_ROLE", locale: "en", field: "usage" });
  return { defects, warnings };
}
