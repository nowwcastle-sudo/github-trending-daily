# Plan B — 스타 tick workflow, star-history v2, gain 앵커 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `star-history.json`을 snapshot contract에서 분리해 W2(`star-ticks.yml`)가 30분마다 게시 repo의 정확한 총 스타를, 하루 1회 게시 이력 repo(상한 500)를 관측·게시하고, W1은 GitHub Trending gain 역산 앵커를 제공한다.

**Architecture:** W1은 `star-history.json` 생성을 멈추고 `data/star-anchors.json`을 만든다(frozen facts에서). finalized contract는 19파일. 새 `scripts/star-ticks.mjs`가 ① `collect`(tier 선택·REST·ledger append) ② `derive`(ledger+anchors → v2 JSON) ③ `verify`(finalized 19 hash가 production contract와 같은지)를 제공한다. `build-pages-artifact.mjs`는 contract 경로를 검증하고 overlay(`star-history.json`)를 manifest에 함께 기록한다. `star-history.js`는 v2를 렌더한다.

**Tech Stack:** Node.js 24 표준 라이브러리(`fetch`, `node:fs`, `node:crypto`), Python 3.13(derive·record 상수), GitHub Actions. 신규 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-09-03-per-repo-summary-admission-and-star-ticks-design.md` §3·§4.3·§4.4·§5·§6·§7.

## Global Constraints

- `star-history.json`은 finalized contract(19)에서 제외되되 artifact와 `deployment-manifest.json.files`에는 포함된다. 기존 snapshot의 `artifact_hashes` 20행은 재작성하지 않는다.
- ledger는 append-only 텍스트. 재작성 감지(접두 bytes 비교) 실패 시 commit·deploy 금지.
- W2 allowlist = `data/star-ticks/**`, `data/star-daily.jsonl`, `star-history.json`. 그 외 변경이 있으면 commit 금지.
- W2는 finalized 19파일 hash가 production snapshot contract와 다르면 배포하지 않는다(코드 변경은 W1으로).
- 두 workflow는 `concurrency.group: daily-refresh`, `cancel-in-progress: false`.
- `GITHUB_TOKEN`만 사용. 시작 시 `GET /rate_limit` remaining < 500이면 종료.
- RED 먼저, mutation 원복, Common Commit Gate, PowerShell. branch: `claude/plan-b-star-ticks-20260903`.

## File Structure

- Create: `scripts/star-ticks.mjs`(collect/derive/verify + 순수 함수 export), `scripts/derive-star-anchors.mjs`, `.github/workflows/star-ticks.yml`, `data/star-ticks/.gitkeep`, `data/star-daily.jsonl`(헤더 1줄), `data/star-anchors.json`(초기 `{"version":1,"generatedAt":null,"anchors":{}}`)
- Delete: `scripts/update-star-history.mjs`, `tests/update-star-history.test.mjs`
- Modify: `scripts/record_repository_observations.py:43-48`(`PAGES_BASE_ARTIFACT_PATHS`), `scripts/build-pages-artifact.mjs:82-100, 296-310, 348-385`(`VERSION_1_BASE_PATHS`, `verifyArtifactContract`, `buildPagesArtifact` overlay), `scripts/probe-production.mjs:300-316`, `scripts/derive_repository_artifacts.py`(`--star-history-out` 제거), `.github/workflows/daily-refresh.yml`(derive·publish allowlist·cp), `.github/workflows/deploy-current-pages.yml`(overlay 포함 build는 자동), `star-history.js`, `index.html`(histnote 문구), `README.md`/`README.ko.md`
- Tests: `tests/star-ticks.test.mjs`(new), `tests/star-history.test.mjs`, `tests/pages-publication.test.mjs:439`, `tests/test_repository_artifacts.py`, `tests/test_repository_observations.py`, `tests/daily-refresh-workflow.test.mjs`, `tests/run-context.test.mjs:61`

---

### Task 0: branch — Plan A Task 0과 같은 절차, branch 이름 `claude/plan-b-star-ticks-20260903`.

### Task 1: finalized contract를 19파일로 줄이고 overlay를 manifest에 남긴다

**Files:** `scripts/record_repository_observations.py:43-48`, `scripts/build-pages-artifact.mjs`, `scripts/probe-production.mjs`, tests

**Interfaces:**
- `PAGES_BASE_ARTIFACT_PATHS`(Python)·`VERSION_1_BASE_PATHS`(JS)에서 `"star-history.json"` 제거. 새 상수 `OVERLAY_PATHS = ["star-history.json"]`(JS, export).
- `buildPagesArtifact`: `verifyArtifactContract(sourceRoot, snapshotId, contractPaths, contract)`는 contract 경로만; `installArtifact`에는 `[...contractPaths, ...OVERLAY_PATHS]`를 넘겨 manifest.files에 20+ 경로 기록.
- `probe-production.verifyVersion1Payload`: `Object.keys(manifest.files) === [...expectedPaths, ...OVERLAY_PATHS].sort()`; `validateArtifactContract(contract, snapshotId, expectedPaths, bodies)`는 contract 경로만; overlay는 manifest hash와 body hash 일치(기존 루프가 이미 함).
- W1 production-state 검증(`inspectProductionState`)은 manifest 형식만 보므로 변경 없음.

- [ ] **Step 1: RED tests** — `pages-publication.test.mjs:439` 기대 목록에서 `star-history.json` 제거 + "manifest.files includes star-history.json overlay while contract has 19 rows" 단언; `test_repository_artifacts.py`에서 finalize 후 `artifact_hashes` 행 수 = 19 + translations.
- [ ] **Step 2: RED 확인**, **Step 3: 구현**, **Step 4: GREEN**, **Step 5: mutation**(overlay를 contract에 넣으면 RED), **Step 6: Commit** — `feat: star-history.json을 snapshot contract에서 분리하고 manifest overlay로 배포`

### Task 2: W1이 star-history.json 대신 star-anchors.json을 만든다

**Files:** `scripts/derive-star-anchors.mjs`(new), `scripts/derive_repository_artifacts.py`(`--star-history-out` 제거·`derive_star_history` 호출 제거; 함수는 `derive_daily_star_series`가 쓰면 유지), `.github/workflows/daily-refresh.yml:421-434, 468-536`, 삭제 `scripts/update-star-history.mjs`, `tests/update-star-history.test.mjs`, `tests/run-context.test.mjs:61`

**Interfaces:**
- `node scripts/derive-star-anchors.mjs --facts FILE --out FILE` → `{"version":1,"generatedAt":"<facts.observedAtUtc>","anchors":{"owner/repo":[{"at","stars","source"}]},"warnings":[{"slug","code":"non_monotonic|negative"}]}`.
- export `deriveStarAnchors(facts)`(순수): repo마다 gain별 앵커, 단조성 필터, created_at 30일 규칙(사양서 §4.4).
- W1 publish allowlist: `star-history.json` 제거, `data/star-anchors.json` 추가(cp·case·git add·secret scan 대상). `translations/`는 그대로.

- [ ] **Step 1: RED tests** — `tests/star-ticks.test.mjs`(anchors 파트): facts fixture `{stars: 1200, gain_daily: 100, gain_weekly: 300, gain_monthly: null, created_at: <25일 전>}` → anchors 3개(created 0, −7d 900, −1d 1100), monthly 없음; `gain_daily 2819 > gain_weekly 2085` → weekly 앵커 제거 + warning; `created_at` 40일 전 → created 앵커 없음.
- [ ] **Step 2~6** — 구현 → GREEN → mutation(단조성 필터 제거 시 RED) → workflow 수정(derive step에 anchors 명령 추가, `update-star-history` 줄 삭제, allowlist 교체) → `daily-refresh-workflow.test.mjs` 갱신 → Commit `feat: W1이 GitHub Trending gain 역산 앵커를 생성하고 star-history.json 생성을 중단`

### Task 3: `star-ticks.mjs` — ledger, tier 선택, 상한 top-N, v2 파생

**Files:** `scripts/star-ticks.mjs`(new), `tests/star-ticks.test.mjs`

**Interfaces (순수 함수, export):**
- `parseDailyLedger(text)` → `Map<slugLower, [{date, stars, tier, unavailable?}]>`; 첫 줄 헤더 `{"version":1}` 검증.
- `selectWatchSet({ published, dailyRows, cap = 500, today })` → `{ tierA: string[], tierB: string[] }`: tierA = published; 후보 = dailyRows slug − tierA; 7일 gain = 가장 최근 값 − (today−7d 이후 첫 값); 상위 `cap − |tierA|`; 동률은 마지막 tier A 줄 날짜 내림차순 → slug 오름차순; 최근 3줄 연속 `unavailable`이면 제외.
- `appendLedger({ existingBytes, lines })` → 새 bytes; 호출자는 commit 전 `newBytes.subarray(0, existing.length).equals(existing)`를 검사(`assertAppendOnly`).
- `rollupDaily(tickLines, date)` → 그날 마지막 tick.
- `deriveStarHistoryV2({ published, tickRowsBySlug, dailyRowsBySlug, anchors, now })` → §5.1 객체: observed = 최근 14일 tick 전부 + 그 이전 daily 1점, 앵커는 관측 있는 날짜 제외, 2,000점 상한.
- CLI: `collect --token-env GITHUB_TOKEN --tier a|ab --published data/latest.json --ticks-dir data/star-ticks --daily data/star-daily.jsonl --run-id ID`, `derive --published … --ticks-dir … --daily … --anchors data/star-anchors.json --out star-history.json`, ~~`verify-contract --source . --manifest-url URL`~~ — 구현 시 제외(2026-09-03): `deploy-current-pages.yml`과 같은 경로(`export-contract` → `build-pages-artifact` → probe)가 이미 finalized 19 hash를 DB contract와 대조해 불일치 시 빌드를 거부하므로 별도 CLI를 두지 않았다.

- [ ] **Step 1: RED tests**(핵심 5개):

```js
test("selectWatchSet keeps published repos, fills the cap by 7-day gain, and never evicts published", () => {
  const rows = new Map([["a/x", days([[-8, 10], [-1, 100]])], ["a/y", days([[-8, 10], [-1, 12]])], ["a/z", days([[-3, 5]])]]);
  const picked = selectWatchSet({ published: ["p/one"], dailyRows: rows, cap: 3, today: TODAY });
  assert.deepEqual(picked.tierA, ["p/one"]);
  assert.deepEqual(picked.tierB, ["a/x", "a/y"]);
});
test("selectWatchSet breaks ties by most recent tier-A day then slug and drops three consecutive unavailable", () => { /* 동률·unavailable fixture */ });
test("assertAppendOnly rejects a rewritten prefix", () => {
  const existing = Buffer.from('{"version":1}\n{"slug":"a/x","stars":1}\n');
  assert.throws(() => assertAppendOnly(existing, Buffer.from('{"version":1}\n{"slug":"a/x","stars":2}\n')), /append-only/);
});
test("deriveStarHistoryV2 keeps 30-minute ticks for 14 days, one daily point before, and suppresses anchors on observed days", () => { /* fixture */ });
test("collect skips the run when rate limit remaining is below 500", async () => { /* fetch stub returning {rate:{remaining:499}} → result.skipped === true, 0 repo calls */ });
```

- [ ] **Step 2: RED 확인**(모듈 부재), **Step 3: 구현**(순수 함수 먼저, CLI는 얇게), **Step 4: GREEN**, **Step 5: mutation**(published 보호 제거 → RED; 접두 검사 제거 → RED), **Step 6: Commit** — `feat: star-ticks 수집·상한 선택·v2 파생 모듈 추가`

### Task 4: `star-history.js` v2 렌더

**Files:** `star-history.js`, `index.html`(histnote 문구·점선 스타일), `tests/star-history.test.mjs`, `tests/page-runtime.test.mjs`

- [ ] **Step 1: RED tests** — `normalizeCache`가 v1 거부·v2 수용; `displayPoints`가 anchors∪observed를 `at` 정렬; `historyHtml`이 anchors 점선(`stroke-dasharray`)과 observed 실선 두 polyline, 문구 "이 사이트가 직접 관측한 총 스타(30분 간격) · 점선은 GitHub Trending 기간 집계로 역산한 앵커", 0점 "관측 시작 대기", 1점 "관측 1회"; slug 미보간(XSS) 유지; CommonJS export 목록 유지.
- [ ] **Step 2~6** — 구현 → GREEN → mutation(v1 수용으로 되돌리면 RED) → Commit `feat: star-history v2(앵커+관측 tick) 렌더`

### Task 5: `star-ticks.yml`과 deploy-only overlay

**Files:** `.github/workflows/star-ticks.yml`(new), `.github/workflows/deploy-current-pages.yml`(변경 없음 확인), `tests/daily-refresh-workflow.test.mjs`(신규 단언), `data/star-ticks/.gitkeep`, `data/star-daily.jsonl`, `data/star-anchors.json`

workflow 골격:

```yaml
name: Star ticks
on:
  schedule: [{ cron: "5,35 * * * *" }]
  workflow_dispatch:
permissions: {}
concurrency: { group: daily-refresh, cancel-in-progress: false }
jobs:
  tick:
    if: ${{ github.event_name == 'workflow_dispatch' || vars.GH_TRENDING_TICKS == 'enabled' }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions: { contents: write, pages: write, id-token: write }
    steps:
      - checkout(main, fetch-depth 0) · setup-node 24 · setup-python 3.13 · npm ci
      - Rate limit gate: node scripts/star-ticks.mjs rate-limit → remaining<500이면 `exit 0` + notice
      - Tier: `TIER=a`; UTC 시가 홀수이고 분이 35면 `TIER=ab`
      - node scripts/star-ticks.mjs collect --tier $TIER … --run-id ${{ github.run_id }}
      - node scripts/star-ticks.mjs derive …
      - allowlist 검사(`git status --porcelain` ⊆ 3경로) · `git diff --check` · secret scan · origin/main == HEAD 확인 · commit `chore: star ticks <UTC>` · push
      - export-contract(committed DB) · build-pages-artifact(v1, contract 19 대조 + overlay 포함) · probe · upload-pages-artifact · deploy-pages · probe deployed  ← verify-contract CLI 대신 builder의 contract 검사를 그대로 사용(2026-09-03)
```

- [ ] **Step 1: RED tests** — `daily-refresh-workflow.test.mjs`: 두 workflow의 `concurrency.group` 동일, W2 cron `5,35 * * * *`, `vars.GH_TRENDING_TICKS` 게이트, allowlist 3경로, `GITHUB_TOKEN` 외 secret 참조 없음.
- [ ] **Step 2~6** — 파일 작성 → GREEN → actionlint(가능하면) → Commit `feat: star-ticks workflow 추가`

### Task 6: 문서·검증·리뷰·PR

- README en/ko "Star history" 문단: 30분 실측·앵커·상한 500 아카이브 설명(§4.3 수치). 08-22 spec §12 참조 링크 유지.
- `npm test`, `npm run test:rules`, `git diff --check`, `data/` 변경은 신규 3파일만. fable 리뷰 → push → PR → CodeQL → **merge 승인 요청**.

### Task 7 (운영, Plan A·B merge 후): W1 controlled dispatch 1회 → production manifest(19 contract + overlay) 확인 → 사용자 승인 후 `gh variable set GH_TRENDING_TICKS --body enabled` → W2 dispatch 1회 + 다음 schedule 2회 관찰(rate limit 헤더 실측) → 카드 sparkline 확인 → 최종 좌표 보고.
