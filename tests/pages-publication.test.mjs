import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  VERSION_1_BASE_PATHS,
  buildLegacyRecoveryArtifact,
  buildPagesArtifact,
  expectedVersion1Paths,
  inspectProductionState,
  parseEmbeddedRepos,
} from "../scripts/build-pages-artifact.mjs";
import { prepareRefreshCandidate, verifyCandidateMutations } from "../scripts/prepare-refresh-candidate.mjs";
import { probeArtifactDirectory, probeProduction } from "../scripts/probe-production.mjs";
import { createRunContext } from "../scripts/run-context.mjs";
import { bindFrozenEventEnvelope } from "../scripts/collect-repository-events.mjs";
import { buildLatestFeed } from "../scripts/update-latest-feed.mjs";
import { buildFrozenFactsEnvelope, renderFrozenCandidate } from "../scripts/update-trending.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceSha = "a".repeat(40);
const snapshotId = "20260826100700-0123456789abcdef";
const LEGACY_PROBE_POSITIVE_PATHS = Object.freeze([
  "data/latest.json",
  "index.html",
  "readmes/owner__both.md",
  "readmes/owner__readme-only.md",
  "translations/owner__both.json",
  "translations/owner__translation-only.json",
]);
const LEGACY_PROBE_MISSING_PATHS = Object.freeze([
  "readmes/owner__neither.md",
  "readmes/owner__translation-only.md",
  "translations/owner__neither.json",
  "translations/owner__readme-only.json",
]);

test("production state inspection validates v0 v1 explicitly and preserves verified 404", () => {
  const fileHash = "b".repeat(64);
  const v0Bytes = Buffer.from(JSON.stringify({ version: 0, legacyBootstrap: true, sourceSha, snapshotId: null, files: { "index.html": fileHash } }));
  const v1Bytes = Buffer.from(JSON.stringify({ version: 1, sourceSha, snapshotId, files: { "index.html": fileHash } }));
  assert.deepEqual(inspectProductionState({ httpStatus: "200", manifestBytes: v0Bytes, fallbackSourceSha: "f".repeat(40) }), {
    manifestStatus: "verified_v0",
    manifestSha256: createHash("sha256").update(v0Bytes).digest("hex"),
    version: 0,
    sourceSha,
    snapshotId: null,
  });
  assert.deepEqual(inspectProductionState({ httpStatus: "200", manifestBytes: v1Bytes, fallbackSourceSha: "f".repeat(40) }), {
    manifestStatus: "verified_v1",
    manifestSha256: createHash("sha256").update(v1Bytes).digest("hex"),
    version: 1,
    sourceSha,
    snapshotId,
  });
  assert.deepEqual(inspectProductionState({ httpStatus: "404", manifestBytes: Buffer.from("not trusted"), fallbackSourceSha: sourceSha }), {
    manifestStatus: "verified_404",
    manifestSha256: null,
    version: 0,
    sourceSha,
    snapshotId: null,
  });
  const malformedV0 = Buffer.from(JSON.stringify({ version: 0, sourceSha, snapshotId: null, files: { "index.html": fileHash } }));
  assert.throws(() => inspectProductionState({ httpStatus: "200", manifestBytes: malformedV0, fallbackSourceSha: sourceSha }), /invalid|version/i);
  assert.throws(() => inspectProductionState({ httpStatus: "500", manifestBytes: Buffer.alloc(0), fallbackSourceSha: sourceSha }), /status/i);
});

async function serveArtifact(root, { mimeOverride = {}, redirect = null, requests = null, requestHeaders = null } = {}) {
  const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".md": "text/markdown; charset=utf-8" };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    requests?.push(requestUrl);
    requestHeaders?.push(request.headers);
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (relative === redirect) { response.writeHead(302, { location: "/index.html" }); response.end(); return; }
    try {
      const bytes = await readFile(join(root, ...relative.split("/")));
      response.writeHead(200, { "content-type": mimeOverride[relative] ?? mime[extname(relative)] ?? "application/octet-stream", "content-length": bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function exactLegacyProbeToken(requests) {
  assert.ok(requests.some(url => url.pathname.endsWith("/deployment-manifest.json")));
  const tokens = requests.map(url => url.searchParams.get("probe"));
  assert.ok(tokens.every(token => /^[a-f0-9-]{36}$/.test(token ?? "")));
  assert.equal(new Set(tokens).size, 1);
  assert.deepEqual(
    requests.map(url => decodeURIComponent(url.pathname).replace(/^\/+/, "")).sort(),
    ["deployment-manifest.json", ...LEGACY_PROBE_POSITIVE_PATHS, ...LEGACY_PROBE_MISSING_PATHS].sort(),
  );
  return tokens[0];
}

function assertProbeConnectionsClose(requests, requestHeaders) {
  assert.equal(requestHeaders.length, requests.length);
  assert.ok(requestHeaders.length > 0);
  assert.ok(requestHeaders.every(headers => headers.connection === "close"));
}

async function rewriteArtifactFile(artifact, relative, bytes) {
  await writeFile(join(artifact, ...relative.split("/")), bytes);
  const manifestPath = join(artifact, "deployment-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[relative] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeTree(directory, paths) {
  for (const path of paths) {
    const target = join(directory, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, `${path}\n`);
  }
}

const summaryLocales = ["en", "ko", "zh-CN", "es", "ja"];
const summaryFields = ["goal", "usage", "pros", "cons", "fit"];
const frozenMarkdown = "# Repository\n\nCanonical README evidence for the repository.";
const frozenContentSha256 = createHash("sha256").update(frozenMarkdown).digest("hex");

function sourceEntry(slug = "owner/one", {
  path = "README.md",
  blobSha = "b".repeat(40),
  contentSha256 = "c".repeat(64),
} = {}) {
  return {
    kind: "readme",
    slug: slug.toLowerCase(),
    path,
    blob_sha: blobSha,
    content_sha256: contentSha256,
    provider: "claude-cli-oauth",
    interface: "claude-p",
    cli_version: "2.1.241",
    auth_method: "oauth_token",
    api_provider: "firstParty",
    model: "claude-sonnet-5",
    schema_version: 3,
    prompt_schema_version: 2,
    translation_applicable: false,
  };
}

function summaryBundle(label = "repository") {
  return Object.fromEntries(summaryLocales.map(locale => [locale, Object.fromEntries(
    summaryFields.map(field => [field, `${label} ${locale} ${field} detailed technical evidence`]),
  )]));
}

const validClassification = () => ({
  tag_rule_version: 1,
  field_tags: ["ai-ml", "dev-tools"],
  form_tags: ["agent", "library"],
});
const classificationMutations = [
  ["missing version", repo => { delete repo.tag_rule_version; }],
  ["missing field tags", repo => { delete repo.field_tags; }],
  ["missing form tags", repo => { delete repo.form_tags; }],
  ["unknown field tag", repo => { repo.field_tags = ["unknown"]; }],
  ["unknown form tag", repo => { repo.form_tags = ["unknown"]; }],
  ["duplicate field tag", repo => { repo.field_tags = ["ai-ml", "ai-ml"]; }],
  ["duplicate form tag", repo => { repo.form_tags = ["agent", "agent"]; }],
  ["out-of-order field tags", repo => { repo.field_tags = ["dev-tools", "ai-ml"]; }],
  ["out-of-order form tags", repo => { repo.form_tags = ["library", "agent"]; }],
  ["mixed unclassified", repo => { repo.field_tags = ["unclassified", "ai-ml"]; }],
  ["drifted version", repo => { repo.tag_rule_version = 2; }],
];

test("synthetic provenance-less v0 page is rejected as a v1 classification candidate", () => {
  const rawV0Page = `<script>\nconst REPOS = ${JSON.stringify([{ slug: "owner/one" }])};\n</script>\n`;
  assert.throws(
    () => parseEmbeddedRepos(rawV0Page, "synthetic raw v0 page REPOS", { requireClassification: true }),
    /classification/i,
  );
});

test("version-1 page REPOS and latest validators reject incomplete or noncanonical classifications", () => {
  for (const [, mutate] of classificationMutations) {
    const pageRepo = { slug: "owner/one", ...validClassification() };
    mutate(pageRepo);
    assert.throws(
      () => parseEmbeddedRepos(`<script>\nconst REPOS = ${JSON.stringify([pageRepo])};\n</script>\n`, "page REPOS", { requireClassification: true }),
      /classification/i,
    );

    const latestRepo = { slug: "owner/one", ...validClassification() };
    mutate(latestRepo);
    assert.throws(
      () => expectedVersion1Paths({ repos: [latestRepo] }, { version: 3, sources: {} }),
      /classification/i,
    );
  }
});

function frozenRepository(context, index) {
  const slug = `owner/repo-${index}`;
  const profile = {
    slug,
    display_slug: slug,
    description: null,
    primary_language: null,
    topics: [],
    license_spdx: null,
    archived: false,
    is_fork: false,
    default_branch: "main",
    created_at: context.observedAtUtc,
    field_tags: ["unclassified"],
    form_tags: [],
    tag_rule_version: 1,
  };
  const factSha = createHash("sha256").update(`fact-${index}`).digest("hex");
  return {
    ...profile,
    default_branch_head_sha: (index + 1).toString(16).padStart(40, "0"),
    display_rank: index + 1,
    rank_daily: index + 1,
    gain_daily: index,
    rank_weekly: null,
    gain_weekly: null,
    rank_monthly: null,
    gain_monthly: null,
    language_color: "#112233",
    stars: index + 1,
    forks: index,
    watchers_count: index + 1,
    subscribers: index,
    open_issues_and_pull_requests: index,
    contributors: index + 1,
    updated_at: context.observedAtUtc,
    pushed_at: null,
    readme_status: "present",
    readme_path: "README.md",
    readme_blob_sha: "b".repeat(40),
    readme_content_sha256: frozenContentSha256,
    readme_locale: null,
    readme_variants: [],
    provenance: {
      repository: { api_path: `/repos/${slug}`, fact_sha256: factSha },
      contributors: { api_path: `/repos/${slug}/contributors`, fact_sha256: factSha },
      default_branch_head: { api_path: `/repos/${slug}/commits/main`, fact_sha256: factSha },
      readme: { api_path: `/repos/${slug}/readme`, blob_api_path: `/repos/${slug}/git/blobs/${"b".repeat(40)}`, status: "present", path: "README.md", blob_sha: "b".repeat(40), content_sha256: frozenContentSha256 },
      trending: {
        daily: { source_path: "/trending?since=daily", rank: index + 1, gain: index, language_color: "#112233", fact_sha256: factSha },
        weekly: { source_path: "/trending?since=weekly", rank: null, gain: null, language_color: null, fact_sha256: factSha },
        monthly: { source_path: "/trending?since=monthly", rank: null, gain: null, language_color: null, fact_sha256: factSha },
        language_color_selection: { rule: "daily_then_weekly_then_monthly", selected_period: "daily", value: "#112233" },
      },
    },
  };
}

async function artifactContract(source, latest, sources, identity = snapshotId) {
  const artifacts = [];
  for (const artifact_path of expectedVersion1Paths(latest, sources)) {
    const bytes = await readFile(join(source, ...artifact_path.split("/")));
    artifacts.push({
      artifact_path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_size: bytes.length,
    });
  }
  return { version: 1, snapshotId: identity, artifacts };
}

test("version-1 artifact path set is exact and contains no full README translations", () => {
  assert.deepEqual(VERSION_1_BASE_PATHS, [
    "auth-lifecycle.js",
    "changes.xml",
    "current-view-export.js",
    "data/latest.json",
    "data/membership-status.json",
    "favorite-sync.js",
    "favorites.js",
    "feed.xml",
    "firebase-client.js",
    "firebase-config.json",
    "hidden-repos.js",
    "index.html",
    "membership-history.js",
    "readme-markdown.js",
    "refresh-schedule.js",
    "repo-filters.js",
    "site-i18n.js",
    "star-history.js",
    "star-history.json",
    "ui-motion.js",
  ]);
  assert.equal(VERSION_1_BASE_PATHS.filter(path => path === "auth-lifecycle.js").length, 1);
  const python = spawnSync(process.env.PYTHON ?? "python", ["-c", "import json; from scripts.record_repository_observations import PAGES_BASE_ARTIFACT_PATHS; print(json.dumps(PAGES_BASE_ARTIFACT_PATHS))"], { cwd: root, encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), VERSION_1_BASE_PATHS);
  const latest = { repos: [{ slug: "Owner/One", ...validClassification() }, { slug: "owner/two", ...validClassification() }] };
  const sources = { version: 3, sources: {
    "Owner/One": sourceEntry("owner/one"),
    "owner/two": sourceEntry("owner/two"),
  } };
  assert.deepEqual(expectedVersion1Paths(latest, sources), [...VERSION_1_BASE_PATHS].sort());
  assert.throws(
    () => expectedVersion1Paths(latest, { version: 3, sources: { ...sources.sources, "old/stale": sourceEntry("old/stale") } }),
    /active set/i,
  );
  assert.ok(!VERSION_1_BASE_PATHS.some(path => path.endsWith(".sqlite")));
  assert.ok(!VERSION_1_BASE_PATHS.includes("data/translation-sources.json"));
});

test("frozen manifest evidence survives the actual render to recorder boundary", async t => {
  const directory = await mkdtemp(join(tmpdir(), "render-record-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = createRunContext(new Date("2026-08-29T00:07:00.000Z"));
  const repositories = Array.from({ length: 10 }, (_, index) => frozenRepository(context, index));
  const productionManifestSha256 = "f".repeat(64);
  const facts = buildFrozenFactsEnvelope({
    context,
    inputSourceSha: "c".repeat(40),
    hydrationSourceSha: "b".repeat(40),
    productionManifestStatus: "verified_v0",
    productionManifestSha256,
    repositories,
    readmes: Object.fromEntries(repositories.map(repository => [repository.slug, {
      path: repository.readme_path,
      blobSha: repository.readme_blob_sha,
      contentSha256: repository.readme_content_sha256,
      markdown: frozenMarkdown,
    }])),
    trendingSourceSha256: {
      daily: "1".repeat(64), weekly: "2".repeat(64), monthly: "3".repeat(64),
    },
    budgetReceipt: {
      logicalRequests: 43,
      httpAttempts: 43,
      originEpochMs: Date.parse(context.observedAtUtc),
      eventDeadlineEpochMs: Date.parse(context.observedAtUtc) + 15 * 60_000,
    },
  });
  const events = bindFrozenEventEnvelope(facts, {
    heads: repositories.map(repository => ({
      slug: repository.slug,
      branch: repository.default_branch,
      headSha: repository.default_branch_head_sha,
      transition: "baseline",
    })),
    releases: [],
    latestReleaseIds: Object.fromEntries(repositories.map(repository => [repository.slug, null])),
    commits: [],
    estimates: repositories.map(repository => ({
      slug: repository.slug,
      rows: [],
      sourcePayloadSha256: "d".repeat(64),
      publicRows: [],
    })),
    budgetReceipt: { ...facts.budgetReceipt, logicalRequests: 83, httpAttempts: 83 },
  });
  const enrichmentIndex = {
    version: 1,
    snapshotId: facts.snapshotId,
    activeSetSha256: facts.activeSetSha256,
    factsSha256: facts.factsSha256,
    sourceSetSha256: facts.sourceSetSha256,
    runContextSha256: facts.runContextSha256,
    eventsSha256: events.completeSetSha256,
    repositories: Object.fromEntries(repositories.map(repository => {
      const source = sourceEntry(repository.slug, {
        path: repository.readme_path,
        blobSha: repository.readme_blob_sha,
        contentSha256: repository.readme_content_sha256,
      });
      const summaries = summaryBundle(repository.slug);
      return [repository.slug, {
        summary: {
          content: summaries.en,
          source,
        },
        summaries,
        evidence: Object.fromEntries(summaryFields.map(field => [field, []])),
        invariants: [],
        inference_fields: [],
      }];
    })),
  };
  const factsPath = join(directory, "facts.json");
  const eventsPath = join(directory, "events.json");
  const enrichmentPath = join(directory, "enrichment.json");
  const snapshotPath = join(directory, "recorder-snapshot.json");
  const candidateRoot = join(directory, "candidate");
  const candidateData = join(candidateRoot, "data");
  await mkdir(candidateData, { recursive: true });
  await Promise.all([
    writeFile(factsPath, `${JSON.stringify(facts)}\n`),
    writeFile(eventsPath, `${JSON.stringify(events)}\n`),
    writeFile(enrichmentPath, `${JSON.stringify(enrichmentIndex)}\n`),
  ]);
  await renderFrozenCandidate({
    factsPath,
    eventsPath,
    enrichmentIndexPath: enrichmentPath,
    pageTemplatePath: join(root, "index.html"),
    pageOut: join(candidateRoot, "index.html"),
    cacheOut: join(candidateData, "repo-summaries.json"),
    snapshotOut: snapshotPath,
  });
  const renderedSnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  assert.equal(renderedSnapshot.productionManifestStatus, "verified_v0");
  assert.equal(renderedSnapshot.inputManifestSha256, productionManifestSha256);
  assert.equal(renderedSnapshot.hydrationSourceSha, facts.hydrationSourceSha);

  const python = process.env.PYTHON ?? "python";
  const legacyPublic = join(directory, "legacy-public.json");
  const baselineReceipt = join(directory, "baseline-receipt.json");
  const parentEvidence = join(directory, "parent-evidence.json");
  const priorHeads = join(directory, "prior-heads.json");
  const missingParent = join(directory, "missing-parent.sqlite");
  const legacyStar = join(root, "data", "star-observations.sqlite");
  const legacyMembership = join(root, "data", "trending-membership.sqlite");
  await writeFile(legacyPublic, `${JSON.stringify({ version: 1, generatedAt: "2026-08-29", repositories: [] }, null, 2)}\n`);
  const receipt = spawnSync(python, [
    join(root, "scripts", "record_repository_observations.py"), "create-baseline-receipt",
    "--legacy-star-database", legacyStar,
    "--legacy-membership-database", legacyMembership,
    "--legacy-public-star-history", legacyPublic,
    "--output", baselineReceipt,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(receipt.status, 0, receipt.stderr);
  const exported = spawnSync(python, [
    join(root, "scripts", "derive_repository_artifacts.py"), "export-parent-inputs",
    "--parent-database", missingParent,
    "--baseline-receipt", baselineReceipt,
    "--expected-parent-snapshot", "none",
    "--production-source-sha", facts.hydrationSourceSha,
    "--parent-evidence-out", parentEvidence,
    "--prior-heads-out", priorHeads,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(exported.status, 0, exported.stderr);
  const recorded = spawnSync(python, [
    join(root, "scripts", "record_repository_observations.py"),
    "--parent-database", missingParent,
    "--candidate-database", join(candidateData, "repository-observations.sqlite"),
    "--snapshot", snapshotPath,
    "--events", eventsPath,
    "--enrichment-index", enrichmentPath,
    "--parent-evidence", parentEvidence,
    "--legacy-star-database", legacyStar,
    "--legacy-membership-database", legacyMembership,
    "--legacy-public-star-history", legacyPublic,
    "--readme-state", join(candidateData, "readme-state.json"),
  ], { cwd: root, encoding: "utf8" });
  assert.equal(recorded.status, 0, recorded.stderr);
  const inspected = spawnSync(python, ["-c", [
    "import json, sqlite3, sys",
    "from scripts.record_repository_observations import validate_schema",
    "connection=sqlite3.connect(sys.argv[1])",
    "validate_schema(connection)",
    "row=connection.execute('SELECT input_source_sha,input_manifest_sha256,repository_count FROM snapshot_runs').fetchone()",
    "print(json.dumps(row,separators=(',',':')))",
  ].join(";"), join(candidateData, "repository-observations.sqlite")], { cwd: root, encoding: "utf8" });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout), [facts.inputSourceSha, productionManifestSha256, 10]);
});

test("builder hashes only the exact allowlist and exact summary source envelope", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pages-builder-"));
  const source = join(directory, "source");
  const out = join(directory, "out");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(source);
  await writeTree(source, VERSION_1_BASE_PATHS);
  const latest = { snapshotId, repos: [{ slug: "owner/one", ...validClassification() }] };
  const sources = { version: 3, sources: { "owner/one": sourceEntry("owner/one") } };
  await writeFile(join(source, "data", "latest.json"), `${JSON.stringify(latest)}\n`);
  await writeFile(join(source, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  const validPage = `<script>\nconst REPOS = [${JSON.stringify({ slug: "owner/one", ...validClassification() })}];\n</script>\n`;
  await writeFile(join(source, "index.html"), validPage);
  await writeFile(join(source, "data", "private.sqlite"), "private");

  const contract = await artifactContract(source, latest, sources);
  const manifest = await buildPagesArtifact({ sourceRoot: source, outDir: out, sourceSha, snapshotId, artifactContract: contract });
  assert.deepEqual(Object.keys(manifest.files), expectedVersion1Paths(latest, sources));
  assert.equal(manifest.files["index.html"], createHash("sha256").update(validPage).digest("hex"));
  await assert.rejects(readFile(join(out, "data", "private.sqlite")));

  const invalidSources = structuredClone(sources);
  invalidSources.sources["owner/one"].prompt_schema_version = 1;
  await writeFile(join(source, "data", "translation-sources.json"), `${JSON.stringify(invalidSources)}\n`);
  await assert.rejects(
    buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "bad"), sourceSha, snapshotId, artifactContract: contract }),
    /summary source/i,
  );
  await writeFile(join(source, "data", "translation-sources.json"), `{"version":3,"version":3,"sources":{}}\n`);
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "duplicate-source"), sourceSha, snapshotId, artifactContract: contract }), /duplicate key/i);
  await writeFile(join(source, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"owner/one","slug":"owner/one"}];\n</script>\n');
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "duplicate-page-json"), sourceSha, snapshotId, artifactContract: contract }), /duplicate key/i);
  await writeFile(join(source, "index.html"), `<script>\nconst REPOS = ${JSON.stringify([{ slug: "Owner/One", ...validClassification() }, { slug: "owner/one", ...validClassification() }])};\n</script>\n`);
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "case-fold-page"), sourceSha, snapshotId, artifactContract: contract }), /duplicate|case-fold|identity/i);
});

test("builder rejects invalid page/latest classifications and requires exact equality", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pages-classification-"));
  const source = join(directory, "source");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(source);
  await writeTree(source, VERSION_1_BASE_PATHS);
  const base = { slug: "owner/one", ...validClassification() };
  const sources = { version: 3, sources: { "owner/one": sourceEntry("owner/one") } };
  const page = repo => `<script>\nconst REPOS = ${JSON.stringify([repo])};\n</script>\n`;
  const writeCandidate = async (latestRepo, pageRepo) => {
    await writeFile(join(source, "data", "latest.json"), `${JSON.stringify({ snapshotId, repos: [latestRepo] })}\n`);
    await writeFile(join(source, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
    await writeFile(join(source, "index.html"), page(pageRepo));
  };
  const candidateContract = async () => ({
    version: 1,
    snapshotId,
    artifacts: await Promise.all(VERSION_1_BASE_PATHS.map(async artifact_path => {
      const bytes = await readFile(join(source, ...artifact_path.split("/")));
      return { artifact_path, sha256: createHash("sha256").update(bytes).digest("hex"), byte_size: bytes.length };
    })),
  });
  await writeCandidate(base, base);
  await buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "valid"), sourceSha, snapshotId, artifactContract: await candidateContract() });

  for (const [label, mutate] of classificationMutations) {
    for (const target of ["page", "latest"]) {
      const latestRepo = structuredClone(base);
      const pageRepo = structuredClone(base);
      mutate(target === "page" ? pageRepo : latestRepo);
      await writeCandidate(latestRepo, pageRepo);
      await assert.rejects(
        buildPagesArtifact({ sourceRoot: source, outDir: join(directory, `${label}-${target}`), sourceSha, snapshotId, artifactContract: await candidateContract() }),
        /classification/i,
      );
    }
  }

  const mismatchedPage = { ...base, field_tags: ["dev-tools"] };
  await writeCandidate(base, mismatchedPage);
  await assert.rejects(
    buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "mismatch"), sourceSha, snapshotId, artifactContract: await candidateContract() }),
    /classification does not match latest/i,
  );
});

test("builder requires exact DB artifact path hash and size equality", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pages-artifact-contract-"));
  const source = join(directory, "source");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(source);
  await writeTree(source, VERSION_1_BASE_PATHS);
  const latest = { snapshotId, repos: [{ slug: "owner/one", ...validClassification() }] };
  const sources = { version: 3, sources: { "owner/one": sourceEntry("owner/one") } };
  await writeFile(join(source, "data", "latest.json"), `${JSON.stringify(latest)}\n`);
  await writeFile(join(source, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  await writeFile(join(source, "index.html"), `<script>\nconst REPOS = [${JSON.stringify({ slug: "owner/one", ...validClassification() })}];\n</script>\n`);
  const contract = await artifactContract(source, latest, sources);

  const missing = structuredClone(contract);
  missing.artifacts.pop();
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "missing"), sourceSha, snapshotId, artifactContract: missing }), /artifact.*path/i);

  const changedHash = structuredClone(contract);
  changedHash.artifacts[0].sha256 = "0".repeat(64);
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "hash"), sourceSha, snapshotId, artifactContract: changedHash }), /artifact.*hash/i);

  const changedSize = structuredClone(contract);
  changedSize.artifacts[0].byte_size += 1;
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "size"), sourceSha, snapshotId, artifactContract: changedSize }), /artifact.*size/i);

  const extra = structuredClone(contract);
  extra.artifacts.push({ artifact_path: "data/repository-observations.sqlite", sha256: "0".repeat(64), byte_size: 1 });
  await assert.rejects(buildPagesArtifact({ sourceRoot: source, outDir: join(directory, "extra"), sourceSha, snapshotId, artifactContract: extra }), /artifact.*path/i);
});

test("candidate preparation uses current committed code and production generated state", async t => {
  const outer = await mkdtemp(join(tmpdir(), "candidate-preparer-"));
  const directory = join(outer, "checkout");
  await mkdir(directory);
  t.after(() => rm(outer, { recursive: true, force: true }));
  const run = args => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run(["init", "-q"]).status, 0);
  run(["config", "user.name", "test"]); run(["config", "user.email", "test@example.invalid"]);
  await mkdir(join(directory, "data"));
  const productionPage = ["production shell", "<!-- GENERATED:TRENDING-DATE:START -->", "production date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [];", "// GENERATED:TRENDING-REPOS:END", "production footer"].join("\n");
  await writeFile(join(directory, "code.js"), "old code\n");
  await writeFile(join(directory, "index.html"), `${productionPage}\n`);
  await writeFile(join(directory, "data", "latest.json"), "production data\n");
  run(["add", "--", "code.js", "index.html", "data/latest.json"]); run(["commit", "-qm", "production"]);
  const productionSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const productionData = run(["show", `${productionSha}:data/latest.json`]).stdout;
  await writeFile(join(directory, "code.js"), "current code\n");
  const currentPage = ["current shell", "<!-- GENERATED:TRENDING-DATE:START -->", "failed current date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [{\"slug\":\"failed/current\"}];", "// GENERATED:TRENDING-REPOS:END", "current footer"].join("\n");
  await writeFile(join(directory, "index.html"), `${currentPage}\n`);
  await writeFile(join(directory, "data", "latest.json"), "failed main-only data\n");
  run(["add", "--", "code.js", "index.html", "data/latest.json"]); run(["commit", "-qm", "current"]);
  const checkoutSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const currentCode = run(["show", `${checkoutSha}:code.js`]).stdout;
  const out = join(outer, "candidate");
  await prepareRefreshCandidate({ checkoutRoot: directory, outDir: out, lastGoodSha: productionSha });
  assert.equal(await readFile(join(out, "code.js"), "utf8"), currentCode);
  assert.equal(await readFile(join(out, "data", "latest.json"), "utf8"), productionData);
  assert.equal(await readFile(join(out, "index.html"), "utf8"), ["current shell", "<!-- GENERATED:TRENDING-DATE:START -->", "production date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [];", "// GENERATED:TRENDING-REPOS:END", "current footer", ""].join("\n"));
  assert.equal(run(["rev-parse", "HEAD"]).stdout.trim(), checkoutSha);
});

test("post-generation boundary rejects base-code mutations and sidecar residue", async t => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-mutation-boundary-"));
  const baseline = join(directory, "baseline");
  const candidate = join(directory, "candidate");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(baseline); await mkdir(candidate);
  const page = ["shell", "<!-- GENERATED:TRENDING-DATE:START -->", "date", "<!-- GENERATED:TRENDING-DATE:END -->", "// GENERATED:TRENDING-REPOS:START", "const REPOS = [];", "// GENERATED:TRENDING-REPOS:END", "footer", ""].join("\n");
  for (const root of [baseline, candidate]) {
    await mkdir(join(root, "data"));
    await writeFile(join(root, "index.html"), page);
    await writeFile(join(root, "app.js"), "current code\n");
    await writeFile(join(root, "data", "latest.json"), "old generated\n");
  }
  await writeFile(join(candidate, "data", "latest.json"), "new generated\n");
  await verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate });
  const cli = spawnSync(process.execPath, [join(root, "scripts", "prepare-refresh-candidate.mjs"), "--verify-generated", baseline, "--candidate", candidate], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  await writeFile(join(candidate, "app.js"), "mutated base code\n");
  await assert.rejects(verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), /non-generated.*app\.js/i);
  await writeFile(join(candidate, "app.js"), "current code\n");
  await writeFile(join(candidate, "data", "trending-membership.sqlite-wal"), "sidecar\n");
  await assert.rejects(verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), /residue|sidecar|unexpected/i);
  await rm(join(candidate, "data", "trending-membership.sqlite-wal"));
  await link(join(candidate, "app.js"), join(candidate, "app-hardlink.js"));
  await assert.rejects(verifyCandidateMutations({ baselineRoot: baseline, candidateRoot: candidate }), /candidate hardlink rejected/i);
});

test("a version-0 recovery manifest produces the next candidate without bootstrap input", async t => {
  const outer = await mkdtemp(join(tmpdir(), "legacy-next-candidate-"));
  const checkout = join(outer, "checkout");
  const recoveryArtifact = join(outer, "recovery-artifact");
  const candidate = join(outer, "candidate");
  await mkdir(checkout);
  t.after(() => rm(outer, { recursive: true, force: true }));
  const run = args => spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
  assert.equal(run(["init", "-q"]).status, 0);
  run(["config", "user.name", "test"]); run(["config", "user.email", "test@example.invalid"]);
  await mkdir(join(checkout, "data"));
  await mkdir(join(checkout, "readmes"));
  await mkdir(join(checkout, "translations"));
  await writeFile(join(checkout, "index.html"), '<html>\n<!-- GENERATED:TRENDING-DATE:START -->\nlegacy date\n<!-- GENERATED:TRENDING-DATE:END -->\n// GENERATED:TRENDING-REPOS:START\nconst REPOS = [{"slug":"owner/both"},{"slug":"owner/readme-only"},{"slug":"owner/translation-only"},{"slug":"owner/neither"}];\n// GENERATED:TRENDING-REPOS:END\n</html>\n');
  await writeFile(join(checkout, "data", "latest.json"), "verified legacy data\n");
  await writeFile(join(checkout, "readmes", "owner__both.md"), "# Both\n");
  await writeFile(join(checkout, "readmes", "owner__readme-only.md"), "# README only\n");
  await writeFile(join(checkout, "readmes", "old__inactive.md"), "# Inactive\n");
  await writeFile(join(checkout, "translations", "owner__both.json"), '{"html":"<h1>Both</h1>"}\n');
  await writeFile(join(checkout, "translations", "owner__translation-only.json"), '{"html":"<h1>Translation only</h1>"}\n');
  await writeFile(join(checkout, "translations", "old__inactive.json"), '{"html":"<h1>Inactive</h1>"}\n');
  assert.equal(run(["add", "--", "index.html", "data/latest.json", "readmes/owner__both.md", "readmes/owner__readme-only.md", "readmes/old__inactive.md", "translations/owner__both.json", "translations/owner__translation-only.json", "translations/old__inactive.json"]).status, 0);
  assert.equal(run(["commit", "-qm", "verified legacy production"]).status, 0);
  const legacySourceSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const recovery = await buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: recoveryArtifact, sourceSha: legacySourceSha });
  assert.deepEqual({ version: recovery.version, sourceSha: recovery.sourceSha, snapshotId: recovery.snapshotId }, { version: 0, sourceSha: legacySourceSha, snapshotId: null });
  assert.deepEqual(Object.keys(recovery.files), [
    "data/latest.json",
    "index.html",
    "readmes/owner__both.md",
    "readmes/owner__readme-only.md",
    "translations/owner__both.json",
    "translations/owner__translation-only.json",
  ]);
  await probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout });
  const originalLegacyManifest = await readFile(join(recoveryArtifact, "deployment-manifest.json"));
  const inactiveReadme = await readFile(join(checkout, "readmes", "old__inactive.md"));
  const extraLegacyManifest = JSON.parse(originalLegacyManifest);
  extraLegacyManifest.files["readmes/old__inactive.md"] = createHash("sha256").update(inactiveReadme).digest("hex");
  await writeFile(join(recoveryArtifact, "readmes", "old__inactive.md"), inactiveReadme);
  await writeFile(join(recoveryArtifact, "deployment-manifest.json"), `${JSON.stringify(extraLegacyManifest, null, 2)}\n`);
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /manifest allowlist mismatch/i,
  );
  await writeFile(join(recoveryArtifact, "deployment-manifest.json"), originalLegacyManifest);
  await rm(join(recoveryArtifact, "readmes", "old__inactive.md"));
  const recoveryRequests = [];
  const recoveryRequestHeaders = [];
  const recoveryServer = await serveArtifact(recoveryArtifact, { requests: recoveryRequests, requestHeaders: recoveryRequestHeaders });
  let recoveryProbeToken;
  try {
    await probeProduction({ baseUrl: recoveryServer.baseUrl, legacyRecoverySha: legacySourceSha, gitRoot: checkout });
    recoveryProbeToken = exactLegacyProbeToken(recoveryRequests);
    assertProbeConnectionsClose(recoveryRequests, recoveryRequestHeaders);
  } finally {
    await recoveryServer.close();
  }
  const originalPresentReadme = await readFile(join(recoveryArtifact, "readmes", "owner__both.md"));
  await writeFile(join(recoveryArtifact, "readmes", "owner__both.md"), "# Altered\n");
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /legacy file mismatch/i,
  );
  await writeFile(join(recoveryArtifact, "readmes", "owner__both.md"), originalPresentReadme);
  const bootstrapRequests = [];
  const bootstrapRequestHeaders = [];
  const bootstrap = await serveArtifact(checkout, { requests: bootstrapRequests, requestHeaders: bootstrapRequestHeaders });
  try {
    await probeProduction({ baseUrl: bootstrap.baseUrl, bootstrapPreflightSha: legacySourceSha, gitRoot: checkout });
    const bootstrapProbeToken = exactLegacyProbeToken(bootstrapRequests);
    assertProbeConnectionsClose(bootstrapRequests, bootstrapRequestHeaders);
    assert.notEqual(bootstrapProbeToken, recoveryProbeToken);
    await writeFile(join(checkout, "readmes", "owner__neither.md"), "# Stale missing README\n");
    await assert.rejects(
      probeProduction({ baseUrl: bootstrap.baseUrl, bootstrapPreflightSha: legacySourceSha, gitRoot: checkout }),
      /owner__neither|status|404/i,
    );
    await rm(join(checkout, "readmes", "owner__neither.md"));
    await writeFile(join(checkout, "translations", "owner__neither.json"), '{"html":"stale"}\n');
    await assert.rejects(
      probeProduction({ baseUrl: bootstrap.baseUrl, bootstrapPreflightSha: legacySourceSha, gitRoot: checkout }),
      /owner__neither|status|404/i,
    );
  } finally {
    await rm(join(checkout, "readmes", "owner__neither.md"), { force: true });
    await rm(join(checkout, "translations", "owner__neither.json"), { force: true });
    await bootstrap.close();
  }
  await writeFile(join(recoveryArtifact, "readmes", "owner__neither.md"), "# Stale missing README\n");
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /owner__neither|status|404/i,
  );
  await rm(join(recoveryArtifact, "readmes", "owner__neither.md"));
  await writeFile(join(recoveryArtifact, "translations", "owner__neither.json"), '{"html":"stale"}\n');
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: legacySourceSha, gitRoot: checkout }),
    /owner__neither|status|404/i,
  );
  await rm(join(recoveryArtifact, "translations", "owner__neither.json"));

  await writeFile(join(checkout, "translations", "owner__readme-only.json"), '{"html":"present"}\n');
  await writeFile(join(checkout, "readmes", "owner__translation-only.md"), "# Present README\n");
  await writeFile(join(checkout, "readmes", "owner__neither.md"), "# Present README\n");
  await writeFile(join(checkout, "translations", "owner__neither.json"), '{"html":"present"}\n');
  assert.equal(run(["add", "--", "readmes/owner__translation-only.md", "readmes/owner__neither.md", "translations/owner__readme-only.json", "translations/owner__neither.json"]).status, 0);
  assert.equal(run(["commit", "-qm", "all active caches present"]).status, 0);
  const allPresentSha = run(["rev-parse", "HEAD"]).stdout.trim();
  const allPresentArtifact = join(outer, "all-present-artifact");
  await buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: allPresentArtifact, sourceSha: allPresentSha });
  await probeArtifactDirectory({ artifactDir: allPresentArtifact, legacyRecoverySha: allPresentSha, gitRoot: checkout });
  const allPresentManifest = JSON.parse(await readFile(join(allPresentArtifact, "deployment-manifest.json"), "utf8"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "readmes/owner__translation-only.md"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "translations/owner__readme-only.json"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "readmes/owner__neither.md"));
  assert.ok(Object.hasOwn(allPresentManifest.files, "translations/owner__neither.json"));
  assert.ok(!Object.hasOwn(allPresentManifest.files, "readmes/old__inactive.md"));
  assert.ok(!Object.hasOwn(allPresentManifest.files, "translations/old__inactive.json"));
  await writeFile(join(checkout, "index.html"), '<html>\nconst REPOS = [{"slug":"owner/legacy","slug":"owner/legacy"}];\n</html>\n');
  await assert.rejects(buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: join(outer, "duplicate-legacy"), sourceSha: legacySourceSha }), /duplicate key/i);
  await writeFile(join(checkout, "index.html"), '<html>\nconst REPOS = [{"slug":"Owner/Legacy"},{"slug":"owner/legacy"}];\n</html>\n');
  await assert.rejects(buildLegacyRecoveryArtifact({ sourceRoot: checkout, outDir: join(outer, "case-fold-legacy"), sourceSha: legacySourceSha }), /duplicate|case-fold|identity/i);
  await writeFile(join(checkout, "index.html"), '<html>\n<!-- GENERATED:TRENDING-DATE:START -->\nlegacy date\n<!-- GENERATED:TRENDING-DATE:END -->\n// GENERATED:TRENDING-REPOS:START\nconst REPOS = [{"slug":"owner/legacy"}];\n// GENERATED:TRENDING-REPOS:END\n</html>\n');

  await mkdir(join(checkout, "scripts"));
  await writeFile(join(checkout, "scripts", "new-refresh-code.js"), "export const current = true;\n");
  await writeFile(join(checkout, "data", "latest.json"), "failed main-only data\n");
  assert.equal(run(["add", "--", "scripts/new-refresh-code.js", "data/latest.json"]).status, 0);
  assert.equal(run(["commit", "-qm", "current refresh code"]).status, 0);

  const result = await prepareRefreshCandidate({ checkoutRoot: checkout, outDir: candidate, lastGoodSha: recovery.sourceSha });
  assert.equal(result.lastGoodSha, legacySourceSha);
  assert.equal(await readFile(join(candidate, "scripts", "new-refresh-code.js"), "utf8"), "export const current = true;\n");
  assert.equal(await readFile(join(candidate, "data", "latest.json"), "utf8"), "verified legacy data\n");
  const context = createRunContext(new Date("2026-08-26T10:07:00.000Z"), { sourceSha: null, snapshotId: null });
  assert.equal(context.parentSourceSha, null);
  assert.equal(context.parentSnapshotId, null);
});

test("legacy recovery rejects noncanonical, nested, and linked README materialization", async t => {
  const outer = await mkdtemp(join(tmpdir(), "legacy-readme-materialization-"));
  const source = join(outer, "source");
  const readmes = join(source, "readmes");
  t.after(() => rm(outer, { recursive: true, force: true }));
  await mkdir(readmes, { recursive: true });
  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"owner/repo"}];\n</script>\n');

  await writeFile(join(readmes, "Owner__Repo.md"), "wrong exact case\n");
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "wrong-case"), sourceSha }),
    /exact-case/i,
  );
  await rm(join(readmes, "Owner__Repo.md"));

  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"a__/b"},{"slug":"a/__b"}];\n</script>\n');
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "encoded-collision"), sourceSha }),
    /duplicate|case-fold/i,
  );
  await writeFile(join(source, "index.html"), '<script>\nconst REPOS = [{"slug":"owner/repo"}];\n</script>\n');

  await writeFile(join(readmes, "README.md"), "not canonical\n");
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "noncanonical"), sourceSha }),
    /canonical/i,
  );
  await rm(join(readmes, "README.md"));

  await mkdir(join(readmes, "nested"));
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "nested"), sourceSha }),
    /regular file|nested/i,
  );
  await rm(join(readmes, "nested"), { recursive: true });

  const linked = join(outer, "linked-readmes");
  await mkdir(linked);
  await rm(readmes, { recursive: true });
  await symlink(linked, readmes, "junction");
  await assert.rejects(
    buildLegacyRecoveryArtifact({ sourceRoot: source, outDir: join(outer, "linked"), sourceSha }),
    /regular directory|symlink/i,
  );
});

test("bootstrap probe rejects malformed or unsafe fake Git README trees", async t => {
  const outer = await mkdtemp(join(tmpdir(), "legacy-fake-git-"));
  const web = join(outer, "web");
  const fakeGit = join(outer, "fake-git.mjs");
  t.after(() => rm(outer, { recursive: true, force: true }));
  const previousGitBin = process.env.GIT_BIN;
  const previousGitScript = process.env.GIT_SCRIPT;
  const previousTreeCase = process.env.FAKE_TREE_CASE;
  t.after(() => {
    if (previousGitBin === undefined) delete process.env.GIT_BIN; else process.env.GIT_BIN = previousGitBin;
    if (previousGitScript === undefined) delete process.env.GIT_SCRIPT; else process.env.GIT_SCRIPT = previousGitScript;
    if (previousTreeCase === undefined) delete process.env.FAKE_TREE_CASE; else process.env.FAKE_TREE_CASE = previousTreeCase;
  });
  await mkdir(web);
  const page = '<script>\nconst REPOS = [{"slug":"owner/missing"}];\n</script>\n';
  await writeFile(join(web, "index.html"), page);
  await writeFile(fakeGit, String.raw`
const args = process.argv.slice(2);
const command = args[2];
if (command === "show") {
  const relative = args[3]?.split(":").slice(1).join(":");
  if (relative === "index.html") process.stdout.write(${JSON.stringify(page)});
  else process.exitCode = 2;
} else if (command === "ls-tree") {
  const oid = "b".repeat(40);
  const record = (mode, path) => mode + " blob " + oid + "\t" + path + "\0";
  const requested = args.includes("readmes") ? "readmes" : args.includes("translations") ? "translations" : "base";
  if (requested === "base") {
    if (process.env.FAKE_TREE_CASE === "base-error") process.exit(2);
    if (process.env.FAKE_TREE_CASE === "base-malformed") process.stdout.write("malformed");
    else process.stdout.write(Buffer.from(record("100644", "index.html"), "utf8"));
    process.exit(0);
  }
  if (process.env.FAKE_TREE_CASE === "readmes-error" && requested === "readmes") process.exit(2);
  if (process.env.FAKE_TREE_CASE === "translation-error" && requested === "translations") process.exit(2);
  const translation = process.env.FAKE_TREE_CASE?.startsWith("translation-");
  const treeCase = process.env.FAKE_TREE_CASE?.replace(/^translation-/, "");
  if ((requested === "translations") !== translation) process.exit(0);
  const directory = translation ? "translations" : "readmes";
  const extension = translation ? ".json" : ".md";
  const canonical = directory + "/owner__repo" + extension;
  const fixtures = {
    malformed: "100644 blob " + oid + "\t" + canonical,
    symlink: record("120000", canonical),
    nonblob: "040000 tree " + oid + "\t" + directory + "/owner__repo" + extension + "\0",
    nested: record("100644", directory + "/nested/owner__repo" + extension),
    noncanonical: record("100644", directory + "/README.txt"),
    wrongcase: record("100644", directory + "/Owner__Missing" + extension),
    duplicate: record("100644", canonical) + record("100644", canonical),
    casefold: record("100644", directory + "/Owner__Repo" + extension) + record("100644", canonical),
  };
  process.stdout.write(Buffer.from(fixtures[treeCase] ?? "", "utf8"));
} else {
  process.exitCode = 2;
}
`);
  process.env.GIT_BIN = process.execPath;
  process.env.GIT_SCRIPT = fakeGit;
  const server = await serveArtifact(web);
  try {
    for (const [treeCase, pattern] of [
      ["base-error", /legacy base listing unavailable/i],
      ["base-malformed", /malformed.*ls-tree/i],
      ["readmes-error", /readmes listing unavailable/i],
      ["translation-error", /translations listing unavailable/i],
      ["malformed", /malformed.*ls-tree/i],
      ["symlink", /symlink/i],
      ["nonblob", /regular file/i],
      ["nested", /canonical/i],
      ["noncanonical", /canonical/i],
      ["wrongcase", /exact-case/i],
      ["duplicate", /duplicate|case-fold/i],
      ["casefold", /duplicate|case-fold/i],
      ["translation-malformed", /malformed.*ls-tree/i],
      ["translation-symlink", /symlink/i],
      ["translation-nonblob", /regular file/i],
      ["translation-nested", /canonical/i],
      ["translation-noncanonical", /canonical/i],
      ["translation-wrongcase", /exact-case/i],
      ["translation-duplicate", /duplicate|case-fold/i],
      ["translation-casefold", /duplicate|case-fold/i],
    ]) {
      process.env.FAKE_TREE_CASE = treeCase;
      await assert.rejects(
        probeProduction({ baseUrl: server.baseUrl, bootstrapPreflightSha: sourceSha, gitRoot: outer }),
        pattern,
      );
    }
  } finally {
    await server.close();
  }
});

test("frozen membership and repository ledger produce one candidate Atom identity before artifact construction", async t => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-chain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = createRunContext(new Date("2026-08-29T10:07:00.000Z"));
  const legacyDatabase = join(root, "data", "trending-membership.sqlite");
  const repos = Array.from({ length: 10 }, (_, index) => ({
    slug: `owner/repo-${index}`, name: `owner / repo-${index}`, desc: `Description ${index}`,
    lang: "JavaScript", topics: ["testing"], stars: index, forks: index, issues: index,
    contributors: index + 1, stars_daily: index,
    summary: { goal: "g", usage: "u", pros: "p", cons: "c", fit: "f" },
    _stats_date: context.statsDateKst,
  }));
  const snapshotExport = {
    version: 1,
    snapshotId: context.snapshotId,
    generatedAt: context.observedAtUtc,
    statsDate: context.statsDateKst,
    repositories: repos.map(repo => ({
      slug: repo.slug,
      name: repo.name,
      description: repo.desc,
      lang: repo.lang,
      topics: repo.topics,
      stars: repo.stars,
      forks: repo.forks,
      issues: repo.issues,
      contributors: repo.contributors,
      gains: { daily: repo.stars_daily, weekly: null, monthly: null },
      signal: null,
      summary: repo.summary,
      tag_rule_version: 1,
      field_tags: ["dev-tools"],
      form_tags: ["library"],
    })),
  };
  const latest = buildLatestFeed(snapshotExport);
  const pageFor = identity => ["<html>", "// GENERATED:TRENDING-REPOS:START", `const REPOS = ${JSON.stringify(repos.map(repo => ({ slug: repo.slug, desc: repo.desc, tag_rule_version: 1, field_tags: ["dev-tools"], form_tags: ["library"], _stats_date: identity.statsDateKst, _snapshot_id: identity.snapshotId, _generated_at: identity.observedAtUtc })))};`, "// GENERATED:TRENDING-REPOS:END", "</html>"].join("\n");
  const page = pageFor(context);
  await writeFile(join(directory, "index.html"), page);
  await writeFile(join(directory, "latest.json"), `${JSON.stringify(latest)}\n`);
  const environment = { ...process.env, RUN_CONTEXT_JSON: JSON.stringify(context) };
  await mkdir(join(directory, "data"), { recursive: true });
  const repositoryDatabase = join(directory, "data", "repository-observations.sqlite");
  const fixture = spawnSync(process.env.PYTHON ?? "python", ["-c", [
    "import hashlib, json, sqlite3, sys",
    "from pathlib import Path",
    "import scripts.record_repository_observations as ledger",
    "from scripts.record_repository_observations import _file_sha256, _legacy_logical_rows, create_database",
    "from tests.test_repository_artifacts import insert_item, insert_profile",
    "database, snapshot_id, legacy = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])",
    "create_database(database)",
    "connection = sqlite3.connect(database)",
    "connection.execute('PRAGMA foreign_keys=ON')",
    "core = 'c' * 64",
    "schema = connection.execute('SELECT schema_fingerprint_sha256 FROM schema_meta').fetchone()[0]",
    "chain = hashlib.sha256(json.dumps({'schema_fingerprint_sha256': schema, 'parent_chain_sha256': None, 'core_payload_sha256': core, 'snapshot_id': snapshot_id, 'snapshot_seq': 1}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()",
    "connection.execute('INSERT INTO snapshot_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (1, snapshot_id, 'migration_baseline', '2026-08-29T10:07:00.000Z', '2026-08-29T19:07:00.000+09:00', '2026-08-29', None, None, 'a' * 40, 'b' * 64, core, None, chain, 10))",
    "[insert_profile(connection, index + 1, f'owner/repo-{index}') for index in range(10)]",
    "[insert_item(connection, 1, f'owner/repo-{index}', index + 1, stars=index, display_rank=index + 1, daily=index + 1, translation_applicable=False) for index in range(10)]",
    "schema_fingerprint, logical_count, logical_hash, last_key = _legacy_logical_rows(legacy)",
    "connection.execute('INSERT INTO baseline_sources VALUES (?,?,?,?,?,?,?,?,?)', ('legacy_trending_membership', 'data/trending-membership.sqlite', legacy.stat().st_size, _file_sha256(legacy), schema_fingerprint, logical_count, logical_hash, last_key, 1))",
    "legacy_connection = sqlite3.connect(legacy)",
    "[connection.execute('INSERT OR IGNORE INTO baseline_membership_slugs VALUES (?,?,?)', (slug.lower(), 'legacy_trending_membership', 1)) for slug, in legacy_connection.execute('SELECT DISTINCT slug FROM snapshot_members ORDER BY slug')]",
    "legacy_connection.close()",
    "captured = []",
    "real_digest = ledger._digest",
    "ledger._digest = lambda value: (captured.append(value), core)[1]",
    "ledger.verify_core_snapshot(connection, 1)",
    "ledger._digest = real_digest",
    "core = real_digest(captured[0])",
    "chain = hashlib.sha256(json.dumps({'schema_fingerprint_sha256': schema, 'parent_chain_sha256': None, 'core_payload_sha256': core, 'snapshot_id': snapshot_id, 'snapshot_seq': 1}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()",
    "update_guard = connection.execute(\"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='snapshot_runs_reject_update'\").fetchone()[0]",
    "connection.execute('DROP TRIGGER snapshot_runs_reject_update')",
    "connection.execute('UPDATE snapshot_runs SET core_payload_sha256=?, chain_sha256=? WHERE snapshot_seq=1', (core, chain))",
    "connection.execute(update_guard)",
    "ledger.verify_core_snapshot(connection, 1)",
    "connection.commit()",
    "connection.close()",
  ].join("; "), repositoryDatabase, context.snapshotId, legacyDatabase], { cwd: root, encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  const atom = spawnSync(process.env.PYTHON ?? "python", [join(root, "scripts", "generate_atom_feeds.py"), "--page", join(directory, "index.html"), "--latest", join(directory, "latest.json"), "--database", repositoryDatabase, "--legacy-membership-database", legacyDatabase, "--feed", join(directory, "feed.xml"), "--changes", join(directory, "changes.xml")], { encoding: "utf8", env: environment });
  assert.equal(atom.status, 0, atom.stderr);
  await writeFile(join(directory, "membership.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: context.observedAtUtc, statsDate: context.statsDateKst, baseline: true, current: repos.map(repo => ({ slug: repo.slug, status: "baseline" })), exited: [] })}\n`);
  const feed = await readFile(join(directory, "feed.xml"), "utf8");
  assert.equal((feed.match(/<entry>/g) ?? []).length, 10);
  assert.ok([...feed.matchAll(/<summary type="text">([^<]+)<\/summary>/g)].every(match => match[1].trim()));

  const sources = { version: 3, sources: Object.fromEntries(repos.map(repo => [repo.slug, sourceEntry(repo.slug)])) };
  const summaries = Object.fromEntries(repos.map(repo => {
    const bundle = summaryBundle(repo.slug);
    return [repo.slug, {
      content: bundle.en,
      summaries: bundle,
      source: sources.sources[repo.slug],
      evidence: Object.fromEntries(summaryFields.map(field => [field, []])),
      invariants: [],
      inference_fields: [],
    }];
  }));
  await mkdir(join(directory, "data"), { recursive: true });
  await writeFile(join(directory, "data", "latest.json"), `${JSON.stringify(latest)}\n`);
  await writeFile(join(directory, "data", "membership-status.json"), await readFile(join(directory, "membership.json")));
  await writeFile(join(directory, "data", "repo-summaries.json"), `${JSON.stringify(summaries)}\n`);
  await writeFile(join(directory, "data", "translation-sources.json"), `${JSON.stringify(sources)}\n`);
  for (const relative of VERSION_1_BASE_PATHS) {
    const target = join(directory, ...relative.split("/"));
    try { await readFile(target); } catch {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, relative.endsWith(".json") ? "{}\n" : `${relative}\n`);
    }
  }
  const finalized = spawnSync(process.env.PYTHON ?? "python", ["-c", [
    "import sqlite3, sys",
    "from contextlib import closing",
    "from pathlib import Path",
    "from scripts.derive_repository_artifacts import _expected_artifact_paths, derive_repository_insights, finalize_snapshot_derivatives, hash_pages_artifacts",
    "database, candidate_root, snapshot_id = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]",
    "connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)",
    "snapshot_seq = connection.execute('SELECT snapshot_seq FROM snapshot_runs WHERE snapshot_id=?', (snapshot_id,)).fetchone()[0]",
    "insights = derive_repository_insights(connection, snapshot_seq)",
    "paths = _expected_artifact_paths(connection, snapshot_seq)",
    "connection.close()",
    "finalize_snapshot_derivatives(database, snapshot_id, insights, hash_pages_artifacts(candidate_root, paths))",
  ].join("; "), repositoryDatabase, directory, context.snapshotId], { cwd: root, encoding: "utf8" });
  assert.equal(finalized.status, 0, finalized.stderr);
  const git = args => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  git(["config", "user.name", "test"]); git(["config", "user.email", "test@example.invalid"]);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-qm", "candidate fixture"]).status, 0);
  const committedSourceSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const artifact = join(directory, "artifact");
  const contract = await artifactContract(directory, latest, sources, context.snapshotId);
  const originalManifest = await buildPagesArtifact({ sourceRoot: directory, outDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract });
  const probed = await probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory });
  assert.equal(probed.sourceSha, committedSourceSha);
  assert.equal(probed.snapshotId, context.snapshotId);

  const recoveryCheckout = join(directory, "recovery-checkout");
  const recoveryArtifact = join(directory, "recovery-v1-artifact");
  const recoveryContractPath = join(directory, "recovery-v1-contract.json");
  assert.equal(spawnSync("git", ["-c", "core.autocrlf=false", "clone", "-q", directory, recoveryCheckout], { encoding: "utf8" }).status, 0);
  const exportedRecoveryContract = spawnSync(process.env.PYTHON ?? "python", [
    join(root, "scripts", "derive_repository_artifacts.py"), "export-contract",
    "--database", join(recoveryCheckout, "data", "repository-observations.sqlite"),
    "--snapshot-id", context.snapshotId,
    "--contract-out", recoveryContractPath,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(exportedRecoveryContract.status, 0, exportedRecoveryContract.stderr);
  const recoveryContract = JSON.parse(await readFile(recoveryContractPath, "utf8"));
  const recoveryManifest = await buildPagesArtifact({ sourceRoot: recoveryCheckout, outDir: recoveryArtifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: recoveryContract });
  assert.deepEqual(recoveryManifest, originalManifest);
  await probeArtifactDirectory({ artifactDir: recoveryArtifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: recoveryContract, gitRoot: recoveryCheckout });
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: recoveryArtifact, legacyRecoverySha: committedSourceSha, gitRoot: recoveryCheckout }),
    /manifest|legacy/i,
  );
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: artifact, sourceSha: "f".repeat(40), snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory }),
    /manifest identity mismatch/i,
  );

  const wrongMime = await serveArtifact(artifact, { mimeOverride: { "current-view-export.js": "text/plain; charset=utf-8" } });
  try { await assert.rejects(probeProduction({ baseUrl: wrongMime.baseUrl, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory }), /MIME/i); } finally { await wrongMime.close(); }
  const redirected = await serveArtifact(artifact, { redirect: "index.html" });
  try { await assert.rejects(probeProduction({ baseUrl: redirected.baseUrl, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory }), /redirect|fetch/i); } finally { await redirected.close(); }

  const originalMembership = await readFile(join(artifact, "data", "membership-status.json"));
  const staleMembership = JSON.parse(originalMembership);
  staleMembership.generatedAt = "2026-08-26T09:07:00.000Z";
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(staleMembership)}\n`));
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory }), /artifact hash|membership run identity/i);
  await rewriteArtifactFile(artifact, "data/membership-status.json", originalMembership);
  const shortMembership = JSON.parse(originalMembership);
  shortMembership.current.pop();
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(shortMembership)}\n`));
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory }), /artifact hash|active repository count|identity mismatch/i);
  await rewriteArtifactFile(artifact, "data/membership-status.json", originalMembership);

  const originalFeed = await readFile(join(artifact, "feed.xml"));
  const corruptFeed = Buffer.from(originalFeed.toString("utf8").replace(context.snapshotId, "20260826120700-fedcba9876543210"));
  await rewriteArtifactFile(artifact, "feed.xml", corruptFeed);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory }), /artifact hash|Atom run identity/i);
  await rewriteArtifactFile(artifact, "feed.xml", originalFeed);
  const originalChanges = await readFile(join(artifact, "changes.xml"));
  const invalidChange = `<entry><id>https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml#bad</id><title>owner/repo-0 신규</title><updated>${context.observedAtUtc}</updated><link rel="alternate" type="text/html" href="https://github.com/owner/repo-0" /><category term="stayed" /><summary type="text">bad</summary></entry>`;
  await rewriteArtifactFile(artifact, "changes.xml", Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${invalidChange}</feed>`)));
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: contract, gitRoot: directory }), /artifact hash|change Atom category/i);
  await rewriteArtifactFile(artifact, "changes.xml", originalChanges);

  const exactMembership = JSON.parse(originalMembership);
  exactMembership.baseline = false;
  exactMembership.current = exactMembership.current.map((row, index) => ({ ...row, status: index === 0 ? "new" : index === 1 ? "reentered" : "stayed" }));
  const changeEntry = (slug, status) => {
    const updated = context.observedAtUtc;
    const id = `https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml#${encodeURIComponent(`${updated}|${status}|${slug.toLowerCase()}`)}`;
    return `<entry><id>${id}</id><title>${slug} ${status === "new" ? "신규" : "재진입"}</title><updated>${updated}</updated><link rel="alternate" type="text/html" href="https://github.com/${slug}" /><category term="${status}" /><summary type="text">change</summary></entry>`;
  };
  const exactEntries = [changeEntry("owner/repo-0", "new"), changeEntry("owner/repo-1", "reentered")];
  const exactChanges = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${exactEntries.join("")}</feed>`));
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(exactMembership)}\n`));
  await rewriteArtifactFile(artifact, "changes.xml", exactChanges);
  const restoredContract = await artifactContract(artifact, latest, sources, context.snapshotId);
  await probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: restoredContract, gitRoot: directory });

  const substituted = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${changeEntry("owner/repo-2", "new")}${changeEntry("owner/repo-1", "reentered")}</feed>`));
  await rewriteArtifactFile(artifact, "changes.xml", substituted);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: restoredContract, gitRoot: directory }), /artifact hash|change.*membership|multiset|identity/i);
  const duplicated = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${exactEntries[0]}${exactEntries[0]}</feed>`));
  await rewriteArtifactFile(artifact, "changes.xml", duplicated);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: restoredContract, gitRoot: directory }), /artifact hash|duplicate|provenance|change.*membership|multiset/i);
  const badUrl = Buffer.from(originalChanges.toString("utf8").replace("</feed>", `${exactEntries[0].replace("https://github.com/owner/repo-0", "https://github.com/owner/repo-0/extra")}${exactEntries[1]}</feed>`));
  await rewriteArtifactFile(artifact, "changes.xml", badUrl);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: restoredContract, gitRoot: directory }), /artifact hash|change.*provenance|URL|identity/i);
  const overlap = structuredClone(exactMembership);
  overlap.exited.push({ slug: "OWNER/REPO-0", lastSeenAt: context.observedAtUtc, exitedAt: context.observedAtUtc });
  await rewriteArtifactFile(artifact, "data/membership-status.json", Buffer.from(`${JSON.stringify(overlap)}\n`));
  await rewriteArtifactFile(artifact, "changes.xml", exactChanges);
  await assert.rejects(probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: context.snapshotId, artifactContract: restoredContract, gitRoot: directory }), /artifact hash|exited.*overlap|disjoint|duplicate/i);
  await rewriteArtifactFile(artifact, "data/membership-status.json", originalMembership);
  await rewriteArtifactFile(artifact, "changes.xml", originalChanges);
  await assert.rejects(
    probeArtifactDirectory({ artifactDir: artifact, sourceSha: committedSourceSha, snapshotId: "20260826120700-fedcba9876543210", artifactContract: restoredContract, gitRoot: directory }),
    /manifest identity mismatch/i,
  );
});
