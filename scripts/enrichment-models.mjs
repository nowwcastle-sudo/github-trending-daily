export const DEFAULT_ENRICHMENT_MODEL = "claude-sonnet-5";
export const LEGACY_TRANSLATION_MODEL = "claude-haiku-4-5";

const CODEX_CLI_MODEL_RE = /^codex-cli\/gpt-[a-z0-9][a-z0-9._-]{0,63}$/;

export function isCodexCliEnrichmentModel(value) {
  return typeof value === "string" && CODEX_CLI_MODEL_RE.test(value);
}

export function isEnrichmentModel(value) {
  return value === DEFAULT_ENRICHMENT_MODEL
    || value === LEGACY_TRANSLATION_MODEL
    || isCodexCliEnrichmentModel(value);
}

export const CLAUDE_SUMMARY_PRODUCER_PROFILE = Object.freeze({
  provider: "claude-cli-oauth",
  interface: "claude-p",
  auth_method: "oauth_token",
  api_provider: "firstParty",
  model: DEFAULT_ENRICHMENT_MODEL,
});

export const CODEX_SUMMARY_PRODUCER_PROFILE = Object.freeze({
  provider: "codex-cli",
  interface: "codex-exec",
  auth_method: "chatgpt_session",
  api_provider: "openai_first_party",
  model: "codex-cli/gpt-5.6-sol",
});

const SUMMARY_PRODUCER_KEYS = Object.freeze([
  "provider", "interface", "cli_version", "auth_method", "api_provider", "model",
]);

export function isSupportedSummaryProducer(value) {
  if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).sort().join("\0") !== [...SUMMARY_PRODUCER_KEYS].sort().join("\0")
      || !/^\d+\.\d+\.\d+$/.test(value.cli_version)) return false;
  return [CLAUDE_SUMMARY_PRODUCER_PROFILE, CODEX_SUMMARY_PRODUCER_PROFILE]
    .some(profile => Object.entries(profile).every(([key, expected]) => value[key] === expected));
}
