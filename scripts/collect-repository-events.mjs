import { createHash } from "node:crypto";

export const EVENT_LIMITS = Object.freeze({
  maxRepositories: 75,
  maxReleasePages: 20,
  maxCommitPages: 20,
  maxContinuityDiagnostics: 2,
  maxLogicalRequests: 3600,
  maxAttempts: 4500,
  requestTimeoutMs: 30_000,
  retryAttempts: 3,
  retryDelaysMs: Object.freeze([2000, 8000]),
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

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const canonicalHash = value => createHash("sha256").update(stableJson(value)).digest("hex");
const exactKeys = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const validTime = (value, nullable = false) => nullable && value === null || (typeof value === "string" && ISO.test(value) && new Date(value).toISOString() === value.replace(/Z$/, ".000Z"));
const normalizeSlug = slug => {
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new Error(`Invalid repository slug: ${slug}`);
  return slug;
};
const repoPath = slug => `/repos/${slug.split("/").map(encodeURIComponent).join("/")}`;
const eventError = (message, cause) => new Error(message, cause === undefined ? undefined : { cause });

class EventBudget {
  constructor({ now = Date.now, originEpochMs } = {}) {
    if (typeof now !== "function") throw new Error("Event clock must be a function");
    this.now = now;
    this.originEpochMs = originEpochMs ?? now();
    if (!Number.isSafeInteger(this.originEpochMs)) throw new Error("Event origin must be an integer epoch");
    this.deadlineEpochMs = this.originEpochMs + EVENT_LIMITS.eventWindowMs;
    this.logical = 0;
    this.attempts = 0;
  }

  remaining() { return this.deadlineEpochMs - this.now(); }
  admitLogical() {
    if (this.logical >= EVENT_LIMITS.maxLogicalRequests) throw new Error("Event logical request cap exceeded");
    this.logical += 1;
  }
  admitAttempt() {
    if (this.attempts >= EVENT_LIMITS.maxAttempts) throw new Error("Event HTTP attempt cap exceeded");
    if (this.remaining() < EVENT_LIMITS.requestTimeoutMs + EVENT_LIMITS.eventAdmissionReserveMs) {
      throw new Error("Event deadline has insufficient request reserve");
    }
    this.attempts += 1;
  }
  admitSleep(delay) {
    if (this.remaining() < delay + EVENT_LIMITS.requestTimeoutMs + EVENT_LIMITS.eventAdmissionReserveMs) {
      throw new Error("Event deadline has insufficient retry reserve");
    }
  }
  receipt() { return Object.freeze({ logicalRequests: this.logical, httpAttempts: this.attempts, originEpochMs: this.originEpochMs, eventDeadlineEpochMs: this.deadlineEpochMs }); }
}

function retryableStatus(status) { return status === 429 || status >= 500; }
function retryableError(error) { return error?.name === "AbortError" || error?.name === "TimeoutError"; }
function retryDelay(response, attempt) {
  const fixed = EVENT_LIMITS.retryDelaysMs[attempt];
  const retryAfter = response?.headers?.get("retry-after");
  const headerDelay = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
  return Math.max(fixed, headerDelay);
}

async function request(url, { fetchImpl, sleep, budget, headers = {}, allow304 = false }) {
  budget.admitLogical();
  for (let attempt = 0; attempt < EVENT_LIMITS.retryAttempts; attempt += 1) {
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
      if (!retryableError(error) || attempt === EVENT_LIMITS.retryAttempts - 1) throw eventError(`Event request failed for ${url}`, error);
      const delay = EVENT_LIMITS.retryDelaysMs[attempt];
      budget.admitSleep(delay);
      await sleep(delay);
      continue;
    }
    if (response.status === 304 && allow304) return response;
    if (!retryableStatus(response.status) || attempt === EVENT_LIMITS.retryAttempts - 1) return response;
    const delay = retryDelay(response, attempt);
    budget.admitSleep(delay);
    await sleep(delay);
  }
  throw new Error(`Event request exhausted for ${url}`);
}

async function json(response, label) {
  if (!response?.ok) throw new Error(`${label} returned ${response?.status}`);
  try { return await response.json(); } catch (error) { throw eventError(`Invalid JSON for ${label}`, error); }
}

function releaseRecord(slug, value) {
  const allowed = ["id", "tag_name", "name", "target_commitish", "draft", "prerelease", "created_at", "published_at", "html_url"];
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.id) || value.id < 1
    || ["tag_name", "target_commitish", "html_url"].some(key => typeof value[key] !== "string")
    || (value.name !== null && typeof value.name !== "string") || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean"
    || !validTime(value.created_at, true) || !validTime(value.published_at, true)) throw new Error(`Invalid release for ${slug}`);
  const url = new URL(value.html_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error(`Invalid release for ${slug}`);
  const record = Object.fromEntries(allowed.map(key => [key, value[key]]));
  return { slug, ...record, metadataSha256: canonicalHash(record) };
}

function releaseNext(link, slug, page) {
  if (link === null) return null;
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)].filter(([, , rel]) => rel === "next");
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error(`Invalid release Link for ${slug}`);
  const value = new URL(matches[0][1]);
  const expected = repoPath(slug) + "/releases";
  if (value.protocol !== "https:" || value.hostname !== "api.github.com" || value.pathname !== expected
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
    const response = await request(url, context);
    const value = await json(response, `release inventory for ${slug}`);
    if (!Array.isArray(value)) throw new Error(`Invalid release inventory for ${slug}`);
    const next = releaseNext(response.headers.get("link"), slug, page);
    if (page === EVENT_LIMITS.maxReleasePages && next !== null) throw new Error(`Release page cap exceeded for ${slug}`);
    const records = value.map(entry => releaseRecord(slug, entry));
    for (const record of records) {
      if (seenIds.has(record.id)) throw new Error(`Duplicate release id for ${slug}`);
      seenIds.add(record.id);
    }
    pages.push({ url, etag: response.headers.get("etag"), canonicalBody: stableJson(value), next, records });
    if (next === null) break;
    url = next;
  }
  // A strong ETag must yield 304; otherwise exact canonical body and Link identity must match.
  for (const [index, first] of pages.entries()) {
    const headers = first.etag ? { "If-None-Match": first.etag } : {};
    const response = await request(first.url, { ...context, headers, allow304: Boolean(first.etag) });
    if (first.etag && response.status !== 304) throw new Error(`Release ETag revalidation changed for ${slug} page ${index + 1}`);
    if (response.status === 304) continue;
    const value = await json(response, `release revalidation for ${slug}`);
    const next = releaseNext(response.headers.get("link"), slug, index + 1);
    if (stableJson(value) !== first.canonicalBody || next !== first.next) throw new Error(`Release revalidation changed for ${slug} page ${index + 1}`);
  }
  return pages;
}

async function latestRelease(slug, inventory, context) {
  const url = `https://api.github.com${repoPath(slug)}/releases/latest`;
  const response = await request(url, context);
  if (response.status === 404) return null;
  const record = releaseRecord(slug, await json(response, `latest release for ${slug}`));
  const existing = inventory.flatMap(page => page.records).find(value => value.id === record.id);
  if (!existing || existing.metadataSha256 !== record.metadataSha256) throw new Error(`Latest release is absent from complete inventory for ${slug}`);
  return record.id;
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
  const url = new URL(value.html_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error(`Invalid commit for ${slug}`);
  return { slug, sha, firstObservedOrdinal: ordinal, branch, authoredAt: value.commit.author.date, committedAt: value.commit.committer.date, authorLogin: value.author?.login ?? null, parentShas: parents.map(parent => parent.sha), htmlUrl: value.html_url };
}

async function diagnoseContinuity(slug, branch, priorHead, currentHead, context) {
  const base = `https://api.github.com${repoPath(slug)}`;
  const compare = await request(`${base}/compare/${priorHead}...${currentHead}`, context);
  const result = await json(compare, `commit continuity for ${slug}`);
  if (!result || typeof result !== "object" || !["ahead", "behind", "diverged", "identical"].includes(result.status)) throw new Error(`Ambiguous commit continuity for ${slug}`);
  const ref = await request(`${base}/git/ref/heads/${encodeURIComponent(branch)}`, context);
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
    const values = await json(await request(url, context), `commit inventory for ${slug}`);
    if (!Array.isArray(values)) throw new Error(`Invalid commit inventory for ${slug}`);
    for (const value of values) {
      const record = commitRecord(slug, branch, value, records.length + 1);
      // GitHub commit pages can overlap while a branch advances.  The current
      // candidate is deduplicated by SHA; absence of the prior head is still
      // diagnosed below, so overlap cannot make a gap look successful.
      if (seen.has(record.sha)) continue;
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
    if (!exactKeys(row, ["date", "stargazers"]) || typeof row.date !== "string" || !DATE.test(row.date) || Number.isNaN(new Date(`${row.date}T00:00:00Z`).getTime())) throw new Error("Invalid OSS Insight row");
    if (row.date <= previousDate) throw new Error("OSS Insight dates must be ascending unique");
    previousDate = row.date;
    return { date: row.date, stars: ossInteger(row.stargazers) };
  });
  return { rows: normalized, sourcePayloadSha256: canonicalHash(value), publicRows: normalized.slice(-EVENT_LIMITS.publicOssRows) };
}

async function collectOss(slug, context) {
  const [owner, name] = normalizeSlug(slug).split("/");
  const url = `https://api.ossinsight.io/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stargazers/history`;
  const response = await request(url, { ...context, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`OSS Insight returned ${response.status} for ${slug}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(contentType)) throw new Error(`Invalid OSS Insight content type for ${slug}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > EVENT_LIMITS.maxOssBytes) throw new Error(`OSS Insight body exceeds ${EVENT_LIMITS.maxOssBytes} bytes for ${slug}`);
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch (error) { throw eventError(`Invalid OSS Insight JSON for ${slug}`, error); }
  return { slug, ...validateOssInsightResponse(parsed) };
}

export async function collectRepositoryEvents(repositories, {
  previous = {},
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = Date.now,
  originEpochMs,
} = {}) {
  if (!Array.isArray(repositories) || repositories.length < 1 || repositories.length > EVENT_LIMITS.maxRepositories) throw new Error(`Repository events require 1-${EVENT_LIMITS.maxRepositories} repositories`);
  if (typeof fetchImpl !== "function" || typeof sleep !== "function") throw new Error("fetchImpl and sleep must be functions");
  const budget = new EventBudget({ now, originEpochMs });
  const context = { fetchImpl, sleep, budget };
  const releases = [];
  const latestReleaseIds = new Map();
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
    latestReleaseIds.set(slug.toLowerCase(), await latestRelease(slug, pages, context));
    const commitEvents = await collectCommits(repository, previous, context);
    heads.push(commitEvents.head);
    commits.push(...commitEvents.commits);
    estimates.push(await collectOss(slug, context));
  }
  return Object.freeze({ releases: Object.freeze(releases), latestReleaseIds, commits: Object.freeze(commits), heads: Object.freeze(heads), estimates: Object.freeze(estimates), budgetReceipt: budget.receipt() });
}
