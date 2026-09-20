// Shared TypeSafe access for the refresh pipeline.
//
// The refresh publishes atomically: a repository either ships complete or ships
// `held` and is retried at the next scheduled run. An outage at TypeSafe must
// therefore never throw into the pipeline — it must produce a hold. Every entry
// point here returns an outcome, and reserves exceptions for programming errors.

import {
  DEFAULT_TAG_THRESHOLD,
  FIELD_JUDGMENTS,
  FORM_JUDGMENTS,
  TAG_RULE_VERSION,
  buildClassificationState,
  resolveTags,
} from "./classification-judgments.mjs";

export { TAG_RULE_VERSION };

// Node's built-in fetch ignores HTTPS_PROXY unless this is set, which turns an
// egress-proxied environment into a stream of 401s that look like a bad key.
if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

const CLASSIFICATION_QUESTIONS = Object.freeze(Object.fromEntries(
  [...FIELD_JUDGMENTS, ...FORM_JUDGMENTS].map(judgment => [
    judgment.id,
    { type: "noul", instructions: judgment.instructions, criteria: judgment.criteria },
  ]),
));

let cached = null;

// The SDK is loaded here rather than at module scope. update-trending.mjs is in the
// import graph of the enrichment entry point, and the self-hosted runner that
// generates summaries checks the repository out without installing dependencies --
// a static import makes merely loading this module fail there with
// ERR_MODULE_NOT_FOUND, even though that path never classifies anything.
export async function typeSafeClient(options = {}) {
  if (options.typeSafeClient) return options.typeSafeClient;
  if (!cached) {
    const { TypeSafeClient } = await import("@typesafe-ai/sdk");
    cached = new TypeSafeClient();
  }
  return cached;
}

// Exposed so tests can drive the pipeline without a network or a key. A stub must
// answer systemOne the way the service does: one noul per question id.
export function setTypeSafeClient(client) {
  cached = client;
}

export function resetTypeSafeClient() {
  cached = null;
}

export const CLASSIFICATION_QUESTION_IDS = Object.freeze(Object.keys(CLASSIFICATION_QUESTIONS));

export function typeSafeConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

/**
 * Classify one repository.
 *
 * Returns `{ status: "verified", tags }` or `{ status: "unavailable", reason }`.
 * The caller holds the repository on `unavailable`; it is never a refresh failure.
 */
export async function classifyRepository(repository, options = {}) {
  const state = buildClassificationState(repository);
  const threshold = options.threshold ?? DEFAULT_TAG_THRESHOLD;
  // A missing key is a misconfigured deployment, not an outage. Holding on it would
  // hold every repository on the page, silently and indefinitely, so fail loudly.
  if (!cached && !options.typeSafeClient && !typeSafeConfigured()) {
    throw new Error("TYPESAFE_API_KEY is not set; refusing to hold every repository on a configuration error");
  }
  try {
    const client = await typeSafeClient(options);
    const { answers } = await client.systemOne({ state, questions: CLASSIFICATION_QUESTIONS });
    const probabilities = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.noul]));
    const { field_tags, form_tags } = resolveTags(probabilities, { threshold });
    return { status: "verified", tags: { tag_rule_version: TAG_RULE_VERSION, field_tags, form_tags } };
  } catch (error) {
    // A malformed or incomplete answer set is as unusable as no answer at all,
    // and equally not worth failing the whole refresh over.
    return { status: "unavailable", reason: error?.message ?? String(error) };
  }
}

// A held repository still has to satisfy the publication invariant, which requires
// canonical tags. `unclassified` is the schema's own "no field applies" value, so a
// hold publishes the measured data and leaves the tags to the next run.
export function unavailableClassification() {
  return { tag_rule_version: TAG_RULE_VERSION, field_tags: ["unclassified"], form_tags: [] };
}
