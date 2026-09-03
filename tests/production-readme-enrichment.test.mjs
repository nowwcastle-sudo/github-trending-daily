import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractReposFromIndex, slugToFile } from "../scripts/generate-translations.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const genericSummary = /(?:구체적인 설치 및 사용 절차는 저장소 README 원문을 확인한다|README(?:를|에서| 원문을)?\s*(?:확인|참고)|자동\s*요약)/i;
const locales = ["en", "ko", "zh-CN", "es", "ja"];
const fields = ["goal", "usage", "pros", "cons", "fit"];

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validDetailedSummary(value) {
  return exactKeys(value, fields)
    && fields.every(field => typeof value[field] === "string" && value[field].trim() && !genericSummary.test(value[field]));
}

function validV3Source(value, repository) {
  return exactKeys(value, ["kind", "slug", "path", "blob_sha", "content_sha256", "provider", "interface", "cli_version", "auth_method", "api_provider", "model", "schema_version", "prompt_schema_version", "translation_applicable"])
    && value.kind === "readme"
    && value.slug === repository.slug.toLowerCase()
    && value.path === repository.readme_path
    && value.blob_sha === repository.readme_blob_sha
    && value.content_sha256 === repository.readme_content_sha256
    && value.provider === "claude-cli-oauth"
    && value.interface === "claude-p"
    && /^\d+\.\d+\.\d+$/.test(value.cli_version)
    && value.auth_method === "oauth_token"
    && value.api_provider === "firstParty"
    && value.model === "claude-sonnet-5"
    && value.schema_version === 3
    && value.prompt_schema_version === 3
    && value.translation_applicable === false;
}

test("tracked production migration gate distinguishes the exact legacy RED from complete v3 summaries", async () => {
  const [page, translationFiles, sourceRegistry] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readdir(path.join(root, "translations")).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error)),
    readFile(path.join(root, "data", "translation-sources.json"), "utf8").then(JSON.parse),
  ]);
  const repositories = extractReposFromIndex(page);
  const trackedTranslations = new Set(translationFiles.map(file => file.toLowerCase()));
  const observed = {
    repository: repositories.length,
    genericSummary: repositories.filter(repository => Object.values(repository.summary ?? {}).some(value => genericSummary.test(String(value)))).length,
    validReadmeProvenance: repositories.filter(repository => (
      typeof repository.readme_path === "string"
      && repository.readme_path.length > 0
      && !repository.readme_path.startsWith("/")
      && !repository.readme_path.split("/").some(part => !part || part === "." || part === "..")
      && sha1.test(repository.readme_blob_sha ?? "")
      && sha256.test(repository.readme_content_sha256 ?? "")
      && sha1.test(repository.default_branch_head_sha ?? "")
    )).length,
    trackedTranslations: repositories.filter(repository => trackedTranslations.has(slugToFile(repository.slug).toLowerCase())).length,
  };

  assert.ok(observed.repository >= 10 && observed.repository <= 75, JSON.stringify(observed));
  if (sourceRegistry.version === 2) {
    assert.deepEqual(observed, {
      repository: 49,
      genericSummary: 49,
      validReadmeProvenance: 0,
      trackedTranslations: 33,
    });
    const activeSources = repositories.map(repository => sourceRegistry.sources?.[repository.slug.toLowerCase()]);
    assert.ok(activeSources.every(source => source?.model == null && source?.blob_sha == null && source?.translation_applicable == null));
    return { status: "legacy_red", ...observed };
  }

  assert.equal(sourceRegistry.version, 3, "tracked production must be either the exact legacy RED or v3");
  assert.equal(translationFiles.length, 0, "v3 retires all tracked full README translations");
  assert.deepEqual(observed, {
    repository: observed.repository,
    genericSummary: 0,
    validReadmeProvenance: observed.repository,
    trackedTranslations: 0,
  });
  const heldRepositories = repositories.filter(repository => repository.summary_status === "held");
  const admittedRepositories = repositories.filter(repository => repository.summary_status !== "held");
  assert.deepEqual(Object.keys(sourceRegistry.sources), admittedRepositories.map(repository => repository.slug));
  for (const repository of heldRepositories) {
    assert.equal(repository.summary, null, `${repository.slug} held must carry no summary`);
    assert.equal(repository.detail, null, `${repository.slug} held must carry no detail`);
    assert.equal(sourceRegistry.sources[repository.slug.toLowerCase()], undefined, `${repository.slug} held must have no source entry`);
  }
  const sourcesByIdentity = new Map(Object.entries(sourceRegistry.sources).map(([slug, source]) => [slug.toLowerCase(), source]));
  assert.equal(sourcesByIdentity.size, admittedRepositories.length, "v3 source identities must be case-insensitively unique");
  for (const repository of admittedRepositories) {
    assert.ok(exactKeys(repository.summaries, locales), `${repository.slug}: five-locale summary bundle missing`);
    assert.ok(locales.every(locale => validDetailedSummary(repository.summaries[locale])), `${repository.slug}: invalid detailed summary`);
    assert.deepEqual(repository.summary, repository.summaries.en, `${repository.slug}: English default mismatch`);
    assert.ok(validV3Source(sourcesByIdentity.get(repository.slug.toLowerCase()), repository), `${repository.slug}: invalid v3 source`);
  }
  return { status: "v3_ready", ...observed };
});
