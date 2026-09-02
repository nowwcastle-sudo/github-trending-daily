# Repository 단위 요약 admission과 스타 tick 분리 설계

- 작성: 2026-09-03 KST (v2 — RED TEAM·우호 리뷰 대립 후 절충, fable 최종 검증 반영)
- 상태: 사용자 승인 대기 → 승인 시 Plan A(admission)·Plan B(star ticks) 계획으로 분해
- 저장소: `https://github.com/nowwcastle-sudo/github-trending-daily`
- 선행 문서: `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md`(정본 §3), `docs/superpowers/specs/2026-08-22-star-history-google-auth-design.md`(§11·§12), `docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md`, `docs/superpowers/plans/2026-09-02-summary-retry-budget-and-url-token-normalization.md`
- 사용자 결정(2026-09-03): 설계 A 채택, number/version/product invariant는 warning으로 하향, OSS 하이브리드(2025-05-22 이전 구간)는 후속, gain 역산 앵커 포함, workflow를 "트렌딩 갱신(W1)"과 "스타 tick(W2)"으로 분리, 한 번이라도 게시된 repo는 상한 500 안에서 계속 관측.

## 1. 배경 — 왜 지금 설계를 바꾸는가

2026-08-31~09-02 controlled run 35회 중 publish 0회. 마지막 두 run(`33639446686`, `33644048203`)은 OSS Insight blocker 제거 뒤 `prepare`를 통과했지만 `enrich`에서 14번째·18번째 repository에서 종료됐고, 앞선 검증 통과 요약 13개·17개는 폐기됐다.

원인이 확정된 validator 종료는 전부 validator 쪽 오탐이었다: `best practices`, 스페인어 `todo`, 제품명 반복, `**Node.js**` 강조 마크업, URL 뒤 마침표, `15,704`·`9.9 percent`(README에 그대로 있는 숫자를 canonical 정규식 `^\d+(\.\d+)*(unit)?$`이 거부하고, 교정 프롬프트는 "README 정확한 부분문자열"을 요구해 동시 만족 불가). 모델이 사실을 틀린 사례는 기록에 확정된 것이 없다.

구조는 "active repository 전부(현재 55개) × 5 locale × 5 field가 결정론적 validator를 전부 통과해야 publish"다. repo 하나가 6% 확률로 막히면 55개 동시 통과 확률은 약 3%다. 전제("모델을 더 조이면 된다")가 틀렸으므로 예산·격리·지속성을 바꾼다.

스타 히스토리는 별도 문제다. OSS Insight 추정은 active 45개 기준 GitHub 실측 대비 중앙값 14.5배 과소(최대 73.8배)라 09-02에 중단했다(§12). GitHub 공식 stargazer 타임스탬프 API는 2026-07부터 임의 공개 repo에 404·빈 결과다(09-03 실측). 정확한 과거 곡선을 외부에서 얻을 길은 없고, 오늘 찍지 않은 점은 내일 아무도 찍을 수 없다. 남은 정확한 원천은 ① GitHub Trending 페이지의 기간별 gain(GitHub 집계값) ② 우리 자체 실측이다. 자체 실측 두 원장(`data/star-observations.sqlite`, `historical_star_observations`)은 요약 파이프라인에 묶여 2026-08-27에 멈춰 있다.

## 2. 목표와 비목표

**목표**
1. 요약 산문 품질 실패를 repository 하나로 격리한다. 다른 repo의 검증 통과 요약은 같은 run에서 publish된다.
2. 데이터 무결성 게이트(README provenance·hash·DB append-only·artifact allowlist·evidence 결합)는 그대로 fail-closed다.
3. 스타 관측을 요약 파이프라인에서 분리한다. 게시 중 repo는 30분마다, 한 번이라도 게시된 repo는 상한 500 안에서 하루 1회 정확한 총 스타를 기록한다.
4. 첫 관측 시점부터 카드에 형태가 보이도록 GitHub Trending gain으로 30일·7일·1일 전 총계 앵커를 복원한다.
5. UI는 "추정치가 아닌 이 사이트의 실측"을 명시한다.

**비목표**
- OSS Insight 재수용(2025-05-22 이전 구간 하이브리드는 후속 문서).
- 요약 producer(Claude CLI OAuth `claude -p`), 5-locale 스키마 v3, 재사용 계약(exact source identity), README 전체 번역 폐기 결정의 변경.
- 실패 run의 검증 통과 bundle을 run 간 지속하는 별도 seed(§9 후속).
- 기존 sqlite 원장 두 개의 스키마 변경.

## 3. 뒤엎는 결정과 유지하는 결정

| 기존 결정 | 새 결정 | 왜 |
|---|---|---|
| 정본 §3 8항 "5개 언어는 한 묶음이며 한 언어의 결함도 repository와 candidate 전체를 실패시킨다" | **repository 단위 admission.** 5 locale은 여전히 한 묶음(한 locale 결함 = 그 repo held)이지만 candidate는 실패하지 않는다 | 35회 중 publish 0. 실패 단위가 너무 컸다 |
| 정본 §3 9항 "`insufficient_source`는 candidate 실패. metadata fallback·'README 참고' 문구 금지" | `insufficient_source`·상한 소진은 **그 repo를 `held`로**. generic fallback 문구 금지는 유지 | 정직한 상태 표시로 대체 |
| number/version/product의 cross-locale exact parity와 canonical number 정규식을 hard gate로 | **command(백틱)·URL(ASCII)만 hard.** number/version/product는 README 부분문자열 존재 검사만 hard, cross-locale 비교·hedge·marketing·길이는 **warning** | 잡은 것은 오탐 6건, 확정된 사실 오류 0건 |
| `star-history.json`은 snapshot에 hash로 묶인 finalized 20파일 중 하나 | **snapshot contract에서 제외**(19파일). `deployment-manifest.json.files`에는 계속 기록되지만 DB `artifact_hashes`와 production-state 검증은 finalized 19만 대조 | 30분 갱신은 snapshot record 없이 배포돼야 한다 |
| observed 점은 `YYYY-MM-DD` 하루 1점 | **`star-history.json` v2**: 타임스탬프 키 tick + 앵커 | 30분 해상도 |
| 스타 관측은 daily-refresh 안의 한 단계, 대상은 active repo만 | **별도 workflow `star-ticks.yml`**, 2계층(게시 중 30분 / 게시 이력 상한 500 하루 1회) | 요약 파이프라인과 운명 분리, 재진입 repo의 이력 확보 |
| "한 repository가 영구 실패하면 다른 worker는 새 요청을 시작하지 않는다" | 폐지. 한 repo 실패가 다른 repo 시도를 막지 않는다 | admission과 모순 |

**유지:** Claude OAuth producer, schema v3, 재사용은 exact source identity, evidence line range, DB append-only·schema fingerprint, allowlisted 생성 경로, 단일 자식 commit, deploy-only는 byte-for-byte, 사용자 결정 4(locale 불완전 시 fallback 없이 localized unavailable), 재시도 상한 `max(12, pending×3)`, repo당 초기+3 교정, W1·W2 concurrency group 공유.

## 4. 아키텍처

```
W1  daily-refresh.yml (cron 7 */2 · dispatch)              W2  star-ticks.yml (cron 5,35 * * * * · dispatch)
 prepare(ubuntu) ── facts/events ── frozen input             tick(ubuntu)
   │                                                          ├ GET /rate_limit (remaining < 500 → 종료)
 enrich(self-hosted Claude)                                   ├ Tier A = main data/latest.json 게시 집합 → REST × |A|
   ├ reuse exact → retained                                   ├ Tier B(홀수시 :35 run만) = 게시 이력 − A, top(500−|A|) → REST × |B|
   ├ generate → validate → verified | held(reason)            ├ append data/star-ticks/YYYY-MM.jsonl (A) · data/star-daily.jsonl (A rollup + B)
   └ warnings[] (non-blocking)                                ├ derive star-history.json v2 (게시 repo만; ticks + star-anchors.json)
 publish(ubuntu)                                              ├ commit "chore: star ticks <UTC>" (allowlist 3 경로)
   ├ record DB (held는 summary_status만)                       └ build 19 finalized (불변 확인) + overlay → deploy-only → probe
   ├ derive: data/star-anchors.json ← frozen facts
   ├ finalize 19 files (star-history.json 제외)
   ├ validate coverage: verified|retained|held 전수
   └ commit → deploy → verify
concurrency: 두 workflow 모두 group `daily-refresh` (cancel-in-progress: false), deploy job은 group `pages`
```

### 4.1 W1 — repository 단위 admission

| 상태 | 조건 | 게시 |
|---|---|---|
| `verified` | 이번 run에서 exact v3 bundle이 모든 hard gate 통과 | 5-locale 요약 |
| `retained` | README identity(path·blob·content sha)가 같아 직전 검증본 재사용 | 직전 요약 |
| `held` | 초기+3 교정 뒤에도 hard defect 잔존, 또는 `insufficient_source`, 또는 run 상한·deadline 소진으로 미시도 | 요약 필드 없음. 카드에 locale별 고정 문구 "요약 검증 중"(static i18n, LLM 아님) + tooltip에 `held_reason` |

- `enrichment-index.json`에 repo마다 `status`, `held_reason`(`quality_defects`·`insufficient_source`·`budget_exhausted`·`deadline_exhausted`), `defect_codes[]`, `warnings[]`를 기록한다. 모델 출력 본문은 기록하지 않는다.
- candidate 성공 조건: active repo 전부가 세 상태 중 하나이고, `verified`+`retained` ≥ 1이며, `held` 비율 ≤ 50%(초과 시 run 실패 — provider/runner 장애로 해석).
- README identity가 바뀐 repo가 held면 직전 요약을 stale로 유지하지 않고 `held`로 표시한다(정본 §3 13항 유지).
- 검증 통과 bundle은 run 종료 시 일괄로 candidate cache(`data/repo-summaries.json`)에 기록한다(admission이 폐기 문제를 해결하므로 즉시 기록은 불필요). run 크래시 시 지속성은 §9 후속. candidate 실패 시 tracked tree 불변은 그대로.

### 4.2 validator 규칙 재분류

| 규칙 | 등급 | 비고 |
|---|---|---|
| envelope/schema shape, 5 locale × 5 field 존재, evidence line range·heading 결합, README provenance | **hard** | 무결성 |
| command(백틱) cross-locale exact parity | **hard** | 잘못된 명령 실행 방지 |
| URL cross-locale parity(ASCII, 끝 문장부호 제외) | **hard** | 잘못된 링크 방지 |
| number/version/product **README 부분문자열 존재**(raw 또는 `**…**` 강조 변형) | **hard** | 사실 근거. canonical number 정규식 **폐지** |
| number/version/product cross-locale 개수·필드 분포 비교 | **warning** | 오탐 4건, 사실 오류 0건 |
| inference field hedge 존재 | **warning** | 초기 프롬프트·correction schema pattern은 유지 |
| generic/placeholder(`TODO`·"README 참고") | **hard** | 정직성(사용자 결정) |
| marketing superlative, 영어 환산 길이 180~280단어, 필드 간 문장 반복 | **warning** | 사실을 훼손하지 않음 |

warning은 `enrichment-index.json`과 bounded artifact에 code·locale·field만 기록하고 correction을 유발하지 않는다. hard defect는 기존 targeted correction 경로(초기+3) 그대로.

### 4.3 W2 — 스타 tick (2계층)

- 트리거: `schedule: "5,35 * * * *"`, `workflow_dispatch`. 저장소 변수 `GH_TRENDING_TICKS == 'enabled'`일 때만 schedule 실행. 시작 시 `GET /rate_limit`(한도 미차감)으로 `remaining < 500`이면 그 run은 관측 없이 종료(skipped 보고).
- **Tier A** = main `data/latest.json`의 게시 집합(45~55, 최대 75). 매 run(30분). `GET /repos/{owner}/{repo}` 1회/repo.
- **Tier B** = 한 번이라도 게시된 slug(`data/star-daily.jsonl`의 전체 slug 합집합) − Tier A. **홀수 UTC시 :35 run에서만**, 상한 `500 − |A|`. W1은 짝수시 :07 시작 후 15분 창에 REST 600~900회를 쓰므로(`EVENT_LIMITS.eventWindowMs`), 롤링 60분 한도 창과 겹치지 않는 시각을 택한다.
- 수집: 404/451(이전·삭제·비공개)은 그 repo tick을 `unavailable`로 기록하고 계속. 5xx·429는 2s/8s 2회 재시도 후 그 repo만 건너뛴다. 순차 호출(2차 한도 900/분·동시 100 이내).
- **저장 3층**
  - `data/star-ticks/YYYY-MM.jsonl` — Tier A 원시 tick, append-only 텍스트, 월 분할. run 헤더 1줄 `{"at":"…Z","run_id":"…"}` 뒤 repo 줄 `{"slug":"owner/repo","stars":12345}`(≈70 B). 월 파일 ≈ 55×48×30×70 B ≈ 5.3 MiB.
  - `data/star-daily.jsonl` — slug당 하루 1줄 영구 rollup `{"date":"YYYY-MM-DD","slug":"…","stars":N,"tier":"A"|"B"}`. Tier A는 00:05 UTC 뒤 첫 run이 전날 마지막 tick을 append, Tier B는 관측 즉시 append. ≈ 95 B × 500 × 365 ≈ 16.5 MiB/년.
  - `star-history.json` v2 — **게시 repo만**(§5.1). Tier B 데이터는 그 repo가 재게시될 때 이 파일에 처음 나타난다.
  - append-only 검사: 각 run은 기존 파일 sha256을 읽고 새 줄만 append하며, commit 전 "새 파일 접두 bytes == 기존 bytes"를 확인해 재작성을 거부한다.
- **상한과 제외(cap 500)**: 매 Tier B run에 `후보 = star-daily 전체 slug − A`, `유지 = 후보 중 7일 gain(star-daily 기준, 자료가 7일 미만이면 있는 만큼) 상위 (500 − |A|)`. 연속 top-N(배치 100 아님, 상태 파일 없음). 동률은 "star-daily에서 마지막 Tier A 줄 날짜가 늦은 쪽 유지 → slug 오름차순". 게시 중(A)은 절대 제외하지 않는다. star-daily 최근 3줄이 연속 `unavailable`이면 gain 무관하게 제외. 제외돼도 과거 줄은 남고, 재게시되면 A로 들어와 이어 찍힌다. 선택 함수와 RED fixture(501개·동률·404·게시 중 보호)는 Plan B에서 지금 쓴다(신규 유입 8~14/일이면 cap 도달 약 32~56일).
- 커밋: allowlist는 정확히 `data/star-ticks/**`, `data/star-daily.jsonl`, `star-history.json`. `git diff --check`·비밀값 스캔·"origin/main == checkout" 검사 통과 시 단일 commit `chore: star ticks <UTC>`를 push한다.
- 배포: 같은 run에서 `build-pages-artifact.mjs`가 finalized 19파일 hash를 snapshot contract와 대조(불일치 = 코드 변경 → 중단, 코드 변경은 W1 publish로만)한 뒤 overlay 포함 artifact를 만들어 deploy. `deployment-manifest.json.files`에는 20+개 경로 hash가 전부 기록되고, `probe-production.mjs`는 contract 경로는 snapshot contract와, `star-history.json`은 manifest 자기 값과 대조한다.
- 동시성: `concurrency.group: daily-refresh`, `cancel-in-progress: false`. W1 실행 중 W2는 대기(pending 1건만 유지되므로 W1 1회당 tick 유실 ≤ 1). W1의 "exact main 미전진" 검사는 그대로 성립하고, W1 deploy→verify 사이에 W2가 배포해 verify가 실패·recovery로 퇴행하는 경쟁은 발생하지 않는다.
- 예산(55 A + 445 B 기준): REST ≈ 2,640 + 445 ≈ 3,100/일, 피크 시간(홀수시) ≈ 110 + 445 = 555(`GITHUB_TOKEN` 저장소당 1,000/h). Actions는 공개 저장소라 무료. Pages 빌드 48/일(custom Actions deploy에는 10/h soft limit 미적용). git 증가 ≈ tick 5.3 MiB/월 + daily 1.4 MiB/월.
- 간격 판단: Tier A 30분 유지(15분은 sparkline 220px에서 시각 이득 없이 커밋 2배, 60분은 "하루 만에 형태" 미달). Tier B는 하루 1회 — 재진입 전 구간은 §5.1 다운샘플로 하루 1점으로만 표시되므로 2시간 관측은 화면 결과가 같고 REST·git만 12배다.

### 4.4 gain 역산 앵커 (W1)

W1 `derive` 단계가 **frozen facts**(`latest.json`에는 `created_at`이 없다)의 repo별 `stars`, 기간 gain, `created_at`, run `observedAtUtc`로 `data/star-anchors.json`을 만든다.

- 앵커: `{"at": observedAt − 1d, "stars": stars − gain.daily, "source": "github_trending_gain_daily"}`, weekly·monthly 동일. gain이 `null`(그 기간 목록에 없음)이면 그 앵커 없음.
- 단조성: `s(−30d) ≤ s(−7d) ≤ s(−1d) ≤ stars`를 어기는 앵커는 버리고 `anchor_warning`에 기록(실측 45개 중 1개가 `daily 2819 > weekly 2085`).
- `created_at` 앵커(`stars: 0`)는 `created_at`이 run 시점 기준 30일 이내일 때만.
- 실측(observed)이 있는 날짜에는 앵커를 그리지 않는다(실측이 정확치, 앵커는 근사).
- 앵커는 근사다(기간 순증가라 언스타 무시). UI 문구와 `source`에 명시. W1이 돌 때마다 재계산·덮어쓴다. W2는 읽기만 한다.

## 5. 데이터 계약

### 5.1 `star-history.json` v2

```json
{
  "version": 2,
  "generatedAt": "2026-09-03T00:35:12Z",
  "repositories": [
    {
      "slug": "owner/repo",
      "anchors": [
        { "at": "2026-08-04T00:02:00Z", "stars": 100, "source": "github_trending_gain_monthly" },
        { "at": "2026-08-27T00:02:00Z", "stars": 900, "source": "github_trending_gain_weekly" },
        { "at": "2026-09-02T00:02:00Z", "stars": 1200, "source": "github_trending_gain_daily" }
      ],
      "observed": [
        { "at": "2026-09-02T14:31:02Z", "stars": 1310, "source": "github_rest" }
      ]
    }
  ]
}
```

- exact keys: 최상위 `version, generatedAt, repositories`; repo `slug, anchors, observed`; 점 `at, stars, source`. `at`은 초 단위 UTC ISO, 오름차순 unique. `stars`는 0 이상 safe integer.
- observed: 최근 14일은 모든 tick, 그 이전은 star-daily의 하루 1점. repo당 최대 2,000점(14×48 + 약 1,300일). anchors 최대 4점.
- `normalizeCache`(star-history.js)는 v2만 수용한다. v2 데이터와 v2 UI는 같은 W1 artifact로 함께 배포되므로 호환 기간이 없다.
- 렌더: anchors ∪ observed를 `at`으로 정렬. anchors는 점선·빈 원, observed는 실선. 관측 공백(Tier B 제외 기간)은 선 끊김. 문구: "이 사이트가 직접 관측한 총 스타(30분 간격) · 점선은 GitHub Trending 기간 집계로 역산한 앵커". 0점 → "관측 시작 대기", 1점 → "관측 1회".

### 5.2 artifact·manifest 계약

- `PAGES_BASE_ARTIFACT_PATHS`(finalized, snapshot contract)에서 `star-history.json`을 제거한다(19). 기존 snapshot의 `artifact_hashes` 20행은 재작성하지 않는다(append-only). 새 snapshot부터 19행.
- `deployment-manifest.json.files`는 `installArtifact`가 쓰는 대로 artifact 전 경로 hash를 담는다(`star-history.json` 포함). W1 `Resolve verified production state`와 `probe-production.mjs`의 contract 검증은 **contract 경로(19)만** 대조하고, 나머지 경로는 manifest 자기 값과 파일 hash가 같은지만 확인한다.
- W2 deploy 전 검증: 현재 checkout으로 만든 19파일 hash가 production snapshot contract와 일치해야 한다. 불일치면 코드가 바뀐 것이므로 W2는 배포하지 않고 W1 publish를 요구한다.

### 5.3 `enrichment-index.json` 확장

repo 항목에 `status: "verified"|"retained"|"held"`, `held_reason`, `defect_codes[]`, `warnings[]` 추가. `validate-enrichment-coverage.mjs`는 active set 전수가 세 상태 중 하나인지, `held` 비율 ≤ 50%인지, `held` repo의 `data/repo-summaries.json` 항목이 없는지(generic 문구 금지)를 검사한다. `update-trending.mjs`는 `held` repo 카드에 static 문구를 렌더하고 `summary: null, summary_status: "held"`를 export한다.

## 6. 오류 모드

| 상황 | 동작 |
|---|---|
| repo 1개 hard defect 잔존 | 그 repo `held`, run 계속 |
| held > 50% | run 실패, publish 0 |
| `CLAUDE_RATE_LIMITED` / deadline 소진 | 남은 pending 전부 `held(budget_exhausted|deadline_exhausted)`, verified는 publish. 다음 run이 held만 재시도 |
| W2 `rate_limit.remaining < 500` | run 종료(skipped), 다음 30분 재시도 |
| W2 GitHub 404/451 | 그 repo `unavailable`, 계속. 3회 연속이면 Tier B 제외 |
| W2 ledger 접두 불일치(재작성 감지) | commit·deploy 중단 |
| W2 finalized 19파일 hash ≠ snapshot contract | 배포 중단(코드 변경은 W1으로) |
| W1 실행 중 W2 slot | concurrency group에서 대기(유실 ≤ 1 tick) |
| repo rename(301) | W1은 기존대로 `full_name` 불일치 오류. W2는 옛 slug로 계속 기록되어 이력이 분절될 수 있음 — 허용 리스크(빈도 낮음), 후속에서 `id` 기록 검토 |

## 7. 테스트 범위

- validator: hard/warning 분류 전수 — 규칙 하나당 RED fixture 1개(number `15,704`/`9.9 percent`가 README에 있으면 통과·없으면 hard; command 불일치 hard; hedge 누락 warning).
- admission: 1 held + N verified candidate 통과, held 51% 실패, held repo generic 문구 실패, held export `summary: null`.
- 재시도: 한 repo 3회 소진 뒤 다음 repo 계속, run 상한 소진 시 나머지 `budget_exhausted`.
- 캐시: repo 단위 즉시 기록, candidate 실패 시 tracked tree 불변.
- W2: ledger append-only(접두 검사 RED), 월 파일 경계, star-daily rollup 결정성, 404 3회 제외, top-N 선택(501개·동률·게시 중 보호), rate_limit 종료, v2 exact keys, allowlist 3경로 외 변경 거부, 19파일 contract 불일치 시 배포 거부.
- 앵커: gain null·단조성 위반·created_at 30일 규칙·관측일 억제, W2 무변경.
- UI: v2 파싱, v1 거부, anchors 점선, 공백 끊김, 0/1/N점 문구, XSS(slug 미보간), 축소 모션.
- workflow: actionlint, 두 workflow의 group 동일성, W2 cron `5,35`, `GH_TRENDING_TICKS` hold.
- 운영: W1 controlled dispatch 1회 → production 19 contract + manifest 확인 → `GH_TRENDING_TICKS=enabled` → W2 2회 연속 성공 + 홀수시 Tier B 1회 → `x-ratelimit-used` 헤더로 피크 실측 → 카드 sparkline 확인.

## 8. 결정 사항 (2026-09-03 확정)

1. W2 Tier A 대상 = 게시 중 repo, Tier B = 게시 이력 전체(상한 500). 사용자 원안의 "공식 trending 잔류 repo만"은 채택하지 않음 — 게시 집합이 곧 trending 집합이고 이탈 repo는 Tier B로 이어진다.
2. `held` 비율 상한 50%.
3. `created_at` 앵커 포함 창 30일.
4. `GH_TRENDING_TICKS`는 W1 첫 publish 검증 뒤 켠다.
5. Tier B 주기 하루 1회(2시간 기각), 제외 지표 7일 gain 연속 top-N(원안 "직전 1회 gain 배치 100" 기각).
6. 동시성은 group 공유(독립 group + skip + ff-only 허용 안 기각).

## 9. 후속 과제 (범위 밖)

- OSS Insight 2025-05-22 이전 구간 하이브리드(active 55 중 15개 repo 효과).
- 실패 run의 검증 통과 bundle을 runner artifact로 보존(admission 도입으로 우선순위 하락).
- rename(301) 대응: tick 줄에 repo `id` 기록.
- 연 단위 tick 아카이브(월 파일을 Release asset으로 이동).
- Tier B 주기 상향은 시간대 분석 요구가 생길 때 상수 1개로 조정.

## 10. 뒤집는 조건

- `held` 비율이 3 run 연속 20%를 넘으면 warning 규칙이 아니라 프롬프트/모델 쪽을 재검토한다.
- warning으로 내린 규칙에서 **사실 오류가 실제로 게시된 사례**가 확인되면 그 규칙 하나만 hard로 되돌린다.
- GitHub가 stargazer 타임스탬프 API를 다시 열면 앵커를 실제 타임라인으로 교체한다.
- W2가 `rate_limit` 종료를 하루 3회 이상 반복하면 Tier B 시각·상한을 조정한다.
- 첫 W1 성공 run의 `x-ratelimit-used` 실측이 900을 넘으면 W1 자체의 REST 예산을 먼저 줄인다(75 repo 상한에서 1,000 초과 가능 — 기존 리스크).

## 11. 롤아웃 순서

1. 이 문서 승인 → `writing-plans`로 Plan A(admission·validator 재분류·즉시 캐시·held UI), Plan B(contract 19·v2 스키마·앵커·W2·상한 선택).
2. 두 계획을 각각 branch·PR·fable 리뷰·CodeQL로 merge. **W1 controlled dispatch는 두 PR이 모두 merge된 뒤 1회**(코드 바이트 변경은 W1 publish로만 배포).
3. production 검증(19 contract + manifest, held 카드 문구, sparkline) → `GH_TRENDING_TICKS=enabled` → W2 관찰(rate limit 헤더 실측) → `GH_TRENDING_REFRESH_SCHEDULE=enabled` 재개 결정.
