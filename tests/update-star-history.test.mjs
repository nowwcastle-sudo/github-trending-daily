import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCache,
  extractRepos,
  mergeRepository,
  normalizeEstimatedRows,
  seoulDate,
  updateCache,
} from "../scripts/update-star-history.mjs";

const markedPage = repos => `<!doctype html>
<script>
// GENERATED:TRENDING-REPOS:START
const REPOS = ${JSON.stringify(repos)};
// GENERATED:TRENDING-REPOS:END
</script>`;

const repos = (count = 10) => Array.from({ length: count }, (_, index) => ({
  slug: `Owner/Repo-${index}`,
  stars: index + 10,
  ignored: true,
}));

async function temporaryFiles(current = repos()) {
  const directory = await mkdtemp(join(tmpdir(), "star-history-test-"));
  const htmlPath = join(directory, "index.html");
  const cachePath = join(directory, "star-history.json");
  await writeFile(htmlPath, markedPage(current), "utf8");
  return { directory, htmlPath, cachePath };
}

function responseMap(current, overrides = new Map()) {
  return new Map(current.map(repo => [
    repo.slug.toLowerCase(),
    overrides.get(repo.slug.toLowerCase()) ?? {
      ok: true,
      json: async () => ({ data: { rows: [] } }),
    },
  ]));
}

function slugFromUrl(url) {
  const [, encoded] = new URL(url).pathname.split("/repos/");
  const [owner, name] = encoded.split("/stargazers/")[0].split("/");
  return `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`.toLowerCase();
}

test("extractRepos reads the one generated region and returns only current identity fields", () => {
  assert.deepEqual(extractRepos(markedPage(repos())), repos().map(({ slug, stars }) => ({ slug, stars })));
});

test("extractRepos fails closed on marker, shape, size, and identity violations", () => {
  assert.throws(() => extractRepos("<html></html>"), /exactly one.*REPOS/i);
  assert.throws(
    () => extractRepos(`${markedPage(repos())}\n// GENERATED:TRENDING-REPOS:START`),
    /exactly one.*REPOS/i,
  );
  assert.throws(
    () => extractRepos(markedPage(repos()).replace("const REPOS =", "let REPOS =")),
    /malformed/i,
  );
  assert.throws(() => extractRepos(markedPage(repos(9))), /10-75/);
  assert.throws(() => extractRepos(markedPage(repos(76))), /10-75/);

  const invalidSlug = repos();
  invalidSlug[0].slug = "not-a-slug";
  assert.throws(() => extractRepos(markedPage(invalidSlug)), /slug/i);

  const duplicate = repos();
  duplicate[1].slug = duplicate[0].slug.toLowerCase();
  assert.throws(() => extractRepos(markedPage(duplicate)), /duplicate/i);

  const invalidStars = repos();
  invalidStars[0].stars = -1;
  assert.throws(() => extractRepos(markedPage(invalidStars)), /stars/i);
});

test("normalizeEstimatedRows sorts, deduplicates, caps, and ignores malformed rows without coercion", () => {
  const points = normalizeEstimatedRows([
    { date: "2026-08-01", stargazers: "12" },
    { date: "2026-07-01", stargazers: 10 },
    { date: "2026-08-01", stargazers: "13" },
    { date: "2026-02-30", stargazers: "99" },
    { date: "2026-09-01", stargazers: "-1" },
    { date: "2026-10-01", stargazers: " 14 " },
    { date: "2026-11-01", stargazers: null },
  ]);

  assert.deepEqual(points, [
    { date: "2026-07-01", stars: 10 },
    { date: "2026-08-01", stars: 13 },
  ]);
  assert.throws(() => normalizeEstimatedRows(null), /array/i);
});

test("normalizeEstimatedRows keeps the newest 500 valid dates without mutating input", () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    stargazers: index,
  }));
  const before = structuredClone(rows);

  const points = normalizeEstimatedRows(rows);

  assert.equal(points.length, 500);
  assert.equal(points[0].date, rows[1].date);
  assert.equal(points.at(-1).date, rows.at(-1).date);
  assert.deepEqual(rows, before);
});

test("normalizeEstimatedRows does not let early invalid or duplicate rows consume the cap", () => {
  const later = Array.from({ length: 500 }, (_, index) => ({
    date: new Date(Date.UTC(2021, 0, index + 1)).toISOString().slice(0, 10),
    stargazers: index + 10,
  }));
  const rows = [
    { date: "invalid", stargazers: 1 },
    { date: "2020-01-01", stargazers: 1 },
    { date: "2020-01-01", stargazers: 2 },
    ...later,
  ];

  const points = normalizeEstimatedRows(rows);

  assert.equal(points.length, 500);
  assert.equal(points[0].date, later[0].date);
  assert.deepEqual(points.at(-1), { date: later.at(-1).date, stars: later.at(-1).stargazers });
});

test("mergeRepository preserves failed estimates and records today's exact observation", () => {
  const prior = {
    slug: "owner/repo-0",
    estimated: [
      { date: "2026-08-01", stars: 8 },
      { date: "invalid", stars: 99 },
    ],
    observed: [
      { date: "2026-08-22", stars: 9 },
      { date: "2026-08-21", stars: 8 },
    ],
  };

  assert.deepEqual(mergeRepository({ slug: "Owner/Repo-0", stars: 10 }, prior, null, "2026-08-22"), {
    slug: "Owner/Repo-0",
    estimated: [{ date: "2026-08-01", stars: 8 }],
    observed: [
      { date: "2026-08-21", stars: 8 },
      { date: "2026-08-22", stars: 10 },
    ],
  });
  assert.deepEqual(
    mergeRepository({ slug: "Owner/Repo-0", stars: 10 }, prior, [], "2026-08-22").estimated,
    [],
  );
});

test("mergeRepository retains only the latest 730 sorted, deduplicated observations", () => {
  const observed = Array.from({ length: 731 }, (_, index) => ({
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    stars: index,
  }));
  observed.push({ ...observed[730], stars: 9999 });

  const merged = mergeRepository(
    { slug: "owner/repo", stars: 10000 },
    { observed },
    [],
    "2026-08-22",
  );

  assert.equal(merged.observed.length, 730);
  assert.deepEqual(merged.observed.at(-1), { date: "2026-08-22", stars: 10000 });
  assert.ok(merged.observed.every((point, index, all) => index === 0 || all[index - 1].date < point.date));
});

test("buildCache matches identities case-insensitively and emits current repositories only", () => {
  const current = repos();
  const priorCache = {
    version: 1,
    generatedAt: "2026-08-21",
    repositories: [
      {
        slug: "owner/repo-0",
        estimated: [{ date: "2026-07-01", stars: 5 }],
        observed: [],
        ignored: true,
      },
      { slug: "stale/repo", estimated: [], observed: [] },
    ],
  };
  const responses = new Map([
    ["OWNER/REPO-1", [{ date: "2026-08-01", stargazers: "11" }]],
  ]);

  const cache = buildCache(current, priorCache, responses, "2026-08-22");

  assert.deepEqual(Object.keys(cache), ["version", "generatedAt", "repositories"]);
  assert.equal(cache.version, 1);
  assert.equal(cache.generatedAt, "2026-08-22");
  assert.deepEqual(cache.repositories.map(entry => entry.slug), current.map(repo => repo.slug));
  assert.deepEqual(cache.repositories[0].estimated, [{ date: "2026-07-01", stars: 5 }]);
  assert.deepEqual(cache.repositories[1].estimated, [{ date: "2026-08-01", stars: 11 }]);
  assert.ok(cache.repositories.every(entry => entry.observed.at(-1).stars === current.find(repo => repo.slug === entry.slug).stars));
});

test("buildCache rejects invalid dates and ambiguous case-insensitive cache identities", () => {
  const current = repos();
  const responses = new Map();
  assert.throws(() => buildCache(current, null, responses, "2026-02-30"), /date/i);
  assert.throws(
    () => buildCache(current, {
      version: 1,
      repositories: [
        { slug: "Owner/Repo-0", estimated: [], observed: [] },
        { slug: "owner/repo-0", estimated: [], observed: [] },
      ],
    }, responses, "2026-08-22"),
    /duplicate.*cache/i,
  );
});

test("seoulDate changes at 15:00 UTC", () => {
  assert.equal(seoulDate(new Date("2026-08-21T14:59:59.999Z")), "2026-08-21");
  assert.equal(seoulDate(new Date("2026-08-21T15:00:00.000Z")), "2026-08-22");
});

test("updateCache keeps a failed repository, prunes stale slugs, and reports changed", async t => {
  const current = repos();
  const paths = await temporaryFiles(current);
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  await writeFile(paths.cachePath, `${JSON.stringify({
    version: 1,
    generatedAt: "2026-08-21",
    repositories: [
      { slug: current[1].slug, estimated: [{ date: "2026-07-01", stars: 8 }], observed: [] },
      { slug: "stale/repo", estimated: [], observed: [] },
    ],
  }, null, 2)}\n`, "utf8");
  const responses = responseMap(current, new Map([
    [current[0].slug.toLowerCase(), {
      ok: true,
      json: async () => ({ data: { rows: [{ date: "2026-08-01", stargazers: "9" }] } }),
    }],
    [current[1].slug.toLowerCase(), { ok: false, status: 503 }],
  ]));

  const result = await updateCache({
    htmlPath: paths.htmlPath,
    cachePath: paths.cachePath,
    date: "2026-08-22",
    fetchImpl: async url => responses.get(slugFromUrl(url)),
    log: () => {},
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.failed, [current[1].slug]);
  const saved = JSON.parse(await readFile(paths.cachePath, "utf8"));
  assert.deepEqual(saved.repositories.map(item => item.slug), current.map(repo => repo.slug));
  assert.deepEqual(saved.repositories[0].estimated, [{ date: "2026-08-01", stars: 9 }]);
  assert.deepEqual(saved.repositories[1].estimated, [{ date: "2026-07-01", stars: 8 }]);
});

test("updateCache treats missing data.rows as a partial failure and preserves estimates", async t => {
  const current = repos();
  const paths = await temporaryFiles(current);
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  await writeFile(paths.cachePath, `${JSON.stringify({
    version: 1,
    generatedAt: "2026-08-21",
    repositories: current.map(repo => ({
      slug: repo.slug,
      estimated: [{ date: "2026-07-01", stars: repo.stars - 1 }],
      observed: [],
    })),
  }, null, 2)}\n`, "utf8");
  const responses = responseMap(current, new Map([
    [current[0].slug.toLowerCase(), { ok: true, json: async () => ({ data: {} }) }],
  ]));

  const result = await updateCache({
    ...paths,
    date: "2026-08-22",
    fetchImpl: async url => responses.get(slugFromUrl(url)),
    log: () => {},
  });

  assert.deepEqual(result.failed, [current[0].slug]);
  const saved = JSON.parse(await readFile(paths.cachePath, "utf8"));
  assert.deepEqual(saved.repositories[0].estimated, [{ date: "2026-07-01", stars: 9 }]);
});

test("updateCache preserves estimates when non-empty rows contain no valid points", async t => {
  const current = repos();
  const paths = await temporaryFiles(current);
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  await writeFile(paths.cachePath, `${JSON.stringify({
    version: 1,
    generatedAt: "2026-08-21",
    repositories: current.map(repo => ({
      slug: repo.slug,
      estimated: [{ date: "2026-07-01", stars: repo.stars - 1 }],
      observed: [],
    })),
  }, null, 2)}\n`, "utf8");
  const responses = responseMap(current, new Map([
    [current[0].slug.toLowerCase(), {
      ok: true,
      json: async () => ({ data: { rows: [{ date: "invalid", stargazers: "not-a-number" }] } }),
    }],
    [current[1].slug.toLowerCase(), {
      ok: true,
      json: async () => ({ data: { rows: [
        { date: "invalid", stargazers: "not-a-number" },
        { date: "2026-08-01", stargazers: "20" },
      ] } }),
    }],
  ]));
  const logs = [];

  const result = await updateCache({
    ...paths,
    date: "2026-08-22",
    fetchImpl: async url => responses.get(slugFromUrl(url)),
    log: message => logs.push(message),
  });

  assert.deepEqual(result.failed, [current[0].slug]);
  assert.deepEqual(logs, [`${current[0].slug}: invalid data.rows`]);
  const saved = JSON.parse(await readFile(paths.cachePath, "utf8"));
  assert.deepEqual(saved.repositories[0].estimated, [{ date: "2026-07-01", stars: 9 }]);
  assert.deepEqual(saved.repositories[1].estimated, [{ date: "2026-08-01", stars: 20 }]);
});

test("updateCache never logs messages thrown by fetch or JSON parsing", async t => {
  const current = repos();
  const paths = await temporaryFiles(current);
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  const fetchSecret = "FETCH_SECRET_SENTINEL";
  const jsonSecret = "JSON_SECRET_SENTINEL";
  const statusSecret = "STATUS_SECRET_SENTINEL";
  const logs = [];

  const result = await updateCache({
    ...paths,
    date: "2026-08-22",
    fetchImpl: async url => {
      const slug = slugFromUrl(url);
      if (slug === current[0].slug.toLowerCase()) throw new Error(fetchSecret);
      if (slug === current[1].slug.toLowerCase()) {
        return { ok: true, json: async () => { throw new Error(jsonSecret); } };
      }
      if (slug === current[2].slug.toLowerCase()) return { ok: false, status: statusSecret };
      return { ok: true, json: async () => ({ data: { rows: [] } }) };
    },
    log: message => logs.push(message),
  });

  assert.deepEqual(result.failed, [current[0].slug, current[1].slug, current[2].slug]);
  assert.deepEqual(logs, [
    `${current[0].slug}: request failed`,
    `${current[1].slug}: invalid JSON`,
    `${current[2].slug}: request failed`,
  ]);
  assert.doesNotMatch(logs.join("\n"), new RegExp(`${fetchSecret}|${jsonSecret}|${statusSecret}`));
});

test("updateCache distinguishes a successful empty history from a failed request", async t => {
  const current = repos();
  const paths = await temporaryFiles(current);
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  await writeFile(paths.cachePath, `${JSON.stringify({
    version: 1,
    generatedAt: "2026-08-21",
    repositories: current.map(repo => ({
      slug: repo.slug,
      estimated: [{ date: "2026-07-01", stars: repo.stars - 1 }],
      observed: [],
    })),
  }, null, 2)}\n`, "utf8");
  const responses = responseMap(current);

  await updateCache({
    ...paths,
    date: "2026-08-22",
    fetchImpl: async url => responses.get(slugFromUrl(url)),
    log: () => {},
  });

  const saved = JSON.parse(await readFile(paths.cachePath, "utf8"));
  assert.ok(saved.repositories.every(entry => entry.estimated.length === 0));
});

test("updateCache creates a missing cache and fetches repositories sequentially", async t => {
  const current = repos();
  const paths = await temporaryFiles(current);
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  let active = 0;
  let maximumActive = 0;

  const result = await updateCache({
    ...paths,
    date: "2026-08-22",
    fetchImpl: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return { ok: true, json: async () => ({ data: { rows: [] } }) };
    },
    log: () => {},
  });

  assert.equal(result.changed, true);
  assert.equal(maximumActive, 1);
  assert.match(await readFile(paths.cachePath, "utf8"), /\n$/);
  assert.deepEqual(await readdir(paths.directory), ["index.html", "star-history.json"]);
});

test("updateCache does not rewrite a byte-identical repository payload", async t => {
  const current = repos();
  const paths = await temporaryFiles(current);
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  const responses = responseMap(current);
  const options = {
    ...paths,
    date: "2026-08-22",
    fetchImpl: async url => responses.get(slugFromUrl(url)),
    log: () => {},
  };
  await updateCache(options);
  const before = await readFile(paths.cachePath, "utf8");

  const result = await updateCache(options);

  assert.equal(result.changed, false);
  assert.equal(await readFile(paths.cachePath, "utf8"), before);
});

test("updateCache rejects malformed cache JSON and unsafe cache schema", async t => {
  const paths = await temporaryFiles();
  t.after(() => rm(paths.directory, { recursive: true, force: true }));
  const fetchImpl = async () => assert.fail("unsafe cache must fail before network access");
  await writeFile(paths.cachePath, "{broken", "utf8");
  await assert.rejects(updateCache({ ...paths, date: "2026-08-22", fetchImpl }), /JSON|cache/i);

  await writeFile(paths.cachePath, JSON.stringify({
    version: 1,
    generatedAt: "2026-08-21",
    repositories: [{ slug: "owner/repo", estimated: [{ date: "bad", stars: 1 }], observed: [] }],
  }), "utf8");
  await assert.rejects(updateCache({ ...paths, date: "2026-08-22", fetchImpl }), /cache/i);
});
