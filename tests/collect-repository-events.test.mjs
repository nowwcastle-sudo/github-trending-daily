import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";

import {
  collectRepositoryEvents,
  createEventCollectionContext,
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
    if (value.hostname === "api.ossinsight.io") return response(200, oss(ossRows));
    if (value.pathname.endsWith("/releases/latest")) return response(200, release(1));
    if (value.pathname.endsWith("/releases")) {
      const page = Number(value.searchParams.get("page"));
      const links = page < releasePages.length
        ? { link: `<https://api.github.com/repos/owner/repo/releases?per_page=100&page=${page + 1}>; rel="next"`, etag: `"release-${page}"` }
        : { etag: `"release-${page}"` };
      if (options.headers?.["If-None-Match"]) return new Response(null, { status: 304, headers: links });
      return response(200, releasePages[page - 1], links);
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
  assert.equal(events.latestReleaseIds.get("owner/repo"), 1);
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
      if (value.pathname.endsWith("/releases/latest")) return response(200, release(1));
      if (value.pathname.endsWith("/releases")) {
        const page = Number(value.searchParams.get("page"));
        const link = page < 20 ? { link: `<${value.origin}${value.pathname}?per_page=100&page=${page + 1}>; rel="next"` } : {};
        return response(200, [release(page)], link);
      }
      if (value.pathname.endsWith("/commits")) {
        return Number(value.searchParams.get("page")) === 20 ? response(200, [commit(sha("a"))]) : response(200, [commit(sha("b"))]);
      }
      if (value.hostname === "api.ossinsight.io") return new Response(JSON.stringify(oss([])), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("unexpected URL");
    },
  }), /logical request cap exceeded/);
});
