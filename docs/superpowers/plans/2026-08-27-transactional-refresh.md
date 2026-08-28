# Transactional Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 신규·변경 저장소의 상세 요약과 README 번역을 검증 가능한 단일 스냅샷으로 만들고, 동일 artifact를 명시적으로 GitHub Pages에 배포·재검증한다.

**Architecture:** 한 workflow run이 고정 `RunContext`를 만들고 runner temp의 candidate copy에서 모든 생성기를 실행한다. Anthropic 상세 요약과 Markdown 번역은 freshness·계획·검증을 독립적으로 유지하며, 둘 다 필요한 경우에만 16,000-token 상한 안의 첫 bounded translation chunk와 summary를 한 응답에서 각각 검증한다. 검증된 candidate만 tracked output으로 설치·commit하고 allowlist Pages artifact로 배포한다.

**Tech Stack:** Node.js 24 표준 라이브러리, Python 3.13 표준 라이브러리, vanilla JavaScript, GitHub Actions, Anthropic Messages API, GitHub REST/Pages Actions.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-data-ui-auth-hardening-design.md`

## Global Constraints

- 운영 schedule은 `cron: 7 */2 * * *`, concurrency는 `cancel-in-progress: false`다.
- 새 서버·framework·영구 dependency·유료 API를 추가하지 않는다.
- `data/star-observations.sqlite`와 `data/trending-membership.sqlite`의 schema와 과거 row를 변경하지 않는다.
- README 본문은 run temp 밖에 장기 보관하지 않는다.
- summary와 translation은 canonical README blob SHA가 같고 provenance가 유효할 때만 재사용한다.
- `ANTHROPIC_API_KEY` 누락, incomplete queue, non-`end_turn`, invalid output은 workflow 실패다.
- raw README/LLM HTML을 `innerHTML`에 직접 넣지 않는다.
- push 직전 fetch에서 `origin/main` 전진이 확인되면 push하지 않는다.
- 각 task의 RED test와 mutation이 통과하기 전 구현 commit을 만들지 않는다.
- 모든 Commit step은 명시된 `git add` 다음, `git commit` 전에 아래 Common Commit Gate를 실행한다.

---

## Common Commit Gate

```powershell
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged diff check failed' }
$stagedDiff = @(git diff --cached --no-ext-diff --unified=0 --no-color -- .)
if ($LASTEXITCODE -ne 0) { throw 'Unable to read staged diff for secret scan' }
$stagedAddedLines = @($stagedDiff | Where-Object { $_ -match '^\+(?!\+\+\+)' } | ForEach-Object { $_.Substring(1) })
$secretPattern = '(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
$secretHits = @($stagedAddedLines | Select-String -Pattern $secretPattern -AllMatches)
if ($secretHits.Count) { throw 'Potential secret detected in staged additions' }
```

---

## File Structure

- Create `scripts/run-context.mjs`: 한 실행의 UTC/KST 시각, snapshot id와 production parent 생성·검증.
- Create `readme-markdown.js`: translated Markdown의 안전한 browser renderer.
- Create `tests/run-context.test.mjs`: midnight와 invalid context 회귀.
- Create `tests/readme-markdown.test.mjs`: raw HTML, URL scheme, code escaping 회귀.
- Modify `scripts/update-trending.mjs`: 고정 context, canonical README metadata, stale metadata 금지, canonical summary schema.
- Replace `scripts/generate-translations.mjs`: 상세 JSON call과 Markdown translation call 분리, timeout/retry/stop reason/provenance.
- Modify `scripts/update-latest-feed.mjs`: 동일 context와 public description contract.
- Modify `scripts/generate_atom_feeds.py`: 실제 latest contract 사용.
- Modify `scripts/update-star-history.mjs`: workflow가 준 날짜만 사용.
- Modify `index.html`: canonical summary 하나와 safe README Markdown renderer 사용.
- Delete `readmes/*.md`: tracked original README body cache; original tabs fetch the exact canonical blob on demand instead.
- Modify `data/repo-summaries.json`, `data/translation-sources.json`, `translations/*.json`: schema v2 migration output.
- Modify `.github/workflows/daily-refresh.yml`: candidate build, exact output allowlist, explicit Pages build/deploy/probe/recovery.
- Modify `tests/daily-refresh-workflow.test.mjs`, `tests/generate-translations.test.mjs`, `tests/update-trending.test.mjs`, `tests/latest-feed.test.mjs`, `tests/test_atom_feeds.py`, `tests/page-runtime.test.mjs`: 새 contract와 실패 경로.

### Task 1: Freeze one run context

**Files:**
- Create: `scripts/run-context.mjs`
- Create: `tests/run-context.test.mjs`
- Modify: `scripts/update-trending.mjs`
- Modify: `scripts/update-latest-feed.mjs`
- Modify: `scripts/update-star-history.mjs`

**Interfaces:**
- Produces: `createRunContext(now: Date, parent): RunContext`, `validateRunContext(value): RunContext`, `readRunContext(env, now): RunContext`.
- `RunContext`: `{ observedAtUtc, observedAtKst, statsDateKst, snapshotId, parentSnapshotId, parentSourceSha }`.

- [ ] **Step 1: Write the failing context tests**

```js
test("one context remains on the same KST date after wall clock midnight", () => {
  const parent = { snapshotId: "20260826120700-0123456789abcdef", sourceSha: "a".repeat(40) };
  const context = createRunContext(new Date("2026-08-26T14:59:59.900Z"), parent);
  assert.equal(context.statsDateKst, "2026-08-26");
  assert.equal(validateRunContext(context).snapshotId, context.snapshotId);
  assert.equal(context.parentSourceSha, parent.sourceSha);
});

test("context rejects a mismatched KST date and malformed snapshot id", () => {
  const context = createRunContext(new Date("2026-08-26T15:00:00.000Z"), { snapshotId: null, sourceSha: null });
  assert.throws(() => validateRunContext({ ...context, statsDateKst: "2026-08-26" }));
  assert.throws(() => validateRunContext({ ...context, snapshotId: "../../bad" }));
});
```

- [ ] **Step 2: Run the RED test**

Run: `node --test tests/run-context.test.mjs`

Expected: FAIL with module-not-found for `scripts/run-context.mjs`.

- [ ] **Step 3: Implement the context module**

```js
import { createHash } from "node:crypto";

const KST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function createRunContext(now = new Date(), parent = { snapshotId: null, sourceSha: null }) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("invalid run time");
  const parts = Object.fromEntries(KST.formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const observedAtUtc = now.toISOString();
  const statsDateKst = `${parts.year}-${parts.month}-${parts.day}`;
  const observedAtKst = `${statsDateKst}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
  const digest = createHash("sha256").update(`${observedAtUtc}|run-context-v1`).digest("hex").slice(0, 16);
  return validateRunContext({
    observedAtUtc,
    observedAtKst,
    statsDateKst,
    snapshotId: `${observedAtUtc.replace(/\D/g, "").slice(0, 14)}-${digest}`,
    parentSnapshotId: parent.snapshotId,
    parentSourceSha: parent.sourceSha,
  });
}
```

`validateRunContext`는 두 ISO instant가 같은 순간인지, KST date가 일치하는지, `snapshotId`가 `^[0-9]{14}-[a-f0-9]{16}$`인지 검사한다. Parent 두 값은 둘 다 null인 bootstrap이거나 각각 valid snapshot id와 40-hex SHA여야 한다. `readRunContext`는 `RUN_CONTEXT_JSON`이 있으면 parse·검증하고 없으면 CLI/local test용으로 한 번 생성한다.

- [ ] **Step 4: Thread the context through generators**

`update-trending.mjs`, `update-latest-feed.mjs`, `update-star-history.mjs`의 `new Date()`/`seoulDate()` 기본값은 CLI entry에서 `readRunContext(process.env)`로 한 번 결정한다. 내부 함수는 `statsDate`, `generatedAt`, `snapshotId`를 인자로 받고 다시 시계를 읽지 않는다.

```js
const context = readRunContext(process.env);
await updateTrending({ context });
await updateLatestFeed({ context });
await updateStarHistory({ context });
```

- [ ] **Step 5: Prove the mutation is caught**

Temporarily change `update-star-history.mjs` CLI to call `seoulDate(new Date())`; run `node --test tests/run-context.test.mjs tests/update-star-history.test.mjs`; verify failure, then restore.

- [ ] **Step 6: Run related and full tests**

Run: `node --test tests/run-context.test.mjs tests/update-trending.test.mjs tests/latest-feed.test.mjs tests/update-star-history.test.mjs`

Run: `npm test`

Expected: all current tests pass; Rules remain the known nine skips until the final emulator run.

- [ ] **Step 7: Commit**

```powershell
git add scripts/run-context.mjs scripts/update-trending.mjs scripts/update-latest-feed.mjs scripts/update-star-history.mjs tests/run-context.test.mjs tests/update-trending.test.mjs tests/latest-feed.test.mjs tests/update-star-history.test.mjs
git commit -m "fix: share one timestamp across refresh artifacts"
```

### Task 2: Fetch canonical GitHub facts without stale relabeling

**Files:**
- Modify: `scripts/update-trending.mjs`
- Modify: `tests/update-trending.test.mjs`
- Create: `tests/fixtures/github-readme.json`

**Interfaces:**
- Produces: `fetchCanonicalReadme(slug, options): { status, path, blobSha, markdown, contentSha256 }`.
- Produces: `fetchRepositoryFacts(slug, options): RepositoryFacts` and `enrichTrendingRepositories(discovered, options): RepositoryFacts[]`.
- Produces: repository values with stars, forks, `open_issues_and_pull_requests`, contributors, subscribers, description, topics, license SPDX, archived/fork booleans, primary language/color, created/updated/pushed times, default branch/HEAD SHA, canonical README path/blob/content hash, three source ranks/gains, display rank, field/form tags, tag-rule version, and per-source provenance.

- [ ] **Step 1: Add RED fixtures and tests**

```js
test("canonical README uses API path and immutable blob SHA", async () => {
  const result = await fetchCanonicalReadme("Owner/Repo", { fetchImpl });
  assert.equal(result.path, "docs/README.rst");
  assert.equal(result.blobSha, "a".repeat(40));
  assert.equal(result.status, "present");
});

test("README 404 is absence but repository 500 cannot reuse stale metadata", async () => {
  assert.equal((await fetchCanonicalReadme("Owner/NoReadme", { fetchImpl: readme404 })).status, "absent");
  await assert.rejects(enrichTrendingRepositories(discovered, { fetchImpl: repo500, summaryCache: prior }), /GitHub metadata/);
});

test("repository facts expose the complete allowlist and no private fields", async () => {
  const expectedRepositoryFactKeys = [
    "archived", "contributors", "created_at", "default_branch", "default_branch_head_sha",
    "description", "display_rank", "display_slug", "field_tags", "forks", "form_tags",
    "gain_daily", "gain_monthly", "gain_weekly", "is_fork", "language_color",
    "license_spdx", "open_issues_and_pull_requests", "primary_language", "provenance", "readme_blob_sha",
    "readme_content_sha256", "readme_path", "readme_status",
    "pushed_at", "rank_daily", "rank_monthly", "rank_weekly", "slug", "stars",
    "subscribers", "tag_rule_version", "topics", "updated_at",
  ].sort();
  const facts = await fetchRepositoryFacts("Owner/Repo", { fetchImpl });
  assert.deepEqual(Object.keys(facts).sort(), expectedRepositoryFactKeys);
  assert.equal("owner" in facts, false);
  assert.equal("permissions" in facts, false);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/update-trending.test.mjs`

Expected: FAIL because `fetchCanonicalReadme` and the new field contract do not exist.

- [ ] **Step 3: Implement canonical README and freshness rules**

Use `/repos/${owner}/${repo}`, `/repos/${owner}/${repo}/readme`, the default-branch commit endpoint, and bounded contributor pagination with GitHub JSON accept headers. Every request uses `AbortSignal.timeout(30_000)`, at most three attempts, 2s/8s retry delay for timeout, 429 and 5xx only, and `Retry-After` when it is the larger bounded delay. Map only the complete interface allowlist, validate nonnegative counts/timestamps/SHAs, preserve `open_issues_count` under the exact `open_issues_and_pull_requests` name, and hash canonical facts. For README validate `path`, 40-hex `sha`, base64 content/encoding, cap decoded content at 512 KiB, and hash decoded bytes. Remove `raw.githubusercontent.com/${slug}/HEAD/README.md`. Treat only README 404 as `absent`; transient response after bounded retry throws. Remove the branch that retains known metadata after terminal REST failure.

```js
export async function fetchCanonicalReadme(slug, { fetchImpl = fetch } = {}) {
  const response = await fetchGitHubJson(`/repos/${encodeSlug(slug)}/readme`, { fetchImpl });
  if (response.status === 404) return { status: "absent", path: null, blobSha: null, markdown: null, contentSha256: null };
  const value = await requireGitHubJson(response);
  if (value.encoding !== "base64" || !/^[a-f0-9]{40}$/.test(value.sha) || typeof value.path !== "string") throw new Error(`Invalid canonical README metadata for ${slug}`);
  const bytes = decodeBoundedBase64(value.content, 512 * 1024);
  return { status: "present", path: value.path, blobSha: value.sha, markdown: decodeUtf8Strict(bytes), contentSha256: sha256(bytes) };
}
```

- [ ] **Step 4: Preserve raw period ordinals and language color**

Extend `parseTrendingHtml` to return `sourceRank` and nullable `languageColor`. `mergeTrendingPeriods` stores `rank_daily`, `rank_weekly`, `rank_monthly` independently. If no observed color exists, store `null`; use neutral gray only while rendering.

```js
const periodFields = { daily: ["rank_daily", "gain_daily"], weekly: ["rank_weekly", "gain_weekly"], monthly: ["rank_monthly", "gain_monthly"] };
for (const [period, rows] of Object.entries(parsedByPeriod)) {
  const [rankKey, gainKey] = periodFields[period];
  rows.forEach((row, index) => Object.assign(merged.get(row.slug), { [rankKey]: index + 1, [gainKey]: row.periodGain }));
}
```

- [ ] **Step 5: Mutation and tests**

Temporarily restore prior metadata on a fixture 500; verify the stale-metadata test fails; restore. Run `node --test tests/update-trending.test.mjs` then `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add scripts/update-trending.mjs tests/update-trending.test.mjs tests/fixtures/github-readme.json
git commit -m "fix: bind repository facts to canonical GitHub sources"
```

### Task 3: Validate summary and translation independently, combining only one bounded first chunk

**Files:**
- Replace: `scripts/generate-translations.mjs`
- Create: `scripts/validate-enrichment-coverage.mjs`
- Modify: `tests/generate-translations.test.mjs`
- Modify: `data/repo-summaries.json`
- Modify: `data/translation-sources.json`

**Interfaces:**
- Produces: `planEnrichment(repos, summaryCache, translationSources): EnrichmentItem[]`.
- Produces: `callDetailedSummary(item, apiKey, fetchImpl): DetailedSummary`.
- Produces: `callMarkdownTranslation(item, apiKey, fetchImpl, { includeSummary }): string | { markdown, summary }`; summary 결합은 두 component가 모두 필요한 첫 bounded chunk에만 허용한다.
- Produces: `runEnrichment({ apiKey, items, fetchImpl, sleep }): { summaries, translations, sources, usage }` and throws unless every item is complete.
- `validate-enrichment-coverage.mjs --root DIR --json-counts` reads the generated active set, prints one counts-only JSON object, and exits nonzero on any contract mismatch.
- Canonical `DetailedSummary`: `{ goal, usage, pros, cons, fit }`.

- [ ] **Step 1: Replace old response tests with fail-closed RED tests**

```js
test("summary request uses output_config JSON schema and accepts only end_turn", async () => {
  const calls = [];
  const value = await callDetailedSummary(item, "test-key", async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return response(200, { stop_reason: "end_turn", content: [{ type: "text", text: validSummaryJson }] });
  });
  assert.deepEqual(Object.keys(value), ["goal", "usage", "pros", "cons", "fit"]);
  assert.equal(calls[0].output_config.format.type, "json_schema");
});

test("missing key, max_tokens, timeout, or one failed pending repo fails the run", async () => {
  await assert.rejects(runEnrichment({ apiKey: "", items: [item] }), /ANTHROPIC_API_KEY/);
  await assert.rejects(callDetailedSummary(item, "x", responseWith({ stop_reason: "max_tokens" })), /stop_reason/);
  await assert.rejects(runEnrichment({ apiKey: "x", items: [item, other], call: failSecond }), /other\/repo/);
});

test("non-JSON envelopes, prompt echoes, and unchanged translatable prose fail closed", async () => {
  await assert.rejects(callDetailedSummary(item, "x", textHtmlResponse()), /content-type/i);
  await assert.rejects(callDetailedSummary(item, "x", malformedMessagesEnvelope()), /envelope/i);
  await assert.rejects(callDetailedSummary(item, "x", responseWithPromptEcho()), /echo/i);
  await assert.rejects(callMarkdownTranslation(englishProseItem, "x", unchangedEnglishResponse()), /unchanged/i);
});

test("coverage CLI rejects compact, placeholder, stale provenance, and missing translations", async () => {
  for (const fixture of [compactFixture, placeholderFixture, staleBlobFixture, missingTranslationFixture]) {
    assert.notEqual(runCoverageCli(fixture).status, 0);
  }
  assert.deepEqual(JSON.parse(runCoverageCli(validActiveSet).stdout), expectedCounts);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/generate-translations.test.mjs`

Expected: FAIL on missing exports and the old unbounded combined JSON assumptions.

- [ ] **Step 3: Implement the summary API payload**

Use this exact `output_config` shape in the raw Messages request:

```js
output_config: {
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: Object.fromEntries(["goal", "usage", "pros", "cons", "fit"].map(key => [key, { type: "string" }])),
      required: ["goal", "usage", "pros", "cons", "fit"],
      additionalProperties: false,
    },
  },
},
```

Use a whole-attempt 60-second deadline, maximum three attempts, and bounded 2s/8s retry delays for timeout, 429, and 5xx only. The same deadline must cover response-body consumption, not only response headers. Require an HTTP success with JSON-compatible `Content-Type`, then validate the Messages envelope before reading it: object body, `stop_reason === "end_turn"`, a nonempty `content` array containing text blocks only, exactly one joined text result, no prompt/source echo, exact schema keys, trimmed nonempty values, and per-field/total length caps. Reject malformed/error envelopes even when HTTP status is 200. Never include request prompts, README bodies, API response bodies, headers, or raw provider errors in errors. A structured failure record may contain one fixed failure code and numeric usage snapshot. Paid-request diagnostics may additionally contain the public repository slug, request kind, chunk index, attempt, prompt/body byte counts, `max_tokens`, elapsed milliseconds, and confirmed/unresolved usage numbers.

- [ ] **Step 4: Implement independently validated Markdown translation with optional first-chunk summary**

Translation input is canonical Markdown only. Parse normalized LF input line-by-line into ordered atomic blocks: headings, blank-delimited prose paragraphs, complete fenced-code blocks, complete HTML blocks, complete tables, and list items including their indented continuation lines. First reject a raw normalized atomic block above 64 KiB UTF-8, then apply deterministic sentinels and measure the resulting atomic blocks for paid-request capacity. Compute `translationTokens = max(1,024, ceil(chunkBytes / 2) + 1,024)` and add 4,096 only when the first chunk also requests summary. Pack each paid request so that this computed allocation never exceeds 16,000 tokens: at most 21,760 bytes for a summary-combined first chunk and 29,952 bytes for later or translation-only chunks. Try the bounded combined plan first. If the first sentinelized atomic block cannot fit 21,760 bytes but fits 29,952 bytes, plan one separate summary call and pack every translation request under 29,952 bytes. Prefer heading and blank-paragraph boundaries and never split an atomic block. Fail before any API call when raw Markdown structural validation fails, a raw normalized atomic block exceeds 64 KiB, a sentinelized atomic block exceeds 29,952 bytes, or another fixed queue budget fails. Never silently clamp a larger required allocation to 16,000. Give each chunk an index plus SHA-256 of its sentinelized input and reject duplicate/missing/reordered chunk results.

Build a deterministic fingerprint of heading levels/order, list markers, table delimiters, fenced/inline-code contents, sentinel ids, and link destinations before the call; require the translated chunks to preserve it exactly. Require the same JSON-compatible response/envelope rules as the summary call, `end_turn`, nonempty text, per-chunk output cap, and 1 MiB rejoined output cap. The response `segment_bindings` contains only each local segment's `index` and `input_sha256`; it must not duplicate translated prose. Extract the translated clauses from `translated_markdown`, align them with the local source bindings, and validate count, order, hash, prose, sentinel, and fingerprint before confirming any usage. When `extractTranslatableProse` finds a prose segment with at least 20 ASCII letters, require a material normalized-text change and at least one Hangul code point in the corresponding translated prose; code-heavy/no-prose documents are explicitly N/A for that check. Reject unchanged English, prompt echo, source echo, silent tail loss, or extra prose outside the chunk. Add malicious, oversized-atomic-block, no-prose, and instruction-like README fixtures. Only the first bounded chunk may request an independently schema-validated summary when both components are pending; later chunks never request summary, and no translation call requests `stars_note`.

```js
const before = fingerprintMarkdown(item.markdown);
const translated = [];
for (const chunk of packTranslationRequests(item.markdown, { includeSummary })) translated.push(await callTranslationChunk(chunk, apiKey, fetchImpl));
const markdown = translated.join("");
assertFingerprintEqual(fingerprintMarkdown(markdown), before, item.slug);
return markdown;
```

- [ ] **Step 5: Implement queue and schema v2**

Remove `MAX_TRANSLATIONS_PER_RUN` and free-baseline writes. A reusable entry requires exact blob SHA, content SHA256, model, and schema v2. Log pending count, planned logical call count, worst-case HTTP attempt count, input bytes and accumulated token usage, not content. Before calling the API, reject more than 75 active repositories, more than 96 logical Messages calls, more than 288 worst-case attempts (`logicalCalls * 3`), or aggregate canonical README source input over 4 MiB. This 4 MiB source-set preflight does not replace per-attempt token-exposure accounting for repeated prompts, schemas, duplicated context, or retries. Maintain a global actual-attempt counter and fail before attempt 289 even if individual retries would otherwise allow it.

Serialize every exact request body once before the first paid call, retain the resulting execution plan, and send that same `bodyText` byte-for-byte for its first attempt and every retry. The preflight separately sums first-attempt `UTF-8 body bytes + 1,024` input reservations and full output allocations, then adds retry margin by selecting the 12 largest per-request input reservations and the 12 largest per-request output allocations and counting each selected request twice more. Reject the complete plan with fetch 0 when either required total exceeds the selected fixed policy. A success whose reported input or output usage exceeds its reservation is invalid and retains both reservations as unresolved; only a validated success envelope within both reservations may replace them with provider usage. Timeout, fetch error, 429, 5xx, malformed success, and body stall also retain both reservations as unresolved usage.

The build job's earliest shell step fixes `ENRICHMENT_DEADLINE_EPOCH_MS` at that time plus 70 minutes, leaving at least 20 minutes of the 90-minute build job for validation, commit, and artifact construction; deploy and production probe remain separately bounded jobs. Do not begin an attempt unless a full 60-second attempt and a 30-second admission reserve fit inside the fixed deadline. Do not sleep for a retry unless its 2s/8s delay plus the same attempt and admission reserve fit. The 60-second whole-attempt deadline includes fetch and complete response-body consumption. The separate 30-second admission reserve covers post-body JSON/schema/prose/fingerprint validation for the current response and, after the final Messages request, complete enrichment-set assembly and failure logging. Later candidate generators and deployment jobs are outside it. Normal runs use the fixed `1,000,000` input / `250,000` output policy and retry margin 12. The verified version-0 manual bootstrap has a separate immutable `bootstrap_v0_approved` policy, but the checked-in workflow deliberately selects `bootstrap_v0_pending_approval` until every implementation plan and the final security/functional gates are complete. Pending mode must fail before any paid fetch with a fixed content-free code. Bootstrap identity requires `workflow_dispatch`, canonical manual SHA, verified recovery version 0, and verified/manual/hydration SHA equality; schedule, version 1, partial configuration, and numeric environment overrides are rejected. Write all outputs to temp names, run the same exported coverage validator used by `validate-enrichment-coverage.mjs` against the complete active set, then atomically install; do not publish a partial queue. The CLI reports only repository/valid/compact/placeholder/applicable/N/A/missing/stale counts, never content. Success prints the numeric usage snapshot. Every failure prints one content-free structured record containing a fixed failure code and numeric usage snapshot; failures before any paid attempt report zero usage, while paid-request failures additionally include only the allowlisted request diagnostic.

After response deduplication, run `node scripts/generate-translations.mjs --plan-only` with the exact verified bootstrap identity and validated `RUN_CONTEXT_JSON`. It may hydrate public canonical README data but must require no Anthropic key and make zero Anthropic requests. The receipt includes first/required input and output, max request allocations, retry count and numeric top-12 arrays, verified source SHA, source-set hash, snapshot id, and run-context hash; it excludes repository names and all content. The 41-repository receipt measured required input `11,394,327` and output `1,156,720`. The approved immutable bootstrap policy is input `11,500,000`, output `1,200,000`, retry margin 12, with no environment numeric override. The official-price conservative ceiling is `$17.50`. Rebuild the exact plan immediately before the eventual user-authorized first workflow; source/snapshot drift or either cap excess fails with zero Anthropic fetch and never auto-increases a cap. The 81 first attempts plus at most 12 additional attempts cannot all consume their 60-second timeout inside the 70-minute enrichment deadline, so an extremely slow provider can consume a material part of the ceiling and still publish nothing. State that fail-late risk immediately before the one final bootstrap execution, and never retry that execution automatically after failure.

```js
const budget = measurePlan(items);
if (items.length > 75 || budget.logicalCalls > 96 || budget.maxAttempts > 288 || budget.inputBytes > 4 * 1024 * 1024) throw new Error(`Enrichment budget exceeded: items=${items.length} logicalCalls=${budget.logicalCalls} maxAttempts=${budget.maxAttempts} bytes=${budget.inputBytes}`);
const completed = await enrichAll(items);
if (completed.length !== items.length) throw new Error(`Incomplete enrichment queue: ${completed.length}/${items.length}`);
validateActiveEnrichment(activeRepos, completed, summaryCache, translationSources);
installEnrichmentSet(completed);
```

Convert cache entries to `{ content, source }`. Use a prior `detail` only when every field is nonempty and provenance is independently verified; never carry compact `summary`. Active invalid entries enter the paid repair queue.

- [ ] **Step 6: Generate deterministic trend notes**

Move `stars_note` to `update-trending.mjs` and derive it from current period gains, membership, and rank fields. Add a test that README text claiming fake star counts cannot change the note.

```js
export function buildTrendNote(repo) {
  const gains = [["일간", repo.gain_daily], ["주간", repo.gain_weekly], ["월간", repo.gain_monthly]].filter(([, value]) => Number.isInteger(value));
  const movement = gains.map(([label, value]) => `${label} +${value.toLocaleString("ko-KR")}`).join(" · ");
  return [movement, repo.membership_status === "reentered" ? "재진입" : null].filter(Boolean).join(" · ");
}
```

- [ ] **Step 7: Mutation and full tests**

Temporarily change the per-item catch to continue; verify the failed-pending test fails. Restore. Run `node --test tests/generate-translations.test.mjs tests/update-trending.test.mjs` and `npm test`.

- [ ] **Step 8: Commit**

```powershell
git add scripts/generate-translations.mjs scripts/validate-enrichment-coverage.mjs scripts/update-trending.mjs tests/generate-translations.test.mjs tests/update-trending.test.mjs data/repo-summaries.json data/translation-sources.json
git commit -m "fix: fail closed on incomplete README enrichment"
```

### Task 4: Render translated Markdown safely

**Files:**
- Create: `readme-markdown.js`
- Create: `tests/readme-markdown.test.mjs`
- Modify: `index.html`
- Modify: `tests/page-runtime.test.mjs`
- Modify: `translations/*.json`
- Delete: `readmes/*.md`

**Interfaces:**
- Produces: `ReadmeMarkdown.render(markdown, { repositoryUrl, blobSha }): string` containing allowlisted HTML only.
- Translation JSON: `{ markdown, source }`.

- [ ] **Step 1: Write XSS RED tests**

```js
test("raw HTML and dangerous URL schemes never survive rendering", () => {
  const html = ReadmeMarkdown.render('<img src=x onerror=alert(1)>\n[x](javascript:alert(1))', source);
  assert.doesNotMatch(html, /<img|onerror|javascript:/i);
  assert.match(html, /&lt;img/);
});

test("code, headings, lists and safe relative links preserve content", () => {
  const html = ReadmeMarkdown.render('# 제목\n- 항목\n`<script>`\n[문서](docs/a.md)', source);
  assert.match(html, /<h1>제목<\/h1>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /github\.com\/owner\/repo\/blob\/[a-f0-9]{40}\/docs\/a\.md/);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/readme-markdown.test.mjs`

Expected: FAIL because renderer does not exist.

- [ ] **Step 3: Implement a small safe renderer**

Escape `&<>"'` before parsing Markdown. Generate only `h1-h6`, `p`, `ul`, `ol`, `li`, `blockquote`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `pre`, `code`, `strong`, `em`, `a`, and optional `img`. Link/image URL resolution accepts `https:`, `http:`, or validated repository-relative paths; it rejects credentials, control characters, `javascript:`, `data:`, and protocol-relative URLs. External anchors get `target="_blank" rel="noopener noreferrer"`.

- [ ] **Step 4: Switch the README panel contract**

Load `readme-markdown.js` before the main inline script. Replace `t.html`/`readmeBody.innerHTML=t.html` with schema validation for `t.markdown` and `ReadmeMarkdown.render`. For the original tab, request `/repos/{slug}/contents/{encodedReadmePath}?ref={defaultBranchHeadSha}`, require the returned SHA to equal `readme_blob_sha`, strict-decode its base64 bytes, and render that Markdown safely. Add RED fixtures proving `HEAD/README.md` is never requested and a SHA mismatch fails visibly. Do not put raw response HTML into the DOM.

- [ ] **Step 5: Convert active translation files**

The repair run in Task 7 writes schema-v2 files. For local tests, convert fixtures only; do not mechanically relabel existing active files as verified.

- [ ] **Step 6: Mutation and tests**

Temporarily return raw Markdown from `render`; verify the XSS test fails. Restore. Run `node --test tests/readme-markdown.test.mjs tests/page-runtime.test.mjs` and `npm test`.

- [ ] **Step 7: Commit**

```powershell
git add readme-markdown.js index.html tests/readme-markdown.test.mjs tests/page-runtime.test.mjs
git add -u -- readmes
git commit -m "fix: render translated README as safe Markdown"
```

### Task 5: Repair latest JSON and Atom producer-consumer integration

**Files:**
- Modify: `scripts/update-latest-feed.mjs`
- Modify: `scripts/generate_atom_feeds.py`
- Modify: `tests/latest-feed.test.mjs`
- Modify: `tests/test_atom_feeds.py`

**Interfaces:**
- `latest.repos[]` uses `description`, never `desc`.
- Every artifact carries `snapshotId`, `generatedAt`, and `statsDate` from `RunContext`.

- [ ] **Step 1: Add a real-contract RED integration test**

In `tests/latest-feed.test.mjs`, call the real `buildLatestFeed`, write that exact result to a unique temp `latest.json`, spawn the Python `generate_atom_feeds.py` CLI with that exact input path and temp XML output paths, parse the generated XML, and assert each Atom summary equals the matching `latest.repos[].description` and is nonempty. Require Python exit 0, verify the expected output files were newly produced, and delete the temp directory in `finally`. Running separate Node and Python suites is not assembled-path evidence.

- [ ] **Step 2: Run RED**

Run: `node --test tests/latest-feed.test.mjs`

Expected: the cross-language fixture exposes the current `desc`/`description` mismatch.

- [ ] **Step 3: Standardize the public field**

Emit `description` from `buildLatestFeed`. Reject unknown/missing identity fields in Python. Validate page/latest snapshot id, generated time, count, order, slug, and description before XML generation.

- [ ] **Step 4: Mutation and tests**

Temporarily read `desc` in Python; require that same assembled integration test to fail. Restore, run `node --test tests/latest-feed.test.mjs`, `python -m unittest tests.test_atom_feeds`, and `npm test`.

- [ ] **Step 5: Commit**

```powershell
git add scripts/update-latest-feed.mjs scripts/generate_atom_feeds.py tests/latest-feed.test.mjs tests/test_atom_feeds.py
git commit -m "fix: bind Atom summaries to the live latest feed contract"
```

### Task 6: Build, publish, deploy and probe one candidate artifact

**Files:**
- Modify: `.github/workflows/daily-refresh.yml`
- Modify: `tests/daily-refresh-workflow.test.mjs`
- Create: `scripts/build-pages-artifact.mjs`
- Create: `scripts/prepare-refresh-candidate.mjs`
- Create: `scripts/dispatch-refresh.mjs`
- Create: `scripts/verify-refresh-chain.mjs`
- Create: `scripts/probe-production.mjs`
- Create: `tests/pages-publication.test.mjs`
- Create: `tests/dispatch-refresh.test.mjs`
- Create: `tests/verify-refresh-chain.test.mjs`

**Interfaces:**
- `build-pages-artifact.mjs --source ROOT --out DIR --source-sha SHA --snapshot-id ID` copies an exact allowlist and writes `deployment-manifest.json`.
- `prepare-refresh-candidate.mjs --checkout ROOT --out DIR --last-good-sha SHA` copies current code while hydrating mutable generated inputs from the verified production SHA.
- `dispatch-refresh.mjs --wait [--bootstrap-source-sha SHA]` snapshots pre-dispatch run ids, dispatches main, selects exactly one new run for the expected head SHA, waits, downloads that run's immutable candidate Pages artifact, and prints one JSON receipt.
- `verify-refresh-chain.mjs --expected-run-id ID --expected-source-sha SHA --expected-snapshot-id ID --expected-manifest-sha256 SHA256 --base-url URL` binds production evidence to that receipt or proves one exact later valid refresh replaced it.
- `verify-refresh-chain.mjs --current-production --base-url URL` binds the current manifest to exactly one successful candidate receipt and requires its source SHA to equal `origin/main`.
- `probe-production.mjs --base-url URL --source-sha SHA --snapshot-id ID` exits nonzero on mismatch.
- `probe-production.mjs --artifact-dir DIR --source-sha SHA --snapshot-id ID` serves that exact directory on an ephemeral loopback port, runs the same HTTP/hash/cross-count probe, and always closes the server in `finally`.
- `probe-production.mjs --base-url URL --bootstrap-preflight-sha SHA` requires manifest 404 and compares the live legacy allowlist with that Git tree without printing bodies.
- `probe-production.mjs --base-url URL --legacy-recovery-sha SHA` requires an exact version-0 manifest and compares its live legacy allowlist with that Git tree without printing bodies.
- Every idempotent probe GET uses an independent `Connection: close` request so synchronous Git verification between requests cannot race a server keep-alive timeout and produce a false `ECONNRESET`.

- [ ] **Step 1: Write workflow and artifact RED tests**

Assert schedule/manual share one command path, `cron: 7 */2 * * *`, `cancel-in-progress:false`, `timeout-minutes:90`, job-level permissions, pinned Pages actions, candidate directory use, origin fetch before push, artifact allowlist excluding `*.sqlite`, deploy job environment, and post-deploy probe. Add dispatch fixtures with pre-existing runs, one matching new run, zero matches, and two same-head matches; only exactly one is accepted. Add receipt-chain fixtures for exact expected production, one valid later fast-forward, non-fast-forward, zero/two later matches, and `--current-production` with exactly one/zero/two matching successful receipts. Add publication fixtures for no generated diff with stale production, concurrent remote advance, deploy failure, SHA mismatch, and `origin/main` containing a failed newer candidate while production points to an ancestor; require generated state to come from production `sourceSha` while code comes from current checkout. The test must reject `continue-on-error`, force push, broad `git add`, unpinned action tags, pull-request secret execution, and direct generation in the checkout.

- [ ] **Step 2: Run RED**

Run: `node --test tests/daily-refresh-workflow.test.mjs tests/pages-publication.test.mjs tests/dispatch-refresh.test.mjs tests/verify-refresh-chain.test.mjs`

- [ ] **Step 3: Implement candidate preparer, dispatch receipt, artifact builder and probe**

The preparer verifies `last-good-sha` is a 40-hex ancestor of the current checkout, materializes only tracked committed bytes with `git archive originalSha` into the temp candidate, and rejects symlinks, `.git`, `node_modules` and untracked residue. It then replaces only approved mutable generated inputs that exist in the production source tree. A later plan may introduce a new generated path that the parent does not contain; the preparer leaves that path absent so the owning migration generator must create and validate it. It never uses generated data from an unverified main-only candidate as the next logical parent.

The dispatch helper reads up to 100 workflow-dispatch runs before dispatch, records their ids, resolves the expected 40-hex `origin/main`, invokes `gh workflow run daily-refresh.yml --ref main`, then polls boundedly. It accepts only a new `event=workflow_dispatch` run whose `headSha` equals the expected SHA; zero after 60 seconds or more than one candidate fails. With `--wait`, it calls `gh run watch` for that id, downloads only `github-pages-candidate-{runId}` from that exact run into a new temp directory, safely extracts only `deployment-manifest.json` (rejecting links, path traversal, duplicates, or extra receipt candidates), and verifies its schema. It emits `{ "runId": integer, "headSha": "40-hex", "sourceSha": "40-hex", "snapshotId": "nonempty", "manifestSha256": "64-hex", "url": "https URL" }` only after exit 0 and always deletes the temp directory.

`verify-refresh-chain.mjs` first validates the exact expected run and receipt. If the current production manifest hash/source/snapshot equal that receipt, it probes those exact values. If production has already advanced, it must prove expected `sourceSha` is a Git ancestor of current manifest `sourceSha`, then search at most 100 later completed successful `daily-refresh.yml` runs and safely inspect their candidate artifacts. Exactly one later run must have a receipt matching the current production manifest hash/source/snapshot; that later run must include a successful Pages deploy/probe and the current source must equal `origin/main`. It then probes the later exact values and returns both expected and effective run ids. `--current-production` performs the same bounded exact-receipt discovery without an older expected run and is valid only when the current source equals `origin/main`. Zero/multiple matches, a non-fast-forward, or silently substituting current `origin/main` fails.

The version-1 artifact allowlist is exactly `index.html`, `current-view-export.js`, `favorite-sync.js`, `favorites.js`, `firebase-client.js`, `firebase-config.json`, `hidden-repos.js`, `membership-history.js`, `readme-markdown.js`, `refresh-schedule.js`, `repo-filters.js`, `star-history.js`, `ui-motion.js`, `data/latest.json`, `data/membership-status.json`, `feed.xml`, `changes.xml`, `star-history.json`, plus one `translations/{encoded-slug}.json` for each active applicable repository in latest. Missing required paths, extra artifact paths, symlinks, sidecars, path escape and stale translations all fail. Export this constant from the builder so tests compare exact paths; later plans must make a RED allowlist test before adding a runtime asset.

The one-time legacy recovery allowlist uses the same files that exist at `$bootstrapSourceSha`, omits `readme-markdown.js`, and includes the exact active `readmes/{encoded-slug}.md` cache required by that old tree. It exists only in the runner recovery artifact and is never copied into the new candidate or committed again. Hash every copied file. Manifest shape is:

```json
{
  "version": 1,
  "sourceSha": "40 lowercase hex",
  "snapshotId": "run snapshot id",
  "files": { "index.html": "64 lowercase hex" }
}
```

Probe appends the validated snapshot id as a `probe` query value, fetches every path in `manifest.files`, verifies each response body SHA-256 against the manifest, and then validates latest, membership, both Atom feeds, translation coverage, and nonempty Atom summaries without logging response bodies. It cross-checks active repository identity/count among `index.html`, `data/latest.json`, `feed.xml`, and the applicable change count in `changes.xml`; a missing JavaScript file, missing translation, stale extra translation, wrong MIME-critical payload, or cross-count mismatch fails.

- [ ] **Step 4: Replace the workflow with build and deploy jobs**

Use the existing pinned checkout/setup actions plus:

```yaml
- uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
  with:
    path: ${{ runner.temp }}/pages-artifact

deploy:
  needs: build
  permissions:
    pages: write
    id-token: write
  environment:
    name: github-pages
    url: ${{ steps.deployment.outputs.page_url }}
  steps:
    - id: deployment
      uses: actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5.0.0
```

The build job has `contents: write`; deploy has only `pages: write` and `id-token: write`. Resolve production state as three explicit cases: 404 preflight uses the approved bootstrap SHA only as `hydrationSourceSha` and gives `RunContext` a null parent pair; version 0 legacy recovery uses manifest `sourceSha` as `hydrationSourceSha` and again gives `RunContext` a null parent pair; version 1 uses manifest `sourceSha` as hydration source and its source/snapshot pair as the validated parent. Candidate generation runs under `${RUNNER_TEMP}/candidate`, validates there, copies allowed generated outputs to checkout, fetches origin, confirms its original SHA is still `origin/main`, scans staged content, commits, and pushes. Before either Pages upload or deploy, build `${RUNNER_TEMP}/pages-artifact` and run `node scripts/probe-production.mjs --artifact-dir "${RUNNER_TEMP}/pages-artifact" --source-sha "$SOURCE_SHA" --snapshot-id "$SNAPSHOT_ID"`; the loopback server is shut down on success or failure. Only that locally HTTP-probed directory is uploaded, and it contains the new local commit SHA.

- [ ] **Step 5: Add recovery semantics**

Before candidate deploy, always preserve a recovery Pages artifact. When a version-1 production manifest exists, rebuild it from that manifest's `sourceSha` and verify all listed hashes. For 404 preflight or a version-0 production state, build the recovery artifact from the verified legacy hydration SHA, add a deploy-only version-0 manifest with `{ version: 0, legacyBootstrap: true, sourceSha, snapshotId: null, files }`, and verify its allowlisted files through the matching preflight or recovery probe mode. Upload this artifact as `github-pages-recovery-${{ github.run_id }}` before uploading `github-pages-candidate-${{ github.run_id }}`; pass the candidate name to the first deploy-pages `artifact_name`.

If the production probe fails after candidate deploy, a sequential recovery job deploys the already preserved recovery artifact. It uses normal SHA/snapshot probing for version 1 and `--legacy-recovery-sha` probing for version 0. The failed verify job keeps the workflow conclusion red even when recovery succeeds. A later schedule/manual run recognizes version 0 automatically, hydrates from its SHA with a null RunContext parent, and retries the candidate without another workflow input. Recovery never force-pushes or marks the candidate snapshot successful.

- [ ] **Step 6: Execute workflow shell tests and mutation**

Run: `node --test tests/daily-refresh-workflow.test.mjs tests/pages-publication.test.mjs tests/dispatch-refresh.test.mjs tests/verify-refresh-chain.test.mjs`. Execute mutations separately and restore after each: allow SQLite into the Pages builder; reuse candidate SHA as recovery source; change failed verification to a green workflow conclusion; use main-only candidate data instead of production hydration for the next run; omit a required JavaScript file from the pre-deploy artifact; omit one active translation; skip the local HTTP probe; replace the expected receipt with current `origin/main`; accept two later-run receipt matches; let `--current-production` accept zero or two matching receipts. Add a version-0-next-run fixture and require it to produce a new candidate without bootstrap input. Every mutation must fail its owning test. Run `npm test` after restoration.

- [ ] **Step 7: Commit**

```powershell
git add .github/workflows/daily-refresh.yml scripts/prepare-refresh-candidate.mjs scripts/dispatch-refresh.mjs scripts/verify-refresh-chain.mjs scripts/build-pages-artifact.mjs scripts/probe-production.mjs tests/daily-refresh-workflow.test.mjs tests/dispatch-refresh.test.mjs tests/verify-refresh-chain.test.mjs tests/pages-publication.test.mjs
git commit -m "feat: deploy one verified refresh artifact to Pages"
```

### Deferred final Task 7: Run the one-time active-set repair and production gate only after Plans 2-5

**Files:**
- Generated: `data/repo-summaries.json`, `data/translation-sources.json`, `translations/*.json`, current public artifacts.

**Interfaces:**
- Consumes all previous tasks plus the observation DB, UI, auth, security, and repository-wide functional gates from Plans 2-5.
- Produces the first schema-v2 production snapshot with zero active placeholder/fallback summaries.

- [ ] **Step 1: After every implementation plan passes, re-fetch, rerun all local gates, and push the final implementation commits**

Run from PowerShell in the repository:

```powershell
git fetch origin main
git status --short --branch
npm test
git merge-base --is-ancestor origin/main HEAD
if ($LASTEXITCODE -ne 0) { throw 'origin/main is not an ancestor of HEAD' }
$pagesSite = gh api 'repos/nowwcastle-sudo/github-trending-daily/pages' | ConvertFrom-Json
if ($pagesSite.build_type -eq 'legacy') {
  gh api --method PUT 'repos/nowwcastle-sudo/github-trending-daily/pages' -f build_type=workflow | Out-Null
} elseif ($pagesSite.build_type -ne 'workflow') {
  throw "Unexpected Pages build_type $($pagesSite.build_type)"
}
$pagesSite = gh api 'repos/nowwcastle-sudo/github-trending-daily/pages' | ConvertFrom-Json
if ($pagesSite.build_type -ne 'workflow') { throw 'Pages did not switch to workflow builds' }
git push origin main
git fetch origin main
if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'Push readback mismatch' }
```

Before changing Pages or pushing, inspect `git log --oneline origin/main..HEAD` and `git diff --stat origin/main..HEAD`; stop if the fetched remote change is not a verified bot-only fast-forward. Switching `build_type` to `workflow` prevents a legacy main push from bypassing the explicit artifact gate; the already deployed site remains live until the dispatch succeeds. Require clean worktree and `HEAD == origin/main` after push, before the manual repair dispatch.

- [ ] **Step 2: Re-measure and activate the approved bootstrap policy in one final commit**

This activation is intentionally absent from the earlier implementation commits. Immediately before the one real dispatch:

1. Resolve and verify the live version-0/bootstrap source, then rerun the exact pending-mode `--plan-only` receipt with that source, current `RUN_CONTEXT_JSON`, and Anthropic fetch 0. Stop on source/snapshot drift or if required input/output exceeds `11,500,000/1,200,000`; never raise a cap automatically.
2. Restate the `$17.50` conservative ceiling and the possibility that provider slowness consumes part of the ceiling before the 70-minute deadline produces publication 0. Confirm that the user's one-run instruction has not been superseded.
3. Add a RED workflow test requiring only the exact `workflow_dispatch` + verified recovery version 0 branch to select `bootstrap_v0_approved`; schedule, version 1, partial identity, and numeric override must remain rejected or preflight fetch 0.
4. Change the workflow selection minimally, run the focused policy/workflow tests, repeat the policy and cap mutations, run the complete Node/Python suite, and perform the staged secret scan.
5. Fetch `origin/main` again, reject any unverified remote diff, commit and push the activation change, and prove the activation commit is the exact remote head.
6. Record the exact activation SHA and bind Step 3's one and only dispatch to that remote head; do not dispatch inside this activation step.
7. If Step 3's single dispatch fails, do not start an automatic or manual second dispatch. Preserve the failure evidence and request a new explicit decision.

- [ ] **Step 3: Resolve the one-time bootstrap parent, then perform the one and only real workflow dispatch**

Fetch the currently deployed Pages SHA from the GitHub Pages build API and prove its allowlisted production file hashes match that commit. If `deployment-manifest.json` is absent, dispatch exactly once with a `bootstrap_source_sha` workflow input equal to that verified 40-hex ancestor. The workflow accepts this input only when the production manifest is 404 and rejects it on scheduled runs or after a manifest exists. On every later run, dispatch with no bootstrap input and use the production manifest parent.

```powershell
$manifestUrl = 'https://nowwcastle-sudo.github.io/github-trending-daily/deployment-manifest.json'
$manifestStatus = (curl.exe -sS -o NUL -w '%{http_code}' "${manifestUrl}?probe=$([guid]::NewGuid())").Trim()
if ($LASTEXITCODE -ne 0) { throw 'Production manifest status request failed' }
if ($manifestStatus -eq '404') {
  $pagesBuild = gh api 'repos/nowwcastle-sudo/github-trending-daily/pages/builds/latest' | ConvertFrom-Json
  $bootstrapSourceSha = $pagesBuild.commit
  if ($pagesBuild.status -ne 'built' -or $bootstrapSourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid last successful Pages build' }
  git merge-base --is-ancestor $bootstrapSourceSha origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Pages build is not an origin/main ancestor' }
  node scripts/probe-production.mjs --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ --bootstrap-preflight-sha $bootstrapSourceSha
  if ($LASTEXITCODE -ne 0) { throw 'Bootstrap production does not match the Pages build SHA' }
  $dispatch = node scripts/dispatch-refresh.mjs --wait --bootstrap-source-sha $bootstrapSourceSha | ConvertFrom-Json
} elseif ($manifestStatus -eq '200') {
  $dispatch = node scripts/dispatch-refresh.mjs --wait | ConvertFrom-Json
} else {
  throw "Unexpected production manifest status $manifestStatus"
}
if (-not $dispatch.runId -or -not $dispatch.sourceSha -or -not $dispatch.snapshotId -or -not $dispatch.manifestSha256) { throw 'Dispatch helper returned an incomplete immutable receipt' }
```

Retain `$dispatch.runId` as the expected run id for every remaining check; if chain verification returns a later `effectiveRunId`, retain both ids.

- [ ] **Step 4: Inspect the run without printing secrets**

Run `gh run view $dispatch.runId --json status,conclusion,headSha,jobs,url`. In logs, search only for failure markers, pending counts, source SHA, snapshot id, and probe result. Do not print environment values or headers.

- [ ] **Step 5: Verify the remote and production**

Bind verification to the immutable receipt returned for `$dispatch.runId`; never replace it with the then-current branch by assumption:

```powershell
git fetch origin main
$verified = node scripts/verify-refresh-chain.mjs --expected-run-id $dispatch.runId --expected-source-sha $dispatch.sourceSha --expected-snapshot-id $dispatch.snapshotId --expected-manifest-sha256 $dispatch.manifestSha256 --base-url https://nowwcastle-sudo.github.io/github-trending-daily/ | ConvertFrom-Json
if (-not $verified.effectiveRunId -or -not $verified.sourceSha -or -not $verified.snapshotId) { throw 'Refresh-chain verifier returned incomplete evidence' }
```

Require the verifier's expected run to equal `$dispatch.runId`. If `effectiveRunId` differs, retain both receipts and the proved fast-forward relation as evidence. Query the GitHub Pages deployment and Actions run via `gh api`; require successful build/deploy for the effective exact receipt.

Verify and fast-forward the bot-only commit:

```powershell
git fetch origin main
if ((git rev-parse origin/main) -ne $verified.sourceSha) { throw 'Remote main does not match verified production receipt' }
git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) { throw 'Refresh bot commit is not a fast-forward' }
$allowedBotPath = '^(index\.html|data/(latest\.json|membership-status\.json|repo-summaries\.json|translation-sources\.json|star-observations\.sqlite|trending-membership\.sqlite)|translations/[^/]+\.json|feed\.xml|changes\.xml|star-history\.json)$'
$unexpectedBotPaths = @(git diff --name-only HEAD..origin/main | Where-Object { $_ -notmatch $allowedBotPath })
if ($unexpectedBotPaths.Count) { throw "Unexpected bot paths: $($unexpectedBotPaths -join ', ')" }
git merge --ff-only origin/main
if (git status --porcelain) { throw 'Worktree is not clean after bot fast-forward' }
```

- [ ] **Step 6: Validate active summary and translation coverage**

Run `node scripts/validate-enrichment-coverage.mjs --root . --json-counts`. Required result: active detailed summaries equal active repositories; compact fields 0; placeholder/fallback 0; applicable translation blob SHA mismatches 0; no-README items explicitly N/A.

- [ ] **Step 7: Stop on any failed gate**

Do not execute this real dispatch before the observation DB, UI, auth, security, and repository-wide functional plans are complete. Before then, require the pending-mode, plan-only, local artifact/probe, full-test, mutation, and staged-secret gates to pass, then proceed to the observation DB plan without a paid request. At the final integrated execution, record exact failure evidence and stop without an automatic second dispatch if any workflow, Pages, production probe, or browser README sample gate fails.
