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
