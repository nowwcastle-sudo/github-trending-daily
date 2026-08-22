import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCache,
  extractRepos,
  mergeRepository,
  normalizeEstimatedRows,
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
  const capped = Array.from({ length: 501 }, (_, index) => ({
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    stargazers: index,
  }));
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
  assert.equal(normalizeEstimatedRows(capped).length, 500);
  assert.throws(() => normalizeEstimatedRows(null), /array/i);
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
