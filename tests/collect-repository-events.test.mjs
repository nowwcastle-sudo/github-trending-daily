import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
  collectRepositoryEvents,
  createEventCollectionContext,
  createPersistentEventCollectionContext,
  bindFrozenEventEnvelope,
  hashCanonicalJson,
  runFrozenEventCollection,
  validatePriorHeadsPayload,
  validateOssInsightResponse,
} from "../scripts/collect-repository-events.mjs";

const sha = char => char.repeat(40);
const repo = { slug: "owner/repo", default_branch: "main", default_branch_head_sha: sha("b") };

function response(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function release(id, tag = `v${id}`) {
  return { id, tag_name: tag, name: tag, target_commitish: "main", draft: false, prerelease: false, created_at: "2026-08-27T00:00:00Z", published_at: "2026-08-27T00:00:00Z", html_url: `https://github.com/owner/repo/releases/tag/${tag}`, body: "must not persist", assets: [{ name: "must not persist" }] };
}

function commit(value, parents = []) {
  return {
    sha: value,
    commit: { author: { date: "2026-08-27T00:00:00Z", name: "not persisted", email: "not@example.test" }, committer: { date: "2026-08-27T00:00:00Z", name: "not persisted", email: "not@example.test" }, message: "not persisted" },
    author: { login: "public-login" },
    parents: parents.map(parent => ({ sha: parent })),
    html_url: `https://github.com/owner/repo/commit/${value}`,
    files: [],
  };
}

function oss(rows) {
  return {
    type: "sql_endpoint",
    data: {
      columns: [
        { col: "date", data_type: "VARCHAR", nullable: true },
        { col: "stargazers", data_type: "DECIMAL", nullable: true },
      ],
      result: { code: 200, message: "ok", start_ms: 0, end_ms: 1, latency: "1ms", row_count: rows.length, row_affect: 0, limit: rows.length },
      rows,
    },
  };
}

function assertContentFreeError(error, sentinel) {
  const pattern = new RegExp(sentinel);
  for (let current = error; current; current = current.cause) {
    assert.doesNotMatch(current.message, pattern);
    assert.doesNotMatch(current.stack ?? "", pattern);
    assert.doesNotMatch(String(current), pattern);
    assert.doesNotMatch(inspect(current, { depth: null }), pattern);
    assert.doesNotMatch(JSON.stringify(current), pattern);
    assert.equal(Object.keys(current).some(key => pattern.test(key)), false);
    assert.equal(Object.values(current).some(value => pattern.test(String(value))), false);
  }
}

function successfulFetch({ releasePages = [[release(1), release(2)]], commits = [], ossRows = [{ date: "2026-08-26", stargazers: "12" }] } = {}) {
  return async (url, options = {}) => {
    const value = new URL(url);
    const requestedSlug = value.pathname.match(/^\/repos\/([^/]+\/[^/]+)\//)?.[1]?.toLowerCase() ?? "owner/repo";
    const forRequestedRepository = item => ({
      ...item,
      html_url: `https://github.com/${requestedSlug}/releases/tag/${item.tag_name}`,
    });
    if (value.hostname === "api.ossinsight.io") return response(200, oss(ossRows));
    if (value.pathname.endsWith("/releases/latest")) return response(200, forRequestedRepository(release(1)));
    if (value.pathname.endsWith("/releases")) {
      const page = Number(value.searchParams.get("page"));
      const links = page < releasePages.length
        ? { link: `<https://api.github.com/repos/owner/repo/releases?per_page=100&page=${page + 1}>; rel="next"`, etag: `"release-${page}"` }
        : { etag: `"release-${page}"` };
      if (options.headers?.["If-None-Match"]) return new Response(null, { status: 304, headers: links });
      return response(200, releasePages[page - 1].map(forRequestedRepository), links);
    }
    if (value.pathname.endsWith("/commits")) return response(200, commits);
    if (value.pathname.includes("/compare/")) return response(200, { status: "ahead" });
    if (value.pathname.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: sha("b") } });
    throw new Error(`unexpected ${url}`);
  };
}

test("release baseline follows all pages and excludes bodies/assets", async () => {
  const events = await collectRepositoryEvents([repo], { fetchImpl: successfulFetch({ releasePages: [[release(1)], [release(2)]] }) });
  assert.deepEqual(events.releases.map(value => value.release_id), [1, 2]);
  assert.equal("body" in events.releases[0], false);
  assert.equal("assets" in events.releases[0], false);
  assert.equal(events.latestReleaseIds["owner/repo"], 1);
});

test("event envelope serializes latest-release ids and binds the exact frozen facts", async () => {
  const collected = await collectRepositoryEvents([repo], { fetchImpl: successfulFetch() });
  const facts = {
    version: 1,
    snapshotId: "20260829000700-aaaaaaaaaaaaaaaa",
    parentSnapshotId: null,
    inputSourceSha: "c".repeat(40),
    activeSetSha256: hashCanonicalJson(["owner/repo"]),
    factsSha256: null,
    repositories: [repo],
  };
  facts.factsSha256 = hashCanonicalJson({
    snapshot_id: facts.snapshotId,
    input_source_sha: facts.inputSourceSha,
    repositories: facts.repositories,
  });
  const envelope = bindFrozenEventEnvelope(facts, collected);
  assert.deepEqual(envelope.latestReleaseIds, { "owner/repo": 1 });
  assert.equal(envelope.snapshotId, facts.snapshotId);
  assert.equal(envelope.activeSetSha256, facts.activeSetSha256);
  assert.equal(envelope.factsSha256, facts.factsSha256);
  assert.match(envelope.completeSetSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(JSON.stringify(envelope)).latestReleaseIds["owner/repo"], 1);
});

test("one persisted event budget carries counters and its absolute deadline across processes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "event-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "budget.json");
  const origin = 1_700_000_000_000;
  const first = createPersistentEventCollectionContext({ statePath, originEpochMs: origin, now: () => origin, create: true });
  first.budget.admitLogical();
  first.budget.admitAttempt();
  const second = createPersistentEventCollectionContext({ statePath, now: () => origin + 1, create: false });
  second.budget.admitLogical();
  const receipt = second.budget.receipt();
  assert.deepEqual(receipt, {
    logicalRequests: 2,
    httpAttempts: 1,
    originEpochMs: origin,
    eventDeadlineEpochMs: origin + 15 * 60_000,
  });
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.logicalRequests, 2);
  assert.equal(persisted.httpAttempts, 1);
  assert.equal(persisted.eventDeadlineEpochMs, origin + 15 * 60_000);
});

test("event CLI consumes exact temp facts, prior heads, and the persisted facts budget", async t => {
  const directory = await mkdtemp(join(tmpdir(), "frozen-event-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = 1_700_000_000_000;
  const budgetStatePath = join(directory, "budget.json");
  const context = createPersistentEventCollectionContext({ statePath: budgetStatePath, originEpochMs: origin, now: () => origin, create: true });
  for (let index = 0; index < 43; index += 1) {
    context.budget.admitLogical();
    context.budget.admitAttempt();
  }
  const repositories = Array.from({ length: 10 }, (_, index) => ({
    slug: `owner/repo-${index}`,
    default_branch: "main",
    default_branch_head_sha: sha("b"),
    readme_status: "absent",
  }));
  const runContext = {
    observedAtUtc: "2023-11-14T22:13:20.000Z",
    observedAtKst: "2023-11-15T07:13:20+09:00",
    statsDateKst: "2023-11-15",
    snapshotId: "20231114221320-aaaaaaaaaaaaaaaa",
    parentSnapshotId: null,
    parentSourceSha: null,
  };
  const inputSourceSha = "c".repeat(40);
  const productionManifestStatus = "verified_v1";
  const productionManifestSha256 = "f".repeat(64);
  const trendingSourceSha256 = { daily: "1".repeat(64), weekly: "2".repeat(64), monthly: "3".repeat(64) };
  const facts = {
    version: 1,
    snapshotId: runContext.snapshotId,
    observedAtUtc: runContext.observedAtUtc,
    observedAtKst: runContext.observedAtKst,
    statsDate: runContext.statsDateKst,
    parentSnapshotId: null,
    inputSourceSha,
    productionManifestStatus,
    productionManifestSha256,
    runContextSha256: hashCanonicalJson(runContext),
    trendingSourceSha256,
    sourceSetSha256: null,
    activeSetSha256: hashCanonicalJson(repositories.map(value => value.slug).sort()),
    factsSha256: hashCanonicalJson({ snapshot_id: runContext.snapshotId, input_source_sha: inputSourceSha, repositories }),
    repositories,
    readmes: Object.fromEntries(repositories.map(value => [value.slug, { path: null, blobSha: null, contentSha256: null, markdown: null }])),
    budgetReceipt: context.budget.receipt(),
  };
  facts.sourceSetSha256 = hashCanonicalJson({
    input_source_sha: inputSourceSha,
    production_manifest_status: productionManifestStatus,
    production_manifest_sha256: productionManifestSha256,
    run_context_sha256: facts.runContextSha256,
    trending_source_sha256: trendingSourceSha256,
  });
  const factsPath = join(directory, "facts.json");
  const eventsOut = join(directory, "events.json");
  const priorHeadsPath = join(directory, "prior-heads.json");
  await Promise.all([
    writeFile(factsPath, `${JSON.stringify(facts)}\n`),
    writeFile(priorHeadsPath, '{"version":1,"snapshotId":null,"heads":{}}\n'),
  ]);

  const events = await runFrozenEventCollection({
    factsPath,
    eventsOut,
    budgetStatePath,
    priorHeadsPath,
    fetchImpl: successfulFetch(),
    now: () => origin,
  });
  assert.equal(events.snapshotId, facts.snapshotId);
  assert.equal(events.releases.length, 20);
  assert.deepEqual(events.latestReleaseIds, Object.fromEntries(repositories.map(value => [value.slug, 1])));
  assert.equal(events.budgetReceipt.logicalRequests, 83);
  assert.deepEqual(JSON.parse(await readFile(eventsOut, "utf8")), events);
});

test("refresh facts require one exact prior head per active repository", () => {
  const facts = { parentSnapshotId: "20260828000700-bbbbbbbbbbbbbbbb", repositories: [repo] };
  assert.throws(() => validatePriorHeadsPayload(facts, { version: 1, snapshotId: facts.parentSnapshotId, heads: {} }), /prior head/i);
  assert.deepEqual(validatePriorHeadsPayload(facts, {
    version: 1,
    snapshotId: facts.parentSnapshotId,
    heads: { "owner/repo": { branch: "main", headSha: "a".repeat(40) } },
  }), { "owner/repo": { branch: "main", headSha: "a".repeat(40) } });
  assert.deepEqual(validatePriorHeadsPayload({ parentSnapshotId: null, repositories: [repo] }, {
    version: 1, snapshotId: null, heads: {},
  }), {});
});

test("page twenty without next completes, but a next link fails instead of truncating", async () => {
  const pages = Array.from({ length: 20 }, (_, index) => [release(index + 1)]);
  const ok = await collectRepositoryEvents([repo], { fetchImpl: successfulFetch({ releasePages: pages }) });
  assert.equal(ok.releases.length, 20);
  await assert.rejects(
    collectRepositoryEvents([repo], { fetchImpl: successfulFetch({ releasePages: [...pages, [release(21)]] }) }),
    /release page cap/i,
  );
});

test("future commits retain a backdated fast-forward and a proven rewrite imports no old history", async () => {
  const prior = sha("a");
  const newest = sha("c");
  const fastForward = await collectRepositoryEvents([{ ...repo, default_branch_head_sha: newest }], {
    previous: { "owner/repo": { branch: "main", headSha: prior } },
    fetchImpl: successfulFetch({ commits: [commit(newest, [sha("d")]), commit(sha("d"), [prior]), commit(prior)] }),
  });
  assert.deepEqual(fastForward.commits.map(value => value.sha), [newest, sha("d")]);
  const rewrite = await collectRepositoryEvents([{ ...repo, default_branch_head_sha: newest }], {
    previous: { "owner/repo": { branch: "main", headSha: prior } },
    fetchImpl: async (url, options) => {
      const value = new URL(url);
      if (value.pathname.endsWith("/commits")) return response(200, [commit(newest)]);
      if (value.pathname.includes("/compare/")) return response(200, { status: "diverged" });
      if (value.pathname.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: newest } });
      return successfulFetch()(url, options);
    },
  });
  assert.equal(rewrite.heads[0].transition, "history_rewritten");
  assert.deepEqual(rewrite.commits, []);
});

test("OSS Insight is exact, complete, normalized and is not limited by public display cap", () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({ date: `2025-01-${String((index % 28) + 1).padStart(2, "0")}`, stargazers: String(index) }));
  rows.sort((left, right) => left.date.localeCompare(right.date));
  // Equal dates deliberately demonstrate that duplicate series are rejected.
  assert.throws(() => validateOssInsightResponse(oss(rows)), /ascending unique/i);
  const valid = validateOssInsightResponse(oss([{ date: "2025-01-01", stargazers: "0" }, { date: "2025-01-02", stargazers: 1 }]));
  assert.deepEqual(valid.rows, [{ date: "2025-01-01", stars: 0 }, { date: "2025-01-02", stars: 1 }]);
  assert.throws(() => validateOssInsightResponse(oss([{ date: "2025-01-01", stargazers: "01" }])), /stargazers/i);
  assert.throws(() => validateOssInsightResponse(oss([{ date: "2025-01-01", stargazers: "1.5" }])), /stargazers/i);
});

test("hostile Link and a page-two-only non-ETag mutation both stop the complete event candidate", async () => {
  await assert.rejects(collectRepositoryEvents([repo], {
    fetchImpl: async (url, options) => {
      const value = new URL(url);
      if (value.pathname.endsWith("/releases")) return response(200, [release(1)], { link: '<https://attacker.example/releases?per_page=100&page=2>; rel="next"' });
      return successfulFetch()(url, options);
    },
  }), /Invalid release Link/);

  let secondPageReads = 0;
  await assert.rejects(collectRepositoryEvents([repo], {
    fetchImpl: async (url, options) => {
      const value = new URL(url);
      if (value.pathname.endsWith("/releases")) {
        const page = Number(value.searchParams.get("page"));
        if (page === 1) return response(200, [release(1)], { link: '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="next"' });
        secondPageReads += 1;
        return response(200, [release(secondPageReads === 1 ? 2 : 3)]);
      }
      return successfulFetch()(url, options);
    },
  }), /Release revalidation changed.*page 2/);
});

test("all 75 candidates share bounded requests and an immutable event deadline", async () => {
  const repos = Array.from({ length: 75 }, (_, index) => ({ slug: `owner/repo-${index}`, default_branch: "main", default_branch_head_sha: sha("b") }));
  const all = await collectRepositoryEvents(repos, { fetchImpl: successfulFetch() });
  assert.equal(all.heads.length, 75);
  assert.ok(all.budgetReceipt.logicalRequests <= 3600);
  assert.ok(all.budgetReceipt.httpAttempts <= 4500);
  const origin = 1_700_000_000_000;
  await assert.rejects(collectRepositoryEvents([repo], {
    fetchImpl: successfulFetch(),
    originEpochMs: origin,
    now: () => origin + 15 * 60_000 - 34_999,
  }), /deadline has insufficient request reserve/);
});

test("terminal retry counts every attempt and OSS rejects 10,001 rows and malformed numbers", async () => {
  let attempts = 0;
  const sleeps = [];
  await assert.rejects(collectRepositoryEvents([repo], {
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname.endsWith("/releases")) { attempts += 1; return response(503, { message: "temporary" }, { "retry-after": "999" }); }
      return successfulFetch()(url, options);
    },
    sleep: async milliseconds => { sleeps.push(milliseconds); },
  }), /release inventory.*503/);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [2000, 8000]);
  const oversized = Array.from({ length: 10_001 }, (_, index) => {
    const day = new Date(Date.UTC(2000, 0, 1 + index)).toISOString().slice(0, 10);
    return { date: day, stargazers: index };
  });
  assert.throws(() => validateOssInsightResponse(oss(oversized)), /Invalid OSS Insight envelope/);
  for (const invalid of ["+1", " 1", "01", "1e2", "9007199254740992", -1, 1.5, null]) {
    assert.throws(() => validateOssInsightResponse(oss([{ date: "2025-01-01", stargazers: invalid }])), /stargazers/);
  }
});

test("release records normalize the DB identity and weak ETags require byte-equivalent revalidation", async () => {
  let calls = 0;
  const uppercase = { ...repo, slug: "Owner/Repo" };
  const events = await collectRepositoryEvents([uppercase], {
    fetchImpl: async (url, options) => {
      const value = new URL(url);
      if (value.pathname.endsWith("/releases/latest")) return response(200, release(1));
      if (value.pathname.endsWith("/releases")) {
        calls += 1;
        return response(200, [release(calls === 2 ? 2 : 1)], { etag: 'W/"weak"' });
      }
      return successfulFetch()(url, options);
    },
  }).catch(error => error);
  assert.match(events.message, /Release revalidation changed/);
  assert.equal(calls, 2);
  const identity = await collectRepositoryEvents([uppercase], { fetchImpl: successfulFetch() });
  assert.deepEqual(Object.keys(identity.releases[0]).sort(), ["created_at", "draft", "html_url", "metadata_sha256", "name", "prerelease", "published_at", "release_id", "slug", "tag_name", "target_commitish"]);
  assert.equal(identity.releases[0].slug, "owner/repo");
  assert.equal(identity.releases[0].created_at, "2026-08-27T00:00:00.000Z");
  const value = identity.releases[0];
  const preimage = {
    created_at: value.created_at,
    draft: value.draft,
    html_url: value.html_url,
    name: value.name,
    prerelease: value.prerelease,
    published_at: value.published_at,
    release_id: value.release_id,
    slug: value.slug,
    tag_name: value.tag_name,
    target_commitish: value.target_commitish,
  };
  assert.equal(value.metadata_sha256, createHash("sha256").update(JSON.stringify(preimage)).digest("hex"));
});

test("malformed release URLs are rejected without retaining upstream URL content", async () => {
  const sentinel = "RELEASE-MALFORMED-URL-SENTINEL-DO-NOT-RETAIN";
  let caught;
  try {
    await collectRepositoryEvents([repo], {
      fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/releases")
        ? response(200, [{ ...release(1), html_url: `https://%${sentinel}` }], { etag: '"release"' })
        : successfulFetch()(url, options),
    });
  } catch (error) { caught = error; }
  assert.ok(caught);
  assertContentFreeError(caught, sentinel);
});

test("malformed commit URLs are rejected without retaining upstream URL content", async () => {
  const sentinel = "COMMIT-MALFORMED-URL-SENTINEL-DO-NOT-RETAIN";
  let caught;
  try {
    await collectRepositoryEvents([{ ...repo, default_branch_head_sha: sha("c") }], {
      previous: { "owner/repo": { branch: "main", headSha: sha("a") } },
      fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/commits")
        ? response(200, [{ ...commit(sha("c")), html_url: `https://%${sentinel}` }])
        : successfulFetch()(url, options),
    });
  } catch (error) { caught = error; }
  assert.ok(caught);
  assertContentFreeError(caught, sentinel);
});

test("release identities and same-origin pagination reject every hostile URL component", async () => {
  const releaseUrls = [
    "http://github.com/owner/repo/releases/tag/v1",
    "https://github.example/owner/repo/releases/tag/v1",
    "https://github.com:443/owner/repo/releases/tag/v1",
    "https://user@github.com/owner/repo/releases/tag/v1",
    "https://github.com/owner/other/releases/tag/v1",
    "https://github.com/owner/repo/releases/tag/v1?download=1",
    "https://github.com/owner/repo/releases/tag/v1#fragment",
  ];
  for (const htmlUrl of releaseUrls) {
    await assert.rejects(collectRepositoryEvents([repo], {
      fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/releases")
        ? response(200, [{ ...release(1), html_url: htmlUrl }], { etag: '"release"' })
        : successfulFetch()(url, options),
    }), /Invalid release/);
  }

  const nextLinks = [
    "http://api.github.com/repos/owner/repo/releases?per_page=100&page=2",
    "https://api.github.example/repos/owner/repo/releases?per_page=100&page=2",
    "https://api.github.com:443/repos/owner/repo/releases?per_page=100&page=2",
    "https://user@api.github.com/repos/owner/repo/releases?per_page=100&page=2",
    "https://api.github.com/repos/owner/other/releases?per_page=100&page=2",
    "https://api.github.com/repos/owner/repo/releases?per_page=100&page=2&extra=1",
    "https://api.github.com/repos/owner/repo/releases?per_page=100&page=2#fragment",
  ];
  for (const next of nextLinks) {
    await assert.rejects(collectRepositoryEvents([repo], {
      fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/releases")
        ? response(200, [], { link: `<${next}>; rel="next"` })
        : successfulFetch()(url, options),
    }), /Invalid release Link/);
  }

  const commitUrls = [
    `http://github.com/owner/repo/commit/${sha("c")}`,
    `https://github.example/owner/repo/commit/${sha("c")}`,
    `https://github.com:443/owner/repo/commit/${sha("c")}`,
    `https://user@github.com/owner/repo/commit/${sha("c")}`,
    `https://github.com/owner/other/commit/${sha("c")}`,
    `https://github.com/owner/repo/commit/${sha("c")}?diff=1`,
    `https://github.com/owner/repo/commit/${sha("c")}#fragment`,
  ];
  for (const htmlUrl of commitUrls) {
    await assert.rejects(collectRepositoryEvents([{ ...repo, default_branch_head_sha: sha("c") }], {
      previous: { "owner/repo": { branch: "main", headSha: sha("a") } },
      fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/commits")
        ? response(200, [{ ...commit(sha("c")), html_url: htmlUrl }])
        : successfulFetch()(url, options),
    }), /Invalid commit/);
  }
});

test("unquoted Link, a page-one HEAD race, and upstream sentinels fail closed without content leakage", async () => {
  await assert.rejects(collectRepositoryEvents([repo], {
    fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/releases")
      ? response(200, [], { link: '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel=next' })
      : successfulFetch()(url, options),
  }), /Invalid release Link/);
  await assert.rejects(collectRepositoryEvents([{ ...repo, default_branch_head_sha: sha("c") }], {
    previous: { "owner/repo": { branch: "main", headSha: sha("a") } },
    fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/commits")
      ? response(200, [commit(sha("d"))])
      : successfulFetch()(url, options),
  }), /HEAD changed/);
  const sentinel = "UPSTREAM-BODY-SENTINEL-DO-NOT-LOG";
  let caught;
  try {
    await collectRepositoryEvents([repo], { fetchImpl: async () => { throw new Error(sentinel); }, sleep: async () => {} });
  } catch (error) { caught = error; }
  assert.ok(caught);
  assert.doesNotMatch(caught.message, new RegExp(sentinel));
  assert.doesNotMatch(caught.stack, new RegExp(sentinel));
  assert.equal(caught.cause, undefined);
});

test("calendar-valid 501-point OSS history retains full storage and independent public slice", () => {
  const rows = Array.from({ length: 501 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
    return { date, stargazers: index };
  });
  const validated = validateOssInsightResponse(oss(rows));
  assert.equal(validated.rows.length, 501);
  assert.equal(validated.publicRows.length, 500);
  assert.deepEqual(validated.rows.at(-1), { date: "2025-05-15", stars: 500 });
  assert.throws(() => validateOssInsightResponse(oss([{ date: "2025-02-30", stargazers: 1 }])), /Invalid OSS Insight row/);
});

test("shared context rejects deadline overrides and a regressing clock", async () => {
  const origin = 1_700_000_000_000;
  const shared = createEventCollectionContext({ originEpochMs: origin, now: () => origin });
  await assert.rejects(collectRepositoryEvents([repo], { fetchImpl: successfulFetch(), collectionContext: shared, originEpochMs: origin }), /rejects numeric or clock overrides/);
  await assert.rejects(collectRepositoryEvents([repo], { fetchImpl: successfulFetch(), collectionContext: { budget: shared.budget } }), /rejects numeric or clock overrides/);
  const readings = [origin + 1, origin];
  const clock = createEventCollectionContext({ originEpochMs: origin, now: () => readings.shift() });
  await assert.rejects(collectRepositoryEvents([repo], { fetchImpl: successfulFetch(), collectionContext: clock }), /clock regressed/);
});

test("collection budget exposes capability methods but no mutable deadline, counter, or clock state", async () => {
  const context = createEventCollectionContext({ originEpochMs: 1_700_000_000_000, now: () => 1_700_000_000_000 });
  const budget = context.budget;
  assert.deepEqual(Object.keys(budget).sort(), ["admitAttempt", "admitLogical", "admitSleep", "receipt"]);
  for (const key of ["deadlineEpochMs", "logical", "attempts", "lastNow", "now"]) {
    assert.equal(key in budget, false);
    assert.throws(() => { budget[key] = 0; }, /read only|extensible|object/i);
  }
  const before = budget.receipt();
  await collectRepositoryEvents([repo], { fetchImpl: successfulFetch(), collectionContext: context });
  const after = budget.receipt();
  assert.equal(after.logicalRequests - before.logicalRequests, 4);
  assert.equal(after.eventDeadlineEpochMs, before.eventDeadlineEpochMs);
});

test("malformed release ETags fail closed and an empty changed-head page is contradictory evidence", async () => {
  await assert.rejects(collectRepositoryEvents([repo], {
    fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/releases")
      ? response(200, [], { etag: "not-an-entity-tag" })
      : successfulFetch()(url, options),
  }), /Invalid release ETag/);
  await assert.rejects(collectRepositoryEvents([{ ...repo, default_branch_head_sha: sha("c") }], {
    previous: { "owner/repo": { branch: "main", headSha: sha("a") } },
    fetchImpl: async (url, options) => new URL(url).pathname.endsWith("/commits")
      ? response(200, [])
      : successfulFetch()(url, options),
  }), /Contradictory empty commit page/);
});

test("75-repository worst-case pagination fails at the shared logical cap rather than truncating", async () => {
  const repos = Array.from({ length: 75 }, (_, index) => ({ slug: `owner/cap-${index}`, default_branch: "main", default_branch_head_sha: sha("b") }));
  const previous = Object.fromEntries(repos.map(value => [value.slug, { branch: "main", headSha: sha("a") }]));
  await assert.rejects(collectRepositoryEvents(repos, {
    previous,
    fetchImpl: async url => {
      const value = new URL(url);
      const requestedSlug = value.pathname.match(/^\/repos\/([^/]+\/[^/]+)\//)?.[1] ?? "owner/repo";
      const requestedRelease = id => ({ ...release(id), html_url: `https://github.com/${requestedSlug}/releases/tag/v${id}` });
      if (value.pathname.endsWith("/releases/latest")) return response(200, requestedRelease(1));
      if (value.pathname.endsWith("/releases")) {
        const page = Number(value.searchParams.get("page"));
        const link = page < 20 ? { link: `<${value.origin}${value.pathname}?per_page=100&page=${page + 1}>; rel="next"` } : {};
        return response(200, [requestedRelease(page)], link);
      }
      if (value.pathname.endsWith("/commits")) {
        const item = Number(value.searchParams.get("page")) === 20 ? commit(sha("a")) : commit(sha("b"));
        return response(200, [{ ...item, html_url: `https://github.com/${requestedSlug}/commit/${item.sha}` }]);
      }
      if (value.hostname === "api.ossinsight.io") return new Response(JSON.stringify(oss([])), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("unexpected URL");
    },
  }), /logical request cap exceeded/);
});
