import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readRunContext, validateRunContext } from "./run-context.mjs";
import {
  collectRepositoryEvents,
  createPersistentEventCollectionContext,
  hashCanonicalJson,
  isEventCollectionContext,
  validateFrozenFactsPayload,
} from "./collect-repository-events.mjs";
import { parseJsonStrict } from "./build-pages-artifact.mjs";

const PERIODS = {
  daily: { field: "stars_daily", label: "today" },
  weekly: { field: "stars_weekly", label: "this week" },
  monthly: { field: "stars_monthly", label: "this month" },
};
const ENRICHMENT_MODEL = "claude-haiku-4-5";
const ENRICHMENT_SCHEMA_VERSION = 2;
const SUMMARY_FIELDS = ["goal", "usage", "pros", "cons", "fit"];

function periodConfig(period) {
  const config = PERIODS[period];
  if (!config) throw new Error(`Unsupported Trending period: ${period}`);
  return config;
}

function normalizeSlug(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`Invalid repository path: ${path}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(decoded)) {
    throw new Error(`Invalid repository path: ${path}`);
  }
  return decoded;
}

export function parseTrendingHtml(html, period) {
  const { field, label } = periodConfig(period);
  if (typeof html !== "string" || !html.trim()) throw new Error("Trending HTML is empty");

  const repos = [];
  const seen = new Set();
  const articles = html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi);
  for (const [, attributes, body] of articles) {
    if (!/\bclass\s*=\s*(?:"[^"]*\bBox-row\b[^"]*"|'[^']*\bBox-row\b[^']*')/i.test(attributes)) continue;

    const heading = body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "";
    const path = heading.match(/<a\b[^>]*\bhref\s*=\s*(?:"\/([^"?#]+)"|'\/([^'?#]+)')/i);
    if (!path) throw new Error("Invalid Trending repository link");
    const slug = normalizeSlug(path[1] ?? path[2]);

    const gainPattern = new RegExp(`^([\\d,]+)\\s+stars?\\s+${label.replaceAll(" ", "\\s+")}$`, "i");
    const gains = [...body.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      .map(([, content]) => content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().match(gainPattern))
      .filter(Boolean);
    const rawGain = gains.length === 1 ? gains[0][1] : "";
    const value = /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(rawGain)
      ? Number(rawGain.replaceAll(",", ""))
      : NaN;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${period} star gain for ${slug}`);

    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate repository in ${period} Trending: ${slug}`);
    seen.add(key);
    const languageColorTag = [...body.matchAll(/<span\b([^>]*)>/gi)]
      .map(([, tagAttributes]) => tagAttributes)
      .find(tagAttributes => /\bclass\s*=\s*(?:"[^"]*\brepo-language-color\b[^"]*"|'[^']*\brepo-language-color\b[^']*')/i.test(tagAttributes));
    const languageColor = languageColorTag?.match(/\bstyle\s*=\s*(?:"[^"]*background-color\s*:\s*(#[0-9a-f]{6})[^"]*"|'[^']*background-color\s*:\s*(#[0-9a-f]{6})[^']*')/i);
    repos.push({
      slug,
      [field]: value,
      sourceRank: repos.length + 1,
      languageColor: (languageColor?.[1] ?? languageColor?.[2] ?? null)?.toLowerCase() ?? null,
    });
  }

  if (!repos.length) throw new Error("Trending page contains no Trending repositories");
  if (repos.length < 5) throw new Error(`Trending ${period} expected at least 5 repositories, got ${repos.length}`);
  return repos;
}

export function mergeTrendingPeriods(periods) {
  const merged = [];
  const bySlug = new Map();

  for (const period of Object.keys(PERIODS)) {
    const repos = periods?.[period];
    const { field } = PERIODS[period];
    const gainKey = `gain_${period}`;
    const rankKey = `rank_${period}`;
    if (!Array.isArray(repos) || repos.length < 5) {
      throw new Error(`Trending ${period} expected at least 5 repositories`);
    }

    const seen = new Set();
    for (const [index, repo] of repos.entries()) {
      const slug = normalizeSlug(repo?.slug ?? "");
      const gain = repo?.[field];
      if (!Number.isSafeInteger(gain) || gain < 0) throw new Error(`Invalid ${period} star gain for ${slug}`);
      const sourceRank = repo?.sourceRank ?? index + 1;
      if (sourceRank !== index + 1) throw new Error(`Invalid ${period} source rank for ${slug}`);
      const languageColor = repo?.languageColor ?? null;
      if (languageColor !== null && (typeof languageColor !== "string" || !/^#[0-9a-f]{6}$/i.test(languageColor))) {
        throw new Error(`Invalid ${period} language color for ${slug}`);
      }

      const key = slug.toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate repository in ${period} Trending: ${slug}`);
      seen.add(key);

      const existing = bySlug.get(key);
      if (existing) {
        existing[rankKey] = sourceRank;
        existing[gainKey] = gain;
        existing.languageColors[period] = languageColor?.toLowerCase() ?? null;
        if (existing.languageColor === null && languageColor !== null) existing.languageColor = languageColor.toLowerCase();
      }
      else {
        const added = {
          slug,
          [rankKey]: sourceRank,
          [gainKey]: gain,
          languageColor: languageColor?.toLowerCase() ?? null,
          languageColors: { [period]: languageColor?.toLowerCase() ?? null },
        };
        bySlug.set(key, added);
        merged.push(added);
      }
    }
  }

  if (merged.length < 10 || merged.length > 75) {
    throw new Error(`Trending union size ${merged.length} is outside 10-75`);
  }
  return merged;
}

class RequestLimitError extends Error {}
class RetryDelayError extends Error {}

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const GITHUB_REQUESTS_PER_REPOSITORY = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_REQUESTS = 75 * GITHUB_REQUESTS_PER_REPOSITORY * DEFAULT_MAX_ATTEMPTS;
const TAG_RULE_VERSION = 1;
const FIELD_RULES = [
  ["ai-ml", /\b(ai|artificial[- ]intelligence|machine[- ]learning|deep[- ]learning|llms?|gpt|claude|codex|agents?|agentic|rag|inference|neural|generative[- ]ai|computer[- ]vision|nlp)\b/i],
  ["web-app", /\b(web|frontend|react|vue|svelte|next\.?js|mobile|android|ios|browser|webapp)\b/i],
  ["dev-tools", /\b(developer[- ]tools?|devtools?|coding|programming|compiler|sdk|ide|cli|automation|api|mcp|plugins?)\b/i],
  ["data", /\b(data|database|sql|analytics|warehouse|vector[- ]database|data[- ]engineering)\b/i],
  ["devops", /\b(devops|cloud|kubernetes|k8s|docker|infrastructure|ci[- /]?cd|observability|deployment)\b/i],
  ["security", /\b(security|privacy|pentest|osint|vulnerabilit(?:y|ies)|authentication|authorization|password|secrets?)\b/i],
  ["productivity", /\b(productivity|project[- ]management|note[- ]taking|knowledge[- ]management|job[- ]search|workflow|crm|finance|media|desktop[- ]app)\b/i],
  ["systems", /\b(linux|operating[- ]system|kernel|embedded|hardware|robotics?|on[- ]device|wearables?|smart[- ]home)\b/i],
  ["learning", /\b(awesome|learn|learning|tutorial|course|book|beginners?|curriculum|resources?)\b/i],
];
const FORM_RULES = [
  ["agent", /\b(agents?|agentic)\b/i],
  ["mcp", /\bmcp\b/i],
  ["plugin-skill", /\b(plugins?|skills?)\b/i],
  ["ide", /\b(ide|code[- ]editor|coding[- ]environment)\b/i],
  ["library", /\b(library|libraries|sdk|toolkit|package)\b/i],
  ["framework", /\bframeworks?\b/i],
  ["cli", /\b(cli|command[- ]line|automation|workflow)\b/i],
];

function githubPath(slug, suffix = "") {
  return `/repos/${slug.split("/").map(encodeURIComponent).join("/")}${suffix}`;
}

function boundedDelay(milliseconds, maximum) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds > maximum) {
    throw new RetryDelayError(`Retry delay ${milliseconds}ms exceeds maximum ${maximum}ms`);
  }
  return milliseconds;
}

function retryDelay(response, attempt, maximum) {
  const scheduled = [2000, 8000][attempt];
  if (scheduled === undefined) throw new RetryDelayError(`Retry attempt ${attempt + 1} is outside the bounded schedule`);
  const header = response?.headers?.get("retry-after");
  const requested = header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : 0;
  return boundedDelay(Math.max(scheduled, requested), maximum);
}

function shouldRetry(response) {
  return response.status === 429 || response.status >= 500;
}

function isTimeout(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return sha256(Buffer.from(stableJson(value), "utf8"));
}

function createGitHubClient({
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  token = "",
  maxRequests = DEFAULT_MAX_REQUESTS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxRetryDelay = 300000,
  collectionBudget = null,
} = {}) {
  if (typeof fetchImpl !== "function" || typeof sleep !== "function") throw new Error("fetchImpl and sleep must be functions");
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("maxRequests must be a positive integer");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("maxAttempts must be between 1 and 3");
  if (!Number.isSafeInteger(maxRetryDelay) || maxRetryDelay < 0) throw new Error("maxRetryDelay must be a non-negative integer");
  if (collectionBudget !== null && ["admitLogical", "admitAttempt", "admitSleep"].some(method => typeof collectionBudget?.[method] !== "function")) {
    throw new Error("collectionBudget must be an immutable event budget");
  }

  let requestCount = 0;
  return {
    get requestCount() { return requestCount; },
    async request(path) {
      collectionBudget?.admitLogical();
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (requestCount >= maxRequests) throw new RequestLimitError(`GitHub request limit ${maxRequests} exceeded`);
        collectionBudget?.admitAttempt();
        requestCount += 1;
        let response;
        try {
          response = await fetchImpl(`https://api.github.com${path}`, {
            headers: {
              Accept: "application/vnd.github+json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          if (!isTimeout(error)) throw new Error(`GitHub request failed for ${path}`);
          if (attempt + 1 >= maxAttempts) throw new Error(`GitHub request timed out for ${path}`);
          const delay = collectionBudget ? [2000, 8000][attempt] : boundedDelay([2000, 8000][attempt], maxRetryDelay);
          collectionBudget?.admitSleep(delay);
          await sleep(delay);
          continue;
        }
        if (!shouldRetry(response) || attempt + 1 >= maxAttempts) return response;
        const delay = collectionBudget ? [2000, 8000][attempt] : retryDelay(response, attempt, maxRetryDelay);
        collectionBudget?.admitSleep(delay);
        await sleep(delay);
      }
      throw new Error(`GitHub request failed for ${path}`);
    },
  };
}

async function requireGitHubJson(response, path) {
  if (!response?.ok) throw new Error(`GitHub request returned ${response?.status} for ${path}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`Invalid GitHub JSON for ${path}`);
  }
}

function contributorCount(response, contributors, slug) {
  if (contributors.length > 1) throw new Error(`Invalid GitHub contributors for ${slug}`);
  const header = response.headers.get("link");
  if (header === null) return contributors.length;
  const links = header.split(",").map(value => {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z]+)"\s*$/.exec(value);
    if (!match) throw new Error(`Invalid GitHub contributors for ${slug}`);
    return { target: match[1], relation: match[2] };
  });
  const lastLinks = links.filter(link => link.relation === "last");
  if (lastLinks.length !== 1) throw new Error(`Invalid GitHub contributors for ${slug}`);
  let last;
  try {
    last = new URL(lastLinks[0].target);
  } catch {
    throw new Error(`Invalid GitHub contributors for ${slug}`);
  }
  const pageValues = last.searchParams.getAll("page");
  const perPageValues = last.searchParams.getAll("per_page");
  const anonValues = last.searchParams.getAll("anon");
  const pageValue = pageValues[0];
  const page = pageValue !== null && /^\d+$/.test(pageValue) ? Number(pageValue) : NaN;
  if (
    last.protocol !== "https:"
    || last.hostname !== "api.github.com"
    || !last.pathname.endsWith("/contributors")
    || pageValues.length !== 1
    || perPageValues.length !== 1
    || perPageValues[0] !== "1"
    || anonValues.length !== 1
    || anonValues[0] !== "1"
    || !Number.isSafeInteger(page)
    || page < Math.max(1, contributors.length)
  ) {
    throw new Error(`Invalid GitHub contributors for ${slug}`);
  }
  return page;
}

function validTimestamp(value, nullable = false) {
  if (nullable && value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value.replace(/Z$/, ".000Z");
}

function assertRepoMetadata(value, slug) {
  const counts = [value?.stargazers_count, value?.forks_count, value?.watchers_count, value?.open_issues_count, value?.subscribers_count];
  const topics = value?.topics;
  if (
    typeof value?.full_name !== "string"
    || value.full_name.toLowerCase() !== slug.toLowerCase()
    || (value.description !== null && typeof value.description !== "string")
    || (value.language !== null && typeof value.language !== "string")
    || typeof value.archived !== "boolean"
    || typeof value.fork !== "boolean"
    || typeof value.default_branch !== "string"
    || !value.default_branch
    || /[\u0000-\u001f\u007f]/.test(value.default_branch)
    || !validTimestamp(value.created_at)
    || !validTimestamp(value.updated_at)
    || !validTimestamp(value.pushed_at, true)
    || (value.license !== null && (typeof value.license !== "object" || typeof value.license.spdx_id !== "string" || !value.license.spdx_id))
    || !Array.isArray(topics)
    || topics.some(topic => typeof topic !== "string" || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic))
    || counts.some(count => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new Error(`Invalid GitHub metadata for ${slug}`);
  }
}

function decodeBoundedBase64(value, maximumBytes) {
  if (typeof value !== "string") throw new Error("README content must be base64 text");
  const normalized = value.replace(/[\r\n\t ]/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error("README content is not canonical base64");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length > maximumBytes) throw new Error(`README content exceeds ${maximumBytes} bytes`);
  return bytes;
}

function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("README content is not valid UTF-8");
  }
}

function classifyRepository({ slug, display_slug, description, primary_language, topics }) {
  const text = [slug, display_slug, description, primary_language, ...topics].filter(value => typeof value === "string").join(" ");
  const field_tags = FIELD_RULES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  const form_tags = FORM_RULES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  return { field_tags: field_tags.length ? field_tags : ["unclassified"], form_tags };
}

export async function fetchCanonicalReadme(slug, options = {}) {
  const normalizedSlug = normalizeSlug(slug);
  const client = options.client ?? createGitHubClient(options);
  const apiPath = githubPath(normalizedSlug, "/readme");
  const response = await client.request(apiPath);
  if (response.status === 404) {
    return { status: "absent", path: null, blobSha: null, markdown: null, contentSha256: null };
  }
  const value = await requireGitHubJson(response, apiPath);
  if (
    value?.encoding !== "base64"
    || typeof value.path !== "string"
    || !value.path
    || value.path.startsWith("/")
    || value.path.includes("\0")
    || typeof value.content !== "string"
    || !/^[a-f0-9]{40}$/.test(value.sha ?? "")
  ) {
    throw new Error(`Invalid canonical README metadata for ${normalizedSlug}`);
  }
  let bytes;
  try {
    bytes = decodeBoundedBase64(value.content, 512 * 1024);
  } catch {
    throw new Error(`Invalid canonical README metadata for ${normalizedSlug}`);
  }
  return {
    status: "present",
    path: value.path,
    blobSha: value.sha,
    markdown: decodeUtf8Strict(bytes),
    contentSha256: sha256(bytes),
  };
}

function nullableOrdinal(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function nullableGain(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

export async function fetchRepositoryFacts(slug, options = {}) {
  const normalizedSlug = normalizeSlug(slug);
  const client = options.client ?? createGitHubClient(options);
  const repositoryPath = githubPath(normalizedSlug);
  const repositoryResponse = await client.request(repositoryPath);
  const metadata = await requireGitHubJson(repositoryResponse, repositoryPath);
  assertRepoMetadata(metadata, normalizedSlug);

  const contributorsPath = `${githubPath(normalizedSlug, "/contributors")}?anon=1&per_page=1`;
  const contributorsResponse = await client.request(contributorsPath);
  const contributorValues = await requireGitHubJson(contributorsResponse, contributorsPath);
  if (!Array.isArray(contributorValues)) throw new Error(`Invalid GitHub contributors for ${normalizedSlug}`);
  const contributors = contributorCount(contributorsResponse, contributorValues, normalizedSlug);
  if (!Number.isSafeInteger(contributors) || contributors < 0) throw new Error(`Invalid GitHub contributors for ${normalizedSlug}`);

  const headPath = githubPath(normalizedSlug, `/commits/${encodeURIComponent(metadata.default_branch)}`);
  const headResponse = await client.request(headPath);
  const head = await requireGitHubJson(headResponse, headPath);
  if (!/^[a-f0-9]{40}$/.test(head?.sha ?? "")) throw new Error(`Invalid default branch HEAD for ${normalizedSlug}`);

  const readme = await fetchCanonicalReadme(normalizedSlug, { ...options, client });
  const [owner, name] = normalizedSlug.split("/");
  const source = options.source ?? {};
  const ranks = {
    rank_daily: nullableOrdinal(source.rank_daily, "daily source rank"),
    rank_weekly: nullableOrdinal(source.rank_weekly, "weekly source rank"),
    rank_monthly: nullableOrdinal(source.rank_monthly, "monthly source rank"),
  };
  const gains = {
    gain_daily: nullableGain(source.gain_daily, "daily gain"),
    gain_weekly: nullableGain(source.gain_weekly, "weekly gain"),
    gain_monthly: nullableGain(source.gain_monthly, "monthly gain"),
  };
  const languageColors = Object.fromEntries(["daily", "weekly", "monthly"].map(period => {
    const value = source.languageColors?.[period]
      ?? (period === "daily" && source.languageColors === undefined ? source.languageColor : null)
      ?? null;
    if (value !== null && (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))) {
      throw new Error(`Invalid language color for ${normalizedSlug}`);
    }
    return [period, value?.toLowerCase() ?? null];
  }));
  const selectedColorPeriod = ["daily", "weekly", "monthly"].find(period => languageColors[period] !== null) ?? null;
  const languageColor = selectedColorPeriod === null ? null : languageColors[selectedColorPeriod];
  const displayRank = options.displayRank ?? null;
  if (displayRank !== null && (!Number.isSafeInteger(displayRank) || displayRank < 1)) {
    throw new Error(`Invalid display rank for ${normalizedSlug}`);
  }

  const repositorySourceFacts = {
    archived: metadata.archived,
    created_at: metadata.created_at,
    default_branch: metadata.default_branch,
    description: metadata.description,
    forks: metadata.forks_count,
    is_fork: metadata.fork,
    license_spdx: metadata.license?.spdx_id ?? null,
    open_issues_and_pull_requests: metadata.open_issues_count,
    primary_language: metadata.language,
    pushed_at: metadata.pushed_at,
    stars: metadata.stargazers_count,
    subscribers: metadata.subscribers_count,
    watchers_count: metadata.watchers_count,
    topics: [...metadata.topics],
    updated_at: metadata.updated_at,
  };
  const repositoryFacts = {
    ...repositorySourceFacts,
    contributors,
    default_branch_head_sha: head.sha,
    language_color: languageColor,
  };
  const display = { display_rank: displayRank, display_slug: `${owner} / ${name}` };
  const tags = classifyRepository({ slug: normalizedSlug, ...display, ...repositoryFacts });
  const readmeFacts = {
    readme_blob_sha: readme.blobSha,
    readme_content_sha256: readme.contentSha256,
    readme_path: readme.path,
    readme_status: readme.status,
  };
  const provenance = {
    repository: {
      api_path: repositoryPath,
      fact_sha256: canonicalHash(repositorySourceFacts),
    },
    contributors: {
      api_path: contributorsPath,
      fact_sha256: canonicalHash({ contributors }),
    },
    default_branch_head: {
      api_path: headPath,
      fact_sha256: canonicalHash({ sha: head.sha }),
    },
    readme: {
      api_path: githubPath(normalizedSlug, "/readme"),
      blob_api_path: readme.blobSha === null ? null : githubPath(normalizedSlug, `/git/blobs/${readme.blobSha}`),
      status: readme.status,
      path: readme.path,
      blob_sha: readme.blobSha,
      content_sha256: readme.contentSha256,
    },
    trending: {
      ...Object.fromEntries(["daily", "weekly", "monthly"].map(period => [period, {
        source_path: `/trending?since=${period}`,
        rank: ranks[`rank_${period}`],
        gain: gains[`gain_${period}`],
        language_color: languageColors[period],
        fact_sha256: canonicalHash({
          rank: ranks[`rank_${period}`],
          gain: gains[`gain_${period}`],
          language_color: languageColors[period],
        }),
      }])),
      language_color_selection: {
        rule: "daily_then_weekly_then_monthly",
        selected_period: selectedColorPeriod,
        value: languageColor,
      },
    },
  };

  const result = {
    archived: repositoryFacts.archived,
    contributors: repositoryFacts.contributors,
    created_at: repositoryFacts.created_at,
    default_branch: repositoryFacts.default_branch,
    default_branch_head_sha: repositoryFacts.default_branch_head_sha,
    description: repositoryFacts.description,
    display_rank: display.display_rank,
    display_slug: display.display_slug,
    field_tags: tags.field_tags,
    forks: repositoryFacts.forks,
    form_tags: tags.form_tags,
    gain_daily: gains.gain_daily,
    gain_monthly: gains.gain_monthly,
    gain_weekly: gains.gain_weekly,
    is_fork: repositoryFacts.is_fork,
    language_color: repositoryFacts.language_color,
    license_spdx: repositoryFacts.license_spdx,
    open_issues_and_pull_requests: repositoryFacts.open_issues_and_pull_requests,
    primary_language: repositoryFacts.primary_language,
    provenance,
    readme_blob_sha: readmeFacts.readme_blob_sha,
    readme_content_sha256: readmeFacts.readme_content_sha256,
    readme_path: readmeFacts.readme_path,
    readme_status: readmeFacts.readme_status,
    pushed_at: repositoryFacts.pushed_at,
    rank_daily: ranks.rank_daily,
    rank_monthly: ranks.rank_monthly,
    rank_weekly: ranks.rank_weekly,
    slug: normalizedSlug,
    stars: repositoryFacts.stars,
    subscribers: repositoryFacts.subscribers,
    tag_rule_version: TAG_RULE_VERSION,
    topics: repositoryFacts.topics,
    updated_at: repositoryFacts.updated_at,
    watchers_count: repositoryFacts.watchers_count,
  };
  if (options.includeReadmeBody === true) result.readme_markdown = readme.markdown;
  return result;
}

async function fetchLatestRelease(slug, { client }) {
  const apiPath = githubPath(slug, "/releases/latest");
  const response = await client.request(apiPath);
  if (response.status === 404) return null;
  const value = await requireGitHubJson(response, apiPath);
  if (!validTimestamp(value?.published_at)) throw new Error(`Invalid latest GitHub release for ${slug}`);
  return value.published_at.slice(0, 10);
}

function readmeIntroduction(readme) {
  if (typeof readme !== "string") return "";
  return readme
    .split(/\r?\n\s*\r?\n/)
    .map(paragraph => paragraph
      .replace(/```[\s\S]*?```/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim())
    .find(Boolean) ?? "";
}

function trendNote(repo) {
  const labels = [
    ["stars_daily", "오늘"],
    ["stars_weekly", "이번 주"],
    ["stars_monthly", "이번 달"],
  ];
  return labels
    .filter(([field]) => Number.isSafeInteger(repo[field]))
    .map(([field, label]) => `${label} ${repo[field].toLocaleString("ko-KR")}개`)
    .join(", ");
}

function koreanFallback(repo, metadata, readme) {
  const source = metadata.description?.trim() || readmeIntroduction(readme) || `${repo.slug} 공개 저장소`;
  const language = metadata.language ? `${metadata.language} 기반 ` : "";
  const gains = trendNote(repo);
  const goal = `${source} GitHub에 공개된 ${language}저장소다.`;
  const usage = "구체적인 설치 및 사용 절차는 저장소 README 원문을 확인한다.";
  const pros = `${gains}의 스타 증가가 공개 Trending 데이터에서 확인됐다.`;
  const cons = "자동 요약은 공개 설명과 GitHub 메타데이터만 반영하므로 세부 기능과 제약은 README 원문 확인이 필요하다.";
  const fit = `${metadata.language || "오픈소스"} 저장소를 탐색하려는 사용자에게 참고 자료가 된다.`;
  return {
    summary: { goal, usage, pros, cons, fit },
    detail: { goal, usage, pros, cons, fit, stars_note: buildTrendNote({
      gain_daily: repo.stars_daily,
      gain_weekly: repo.stars_weekly,
      gain_monthly: repo.stars_monthly,
      membership_status: repo.membership_status,
    }) },
  };
}

export async function enrichTrendingRepositories(discovered, {
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  token = "",
  maxRequests = DEFAULT_MAX_REQUESTS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxRetryDelay = 300000,
  collectionBudget = null,
  includeLatestRelease = true,
  includeReadmeBody = false,
} = {}) {
  if (!Array.isArray(discovered) || discovered.length < 10 || discovered.length > 75) {
    throw new Error("Discovered repositories must contain 10-75 entries");
  }
  const client = createGitHubClient({ fetchImpl, sleep, token, maxRequests, maxAttempts, maxRetryDelay, collectionBudget });
  const requestsPerRepository = includeLatestRelease ? GITHUB_REQUESTS_PER_REPOSITORY : GITHUB_REQUESTS_PER_REPOSITORY - 1;
  const requiredRequests = discovered.length * requestsPerRepository * maxAttempts;
  if (maxRequests < requiredRequests) {
    throw new RequestLimitError(`GitHub request budget ${maxRequests} requires at least ${requiredRequests} for ${discovered.length} repositories`);
  }
  const repos = [];
  const latestReleases = new Map();
  const seen = new Set();
  for (const [index, discoveredRepo] of discovered.entries()) {
    const slug = normalizeSlug(discoveredRepo?.slug ?? "");
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate discovered repository: ${slug}`);
    seen.add(key);
    try {
      const facts = await fetchRepositoryFacts(slug, {
        client,
        source: discoveredRepo,
        displayRank: index + 1,
        includeReadmeBody,
      });
      if (includeLatestRelease) latestReleases.set(key, await fetchLatestRelease(slug, { client }));
      repos.push(facts);
    } catch (error) {
      if (error instanceof RequestLimitError || error instanceof RetryDelayError) throw error;
      throw new Error(`GitHub metadata unavailable for ${slug}`);
    }
  }
  Object.defineProperty(repos, "requestCount", { value: client.requestCount, enumerable: false });
  Object.defineProperty(repos, "latestReleases", { value: latestReleases, enumerable: false });
  return repos;
}

export function buildFrozenFactsEnvelope({
  context,
  inputSourceSha,
  productionManifestStatus,
  productionManifestSha256,
  repositories,
  readmes,
  trendingSourceSha256,
  budgetReceipt,
}) {
  validateRunContext(context);
  if (!/^[a-f0-9]{40}$/.test(inputSourceSha ?? "")) throw new Error("Frozen facts source SHA is invalid");
  if (!["verified_v0", "verified_v1", "verified_404"].includes(productionManifestStatus)
      || (productionManifestStatus === "verified_404"
        ? productionManifestSha256 !== null
        : !/^[a-f0-9]{64}$/.test(productionManifestSha256 ?? ""))) {
    throw new Error("Frozen production manifest evidence is invalid");
  }
  if (!Array.isArray(repositories) || repositories.length < 10 || repositories.length > 75) {
    throw new Error("Frozen facts require 10-75 repositories");
  }
  if (!readmes || Array.isArray(readmes) || typeof readmes !== "object") throw new Error("Frozen README set is invalid");
  if (!trendingSourceSha256 || Object.keys(trendingSourceSha256).sort().join("\0") !== Object.keys(PERIODS).sort().join("\0")
      || Object.values(trendingSourceSha256).some(value => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Frozen Trending source hashes are invalid");
  }
  if (!budgetReceipt || Object.keys(budgetReceipt).sort().join("\0") !== ["eventDeadlineEpochMs", "httpAttempts", "logicalRequests", "originEpochMs"].sort().join("\0")
      || Object.values(budgetReceipt).some(value => !Number.isSafeInteger(value) || value < 0)
      || budgetReceipt.eventDeadlineEpochMs !== budgetReceipt.originEpochMs + 15 * 60_000) {
    throw new Error("Frozen facts budget receipt is invalid");
  }
  const activeSlugs = [];
  const seen = new Set();
  for (const repository of repositories) {
    const slug = normalizeSlug(repository?.slug ?? "");
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error("Frozen facts contain a duplicate repository");
    seen.add(key);
    activeSlugs.push(key);
    const readme = readmes[key];
    if (!readme || Array.isArray(readme) || typeof readme !== "object"
        || Object.keys(readme).sort().join("\0") !== ["blobSha", "contentSha256", "markdown", "path"].sort().join("\0")) {
      throw new Error("Frozen README set does not match active repositories");
    }
    const absent = repository.readme_status === "absent";
    if (absent) {
      if (readme.path !== null || readme.blobSha !== null || readme.contentSha256 !== null || readme.markdown !== null) {
        throw new Error("Frozen README absence identity is invalid");
      }
    } else if (repository.readme_status !== "present"
        || readme.path !== repository.readme_path
        || readme.blobSha !== repository.readme_blob_sha
        || readme.contentSha256 !== repository.readme_content_sha256
        || typeof readme.markdown !== "string"
        || sha256(Buffer.from(readme.markdown, "utf8")) !== readme.contentSha256) {
      throw new Error("Frozen README identity does not match canonical facts");
    }
  }
  if (Object.keys(readmes).length !== seen.size || Object.keys(readmes).some(slug => !seen.has(slug))) {
    throw new Error("Frozen README set does not match active repositories");
  }
  activeSlugs.sort();
  const runContextSha256 = canonicalHash(context);
  const sourceSetSha256 = canonicalHash({
    input_source_sha: inputSourceSha,
    production_manifest_status: productionManifestStatus,
    production_manifest_sha256: productionManifestSha256,
    run_context_sha256: runContextSha256,
    trending_source_sha256: trendingSourceSha256,
  });
  return {
    version: 1,
    snapshotId: context.snapshotId,
    observedAtUtc: context.observedAtUtc,
    observedAtKst: context.observedAtKst,
    statsDate: context.statsDateKst,
    parentSnapshotId: context.parentSnapshotId,
    inputSourceSha,
    productionManifestStatus,
    productionManifestSha256,
    runContextSha256,
    trendingSourceSha256: { ...trendingSourceSha256 },
    sourceSetSha256,
    activeSetSha256: canonicalHash(activeSlugs),
    factsSha256: canonicalHash({
      snapshot_id: context.snapshotId,
      input_source_sha: inputSourceSha,
      repositories,
    }),
    repositories,
    readmes,
    budgetReceipt: { ...budgetReceipt },
  };
}

// The transactional workflow uses this boundary after canonical facts and
// before paid LLM enrichment. Keeping it separate from the legacy page updater
// keeps the existing local/check command side-effect free until Task 6 owns
// candidate promotion wiring.
export async function collectTrendingFactsAndEvents(discovered, {
  factOptions = {},
  eventOptions = {},
  collectionContext,
} = {}) {
  if (!isEventCollectionContext(collectionContext)) throw new Error("An immutable event collection context is required");
  if (["maxRequests", "maxAttempts", "maxRetryDelay"].some(key => Number.isFinite(factOptions[key]))) {
    throw new Error("Transactional fact collection rejects numeric overrides");
  }
  const facts = await enrichTrendingRepositories(discovered, { ...factOptions, collectionBudget: collectionContext.budget });
  const events = await collectRepositoryEvents(facts, { ...eventOptions, collectionContext });
  return { facts, events };
}

export function buildTrendNote(repo) {
  const gains = [
    ["일간", repo.gain_daily],
    ["주간", repo.gain_weekly],
    ["월간", repo.gain_monthly],
  ].filter(([, value]) => Number.isInteger(value));
  const movement = gains
    .map(([label, value]) => `${label} +${value.toLocaleString("ko-KR")}`)
    .join(" · ");
  return [movement, repo.membership_status === "reentered" ? "재진입" : null]
    .filter(Boolean)
    .join(" · ");
}

function validDetailedContent(value) {
  return value && !Array.isArray(value) && typeof value === "object"
    && Object.keys(value).length === SUMMARY_FIELDS.length
    && SUMMARY_FIELDS.every(field => typeof value[field] === "string" && value[field].trim());
}

function exactObjectKeys(value, keys) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function frozenSourceMatchesFact(source, fact) {
  if (!source || Array.isArray(source) || typeof source !== "object"
      || source.model !== ENRICHMENT_MODEL || source.schema_version !== ENRICHMENT_SCHEMA_VERSION
      || source.slug !== fact.slug.toLowerCase() || typeof source.translation_applicable !== "boolean") return false;
  if (fact.readme_status === "present") {
    return exactObjectKeys(source, ["kind", "slug", "path", "blob_sha", "content_sha256", "model", "schema_version", "translation_applicable"])
      && source.kind === "readme" && source.path === fact.readme_path
      && source.blob_sha === fact.readme_blob_sha && source.content_sha256 === fact.readme_content_sha256;
  }
  if (fact.readme_status !== "absent" || source.translation_applicable !== false
      || !exactObjectKeys(source, ["kind", "slug", "profile_sha256", "model", "schema_version", "translation_applicable"])) return false;
  const profile = {
    slug: fact.slug.toLowerCase(),
    display_slug: fact.display_slug.replace(/\s*\/\s*/g, "/"),
    description: fact.description,
    primary_language: fact.primary_language,
    topics: fact.topics,
    license_spdx: fact.license_spdx,
    archived: fact.archived,
    is_fork: fact.is_fork,
    default_branch: fact.default_branch,
    created_at: fact.created_at,
    field_tags: fact.field_tags,
    form_tags: fact.form_tags,
    tag_rule_version: fact.tag_rule_version,
  };
  return source.kind === "metadata_only" && source.profile_sha256 === hashCanonicalJson(profile);
}

function reusableSummaryEntry(value, fact) {
  const source = value?.source;
  if (!validDetailedContent(value?.content) || !source || Array.isArray(source) || typeof source !== "object") return false;
  if (source.kind !== undefined) return frozenSourceMatchesFact(source, fact);
  return source
    && source.blob_sha === fact.readme_blob_sha
    && source.content_sha256 === fact.readme_content_sha256
    && source.model === ENRICHMENT_MODEL
    && source.schema_version === ENRICHMENT_SCHEMA_VERSION;
}

function renderRepositoryFacts(facts, summaryCache, context, latestReleases) {
  const { snapshotId, observedAtUtc: generatedAt, statsDateKst: statsDate } = context;
  const summaries = new Map(Object.entries(summaryCache).map(([slug, value]) => [slug.toLowerCase(), value]));
  return facts.map(fact => {
    const gains = Object.fromEntries(["daily", "weekly", "monthly"]
      .map(period => [`stars_${period}`, fact[`gain_${period}`]])
      .filter(([, value]) => value !== null));
    const cached = summaries.get(fact.slug.toLowerCase());
    const fallback = koreanFallback(
      { slug: fact.slug, ...gains, membership_status: fact.membership_status },
      { description: fact.description, language: fact.primary_language },
      "",
    );
    const content = reusableSummaryEntry(cached, fact) ? cached.content : fallback.detail;
    const starsNote = buildTrendNote(fact);
    return {
      slug: fact.slug,
      latest_release: latestReleases.get(fact.slug.toLowerCase()) ?? null,
      name: fact.display_slug,
      desc: fact.description ?? "",
      lang: fact.primary_language ?? "",
      topics: fact.topics,
      rank_daily: fact.rank_daily,
      rank_weekly: fact.rank_weekly,
      rank_monthly: fact.rank_monthly,
      tag_rule_version: fact.tag_rule_version,
      field_tags: [...fact.field_tags],
      form_tags: [...fact.form_tags],
      stars: fact.stars,
      forks: fact.forks,
      ...gains,
      color: fact.language_color ?? "#8b949e",
      summary: Object.fromEntries(SUMMARY_FIELDS.map(field => [field, content[field]])),
      detail: { ...Object.fromEntries(SUMMARY_FIELDS.map(field => [field, content[field]])), stars_note: starsNote },
      issues: fact.open_issues_and_pull_requests,
      contributors: fact.contributors,
      pushed_at: fact.pushed_at?.slice(0, 10) ?? null,
      _snapshot_id: snapshotId,
      _generated_at: generatedAt,
      _stats_date: statsDate,
    };
  });
}

const REPOS_START = "// GENERATED:TRENDING-REPOS:START";
const REPOS_END = "// GENERATED:TRENDING-REPOS:END";
const DATE_START = "<!-- GENERATED:TRENDING-DATE:START -->";
const DATE_END = "<!-- GENERATED:TRENDING-DATE:END -->";

function assertValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  const date = match && new Date(`${value}T00:00:00Z`);
  if (
    !match
    || Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error("statsDate must be a valid YYYY-MM-DD date");
  }
}

function markedRegion(value, start, end, name) {
  const starts = value.split(start).length - 1;
  const ends = value.split(end).length - 1;
  if (starts !== 1 || ends !== 1) throw new Error(`Expected exactly one ${name} marker pair`);
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  if (to < from) throw new Error(`Invalid ${name} marker order`);
  return { from, to: to + end.length, bodyFrom: from + start.length, bodyTo: to };
}

function replaceMarkedRegion(value, start, end, name, body) {
  const region = markedRegion(value, start, end, name);
  return `${value.slice(0, region.bodyFrom)}\n${body}\n${value.slice(region.bodyTo)}`;
}

export function parsePageRepos(page) {
  const region = markedRegion(page, REPOS_START, REPOS_END, "REPOS");
  const body = page.slice(region.bodyFrom, region.bodyTo).trim();
  const match = /^const REPOS = (\[[\s\S]*\]);$/.exec(body);
  if (!match) throw new Error("Generated REPOS region is malformed");
  const repos = JSON.parse(match[1]);
  if (!Array.isArray(repos)) throw new Error("Generated REPOS value must be an array");
  return repos;
}

function pageRunIdentity(repos) {
  const first = repos[0];
  const snapshotId = first?._snapshot_id;
  const generatedAt = first?._generated_at;
  const statsDate = first?._stats_date;
  if (
    typeof snapshotId !== "string"
    || !/^\d{14}-[a-f0-9]{16}$/.test(snapshotId)
    || typeof generatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generatedAt)
    || new Date(generatedAt).toISOString() !== generatedAt
    || snapshotId.slice(0, 14) !== generatedAt.replace(/\D/g, "").slice(0, 14)
  ) {
    throw new Error("Published repositories must share a valid run context identity");
  }
  return { snapshotId, generatedAt, statsDate };
}

function assertCompleteSummary(repo, { snapshotId, generatedAt, statsDate }) {
  const slug = normalizeSlug(repo?.slug ?? "");
  if (repo.slug !== slug) throw new Error(`Published ${slug} must use a normalized slug`);
  if (
    repo._snapshot_id !== snapshotId
    || repo._generated_at !== generatedAt
    || repo._stats_date !== statsDate
  ) throw new Error(`Published ${slug} has the wrong run context identity`);
  const counts = [repo?.stars, repo?.forks, repo?.issues, repo?.contributors];
  if (
    typeof repo?.name !== "string"
    || !repo.name.trim()
    || typeof repo.desc !== "string"
    || typeof repo.lang !== "string"
    || !Array.isArray(repo.topics)
    || repo.topics.some(topic => typeof topic !== "string" || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic))
    || typeof repo.color !== "string"
    || !/^#[0-9a-f]{6}$/i.test(repo.color)
    || counts.some(value => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error(`Published ${slug} must have a valid UI schema`);
  }
  const gains = Object.values(PERIODS)
    .map(({ field }) => repo[field])
    .filter(value => value !== undefined);
  if (!gains.length || gains.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Published ${slug} must have at least one valid period gain`);
  }
  const complete = [
    ...SUMMARY_FIELDS.map(field => repo?.summary?.[field]),
    ...SUMMARY_FIELDS.map(field => repo?.detail?.[field]),
    repo?.detail?.stars_note,
  ].every(value => typeof value === "string" && value.trim());
  if (!complete) throw new Error(`Published ${slug} must have a complete summary and detail`);
  return slug;
}

function assertUniqueCacheKeys(cache) {
  const seen = new Set();
  for (const slug of Object.keys(cache)) {
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate summary cache key: ${slug}`);
    seen.add(key);
  }
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function validateSnapshotPair(page, summaryCacheText, statsDate) {
  assertValidDate(statsDate);
  const repos = parsePageRepos(page);
  if (repos.length < 10 || repos.length > 75) throw new Error("Final snapshot must contain 10-75 repositories");
  const identity = pageRunIdentity(repos);
  if (identity.statsDate !== statsDate) throw new Error("Published repositories have the wrong stats date");
  const cache = JSON.parse(summaryCacheText);
  if (!cache || Array.isArray(cache) || typeof cache !== "object") throw new Error("Summary cache must be an object");
  assertUniqueCacheKeys(cache);
  const cachedBySlug = new Map(Object.entries(cache).map(([slug, value]) => [slug.toLowerCase(), value]));
  const seen = new Set();
  for (const repo of repos) {
    const slug = assertCompleteSummary(repo, identity);
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate published repository: ${slug}`);
    seen.add(key);
    const cached = cachedBySlug.get(key);
    const detail = Object.fromEntries(SUMMARY_FIELDS.map(field => [field, repo.detail[field]]));
    if (!cached || JSON.stringify(cached.content) !== JSON.stringify(detail) || !cached.source || typeof cached.source !== "object") {
      throw new Error(`Summary cache does not match published ${slug}`);
    }
  }
  const dateRegion = markedRegion(page, DATE_START, DATE_END, "date");
  const dateBody = page.slice(dateRegion.bodyFrom, dateRegion.bodyTo).trim();
  if (dateBody !== `<time id="lastUpdated" datetime="${statsDate}">${statsDate} (Asia/Seoul)</time>`) {
    throw new Error("Generated update date is malformed");
  }
  return repos;
}

export function createPageSnapshot({ page, summaryCache, repos, statsDate }) {
  if (typeof page !== "string" || !Array.isArray(repos)) throw new Error("Page and repositories are required");
  if (repos.length < 10 || repos.length > 75) throw new Error("Final snapshot must contain 10-75 repositories");
  assertValidDate(statsDate);
  if (!summaryCache || Array.isArray(summaryCache) || typeof summaryCache !== "object") {
    throw new Error("Summary cache must be an object");
  }
  assertUniqueCacheKeys(summaryCache);

  const nextCache = { ...summaryCache };
  const cacheKeys = new Map(Object.keys(nextCache).map(slug => [slug.toLowerCase(), slug]));
  const identity = pageRunIdentity(repos);
  if (identity.statsDate !== statsDate) throw new Error("Published repositories have the wrong stats date");
  const seen = new Set();
  for (const repo of repos) {
    const slug = assertCompleteSummary(repo, identity);
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate published repository: ${slug}`);
    seen.add(key);
    const cacheKey = cacheKeys.get(key) ?? slug;
    const source = nextCache[cacheKey]?.source ?? {
      blob_sha: null,
      content_sha256: null,
      model: null,
      schema_version: ENRICHMENT_SCHEMA_VERSION,
      translation_applicable: null,
    };
    nextCache[cacheKey] = {
      content: Object.fromEntries(SUMMARY_FIELDS.map(field => [field, repo.detail[field]])),
      source,
    };
    cacheKeys.set(key, cacheKey);
  }

  let nextPage = replaceMarkedRegion(page, REPOS_START, REPOS_END, "REPOS", `const REPOS = ${inlineJson(repos)};`);
  nextPage = replaceMarkedRegion(
    nextPage,
    DATE_START,
    DATE_END,
    "date",
    `<time id="lastUpdated" datetime="${statsDate}">${statsDate} (Asia/Seoul)</time>`,
  );
  const summaryCacheText = `${JSON.stringify(nextCache, null, 2)}\n`;
  validateSnapshotPair(nextPage, summaryCacheText, statsDate);
  return { page: nextPage, summaryCacheText };
}

async function cleanup(paths) {
  await Promise.all(paths.map(path => rm(path, { force: true }).catch(() => {})));
}

export async function installPageSnapshot({
  pagePath,
  cachePath,
  page,
  summaryCacheText,
  renameImpl = rename,
}) {
  const originals = await Promise.all([readFile(pagePath), readFile(cachePath)]);
  if (originals[0].equals(Buffer.from(page)) && originals[1].equals(Buffer.from(summaryCacheText))) return false;

  const suffix = `${process.pid}-${randomUUID()}`;
  const pagePending = `${pagePath}.pending-${suffix}`;
  const cachePending = `${cachePath}.pending-${suffix}`;
  const pageBackup = `${pagePath}.backup-${suffix}`;
  const cacheBackup = `${cachePath}.backup-${suffix}`;
  const temporary = [pagePending, cachePending, pageBackup, cacheBackup];
  let pageBacked = false;
  let cacheBacked = false;
  let pageInstalled = false;
  let cacheInstalled = false;

  try {
    await Promise.all([
      writeFile(pagePending, page),
      writeFile(cachePending, summaryCacheText),
    ]);
    const prepared = await Promise.all([readFile(pagePending, "utf8"), readFile(cachePending, "utf8")]);
    const statsDate = parsePageRepos(prepared[0])[0]?._stats_date;
    validateSnapshotPair(prepared[0], prepared[1], statsDate);

    await renameImpl(pagePath, pageBackup);
    pageBacked = true;
    await renameImpl(cachePath, cacheBackup);
    cacheBacked = true;
    await renameImpl(pagePending, pagePath);
    pageInstalled = true;
    await renameImpl(cachePending, cachePath);
    cacheInstalled = true;
    await cleanup([pageBackup, cacheBackup]);
    return true;
  } catch (error) {
    const rollbackErrors = [];
    if (pageInstalled) await rm(pagePath, { force: true }).catch(rollbackError => rollbackErrors.push(rollbackError));
    if (cacheInstalled) await rm(cachePath, { force: true }).catch(rollbackError => rollbackErrors.push(rollbackError));
    if (pageBacked) await rename(pageBackup, pagePath).catch(rollbackError => rollbackErrors.push(rollbackError));
    if (cacheBacked) await rename(cacheBackup, cachePath).catch(rollbackError => rollbackErrors.push(rollbackError));
    await cleanup(temporary);
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Snapshot installation and rollback failed");
    throw error;
  }
}

async function fetchTrendingPage(period, { fetchImpl, sleep, maxAttempts = 3, maxRetryDelay = 300000, collectionBudget = null }) {
  const url = `https://github.com/trending?since=${period}`;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("maxAttempts must be between 1 and 3");
  collectionBudget?.admitLogical();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    collectionBudget?.admitAttempt();
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (!isTimeout(error) || attempt + 1 >= maxAttempts) throw new Error(`Trending request failed for ${period}`);
      const delay = collectionBudget ? [2000, 8000][attempt] : boundedDelay([2000, 8000][attempt], maxRetryDelay);
      collectionBudget?.admitSleep(delay);
      await sleep(delay);
      continue;
    }
    if (response.ok) return response.text();
    if (!shouldRetry(response) || attempt + 1 >= maxAttempts) {
      throw new Error(`Trending request returned ${response.status} for ${period}`);
    }
    const delay = collectionBudget ? [2000, 8000][attempt] : retryDelay(response, attempt, maxRetryDelay);
    collectionBudget?.admitSleep(delay);
    await sleep(delay);
  }
  throw new Error(`Trending request failed for ${period}`);
}

function repositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function assertTempOutput(target, label) {
  if (typeof target !== "string" || !target) throw new Error(`${label} path is required`);
  const resolved = path.resolve(target);
  const relative = path.relative(repositoryRoot(), resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the tracked checkout`);
  }
  return resolved;
}

async function writeNewJson(target, value) {
  const resolved = assertTempOutput(target, "Frozen facts output");
  try {
    await readFile(resolved);
    throw new Error("Frozen facts output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const pending = `${resolved}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(pending, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(pending, resolved);
  } finally {
    await rm(pending, { force: true });
  }
}

export async function collectFrozenFacts({
  factsOut,
  budgetStatePath,
  context,
  inputSourceSha,
  productionManifestStatus,
  productionManifestSha256,
  eventOriginEpochMs,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  token = "",
  now = Date.now,
} = {}) {
  validateRunContext(context);
  const outputPath = assertTempOutput(factsOut, "Frozen facts output");
  const statePath = assertTempOutput(budgetStatePath, "Event budget state");
  if (outputPath === statePath) throw new Error("Frozen facts and event budget paths must not alias");
  const collectionContext = createPersistentEventCollectionContext({
    statePath,
    originEpochMs: eventOriginEpochMs,
    now,
    create: true,
  });
  const sourceBodies = {};
  const periods = {};
  for (const period of Object.keys(PERIODS)) {
    const html = await fetchTrendingPage(period, {
      fetchImpl,
      sleep,
      collectionBudget: collectionContext.budget,
    });
    sourceBodies[period] = html;
    periods[period] = parseTrendingHtml(html, period);
  }
  const discovered = mergeTrendingPeriods(periods);
  const collected = await enrichTrendingRepositories(discovered, {
    fetchImpl,
    sleep,
    token,
    collectionBudget: collectionContext.budget,
    includeLatestRelease: false,
    includeReadmeBody: true,
  });
  const readmes = {};
  const repositories = collected.map(value => {
    const { readme_markdown: markdown, ...repository } = value;
    readmes[repository.slug.toLowerCase()] = {
      path: repository.readme_path,
      blobSha: repository.readme_blob_sha,
      contentSha256: repository.readme_content_sha256,
      markdown: markdown ?? null,
    };
    return repository;
  });
  const payload = buildFrozenFactsEnvelope({
    context,
    inputSourceSha,
    productionManifestStatus,
    productionManifestSha256,
    repositories,
    readmes,
    trendingSourceSha256: Object.fromEntries(Object.entries(sourceBodies)
      .map(([period, html]) => [period, sha256(Buffer.from(html, "utf8"))])),
    budgetReceipt: collectionContext.budget.receipt(),
  });
  await writeNewJson(outputPath, payload);
  return payload;
}

function validateFrozenRenderEvents(facts, events) {
  const bindingKeys = new Set(["version", "snapshotId", "activeSetSha256", "factsSha256", "completeSetSha256"]);
  const contentKeys = ["heads", "releases", "latestReleaseIds", "commits", "estimates", "budgetReceipt"];
  if (!events || Array.isArray(events) || typeof events !== "object" || events.version !== 1
      || events.snapshotId !== facts.snapshotId || events.activeSetSha256 !== facts.activeSetSha256
      || events.factsSha256 !== facts.factsSha256 || !/^[a-f0-9]{64}$/.test(events.completeSetSha256 ?? "")
      || contentKeys.some(key => !Object.hasOwn(events, key))
      || Object.keys(events).some(key => !bindingKeys.has(key) && !contentKeys.includes(key))) {
    throw new Error("Frozen render event binding is invalid");
  }
  const content = Object.fromEntries(Object.entries(events).filter(([key]) => !bindingKeys.has(key)));
  if (hashCanonicalJson(content) !== events.completeSetSha256) throw new Error("Frozen render event hash is invalid");
  return events;
}

function validateFrozenEnrichmentIndex(facts, events, index) {
  const expectedKeys = ["version", "snapshotId", "activeSetSha256", "factsSha256", "eventsSha256", "repositories"];
  if (!index || Array.isArray(index) || typeof index !== "object"
      || Object.keys(index).sort().join("\0") !== expectedKeys.sort().join("\0") || index.version !== 1
      || index.snapshotId !== facts.snapshotId || index.activeSetSha256 !== facts.activeSetSha256
      || index.factsSha256 !== facts.factsSha256 || index.eventsSha256 !== events.completeSetSha256
      || !index.repositories || Array.isArray(index.repositories) || typeof index.repositories !== "object") {
    throw new Error("Frozen render enrichment binding is invalid");
  }
  const slugs = facts.repositories.map(repository => repository.slug.toLowerCase());
  if (Object.keys(index.repositories).length !== slugs.length || slugs.some(slug => !Object.hasOwn(index.repositories, slug))) {
    throw new Error("Frozen render enrichment active set is incomplete");
  }
  for (const [position, slug] of slugs.entries()) {
    const entry = index.repositories[slug];
    if (!entry || Array.isArray(entry) || typeof entry !== "object" || !["summary", "summary\0translation"].includes(Object.keys(entry).sort().join("\0"))
        || !reusableSummaryEntry(entry.summary, facts.repositories[position])) {
      throw new Error("Frozen render detailed summary is invalid");
    }
    const source = entry.summary.source;
    if (source.translation_applicable) {
      if (!entry.translation || Array.isArray(entry.translation) || typeof entry.translation !== "object"
          || !exactObjectKeys(entry.translation, ["markdown", "source"])
          || typeof entry.translation.markdown !== "string" || !entry.translation.markdown.trim()
          || JSON.stringify(entry.translation.source) !== JSON.stringify(source)) {
        throw new Error("Frozen render translation identity is invalid");
      }
    } else if (Object.hasOwn(entry, "translation")) {
      throw new Error("Frozen render translation is not applicable");
    }
  }
  return index;
}

function latestReleaseDates(facts, events) {
  const releases = new Map();
  for (const release of events.releases) {
    const slug = normalizeSlug(release?.slug ?? "").toLowerCase();
    if (!Number.isSafeInteger(release.release_id) || release.release_id < 1
        || (release.published_at !== null && (typeof release.published_at !== "string" || Number.isNaN(new Date(release.published_at).getTime())))) {
      throw new Error("Frozen render release identity is invalid");
    }
    const key = `${slug}\0${release.release_id}`;
    if (releases.has(key)) throw new Error("Frozen render release identity is duplicated");
    releases.set(key, release);
  }
  const result = new Map();
  const expected = facts.repositories.map(repository => repository.slug.toLowerCase());
  if (!events.latestReleaseIds || Array.isArray(events.latestReleaseIds) || typeof events.latestReleaseIds !== "object"
      || Object.keys(events.latestReleaseIds).length !== expected.length || expected.some(slug => !Object.hasOwn(events.latestReleaseIds, slug))) {
    throw new Error("Frozen render latest release set is incomplete");
  }
  for (const slug of expected) {
    const id = events.latestReleaseIds[slug];
    if (id === null) result.set(slug, null);
    else {
      const release = releases.get(`${slug}\0${id}`);
      if (!release) throw new Error("Frozen render latest release is absent from inventory");
      result.set(slug, release.published_at?.slice(0, 10) ?? null);
    }
  }
  return result;
}

export async function renderFrozenCandidate({
  factsPath,
  eventsPath,
  enrichmentIndexPath,
  pageTemplatePath,
  pageOut,
  cacheOut,
  snapshotOut,
} = {}) {
  const outputs = [
    assertTempOutput(pageOut, "Rendered page output"),
    assertTempOutput(cacheOut, "Rendered cache output"),
    assertTempOutput(snapshotOut, "Recorder snapshot output"),
  ];
  if (new Set(outputs).size !== outputs.length) throw new Error("Frozen render outputs must not alias");
  if (outputs.some(target => target === path.resolve(factsPath ?? "") || target === path.resolve(eventsPath ?? "") || target === path.resolve(enrichmentIndexPath ?? "") || target === path.resolve(pageTemplatePath ?? ""))) {
    throw new Error("Frozen render input and output paths must not alias");
  }
  const [factsBytes, eventsBytes, indexBytes, template] = await Promise.all([
    readFile(factsPath), readFile(eventsPath), readFile(enrichmentIndexPath), readFile(pageTemplatePath, "utf8"),
  ]);
  const facts = validateFrozenFactsPayload(parseJsonStrict(factsBytes, "frozen facts", 64 * 1024 * 1024));
  const events = validateFrozenRenderEvents(facts, parseJsonStrict(eventsBytes, "frozen events", 64 * 1024 * 1024));
  const index = validateFrozenEnrichmentIndex(facts, events, parseJsonStrict(indexBytes, "enrichment index", 64 * 1024 * 1024));
  const context = validateRunContext({
    observedAtUtc: facts.observedAtUtc,
    observedAtKst: facts.observedAtKst,
    statsDateKst: facts.statsDate,
    snapshotId: facts.snapshotId,
    parentSnapshotId: facts.parentSnapshotId,
    parentSourceSha: facts.parentSnapshotId === null ? null : facts.inputSourceSha,
  });
  const summaryCache = Object.fromEntries(facts.repositories.map(repository => [
    repository.slug,
    index.repositories[repository.slug.toLowerCase()].summary,
  ]));
  const latestReleases = latestReleaseDates(facts, events);
  const published = renderRepositoryFacts(facts.repositories, summaryCache, context, latestReleases);
  const pageSnapshot = createPageSnapshot({
    page: template,
    summaryCache,
    repos: published,
    statsDate: facts.statsDate,
  });
  const enrichmentIndexSha256 = hashCanonicalJson(index);
  const runKind = facts.parentSnapshotId === null ? "migration_baseline" : "refresh";
  const recorderSnapshot = {
    snapshotId: facts.snapshotId,
    observedAtUtc: facts.observedAtUtc,
    observedAtKst: facts.observedAtKst,
    statsDate: facts.statsDate,
    runKind,
    parentSnapshotId: facts.parentSnapshotId,
    inputSourceSha: facts.inputSourceSha,
    inputManifestSha256: facts.productionManifestSha256,
    productionManifestStatus: facts.productionManifestStatus,
    activeSetSha256: facts.activeSetSha256,
    factsSha256: facts.factsSha256,
    eventsSha256: events.completeSetSha256,
    enrichmentIndexSha256,
    ...(facts.productionManifestStatus === "verified_404" ? {
      explicitBootstrapSourceSha: facts.inputSourceSha,
    } : {}),
    repositories: facts.repositories,
  };
  await Promise.all([mkdir(path.dirname(outputs[0]), { recursive: true }), mkdir(path.dirname(outputs[1]), { recursive: true })]);
  await Promise.all([writeFile(outputs[0], template, { flag: "wx" }), writeFile(outputs[1], "{}\n", { flag: "wx" })]);
  await installPageSnapshot({ pagePath: outputs[0], cachePath: outputs[1], ...pageSnapshot });
  await writeNewJson(outputs[2], recorderSnapshot);
  return { repositories: published.length, snapshotId: facts.snapshotId, recorderSnapshot };
}

export async function runTrendingUpdate({
  check = false,
  pagePath,
  cachePath,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  token = "",
  context,
} = {}) {
  if (!pagePath || !cachePath) throw new Error("pagePath and cachePath are required");
  validateRunContext(context);
  const [page, cacheText] = await Promise.all([readFile(pagePath, "utf8"), readFile(cachePath, "utf8")]);
  const summaryCache = JSON.parse(cacheText);
  const periods = Object.fromEntries(await Promise.all(Object.keys(PERIODS).map(async period => [
    period,
    parseTrendingHtml(await fetchTrendingPage(period, { fetchImpl, sleep }), period),
  ])));
  const discovered = mergeTrendingPeriods(periods);
  const statsDate = context.statsDateKst;
  const repos = await enrichTrendingRepositories(discovered, {
    fetchImpl,
    sleep,
    token,
  });
  const requestCount = repos.requestCount;
  const publishedRepos = renderRepositoryFacts(repos, summaryCache, context, repos.latestReleases);
  const snapshot = createPageSnapshot({ page, summaryCache, repos: publishedRepos, statsDate });
  const changed = page !== snapshot.page || cacheText !== snapshot.summaryCacheText;
  if (!check && changed) await installPageSnapshot({ pagePath, cachePath, ...snapshot });
  return { changed, repos, requestCount, statsDate, snapshotId: context.snapshotId };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes("--render-facts")) {
    const allowed = new Set(["--render-facts", "--events", "--enrichment-index", "--page-template", "--page-out", "--cache-out", "--snapshot-out"]);
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (!allowed.has(key) || !value || Object.hasOwn(values, key)) throw new Error("Invalid frozen render CLI arguments");
      values[key] = value;
    }
    if (Object.keys(values).length !== allowed.size) throw new Error("Invalid frozen render CLI arguments");
    const result = await renderFrozenCandidate({
      factsPath: values["--render-facts"],
      eventsPath: values["--events"],
      enrichmentIndexPath: values["--enrichment-index"],
      pageTemplatePath: values["--page-template"],
      pageOut: values["--page-out"],
      cacheOut: values["--cache-out"],
      snapshotOut: values["--snapshot-out"],
    });
    console.log(JSON.stringify({ snapshotId: result.snapshotId, repositories: result.repositories }));
  } else if (args.includes("--facts-out")) {
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (!["--facts-out", "--budget-state"].includes(key) || !value || Object.hasOwn(values, key)) {
        throw new Error("Usage: node scripts/update-trending.mjs --facts-out FILE --budget-state FILE");
      }
      values[key] = value;
    }
    if (Object.keys(values).length !== 2) throw new Error("Usage: node scripts/update-trending.mjs --facts-out FILE --budget-state FILE");
    const originText = process.env.EVENT_ORIGIN_EPOCH_MS ?? "";
    if (!/^[1-9]\d*$/.test(originText) || !Number.isSafeInteger(Number(originText))) throw new Error("Event origin is invalid");
    const numericOverrides = Object.keys(process.env).filter(name => /^EVENT_.*(?:CAP|LIMIT|TIMEOUT|DEADLINE|ATTEMPTS|RETRIES)$/i.test(name));
    if (numericOverrides.length) throw new Error("Event numeric overrides are forbidden");
    const result = await collectFrozenFacts({
      factsOut: values["--facts-out"],
      budgetStatePath: values["--budget-state"],
      context: readRunContext(process.env),
      inputSourceSha: process.env.INPUT_SOURCE_SHA ?? "",
      productionManifestStatus: process.env.PRODUCTION_MANIFEST_STATUS ?? "",
      productionManifestSha256: process.env.PRODUCTION_MANIFEST_STATUS === "verified_404"
        ? null
        : process.env.PRODUCTION_MANIFEST_SHA256 ?? "",
      eventOriginEpochMs: Number(originText),
      token: process.env.GITHUB_TOKEN ?? "",
    });
    console.log(JSON.stringify({ version: result.version, snapshotId: result.snapshotId, repositories: result.repositories.length, factsSha256: result.factsSha256 }));
  } else {
    if (args.some(arg => arg !== "--check") || args.filter(arg => arg === "--check").length > 1) {
      throw new Error("Usage: node scripts/update-trending.mjs [--check]");
    }
    const check = args.includes("--check");
    const result = await runTrendingUpdate({
      check,
      pagePath: fileURLToPath(new URL("../index.html", import.meta.url)),
      cachePath: fileURLToPath(new URL("../data/repo-summaries.json", import.meta.url)),
      token: process.env.GITHUB_TOKEN ?? "",
      context: readRunContext(process.env),
    });
    console.log(`${check ? "Validated" : result.changed ? "Updated" : "Unchanged"}: ${result.repos.length} repositories for ${result.statsDate} (Asia/Seoul)`);
  }

}
