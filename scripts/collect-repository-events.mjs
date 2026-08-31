import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJsonStrict } from "./build-pages-artifact.mjs";
import { inferReadmeLocale, isReadmeVariantSet } from "./readme-variants.mjs";

export const MAX_FROZEN_FACTS_BYTES = 320 * 1024 * 1024;

export const EVENT_LIMITS = Object.freeze({
  maxRepositories: 75,
  maxReleasePages: 20,
  maxCommitPages: 20,
  maxContinuityDiagnostics: 2,
  maxLogicalRequests: 3600,
  maxAttempts: 4500,
  requestTimeoutMs: 30_000,
  retryDelaysMs: Object.freeze([2000, 8000]),
  ossRetryDelaysMs: Object.freeze([2000, 8000, 30_000, 60_000]),
  eventAdmissionReserveMs: 5000,
  eventWindowMs: 15 * 60_000,
  maxOssBytes: 2 * 1024 * 1024,
  maxOssRows: 10_000,
  publicOssRows: 500,
});

const SHA = /^[a-f0-9]{40}$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const collectionContexts = new WeakSet();
const RETRYABLE_RESPONSE_BODY = Symbol("retryable-response-body");

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const hashCanonicalJson = value => createHash("sha256").update(stableJson(value)).digest("hex");
const canonicalHash = hashCanonicalJson;
const exactKeys = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const validTime = (value, nullable = false) => nullable && value === null || (typeof value === "string" && ISO.test(value) && new Date(value).toISOString() === value.replace(/Z$/, ".000Z"));
const normalizeSlug = slug => {
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new Error(`Invalid repository slug: ${slug}`);
  return slug;
};
const repoPath = slug => `/repos/${slug.split("/").map(encodeURIComponent).join("/")}`;
// Network/parser details can contain upstream bodies or credentials. Event
// errors deliberately keep only an allowlisted operation label and status.
const eventError = message => new Error(message);

function createEventBudget({ now = Date.now, originEpochMs, initialState = null, onUpdate = () => {} } = {}) {
  if (typeof now !== "function") throw new Error("Event clock must be a function");
  const origin = initialState?.originEpochMs ?? originEpochMs ?? now();
  if (!Number.isSafeInteger(origin)) throw new Error("Event origin must be an integer epoch");
  const deadline = origin + EVENT_LIMITS.eventWindowMs;
  let logical = initialState?.logicalRequests ?? 0;
  let attempts = initialState?.httpAttempts ?? 0;
  let lastNow = initialState?.lastObservedEpochMs ?? origin;
  if (![logical, attempts, lastNow].every(Number.isSafeInteger) || logical < 0 || attempts < 0 || lastNow < origin
      || initialState && initialState.eventDeadlineEpochMs !== deadline) {
    throw new Error("Persisted event budget is invalid");
  }
  const state = () => ({
    version: 1,
    originEpochMs: origin,
    eventDeadlineEpochMs: deadline,
    logicalRequests: logical,
    httpAttempts: attempts,
    lastObservedEpochMs: lastNow,
  });
  const persist = () => onUpdate(state());
  const remaining = () => {
    const current = now();
    if (!Number.isSafeInteger(current) || current < lastNow) throw new Error("Event clock regressed");
    lastNow = current;
    persist();
    return deadline - current;
  };
  return Object.freeze({
    admitLogical() {
      if (logical >= EVENT_LIMITS.maxLogicalRequests) throw new Error("Event logical request cap exceeded");
      logical += 1;
      persist();
    },
    admitAttempt() {
      if (attempts >= EVENT_LIMITS.maxAttempts) throw new Error("Event HTTP attempt cap exceeded");
      if (remaining() < EVENT_LIMITS.requestTimeoutMs + EVENT_LIMITS.eventAdmissionReserveMs) {
      throw new Error("Event deadline has insufficient request reserve");
      }
      attempts += 1;
      persist();
    },
    admitSleep(delay) {
      if (remaining() < delay + EVENT_LIMITS.requestTimeoutMs + EVENT_LIMITS.eventAdmissionReserveMs) {
        throw new Error("Event deadline has insufficient retry reserve");
      }
    },
    receipt() { return Object.freeze({ logicalRequests: logical, httpAttempts: attempts, originEpochMs: origin, eventDeadlineEpochMs: deadline }); },
  });
}

// The workflow creates this once before checkout. Task 1's canonical-fact
// client and this module both accept its `budget`; neither gets a mutable
// deadline or numeric cap override.
export function createEventCollectionContext({ originEpochMs, now = Date.now } = {}) {
  if (!Number.isSafeInteger(originEpochMs)) throw new Error("Event collection origin must be an integer epoch");
  const context = Object.freeze({ budget: createEventBudget({ originEpochMs, now }) });
  collectionContexts.add(context);
  return context;
}

export const isEventCollectionContext = value => collectionContexts.has(value);

function validateBudgetState(value) {
  if (!exactKeys(value, ["version", "originEpochMs", "eventDeadlineEpochMs", "logicalRequests", "httpAttempts", "lastObservedEpochMs"])
      || value.version !== 1
      || [value.originEpochMs, value.eventDeadlineEpochMs, value.logicalRequests, value.httpAttempts, value.lastObservedEpochMs]
        .some(number => !Number.isSafeInteger(number) || number < 0)
      || value.eventDeadlineEpochMs !== value.originEpochMs + EVENT_LIMITS.eventWindowMs
      || value.lastObservedEpochMs < value.originEpochMs
      || value.logicalRequests > EVENT_LIMITS.maxLogicalRequests
      || value.httpAttempts > EVENT_LIMITS.maxAttempts) {
    throw new Error("Persisted event budget is invalid");
  }
  return value;
}

function persistBudgetState(statePath, value) {
  const target = path.resolve(statePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const pending = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(pending, `${JSON.stringify(validateBudgetState(value))}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
}

export function createPersistentEventCollectionContext({ statePath, originEpochMs, now = Date.now, create = false } = {}) {
  if (typeof statePath !== "string" || !statePath) throw new Error("Persisted event budget path is required");
  const exists = existsSync(statePath);
  if (create === exists) throw new Error(create ? "Persisted event budget already exists" : "Persisted event budget is missing");
  let initialState = null;
  if (exists) {
    initialState = validateBudgetState(parseJsonStrict(readFileSync(statePath), "event budget state", 64 * 1024));
    if (originEpochMs !== undefined && originEpochMs !== initialState.originEpochMs) throw new Error("Persisted event budget origin changed");
  } else if (!Number.isSafeInteger(originEpochMs)) {
    throw new Error("Persisted event budget origin is required");
  }
  const budget = createEventBudget({
    now,
    originEpochMs,
    initialState,
    onUpdate: value => persistBudgetState(statePath, value),
  });
  if (!exists) persistBudgetState(statePath, {
    version: 1,
    originEpochMs,
    eventDeadlineEpochMs: originEpochMs + EVENT_LIMITS.eventWindowMs,
    logicalRequests: 0,
    httpAttempts: 0,
    lastObservedEpochMs: originEpochMs,
  });
  const context = Object.freeze({ budget });
  collectionContexts.add(context);
  return context;
}

function retryableStatus(status) { return status === 429 || status >= 500; }
function retryableError(error) { return error?.name === "AbortError" || error?.name === "TimeoutError"; }
function retryDelay(_response, attempt, retryDelaysMs) {
  return retryDelaysMs[attempt];
}

const STRONG_ETAG = /^"(?:[\x21\x23-\x7e\x80-\xff])*"$/;
const WEAK_ETAG = /^W\/"(?:[\x21\x23-\x7e\x80-\xff])*"$/;

const REQUEST_OPERATIONS = new Set([
  "release inventory", "release revalidation", "latest release", "commit inventory",
  "commit comparison", "branch continuity", "OSS star history",
]);

async function request(url, { fetchImpl, sleep, budget, operation, headers = {}, allow304 = false, readResponse = null, retryDelaysMs = EVENT_LIMITS.retryDelaysMs }) {
  if (!REQUEST_OPERATIONS.has(operation)) throw new Error("Event request operation is invalid");
  budget.admitLogical();
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    budget.admitAttempt();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers,
        signal: AbortSignal.timeout(EVENT_LIMITS.requestTimeoutMs),
      });
    } catch (error) {
      if (!retryableError(error) || attempt === retryDelaysMs.length) throw eventError(`Event ${operation} request failed`);
      const delay = retryDelaysMs[attempt];
      budget.admitSleep(delay);
      await sleep(delay);
      continue;
    }
    if (response.status === 304 && allow304) return readResponse ? readResponse(response) : response;
    if (!retryableStatus(response.status) || attempt === retryDelaysMs.length) {
      if (!readResponse) return response;
      try {
        return await readResponse(response);
      } catch (error) {
        if (!error?.[RETRYABLE_RESPONSE_BODY] || attempt === retryDelaysMs.length) throw error;
        const delay = retryDelaysMs[attempt];
        budget.admitSleep(delay);
        await sleep(delay);
        continue;
      }
    }
    const delay = retryDelay(response, attempt, retryDelaysMs);
    budget.admitSleep(delay);
    await sleep(delay);
  }
  throw new Error(`Event ${operation} request exhausted`);
}

async function json(response, label) {
  if (!response?.ok) throw new Error(`${label} returned ${response?.status}`);
  try {
    return await response.json();
  } catch {
    const error = new Error(`Invalid JSON for ${label}`);
    Object.defineProperty(error, RETRYABLE_RESPONSE_BODY, { value: true });
    throw error;
  }
}

function githubHtmlUrl(value, errorMessage, expectedPath) {
  let url;
  try { url = new URL(value); } catch { throw new Error(errorMessage); }
  const actualParts = url.pathname.split("/");
  const expectedPaths = Array.isArray(expectedPath) ? expectedPath : [expectedPath];
  const exactRepositoryPath = expectedPaths.some(pathname => {
    const expectedParts = pathname.split("/");
    return actualParts.length === expectedParts.length
      && actualParts.every((part, index) => (index === 1 || index === 2)
        ? part.toLowerCase() === expectedParts[index].toLowerCase()
        : part === expectedParts[index]);
  });
  if (typeof value !== "string" || !value.startsWith("https://github.com/")
      || url.protocol !== "https:" || url.hostname !== "github.com" || url.host !== "github.com"
      || url.username || url.password || url.port || url.search || url.hash
      || !exactRepositoryPath) throw new Error(errorMessage);
}

function releaseRecord(slug, value) {
  const canonicalSlug = normalizeSlug(slug).toLowerCase();
  const allowed = ["release_id", "tag_name", "name", "target_commitish", "draft", "prerelease", "created_at", "published_at", "html_url"];
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.id) || value.id < 1
    || ["tag_name", "target_commitish", "html_url"].some(key => typeof value[key] !== "string")
    || (value.name !== null && typeof value.name !== "string") || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean"
    || !validTime(value.created_at) || !validTime(value.published_at, true)) throw new Error(`Invalid release for ${slug}`);
  if (!value.tag_name || /[\u0000-\u001f\u007f]/.test(value.tag_name)) throw new Error(`Invalid release for ${slug}`);
  githubHtmlUrl(value.html_url, `Invalid release for ${slug}`, [
    `/${canonicalSlug}/releases/tag/${encodeURIComponent(value.tag_name)}`,
    `/${canonicalSlug}/releases/tag/${value.tag_name.split("/").map(encodeURIComponent).join("/")}`,
  ]);
  const record = {
    release_id: value.id,
    tag_name: value.tag_name,
    name: value.name,
    target_commitish: value.target_commitish,
    draft: value.draft,
    prerelease: value.prerelease,
    created_at: new Date(value.created_at).toISOString(),
    published_at: value.published_at === null ? null : new Date(value.published_at).toISOString(),
    html_url: value.html_url,
  };
  return { slug: canonicalSlug, ...Object.fromEntries(allowed.map(key => [key, record[key]])), metadata_sha256: canonicalHash({ slug: canonicalSlug, ...record }) };
}

function releaseNext(link, slug, page, itemCount) {
  if (link === null) return null;
  if (typeof link !== "string" || !link.trim()) throw new Error(`Invalid release Link for ${slug}`);
  const links = link.split(",").map(part => /^\s*<([^>]+)>\s*;\s*rel="([a-z]+)"\s*$/.exec(part));
  if (links.some(value => value === null)) throw new Error(`Invalid release Link for ${slug}`);
  const matches = links.filter(([, , rel]) => rel === "next");
  if (matches.length > 1) throw new Error(`Invalid release Link for ${slug}`);
  if (!matches.length) return null;
  let value;
  try { value = new URL(matches[0][1]); } catch { throw new Error(`Invalid release Link for ${slug}`); }
  const expected = repoPath(slug) + "/releases";
  const numericRepository = /^\/repositories\/[1-9]\d{0,19}\/releases$/.test(value.pathname);
  if (!matches[0][1].startsWith("https://api.github.com/")
    || value.protocol !== "https:" || value.hostname !== "api.github.com" || value.host !== "api.github.com"
    || value.pathname !== expected && !numericRepository || numericRepository && itemCount !== 100
    || value.port !== "" || value.hash
    || value.username || value.password
    || value.searchParams.getAll("per_page").join() !== "100" || value.searchParams.getAll("page").length !== 1
    || Number(value.searchParams.get("page")) !== page + 1 || [...value.searchParams.keys()].some(key => key !== "per_page" && key !== "page")) {
    throw new Error(`Invalid release Link for ${slug}`);
  }
  return value.href;
}

async function collectReleaseInventory(slug, context) {
  const pages = [];
  let url = `https://api.github.com${repoPath(slug)}/releases?per_page=100&page=1`;
  const seenIds = new Set();
  for (let page = 1; page <= EVENT_LIMITS.maxReleasePages; page += 1) {
    const { response, value } = await request(url, {
      ...context,
      operation: "release inventory",
      headers: context.githubHeaders,
      readResponse: async response => ({ response, value: await json(response, `release inventory for ${slug}`) }),
    });
    if (!Array.isArray(value)) throw new Error(`Invalid release inventory for ${slug}`);
    const next = releaseNext(response.headers.get("link"), slug, page, value.length);
    if (page === EVENT_LIMITS.maxReleasePages && next !== null) throw new Error(`Release page cap exceeded for ${slug}`);
    const records = value.map(entry => releaseRecord(slug, entry));
    if (page > 1 && records.length === 0) throw new Error(`Invalid release pagination for ${slug}`);
    for (const record of records) {
      if (seenIds.has(record.release_id)) throw new Error(`Duplicate release id for ${slug}`);
      seenIds.add(record.release_id);
    }
    const etag = response.headers.get("etag");
    if (etag !== null && !STRONG_ETAG.test(etag) && !WEAK_ETAG.test(etag)) throw new Error(`Invalid release ETag for ${slug}`);
    pages.push({ url, etag: etag !== null && STRONG_ETAG.test(etag) ? etag : null, canonicalBody: stableJson(records), next, records });
    if (next === null) break;
    url = next;
  }
  // A strong ETag must yield 304; otherwise exact canonical body and Link identity must match.
  for (const [index, first] of pages.entries()) {
    const headers = { ...context.githubHeaders, ...(first.etag ? { "If-None-Match": first.etag } : {}) };
    const { response, value } = await request(first.url, {
      ...context,
      operation: "release revalidation",
      headers,
      allow304: Boolean(first.etag),
      readResponse: async response => ({
        response,
        value: response.status === 304 ? null : await json(response, `release revalidation for ${slug}`),
      }),
    });
    if (first.etag && response.status !== 304) throw new Error(`Release ETag revalidation changed for ${slug} page ${index + 1}`);
    if (response.status === 304) continue;
    if (!Array.isArray(value)) throw new Error(`Release revalidation changed for ${slug} page ${index + 1}`);
    const next = releaseNext(response.headers.get("link"), slug, index + 1, value.length);
    const records = value.map(entry => releaseRecord(slug, entry));
    if (stableJson(records) !== first.canonicalBody || next !== first.next) throw new Error(`Release revalidation changed for ${slug} page ${index + 1}`);
  }
  return pages;
}

async function latestRelease(slug, inventory, context) {
  const url = `https://api.github.com${repoPath(slug)}/releases/latest`;
  const response = await request(url, { ...context, operation: "latest release", headers: context.githubHeaders });
  if (response.status === 404) return null;
  const record = releaseRecord(slug, await json(response, `latest release for ${slug}`));
  const existing = inventory.flatMap(page => page.records).find(value => value.release_id === record.release_id);
  if (!existing || existing.metadata_sha256 !== record.metadata_sha256) throw new Error(`Latest release is absent from complete inventory for ${slug}`);
  return record.release_id;
}

function priorFor(previous, slug) {
  if (!previous) return null;
  const raw = previous instanceof Map ? previous.get(slug.toLowerCase()) ?? previous.get(slug) : previous[slug] ?? previous[slug.toLowerCase()];
  if (!raw) return null;
  if (typeof raw.branch !== "string" || !SHA.test(raw.headSha ?? "")) throw new Error(`Invalid previous head for ${slug}`);
  return raw;
}

function commitRecord(slug, branch, value, ordinal) {
  const parents = value?.parents;
  const sha = value?.sha;
  if (!SHA.test(sha ?? "") || !Array.isArray(parents) || parents.some(parent => !SHA.test(parent?.sha ?? ""))
    || !validTime(value?.commit?.author?.date) || !validTime(value?.commit?.committer?.date)
    || (value.author !== null && (typeof value.author !== "object" || (value.author.login !== undefined && typeof value.author.login !== "string")))
    || typeof value.html_url !== "string") throw new Error(`Invalid commit for ${slug}`);
  githubHtmlUrl(value.html_url, `Invalid commit for ${slug}`, `/${normalizeSlug(slug).toLowerCase()}/commit/${sha}`);
  return { slug, sha, firstObservedOrdinal: ordinal, branch, authoredAt: value.commit.author.date, committedAt: value.commit.committer.date, authorLogin: value.author?.login ?? null, parentShas: parents.map(parent => parent.sha), htmlUrl: value.html_url };
}

async function diagnoseContinuity(slug, branch, priorHead, currentHead, context) {
  const base = `https://api.github.com${repoPath(slug)}`;
  const compare = await request(`${base}/compare/${priorHead}...${currentHead}`, { ...context, operation: "commit comparison", headers: context.githubHeaders });
  const result = await json(compare, `commit continuity for ${slug}`);
  if (!result || typeof result !== "object" || !["ahead", "behind", "diverged", "identical"].includes(result.status)) throw new Error(`Ambiguous commit continuity for ${slug}`);
  const ref = await request(`${base}/git/ref/heads/${encodeURIComponent(branch)}`, { ...context, operation: "branch continuity", headers: context.githubHeaders });
  const head = await json(ref, `branch continuity for ${slug}`);
  if (!head?.object || !SHA.test(head.object.sha ?? "") || head.object.sha !== currentHead) throw new Error(`Ambiguous commit continuity for ${slug}`);
  if (result.status === "behind" || result.status === "diverged") return "history_rewritten";
  throw new Error(`Commit continuity gap for ${slug}`);
}

async function collectCommits(repo, previous, context) {
  const slug = normalizeSlug(repo.slug);
  const branch = repo.default_branch;
  const headSha = repo.default_branch_head_sha;
  if (typeof branch !== "string" || !branch || !SHA.test(headSha ?? "")) throw new Error(`Invalid current head for ${slug}`);
  const prior = priorFor(previous, slug);
  if (!prior) return { head: { slug, branch, headSha, transition: "baseline" }, commits: [] };
  if (prior.branch !== branch) return { head: { slug, branch, headSha, transition: "branch_changed" }, commits: [] };
  if (prior.headSha === headSha) return { head: { slug, branch, headSha, transition: "unchanged" }, commits: [] };
  const records = [];
  const seen = new Set();
  let found = false;
  for (let page = 1; page <= EVENT_LIMITS.maxCommitPages && !found; page += 1) {
    const url = `https://api.github.com${repoPath(slug)}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`;
    const values = await json(await request(url, { ...context, operation: "commit inventory", headers: context.githubHeaders }), `commit inventory for ${slug}`);
    if (!Array.isArray(values)) throw new Error(`Invalid commit inventory for ${slug}`);
    if (page === 1 && !values.length) throw new Error(`Contradictory empty commit page for ${slug}`);
    for (const value of values) {
      const record = commitRecord(slug, branch, value, records.length + 1);
      // GitHub commit pages can overlap while a branch advances.  The current
      // candidate is deduplicated by SHA; absence of the prior head is still
      // diagnosed below, so overlap cannot make a gap look successful.
      if (seen.has(record.sha)) continue;
      if (page === 1 && seen.size === 0 && record.sha !== headSha) throw new Error(`Current HEAD changed during commit collection for ${slug}`);
      seen.add(record.sha);
      if (record.sha === prior.headSha) { found = true; break; }
      records.push(record);
    }
    if (!values.length) break;
  }
  if (!found) {
    const transition = await diagnoseContinuity(slug, branch, prior.headSha, headSha, context);
    return { head: { slug, branch, headSha, transition }, commits: [] };
  }
  return { head: { slug, branch, headSha, transition: "fast_forward" }, commits: records };
}

function ossInteger(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  throw new Error("Invalid OSS Insight stargazers");
}

export function validateOssInsightResponse(value) {
  if (!exactKeys(value, ["data", "type"]) || value.type !== "sql_endpoint" || !exactKeys(value.data, ["columns", "result", "rows"])) throw new Error("Invalid OSS Insight envelope");
  const { columns, result, rows } = value.data;
  const expectedColumns = [{ col: "date", data_type: "VARCHAR", nullable: true }, { col: "stargazers", data_type: "DECIMAL", nullable: true }];
  if (stableJson(columns) !== stableJson(expectedColumns) || !exactKeys(result, ["code", "message", "start_ms", "end_ms", "latency", "row_count", "row_affect", "limit"])
    || result.code !== 200 || typeof result.message !== "string" || !Number.isFinite(result.start_ms) || !Number.isFinite(result.end_ms) || result.start_ms < 0 || result.end_ms < result.start_ms || typeof result.latency !== "string"
    || !Array.isArray(rows) || result.row_count !== rows.length || result.row_affect !== 0 || !Number.isInteger(result.limit) || result.limit < rows.length || rows.length > EVENT_LIMITS.maxOssRows) throw new Error("Invalid OSS Insight envelope");
  let previousDate = "";
  const normalized = rows.map(row => {
    const date = typeof row?.date === "string" ? new Date(`${row.date}T00:00:00.000Z`) : null;
    if (!exactKeys(row, ["date", "stargazers"]) || !DATE.test(row.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== row.date) throw new Error("Invalid OSS Insight row");
    if (row.date <= previousDate) throw new Error("OSS Insight dates must be ascending unique");
    previousDate = row.date;
    return { date: row.date, stars: ossInteger(row.stargazers) };
  });
  return { rows: normalized, sourcePayloadSha256: canonicalHash(value), publicRows: normalized.slice(-EVENT_LIMITS.publicOssRows) };
}

async function collectOss(slug, context) {
  const [owner, name] = normalizeSlug(slug).split("/");
  const url = `https://api.ossinsight.io/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stargazers/history`;
  const response = await request(url, { ...context, operation: "OSS star history", headers: { Accept: "application/json" }, retryDelaysMs: EVENT_LIMITS.ossRetryDelaysMs });
  if (!response.ok) throw new Error(`OSS Insight returned ${response.status} for ${slug}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(contentType)) throw new Error(`Invalid OSS Insight content type for ${slug}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > EVENT_LIMITS.maxOssBytes) throw new Error(`OSS Insight body exceeds ${EVENT_LIMITS.maxOssBytes} bytes for ${slug}`);
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`Invalid OSS Insight JSON for ${slug}`); }
  return { slug, ...validateOssInsightResponse(parsed) };
}

export async function collectRepositoryEvents(repositories, {
  previous = {},
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  collectionContext = null,
  now = Date.now,
  originEpochMs,
  token = "",
} = {}) {
  if (!Array.isArray(repositories) || repositories.length < 1 || repositories.length > EVENT_LIMITS.maxRepositories) throw new Error(`Repository events require 1-${EVENT_LIMITS.maxRepositories} repositories`);
  if (typeof fetchImpl !== "function" || typeof sleep !== "function") throw new Error("fetchImpl and sleep must be functions");
  if (collectionContext !== null && (!isEventCollectionContext(collectionContext) || originEpochMs !== undefined || now !== Date.now)) {
    throw new Error("Event collection context rejects numeric or clock overrides");
  }
  const budget = collectionContext?.budget ?? createEventBudget({ now, originEpochMs });
  if (typeof token !== "string" || /[\r\n]/.test(token)) throw new Error("GitHub event token is invalid");
  const githubHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const context = { fetchImpl, sleep, budget, githubHeaders };
  const releases = [];
  const latestReleaseIds = {};
  const commits = [];
  const heads = [];
  const estimates = [];
  const seen = new Set();
  for (const repository of repositories) {
    const slug = normalizeSlug(repository?.slug);
    if (seen.has(slug.toLowerCase())) throw new Error(`Duplicate repository event input: ${slug}`);
    seen.add(slug.toLowerCase());
    const pages = await collectReleaseInventory(slug, context);
    const inventory = pages.flatMap(page => page.records);
    releases.push(...inventory);
    latestReleaseIds[slug.toLowerCase()] = await latestRelease(slug, pages, context);
    const commitEvents = await collectCommits(repository, previous, context);
    heads.push(commitEvents.head);
    commits.push(...commitEvents.commits);
    estimates.push(await collectOss(slug, context));
  }
  return Object.freeze({ releases: Object.freeze(releases), latestReleaseIds, commits: Object.freeze(commits), heads: Object.freeze(heads), estimates: Object.freeze(estimates), budgetReceipt: budget.receipt() });
}

export function validatePriorHeadsPayload(facts, payload, { parentEvidence, parentDatabasePath = null } = {}) {
  const keys = ["version", "snapshotId", "scope", "parentDatabaseSha256", "snapshotSeq", "headCount", "headsSha256", "heads"];
  if (!facts || !Array.isArray(facts.repositories) || !/^[a-f0-9]{40}$/.test(facts.hydrationSourceSha ?? "")
      || !payload || !exactKeys(payload, keys)
      || payload.version !== 1 || payload.snapshotId !== facts.parentSnapshotId || payload.scope !== "all_historical"
      || !payload.heads || Array.isArray(payload.heads) || typeof payload.heads !== "object") {
    throw new Error("Prior head payload is invalid");
  }
  const active = facts.repositories.map(repository => normalizeSlug(repository?.slug).toLowerCase());
  if (new Set(active).size !== active.length) throw new Error("Prior head payload has duplicate active repositories");
  const headKeys = Object.keys(payload.heads);
  if (payload.headCount !== headKeys.length || !Number.isSafeInteger(payload.headCount) || payload.headCount < 0
      || payload.headsSha256 !== canonicalHash(payload.heads)
      || headKeys.join("\0") !== [...headKeys].sort().join("\0")) {
    throw new Error("Prior head payload receipt is invalid");
  }
  if (!parentEvidence || !exactKeys(parentEvidence, ["version", "parent_database", "production_source_sha", "historical_heads", "legacy_baseline_receipt"])
      || parentEvidence.version !== 1 || !parentEvidence.legacy_baseline_receipt
      || Array.isArray(parentEvidence.legacy_baseline_receipt) || typeof parentEvidence.legacy_baseline_receipt !== "object"
      || parentEvidence.production_source_sha !== facts.hydrationSourceSha) {
    throw new Error("Prior head parent evidence is invalid");
  }
  const historicalEvidence = parentEvidence.historical_heads;
  if (!exactKeys(historicalEvidence, ["scope", "head_count", "heads_sha256"])
      || historicalEvidence.scope !== "all_historical"
      || historicalEvidence.head_count !== payload.headCount
      || historicalEvidence.heads_sha256 !== payload.headsSha256) {
    throw new Error("Prior head historical evidence is mismatched");
  }
  if (facts.parentSnapshotId === null) {
    if (payload.parentDatabaseSha256 !== null || payload.snapshotSeq !== null || headKeys.length !== 0) {
      throw new Error("Migration prior head payload is invalid");
    }
    if (!exactKeys(parentEvidence.parent_database, ["missing"]) || parentEvidence.parent_database.missing !== true
        || (parentDatabasePath !== null && existsSync(parentDatabasePath))) {
      throw new Error("Migration prior head parent evidence is invalid");
    }
  } else if (!/^[a-f0-9]{64}$/.test(payload.parentDatabaseSha256 ?? "")
      || !Number.isSafeInteger(payload.snapshotSeq) || payload.snapshotSeq < 1) {
    throw new Error("Refresh prior head provenance is invalid");
  } else {
    const databaseEvidence = parentEvidence.parent_database;
    if (!databaseEvidence || Array.isArray(databaseEvidence) || typeof databaseEvidence !== "object"
        || databaseEvidence.file_sha256 !== payload.parentDatabaseSha256
        || databaseEvidence.last_snapshot_seq !== payload.snapshotSeq
        || databaseEvidence.last_snapshot_id !== payload.snapshotId) {
      throw new Error("Refresh prior head parent evidence is mismatched");
    }
    if (parentDatabasePath !== null) {
      let actualSha256;
      try { actualSha256 = createHash("sha256").update(readFileSync(parentDatabasePath)).digest("hex"); } catch {
        throw new Error("Refresh prior head parent database is unavailable");
      }
      if (actualSha256 !== payload.parentDatabaseSha256) throw new Error("Refresh prior head parent database is mismatched");
    }
  }
  const historical = {};
  for (const slug of headKeys) {
    if (normalizeSlug(slug).toLowerCase() !== slug) throw new Error("Prior head identity is invalid");
    const value = payload.heads[slug];
    if (!exactKeys(value, ["branch", "headSha"]) || typeof value.branch !== "string" || !value.branch
        || /[\u0000-\u001f\u007f]/.test(value.branch) || !SHA.test(value.headSha ?? "")) {
      throw new Error("Refresh prior head is invalid");
    }
    historical[slug] = { branch: value.branch, headSha: value.headSha };
  }
  return Object.fromEntries(active.filter(slug => Object.hasOwn(historical, slug)).map(slug => [slug, historical[slug]]));
}

export function bindFrozenEventEnvelope(facts, collected) {
  if (!facts || facts.version !== 1 || !Array.isArray(facts.repositories)
      || !/^[0-9]{14}-[a-f0-9]{16}$/.test(facts.snapshotId ?? "")
      || !/^[a-f0-9]{40}$/.test(facts.inputSourceSha ?? "")
      || !/^[a-f0-9]{40}$/.test(facts.hydrationSourceSha ?? "")
      || !/^[a-f0-9]{64}$/.test(facts.activeSetSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(facts.sourceSetSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(facts.runContextSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(facts.factsSha256 ?? "")) {
    throw new Error("Frozen facts binding is invalid");
  }
  const slugs = facts.repositories.map(repository => normalizeSlug(repository?.slug).toLowerCase());
  if (new Set(slugs).size !== slugs.length
      || facts.activeSetSha256 !== canonicalHash([...slugs].sort())
      || facts.factsSha256 !== canonicalHash({
        snapshot_id: facts.snapshotId,
        input_source_sha: facts.inputSourceSha,
        repositories: facts.repositories,
      })) {
    throw new Error("Frozen facts hash binding is invalid");
  }
  if (!collected || !Array.isArray(collected.heads) || !Array.isArray(collected.releases)
      || !Array.isArray(collected.commits) || !Array.isArray(collected.estimates)
      || !collected.latestReleaseIds || Array.isArray(collected.latestReleaseIds)
      || typeof collected.latestReleaseIds !== "object") {
    throw new Error("Collected event set is invalid");
  }
  if (Object.keys(collected.latestReleaseIds).length !== slugs.length
      || slugs.some(slug => !Object.hasOwn(collected.latestReleaseIds, slug))) {
    throw new Error("Collected latest-release set is incomplete");
  }
  const content = {
    heads: collected.heads,
    releases: collected.releases,
    latestReleaseIds: collected.latestReleaseIds,
    commits: collected.commits,
    estimates: collected.estimates,
    budgetReceipt: collected.budgetReceipt,
  };
  return {
    ...content,
    version: 1,
    snapshotId: facts.snapshotId,
    activeSetSha256: facts.activeSetSha256,
    factsSha256: facts.factsSha256,
    sourceSetSha256: facts.sourceSetSha256,
    runContextSha256: facts.runContextSha256,
    completeSetSha256: canonicalHash(content),
  };
}

const FROZEN_FACT_KEYS = [
  "version", "snapshotId", "observedAtUtc", "observedAtKst", "statsDate", "parentSnapshotId",
  "inputSourceSha", "hydrationSourceSha", "productionManifestStatus", "productionManifestSha256",
  "runContextSha256", "trendingSourceSha256", "sourceSetSha256",
  "activeSetSha256", "factsSha256", "repositories", "readmes", "budgetReceipt",
];

function validBudgetReceipt(value) {
  return exactKeys(value, ["logicalRequests", "httpAttempts", "originEpochMs", "eventDeadlineEpochMs"])
    && Object.values(value).every(number => Number.isSafeInteger(number) && number >= 0)
    && value.eventDeadlineEpochMs === value.originEpochMs + EVENT_LIMITS.eventWindowMs
    && value.logicalRequests <= EVENT_LIMITS.maxLogicalRequests
    && value.httpAttempts <= EVENT_LIMITS.maxAttempts;
}

export function validateFrozenFactsPayload(value) {
  if (!exactKeys(value, FROZEN_FACT_KEYS) || value.version !== 1
      || !/^[0-9]{14}-[a-f0-9]{16}$/.test(value.snapshotId ?? "")
      || !/^[a-f0-9]{40}$/.test(value.inputSourceSha ?? "")
      || !/^[a-f0-9]{40}$/.test(value.hydrationSourceSha ?? "")
      || !["verified_v0", "verified_v1", "verified_404"].includes(value.productionManifestStatus)
      || (value.productionManifestStatus === "verified_404"
        ? value.productionManifestSha256 !== null
        : !/^[a-f0-9]{64}$/.test(value.productionManifestSha256 ?? ""))
      || ((value.productionManifestStatus === "verified_v1") === (value.parentSnapshotId === null))
      || !/^[a-f0-9]{64}$/.test(value.runContextSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(value.sourceSetSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(value.activeSetSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(value.factsSha256 ?? "")
      || !Array.isArray(value.repositories) || value.repositories.length < 10 || value.repositories.length > EVENT_LIMITS.maxRepositories
      || !value.readmes || Array.isArray(value.readmes) || typeof value.readmes !== "object"
      || !validBudgetReceipt(value.budgetReceipt)
      || !exactKeys(value.trendingSourceSha256, ["daily", "weekly", "monthly"])
      || Object.values(value.trendingSourceSha256).some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Frozen facts envelope is invalid");
  }
  const runContext = {
    observedAtUtc: value.observedAtUtc,
    observedAtKst: value.observedAtKst,
    statsDateKst: value.statsDate,
    snapshotId: value.snapshotId,
    parentSnapshotId: value.parentSnapshotId,
    parentSourceSha: value.parentSnapshotId === null ? null : value.hydrationSourceSha,
  };
  if (value.runContextSha256 !== canonicalHash(runContext)) throw new Error("Frozen run context hash is invalid");
  if (value.sourceSetSha256 !== canonicalHash({
    input_source_sha: value.inputSourceSha,
    hydration_source_sha: value.hydrationSourceSha,
    production_manifest_status: value.productionManifestStatus,
    production_manifest_sha256: value.productionManifestSha256,
    run_context_sha256: value.runContextSha256,
    trending_source_sha256: value.trendingSourceSha256,
  })) throw new Error("Frozen source-set hash is invalid");
  const slugs = value.repositories.map(repository => normalizeSlug(repository?.slug).toLowerCase());
  if (new Set(slugs).size !== slugs.length || value.activeSetSha256 !== canonicalHash([...slugs].sort())
      || value.factsSha256 !== canonicalHash({
        snapshot_id: value.snapshotId,
        input_source_sha: value.inputSourceSha,
        repositories: value.repositories,
      })) throw new Error("Frozen facts hash binding is invalid");
  if (Object.keys(value.readmes).length !== slugs.length || slugs.some(slug => !Object.hasOwn(value.readmes, slug))) {
    throw new Error("Frozen README set is incomplete");
  }
  for (const [index, slug] of slugs.entries()) {
    const repository = value.repositories[index];
    const readme = value.readmes[slug];
    if (!exactKeys(readme, ["path", "blobSha", "contentSha256", "markdown"])) throw new Error("Frozen README envelope is invalid");
    if (repository.readme_status === "absent") {
      if ([readme.path, readme.blobSha, readme.contentSha256, readme.markdown, repository.readme_locale].some(item => item !== null)
          || !isReadmeVariantSet(repository.readme_variants, null) || repository.readme_variants.length !== 0) throw new Error("Frozen README absence is invalid");
    } else if (repository.readme_status !== "present" || readme.path !== repository.readme_path
        || readme.blobSha !== repository.readme_blob_sha || readme.contentSha256 !== repository.readme_content_sha256
        || repository.readme_locale !== inferReadmeLocale(repository.readme_path)
        || !isReadmeVariantSet(repository.readme_variants, repository.readme_path)
        || typeof readme.markdown !== "string"
        || createHash("sha256").update(Buffer.from(readme.markdown, "utf8")).digest("hex") !== readme.contentSha256) {
      throw new Error("Frozen README identity is invalid");
    }
  }
  return value;
}

export function parseFrozenFactsBytes(bytes) {
  return validateFrozenFactsPayload(parseJsonStrict(bytes, "frozen facts", MAX_FROZEN_FACTS_BYTES));
}

function assertOutsideCheckout(target, label) {
  if (typeof target !== "string" || !target) throw new Error(`${label} path is required`);
  const resolved = path.resolve(target);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the tracked checkout`);
  }
  return resolved;
}

function writeNewEventJson(target, value) {
  const resolved = assertOutsideCheckout(target, "Event output");
  if (existsSync(resolved)) throw new Error("Event output already exists");
  mkdirSync(path.dirname(resolved), { recursive: true });
  const pending = `${resolved}.${process.pid}.tmp`;
  try {
    writeFileSync(pending, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(pending, resolved);
  } finally {
    rmSync(pending, { force: true });
  }
}

export function verifyFrozenParentInputs({
  parentDatabasePath,
  parentEvidencePath,
  priorHeadsPath,
  python = process.env.PYTHON ?? "python",
  verifierScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "derive_repository_artifacts.py"),
} = {}) {
  const result = spawnSync(python, [
    verifierScriptPath,
    "verify-parent-inputs",
    "--parent-database", parentDatabasePath,
    "--parent-evidence", parentEvidencePath,
    "--prior-heads", priorHeadsPath,
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || !/^\{"verified":true,"version":1\}\r?\n$/.test(result.stdout ?? "")) {
    throw new Error("Frozen parent input verification failed");
  }
  return true;
}

function parentDatabaseSha256(target) {
  if (!existsSync(target)) return null;
  try { return createHash("sha256").update(readFileSync(target)).digest("hex"); } catch {
    throw new Error("Frozen parent database is unavailable");
  }
}

function frozenFileUnchanged(target, expected) {
  try { return expected.equals(readFileSync(target)); } catch { return false; }
}

export async function runFrozenEventCollection({
  factsPath,
  eventsOut,
  budgetStatePath,
  priorHeadsPath,
  parentEvidencePath,
  parentDatabasePath,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = Date.now,
  token = "",
  verifyParentInputs = verifyFrozenParentInputs,
} = {}) {
  const resolved = [
    assertOutsideCheckout(factsPath, "Frozen facts"),
    assertOutsideCheckout(eventsOut, "Event output"),
    assertOutsideCheckout(budgetStatePath, "Event budget state"),
    assertOutsideCheckout(priorHeadsPath, "Prior heads"),
    assertOutsideCheckout(parentEvidencePath, "Parent evidence"),
    assertOutsideCheckout(parentDatabasePath, "Parent database"),
  ];
  if (new Set(resolved).size !== resolved.length) throw new Error("Frozen event CLI paths must not alias");
  const facts = parseFrozenFactsBytes(readFileSync(resolved[0]));
  const priorBytes = readFileSync(resolved[3]);
  const parentEvidenceBytes = readFileSync(resolved[4]);
  const priorPayload = parseJsonStrict(priorBytes, "prior heads", 16 * 1024 * 1024);
  const parentEvidence = parseJsonStrict(parentEvidenceBytes, "parent evidence", 64 * 1024 * 1024);
  const previous = validatePriorHeadsPayload(facts, priorPayload, {
    parentEvidence,
    parentDatabasePath: resolved[5],
  });
  if (typeof verifyParentInputs !== "function") throw new Error("Frozen parent verifier is invalid");
  const parentDatabaseBefore = parentDatabaseSha256(resolved[5]);
  await verifyParentInputs({
    parentDatabasePath: resolved[5],
    parentEvidencePath: resolved[4],
    priorHeadsPath: resolved[3],
  });
  if (parentDatabaseSha256(resolved[5]) !== parentDatabaseBefore) {
    throw new Error("Frozen parent database changed during verification");
  }
  if (!frozenFileUnchanged(resolved[3], priorBytes) || !frozenFileUnchanged(resolved[4], parentEvidenceBytes)) {
    throw new Error("Frozen parent evidence changed during verification");
  }
  const collectionContext = createPersistentEventCollectionContext({ statePath: resolved[2], now, create: false });
  if (stableJson(collectionContext.budget.receipt()) !== stableJson(facts.budgetReceipt)) {
    throw new Error("Persisted event budget does not continue the frozen facts receipt");
  }
  const collected = await collectRepositoryEvents(facts.repositories, {
    previous,
    fetchImpl,
    sleep,
    collectionContext,
    token,
  });
  if (parentDatabaseSha256(resolved[5]) !== parentDatabaseBefore) {
    throw new Error("Frozen parent database changed during event collection");
  }
  if (!frozenFileUnchanged(resolved[3], priorBytes) || !frozenFileUnchanged(resolved[4], parentEvidenceBytes)) {
    throw new Error("Frozen parent evidence changed during event collection");
  }
  const envelope = bindFrozenEventEnvelope(facts, collected);
  writeNewEventJson(resolved[1], envelope);
  return envelope;
}

function parseEventCliArgs(argv) {
  const allowed = new Set(["--facts", "--events-out", "--budget-state", "--prior-heads", "--parent-evidence", "--parent-database"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || Object.hasOwn(values, key)) throw new Error("Invalid frozen event CLI arguments");
    values[key] = value;
  }
  if (Object.keys(values).length !== allowed.size) throw new Error("Invalid frozen event CLI arguments");
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseEventCliArgs(process.argv.slice(2));
  const numericOverrides = Object.keys(process.env).filter(name => /^EVENT_.*(?:CAP|LIMIT|TIMEOUT|DEADLINE|ATTEMPTS|RETRIES)$/i.test(name));
  if (numericOverrides.length) throw new Error("Event numeric overrides are forbidden");
  const result = await runFrozenEventCollection({
    factsPath: args["--facts"],
    eventsOut: args["--events-out"],
    budgetStatePath: args["--budget-state"],
    priorHeadsPath: args["--prior-heads"],
    parentEvidencePath: args["--parent-evidence"],
    parentDatabasePath: args["--parent-database"],
    token: process.env.GITHUB_TOKEN ?? "",
  });
  console.log(JSON.stringify({ version: result.version, snapshotId: result.snapshotId, completeSetSha256: result.completeSetSha256 }));
}
