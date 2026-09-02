# OSS Insight 과거 스타 추정치 중단 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OSS Insight 과거 스타 추정치 수집·표시를 중단하고 자체 exact 일별 관측만 게시해, `Collect complete repository events`의 `Invalid OSS Insight envelope` fail-closed를 근본적으로 해소한다.

**Architecture:** `collect-repository-events.mjs`는 OSS Insight를 더 이상 호출하지 않고 repository마다 고정 discontinuation receipt(빈 rows + 상수 해시)를 events envelope에 남긴다. recorder는 기존 로직으로 이전 API 추정 점을 tombstone 처리하므로 변경하지 않는다. `derive_repository_artifacts.py`의 `_selected_estimates`는 legacy cache fallback을 제거해 API present 점만 선택한다(모두 tombstone이면 빈 배열). 공개 스키마 키 `estimated`/`observed`는 유지한다.

**Tech Stack:** Node.js 24 표준 라이브러리, Python 3.13 표준 라이브러리, SQLite, GitHub Actions, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-08-22-star-history-google-auth-design.md` §11 뒤집는 조건 2항("OSS Insight의 성공률 또는 최신성이 지속적으로 기준을 충족하지 못하면 과거 추정 수집을 중단하고 자체 일별 관측만 유지한다"). 발동 근거는 본 계획 §근거에 기록한다.

## 근거 (2026-09-02 실측)

- 45개 active repository 전부 OSS Insight 응답 최상위 키가 `data,data_quality,type`이며 `data_quality.status="degraded"`, `severely_degraded_since="2026-05-01"`.
- GitHub 현재 스타 ÷ OSS 최신 추정: 중앙값 14.5배, 최대 73.8배, 37/45가 2배 이상 과소. 1.2배 미만은 3개(전부 2025년 이전 구저장소).
- 기존 validator(`collect-repository-events.mjs:444`)는 3-key envelope를 거부한다. 실측 payload에서 `data_quality`만 제거하면 수용된다.
- 사용자 결정(2026-09-02): A안 승인. Codex 자동화 2건 삭제. enrichment는 Claude 경로.

## Global Constraints

- fail-closed 유지. 검증 약화·stale relabeling 금지.
- append-only DB, schema fingerprint, `historical_star_estimates` 스키마(`source IN ('legacy_star_history_cache','ossinsight_api')`)는 바꾸지 않는다.
- 공개 star-history 스키마 `{slug, estimated, observed}` exact keys 유지. `estimated`는 빈 배열 허용(기존 validator가 이미 허용).
- events envelope의 estimate receipt exact keys `slug, rows, sourcePayloadSha256, publicRows` 유지. Python recorder(`_validated_event_maps`, 1651~1670행)는 수정하지 않는다.
- production code를 쓰기 전에 그 동작을 잡는 RED test를 실행하고 예상한 이유로 실패한 것을 기록한다.
- 각 mutation은 owning test가 RED임을 확인한 즉시 원복하고 같은 focused test를 GREEN으로 다시 실행한다.
- 테스트·검증은 PowerShell에서 실행한다(Git Bash에서는 GNU tar가 선택되어 `pages-publication` 2건이 환경 오류로 실패한다).
- push 직전 `git fetch --prune origin`에서 원격 전진이 보이면 자동 병합·rebase·reset 없이 중단한다.
- merge·workflow dispatch·Pages deploy는 사용자 확인 뒤에만 수행한다.
- 비밀값·raw auth output·README 본문을 터미널이나 커밋에 출력하지 않는다.

## Common Commit Gate

모든 task의 Commit step은 명시된 파일만 stage한 뒤 다음 PowerShell 검사를 실행한다.

```powershell
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged diff check failed' }
$stagedDiff = @(git diff --cached --no-ext-diff --unified=0 --no-color -- .)
if ($LASTEXITCODE -ne 0) { throw 'Unable to read staged diff for secret scan' }
$stagedAddedLines = @($stagedDiff | Where-Object { $_ -match '^\+(?!\+\+\+)' } | ForEach-Object { $_.Substring(1) })
$secretPattern = '(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
$secretHits = @($stagedAddedLines | Select-String -Pattern $secretPattern -AllMatches)
if ($secretHits.Count) { throw 'Potential secret detected in staged additions' }
```

---

## File Structure

### 수정할 production 파일
- `scripts/collect-repository-events.mjs` — OSS 호출·validator·retry 상수 제거, discontinuation receipt 상수 추가
- `scripts/derive_repository_artifacts.py` — `_selected_estimates`에서 legacy fallback 제거
- `star-history.js` — 설명 문구를 관측 전용으로 교체

### 수정할 test·문서 파일
- `tests/collect-repository-events.test.mjs`
- `tests/update-trending.test.mjs`
- `tests/test_repository_artifacts.py`
- `tests/star-history.test.mjs`
- `README.md`, `README.ko.md`
- `docs/superpowers/specs/2026-08-22-star-history-google-auth-design.md` (§12 addendum)
- `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md` (§1 결정 13 추가)

---

### Task 0: exact clean main에서 작업 branch 생성

**Files:** 없음 (git만)

- [ ] **Step 1: 좌표 확인·branch 생성**

```powershell
Set-Location -LiteralPath 'C:\Users\nasca\AppData\Local\Temp\gh-trending-page'
git fetch --prune origin
git switch main
git pull --ff-only origin main
if ((git status --short).Count -ne 0) { throw 'main worktree is not clean' }
if ((git rev-parse HEAD) -ne (git rev-parse refs/remotes/origin/main)) { throw 'main is not exact origin/main' }
git switch -c claude/discontinue-oss-star-estimates-20260902
```

Expected: HEAD `a227cba4a77dbb55b4b84085fedd4a69def920db`. 다르면 중단하고 보고한다.

- [ ] **Step 2: 이 계획 문서를 첫 커밋으로 남긴다**

```powershell
git add docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md
# Common Commit Gate 실행
git commit -m "docs: OSS Insight 과거 스타 추정치 중단 구현 계획 작성"
```

---

### Task 1: collector가 OSS Insight를 호출하지 않고 고정 discontinuation receipt를 남긴다

**Files:**
- Modify: `scripts/collect-repository-events.mjs:12-27` (EVENT_LIMITS), `:44-46` (상수 추가 위치), `:183-186` (REQUEST_OPERATIONS), `:188` (request 시그니처), `:434-473` (ossInteger·validateOssInsightResponse·collectOss 삭제), `:514` (estimates.push)
- Test: `tests/collect-repository-events.test.mjs`, `tests/update-trending.test.mjs:827-859`

**Interfaces:**
- Consumes: 기존 `collectRepositoryEvents(repositories, options)`.
- Produces: `export const OSS_ESTIMATE_DISCONTINUATION` (frozen object), `export const OSS_ESTIMATE_DISCONTINUATION_SHA256` (64-hex). `events.estimates[i]`는 `{ slug, rows: [], sourcePayloadSha256: OSS_ESTIMATE_DISCONTINUATION_SHA256, publicRows: [] }`. `validateOssInsightResponse`는 더 이상 export되지 않는다.

- [ ] **Step 1: RED test 작성** — `tests/collect-repository-events.test.mjs`의 import에 두 상수를 추가하고 `validateOssInsightResponse`를 제거한 뒤, 파일 끝에 추가:

```js
test("historical star estimates are discontinued: no OSS Insight request and one exact empty receipt per repository", async () => {
  const other = { slug: "owner/other", default_branch: "main", default_branch_head_sha: sha("b") };
  const events = await collectRepositoryEvents([repo, other], {
    fetchImpl: async (url, options) => {
      if (new URL(url).hostname === "api.ossinsight.io") throw new Error("OSS Insight must not be requested");
      return successfulFetch()(url, options);
    },
  });
  assert.deepEqual(events.estimates, [
    { slug: "owner/repo", rows: [], sourcePayloadSha256: OSS_ESTIMATE_DISCONTINUATION_SHA256, publicRows: [] },
    { slug: "owner/other", rows: [], sourcePayloadSha256: OSS_ESTIMATE_DISCONTINUATION_SHA256, publicRows: [] },
  ]);
  assert.match(OSS_ESTIMATE_DISCONTINUATION_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(OSS_ESTIMATE_DISCONTINUATION.provider, "ossinsight_api");
  assert.equal(OSS_ESTIMATE_DISCONTINUATION.status, "discontinued");
  assert.equal(OSS_ESTIMATE_DISCONTINUATION.severelyDegradedSince, "2026-05-01");
  assert.equal(Object.isFrozen(OSS_ESTIMATE_DISCONTINUATION), true);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/collect-repository-events.test.mjs`
Expected: 새 test FAIL. 이유는 `OSS_ESTIMATE_DISCONTINUATION_SHA256`가 undefined이고 collector가 `api.ossinsight.io`를 호출해 `Event OSS star history request failed`로 reject하기 때문. 기존 test는 통과 상태.

- [ ] **Step 3: 최소 구현**

`scripts/collect-repository-events.mjs`:

1. `EVENT_LIMITS`에서 `ossRetryDelaysMs`, `maxOssBytes`, `maxOssRows`, `publicOssRows` 네 항목을 삭제한다.
2. `const canonicalHash = hashCanonicalJson;` 바로 아래(46행 근처)에 추가:

```js
// 2026-09-02: OSS Insight declared its event-derived stargazer counts
// severely degraded since 2026-05-01 (median 14.5x undercount on the active
// set). Historical estimate collection is discontinued; only exact daily
// observations are published. The receipt keeps the envelope contract intact.
export const OSS_ESTIMATE_DISCONTINUATION = Object.freeze({
  provider: "ossinsight_api",
  status: "discontinued",
  decidedOn: "2026-09-02",
  severelyDegradedSince: "2026-05-01",
  reason: "OSS Insight data_quality: github_event_derived stargazer counts are lower bounds since 2025-05-23 and severely degraded since 2026-05-01",
});
export const OSS_ESTIMATE_DISCONTINUATION_SHA256 = canonicalHash(OSS_ESTIMATE_DISCONTINUATION);
```

3. `REQUEST_OPERATIONS`에서 `"OSS star history"` 제거.
4. `request()` 시그니처의 `retryDelaysMs = EVENT_LIMITS.retryDelaysMs` 옵션을 제거하고 함수 첫 줄에 `const retryDelaysMs = EVENT_LIMITS.retryDelaysMs;`를 둔다.
5. `ossInteger`, `validateOssInsightResponse`, `collectOss` 세 함수를 삭제한다.
6. `collectRepositoryEvents` 안의 `estimates.push(await collectOss(slug, context));`를 다음으로 교체:

```js
    estimates.push({ slug, rows: [], sourcePayloadSha256: OSS_ESTIMATE_DISCONTINUATION_SHA256, publicRows: [] });
```

- [ ] **Step 4: 죽은 테스트·fixture 정리** — `tests/collect-repository-events.test.mjs`:

1. `function oss(rows)` 헬퍼 삭제.
2. `successfulFetch`의 `ossRows` 파라미터 삭제, `if (value.hostname === "api.ossinsight.io") return response(200, oss(ossRows));`를 `if (value.hostname === "api.ossinsight.io") throw new Error("OSS Insight must not be requested");`로 교체.
3. 다음 test 삭제: `"OSS Insight is exact, complete, normalized and is not limited by public display cap"`, `"OSS Insight alone gets the longer bounded recovery schedule"`, `"calendar-valid 501-point OSS history retains full storage and independent public slice"`.
4. `"terminal retry counts every attempt and OSS rejects 10,001 rows and malformed numbers"`에서 `oversized` 배열과 `validateOssInsightResponse` 관련 `assert.throws` 블록(뒤쪽 10줄)을 삭제하고 test 이름을 `"terminal retry counts every attempt"`로 바꾼다.
5. 803·823·955행의 `if (value.hostname === "api.ossinsight.io") return ...` 분기를 삭제하고, 875행의 `|| new URL(url).hostname === "api.ossinsight.io"` 절을 삭제한다.

`tests/update-trending.test.mjs` `"transactional boundary completes facts and events before paid enrichment"`:
- 831~840행의 `api.ossinsight.io` 분기를 삭제한다.
- `logicalRequests`·`httpAttempts` 기대값 110을 100으로 바꾼다(repository 10개 × OSS 1회가 빠진다). 실제 측정값이 100이 아니면 그 이유를 먼저 설명하고 값을 맞춘다.

- [ ] **Step 5: GREEN 확인**

Run (PowerShell): `node --test tests/collect-repository-events.test.mjs tests/update-trending.test.mjs`
Expected: 전부 PASS. collector test 수는 30 → 28.

- [ ] **Step 6: mutation** — `estimates.push({...})`를 임시로 `estimates.push({ slug, rows: [], sourcePayloadSha256: "0".repeat(64), publicRows: [] });`로 바꾸고 Step 5를 다시 실행한다. Expected: 새 test FAIL(sourcePayloadSha256 불일치). 즉시 원복 후 GREEN 재확인.

- [ ] **Step 7: Commit**

```powershell
git add scripts/collect-repository-events.mjs tests/collect-repository-events.test.mjs tests/update-trending.test.mjs
# Common Commit Gate 실행
git commit -m "feat: OSS Insight 과거 스타 추정치 수집을 중단하고 고정 discontinuation receipt만 남김"
```

---

### Task 2: derive가 legacy cache fallback 없이 API present 점만 선택한다

**Files:**
- Modify: `scripts/derive_repository_artifacts.py:382-415` (`_selected_estimates`)
- Test: `tests/test_repository_artifacts.py:501-590`

**Interfaces:**
- Consumes: `historical_star_estimates` 행(recorder가 Task 1 receipt로 이전 API 점을 `is_present=0` tombstone으로 append함).
- Produces: `_selected_estimates(connection, slug, snapshot_seq) -> list[{"date","stars"}]` — `source='ossinsight_api'` 각 date의 최신 version이 present인 점만, 최대 500개.

- [ ] **Step 1: RED test** — `test_star_history_applies_as_of_tombstone_and_public_exact_precedence`의 기대값 두 줄을 다음으로 바꾼다(legacy 행 insert는 fixture에 그대로 두어 "무시됨"을 증명한다):

```python
        self.assertEqual(at_removed["repositories"][0]["estimated"], [])
        self.assertEqual(at_reentry["repositories"][0]["estimated"], [{"date": "2026-08-01", "stars": 10}])
```

test 이름을 `test_star_history_applies_as_of_tombstone_ignores_legacy_cache_and_public_exact_precedence`로 바꾼다.

`test_star_history_applies_caps_after_selection_and_rejects_per_repo_baseline_hash`는 다음으로 교체한다:

```python
    def test_star_history_applies_caps_after_selection(self):
        database = self.root / "ledger.sqlite"
        create_database(database)
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            insert_run(connection, 1, "2026-08-28T00:00:00.000Z", "2026-08-28")
            insert_profile(connection, 1, "owner/repo", "Owner/Repo")
            insert_item(connection, 1, "owner/repo", 1, stars=1)
            insert_public_baseline(connection)
            start = date.fromisoformat("2020-01-01")
            for index in range(501):
                point_date = (start + timedelta(days=index)).isoformat()
                insert_estimate(connection, 1, "owner/repo", index, point_date=point_date)
            for index in range(731):
                point_date = (start + timedelta(days=index)).isoformat()
                stars = index
                connection.execute("INSERT INTO historical_star_observations VALUES (?,?,?,?,?,?,?,?,?)", (
                    "legacy_public_star_history", None, "owner/repo", point_date, stars, None, None,
                    digest({"source": "legacy_public_star_history", "slug": "owner/repo", "observation_date": point_date, "stars": stars}), 1,
                ))
            result = derive_star_history(connection, 1)
            self.assertEqual(len(result["repositories"][0]["estimated"]), 500)
            self.assertEqual(result["repositories"][0]["estimated"][0], {"date": "2020-01-02", "stars": 1})
            self.assertEqual(len(result["repositories"][0]["observed"]), 730)
```

- [ ] **Step 2: RED 확인**

Run: `python -m unittest tests.test_repository_artifacts -k star_history -v`
Expected: tombstone test FAIL — `at_removed`가 `[{"date": "2026-07-01", "stars": 7}]`(legacy fallback)를 반환. caps test는 PASS(구현 변경 전에도 API 500 cap은 성립).

- [ ] **Step 3: 최소 구현** — `_selected_estimates` 전체를 교체:

```python
def _selected_estimates(connection: sqlite3.Connection, slug: str, snapshot_seq: int) -> list[dict[str, int | str]]:
    # 2026-09-02: legacy_star_history_cache rows share the discontinued OSS Insight
    # provenance and are no longer selected for display. They stay in the ledger
    # untouched; only the latest present ossinsight_api version per date is shown.
    latest: dict[str, tuple[int, int | None]] = {}
    for estimate_date, present, stars in connection.execute(
        """SELECT estimate_date,is_present,stars
           FROM historical_star_estimates
           WHERE source='ossinsight_api' AND slug=? AND first_observed_snapshot_seq<=?
           ORDER BY estimate_date,first_observed_snapshot_seq""", (slug, snapshot_seq)
    ):
        latest[estimate_date] = (present, stars)
    selected = [
        {"date": estimate_date, "stars": stars}
        for estimate_date, (present, stars) in sorted(latest.items())
        if present
    ]
    return selected[-500:]
```

- [ ] **Step 4: GREEN 확인**

Run: `python -m unittest tests.test_repository_artifacts -v`
Expected: 전부 PASS.

- [ ] **Step 5: mutation** — `if present` 조건을 임시로 제거하고 Step 4 재실행. Expected: tombstone test FAIL(`at_removed`에 stars None 점 포함). 원복 후 GREEN 재확인.

- [ ] **Step 6: Commit**

```powershell
git add scripts/derive_repository_artifacts.py tests/test_repository_artifacts.py
# Common Commit Gate 실행
git commit -m "fix: 공개 스타 추정 선택에서 legacy OSS cache fallback을 제거하고 API present 점만 사용"
```

---

### Task 3: UI 설명 문구를 exact 관측 전용으로 바꾼다

**Files:**
- Modify: `star-history.js:9`
- Test: `tests/star-history.test.mjs:46-53`

**Interfaces:**
- Produces: `EXPLANATION = "매일 GitHub에서 직접 관측한 총 스타 추이"`. `displayPoints`·`normalizeCache`·스키마는 그대로.

- [ ] **Step 1: RED test** — `"historyHtml uses fixed copy and never interpolates the slug"`의 `assert.match(html, /GH Archive 기반 과거 추정 · 현재 총 스타는 GitHub 기준/);`를 다음으로 교체:

```js
  assert.match(html, /매일 GitHub에서 직접 관측한 총 스타 추이/);
  assert.doesNotMatch(html, /GH Archive|추정/);
```

- [ ] **Step 2: RED 확인**

Run: `node --test tests/star-history.test.mjs`
Expected: 해당 test FAIL(현재 문구는 "GH Archive 기반 과거 추정 …").

- [ ] **Step 3: 최소 구현** — `star-history.js` 9행:

```js
  const EXPLANATION = "매일 GitHub에서 직접 관측한 총 스타 추이";
```

- [ ] **Step 4: GREEN 확인** — Run: `node --test tests/star-history.test.mjs tests/page-runtime.test.mjs`. Expected: 전부 PASS.

- [ ] **Step 5: Commit**

```powershell
git add star-history.js tests/star-history.test.mjs
# Common Commit Gate 실행
git commit -m "fix: 스타 추이 설명을 GitHub 일별 관측 전용 문구로 교체"
```

---

### Task 4: 문서를 결정과 일치시킨다

**Files:**
- Modify: `README.md:89`, `README.ko.md:89`
- Modify: `docs/superpowers/specs/2026-08-22-star-history-google-auth-design.md` (§11 뒤에 §12 추가)
- Modify: `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md` (§1에 13항 추가)

- [ ] **Step 1: README 문장 교체**

`README.md` 89행 첫 문장을:

```
Historical star charts show only exact daily GitHub star totals observed by this pipeline; GH Archive-derived estimates were discontinued on 2026-09-02 after the upstream source declared its event-derived counts severely degraded since 2026-05-01. CSV uses a UTF-8 BOM ...
```

`README.ko.md` 89행 첫 문장을:

```
과거 스타 차트는 이 파이프라인이 매일 GitHub에서 직접 관측한 총 스타만 표시합니다. GH Archive 기반 추정치는 출처가 2026-05-01 이후 심각한 과소집계를 스스로 선언해 2026-09-02에 중단했습니다. CSV는 ...
```

(각 문장의 CSV 이하 부분은 기존 원문을 그대로 유지한다.)

- [ ] **Step 2: spec addendum** — 08-22 spec 파일 끝에 추가:

```markdown
## 12. 2026-09-02 뒤집는 조건 발동 기록

§11 2항이 발동됐다. 2026-09-02 실측에서 active repository 45개 전부의 OSS Insight 응답에 `data_quality`(`status=degraded`, `severely_degraded_since=2026-05-01`)가 추가됐고, GitHub 현재 스타 대비 OSS 최신 추정은 중앙값 14.5배·최대 73.8배 과소였다. 사용자 결정으로 과거 추정 수집을 중단하고 자체 exact 일별 관측만 게시한다. `historical_star_estimates`의 기존 행은 append-only로 보존하며 새 snapshot부터 `ossinsight_api` 점은 tombstone, `legacy_star_history_cache` 점은 표시 선택에서 제외한다. 구현 계획: `docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md`.
```

- [ ] **Step 3: handoff §1 13항 추가**

```markdown
13. OSS Insight 과거 스타 추정치 수집·표시는 2026-09-02 사용자 결정으로 중단했다. events envelope는 repository마다 빈 receipt와 discontinuation 해시를 유지하고, 공개 `estimated`는 새 snapshot부터 빈 배열이다. 근거와 구현은 `docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md`.
```

- [ ] **Step 4: 관련 문서 테스트 확인** — Run: `node --test tests/daily-refresh-workflow.test.mjs tests/run-context.test.mjs`. Expected: PASS(README·spec 참조 테스트가 있으면 함께 통과).

- [ ] **Step 5: Commit**

```powershell
git add README.md README.ko.md docs/superpowers/specs/2026-08-22-star-history-google-auth-design.md docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md
# Common Commit Gate 실행
git commit -m "docs: OSS Insight 추정치 중단 결정을 README·설계서·handoff에 반영"
```

---

### Task 5: 전체 검증, 리뷰, push, PR, matching-SHA CodeQL

**Files:** 없음 (검증·git만)

- [ ] **Step 1: 전체 테스트(PowerShell)**

```powershell
npm test
npm run test:rules
```

Expected: Node fail 0(총 test 수는 594 − 3 삭제 + 1 추가 = 592 근처, skip 12), Python 150 pass, Rules 9 pass. 숫자가 다르면 원인을 설명한다.

- [ ] **Step 2: 정적 검사**

```powershell
git diff --check main...HEAD
npx --yes actionlint@1.7.12 -color never 2>$null; if ($LASTEXITCODE -eq 0) { 'actionlint pass' }
git grep -n -i "ossinsight" -- scripts tests README.md README.ko.md star-history.js
```

Expected: `git diff --check` 출력 없음. `ossinsight` 잔여 참조는 `record_repository_observations.py`·`derive_repository_artifacts.py`·`test_repository_observations.py`·`test_repository_artifacts.py`의 DB source 문자열, 그리고 collector의 discontinuation 상수만이다. actionlint는 workflow가 바뀌지 않았으므로 기존 결과와 같아야 한다.

- [ ] **Step 3: 의도 검증(안전 불변식)**

```powershell
git diff --stat main...HEAD
git diff main...HEAD -- .github/workflows data/ | Measure-Object -Line
```

Expected: workflow·`data/` 변경 0줄. tracked DB·snapshot 파일 미변경.

- [ ] **Step 4: 독립 코드 리뷰** — `mattpocock-skills:code-review` 기준으로 diff 전체를 리뷰한다(서브에이전트 사용 시 opus). finding이 있으면 수정 후 Step 1부터 반복.

- [ ] **Step 5: remote drift 확인 후 push**

```powershell
git fetch --prune origin
if ((git rev-parse refs/remotes/origin/main) -ne 'a227cba4a77dbb55b4b84085fedd4a69def920db') { throw 'origin/main advanced; stop and re-measure' }
git push -u origin claude/discontinue-oss-star-estimates-20260902
```

- [ ] **Step 6: PR 생성·CodeQL 확인**

```powershell
gh pr create --base main --head claude/discontinue-oss-star-estimates-20260902 --title "OSS Insight 과거 스타 추정치 중단, exact 관측만 게시" --body-file docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md
gh run list --workflow codeql.yml --limit 3
```

Expected: PR head SHA와 같은 `commit_sha`의 CodeQL analysis 2건(JavaScript/TypeScript, Python), `results_count` 확인. 0 analyses는 통과로 세지 않는다.

- [ ] **Step 7: 사용자에게 merge 승인 요청** — PR URL, head SHA, 테스트 수치, CodeQL analysis id를 보고하고 멈춘다.

---

### Task 6 (merge 승인 후): Claude 경로 controlled dispatch와 production 검증

**Files:** 없음 (운영)

- [ ] **Step 1: merge 뒤 exact main 고정** — Task 0 Step 1 명령을 다시 실행(branch 생성 제외). 새 main SHA를 기록한다. 매칭 CodeQL analysis를 다시 확인한다.

- [ ] **Step 2: self-hosted runner를 대화형 listener로 기동**

```powershell
Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','C:\actions-runner-gh-trending\run-sanitized.ps1'
```

```powershell
gh api repos/nowwcastle-sudo/github-trending-daily/actions/runners --jq '.runners[] | {name,status,busy}'
```

Expected: `nasca-gh-trending-claude` `status: online`. offline이면 dispatch하지 않는다.

- [ ] **Step 3: 사전 조건 확인**

```powershell
gh run list --limit 5
gh variable list
```

Expected: 진행 중인 refresh/deploy run 0, `GH_TRENDING_REFRESH_SCHEDULE` 미설정 유지.

- [ ] **Step 4: inputless controlled dispatch(사용자 승인 뒤)**

```powershell
gh workflow run daily-refresh.yml --ref main
```

```powershell
gh run list --workflow daily-refresh.yml --limit 1
```

run ID를 기록한 뒤 `gh run watch <run_id>`로 완료까지 대기한다. 실패하면 `gh run view <run_id> --log-failed`를 끝까지 읽고 원인을 정의한 뒤에만 다음 행동을 정한다. blind retry 금지.

- [ ] **Step 5: production 검증**

```powershell
curl.exe -sS https://nowwcastle-sudo.github.io/github-trending-daily/deployment-manifest.json
curl.exe -sS https://nowwcastle-sudo.github.io/github-trending-daily/star-history.json
```

Expected: manifest `sourceSha`가 새 main SHA, 새 `snapshotId`, 20개 파일 hash. `star-history.json`의 모든 `estimated`가 `[]`, `observed`가 각 repo의 exact 관측. 브라우저에서 카드 tooltip이 관측 전용 문구를 표시하고 콘솔 오류 0.

- [ ] **Step 6: 인증 matrix** — current production에서 Google login → reload → 새 탭 → BFCache → 브라우저 재시작 → cross-tab logout → guest/account 분리를 사용자의 일반 Chrome에서 확인한다(자동화 브라우저는 Google이 차단함).

- [ ] **Step 7: 최종 좌표 보고** — source SHA, snapshot ID, CodeQL analysis, refresh run ID, deploy run/Pages deployment id, provider별 entry 수, `HEAD == origin/main == deployed sourceSha`, schedule 상태, runner 상태.

---

## Self-Review

- Spec coverage: §11 2항(중단·관측만 유지) → Task 1·2·3; UI/README 정직성 → Task 3·4; fail-closed·append-only 불변 → Global Constraints + Task 5 Step 3.
- Placeholder scan: 없음. 모든 코드 step에 실제 코드가 있다.
- Type consistency: `OSS_ESTIMATE_DISCONTINUATION_SHA256` 이름이 Task 1 구현·테스트에서 동일. `_selected_estimates` 시그니처 불변.
- 사각지대: Task 1 Step 4의 `logicalRequests` 기대값 100은 "OSS 1회/repo 감소" 추론이며 실측으로 확정한다. legacy cache 행에 대한 derive-시점 baseline identity 재검증은 그 행을 더 이상 소비하지 않으므로 함께 제거된다(DB trigger 불변성은 그대로).
