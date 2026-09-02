# Repository 단위 요약 admission과 30분 스타 tick 분리 설계

- 작성: 2026-09-03 KST
- 상태: 초안 — 사용자 리뷰 대기
- 저장소: `https://github.com/nowwcastle-sudo/github-trending-daily`
- 선행 문서: `docs/handoffs/2026-08-30-production-closure-readme-enrichment-handoff.md`(정본 §3 요약 품질 사양), `docs/superpowers/specs/2026-08-22-star-history-google-auth-design.md`(§11·§12), `docs/superpowers/plans/2026-09-02-discontinue-oss-star-estimates.md`, `docs/superpowers/plans/2026-09-02-summary-retry-budget-and-url-token-normalization.md`
- 사용자 결정(2026-09-03): 설계 A 채택, number/version/product invariant는 warning으로 하향, OSS 하이브리드(2025-05-22 이전 구간)는 후속, gain 역산 앵커 포함, workflow를 "트렌딩 갱신"과 "스타 tick"으로 분리.

## 1. 배경 — 왜 지금 설계를 바꾸는가

2026-08-31부터 2026-09-02까지 controlled run 35회 중 publish 0회다. 마지막 두 run(`33639446686`, `33644048203`)은 OSS Insight blocker 제거 뒤 `prepare`를 통과했지만 `enrich`에서 각각 14번째·18번째 repository에서 종료됐고, 그 앞의 검증 통과 요약 13개·17개는 폐기됐다.

원인이 확정된 validator 종료는 전부 validator 쪽 오탐이었다: `best practices`, 스페인어 `todo`, 제품명 반복, `**Node.js**` 강조 마크업, URL 뒤 마침표, `15,704`·`9.9 percent`(README에 그대로 있는 숫자를 canonical 정규식 `^\d+(\.\d+)*(unit)?$`이 거부하고, 동시에 교정 프롬프트는 "README 정확한 부분문자열"을 요구해 동시 만족이 불가능). 모델이 사실을 틀린 사례는 기록에 확정된 것이 없다.

구조는 "active repository 전부(현재 55개) × 5 locale × 5 field가 결정론적 validator를 전부 통과해야 publish"다. repo 하나가 6% 확률로 막히면 55개 동시 통과 확률은 약 3%다. 전제("모델을 더 조이면 된다")가 틀렸으므로 예산·격리·지속성을 바꾼다.

스타 히스토리는 별도 문제다. OSS Insight 추정은 active 45개 기준 GitHub 실측 대비 중앙값 14.5배 과소(최대 73.8배)라 09-02에 중단했다(§12). GitHub 공식 stargazer 타임스탬프 API는 2026-07부터 임의 공개 repo에 404·빈 결과다(09-03 실측). 정확한 과거 곡선을 외부에서 얻을 길은 없다. 남은 정확한 원천은 ① GitHub Trending 페이지의 기간별 gain(GitHub 집계값) ② 우리 자체 실측이다. 자체 실측은 하루 1점(요약 파이프라인에 묶여 있어 파이프라인이 멈추면 함께 멈춤)이라 "트렌딩에 며칠 머무는 repo"에 곡선이 생기기 어렵다.

## 2. 목표와 비목표

**목표**
1. 요약 산문 품질 실패를 repository 하나로 격리한다. 다른 repo의 검증 통과 요약은 같은 run에서 publish된다.
2. 데이터 무결성 게이트(README provenance·hash·DB append-only·artifact allowlist·evidence 결합)는 그대로 fail-closed다.
3. 스타 관측을 요약 파이프라인에서 분리해 30분마다 게시된 모든 repository의 정확한 총 스타를 기록·게시한다.
4. 첫 관측 시점부터 카드에 형태가 보이도록 GitHub Trending gain으로 30일·7일·1일 전 총계 앵커를 복원한다.
5. UI는 "추정치가 아닌 이 사이트의 실측"을 명시한다.

**비목표**
- OSS Insight 재수용(2025-05-22 이전 구간 하이브리드는 후속 문서).
- 요약 producer(Claude CLI OAuth `claude -p`), 5-locale 스키마 v3, 재사용 계약(exact source identity), README 전체 번역 폐기 결정의 변경.
- 실패 run의 검증 통과 bundle을 run 간 지속하는 별도 seed(§9 후속).

## 3. 뒤엎는 결정과 유지하는 결정

| 기존 결정 | 새 결정 | 왜 |
|---|---|---|
| 정본 §3 8항 "5개 언어는 한 묶음이며 한 언어의 결함도 repository와 candidate 전체를 실패시킨다" | **repository 단위 admission.** 5 locale은 여전히 한 묶음(한 locale 결함 = 그 repo held)이지만 candidate는 실패하지 않는다 | 35회 중 publish 0. 실패 단위가 너무 컸다 |
| 정본 §3 9항 "`insufficient_source`는 candidate 실패. metadata fallback·'README 참고' 문구로 통과 금지" | `insufficient_source`·상한 소진은 **그 repo를 `held`로** 만든다. generic fallback 문구 금지는 유지 | 같은 이유. 정직한 상태 표시로 대체 |
| number/version/product의 cross-locale exact parity와 canonical number 정규식을 hard gate로 | **command(백틱)·URL(ASCII)만 hard.** number/version/product는 README 부분문자열 존재 검사만 hard, cross-locale 개수 비교·hedge·marketing 어휘는 **warning** | 이 규칙들이 잡은 것은 오탐 6건, 확정된 사실 오류 0건 |
| `star-history.json`은 snapshot에 hash로 묶인 finalized 20파일 중 하나 | **finalized 집합에서 제외**하고 tick ledger에 묶인 **overlay 계약**으로 이동(19 + overlay) | 30분 갱신은 snapshot record 없이 배포돼야 한다 |
| observed 점은 `YYYY-MM-DD` 하루 1점 | **`star-history.json` v2**: 타임스탬프 키 tick + 앵커 | 30분 해상도 |
| 스타 관측은 daily-refresh 안의 한 단계 | **별도 workflow `star-ticks.yml`**(30분) | 요약 파이프라인과 운명을 분리 |

**유지:** Claude OAuth producer, schema v3, 재사용은 exact source identity, evidence line range, DB append-only·schema fingerprint, allowlisted 생성 경로, 단일 자식 commit, deploy-only는 byte-for-byte, 사용자 결정 4(locale 불완전 시 fallback 없이 localized unavailable), 재시도 상한 `max(12, pending×3)`, repo당 초기+3 교정.

## 4. 아키텍처

```
W1  daily-refresh.yml (schedule 2h · dispatch)          W2  star-ticks.yml (schedule */30 · dispatch)
 prepare(ubuntu) ── facts/events ── frozen input           tick(ubuntu)
   │                                                        ├ read main data/latest.json (published set)
 enrich(self-hosted Claude)                                 ├ GitHub REST repos/{slug} × N (GITHUB_TOKEN)
   ├ reuse exact → verified                                 ├ append data/star-ticks.jsonl (append-only text)
   ├ generate → validate → verified | held(reason)          ├ derive star-history.json v2 (ticks + anchors.json)
   └ warnings[] (non-blocking)                              ├ overlay manifest bind (ticks sha, anchors sha, sourceSha)
 publish(ubuntu)                                            ├ commit "chore: star ticks <at>" (allowlist 2 files)
   ├ record DB (held는 summary_status만 기록)                └ deploy-only (finalized 19 unchanged + overlay)
   ├ derive: anchors.json ← latest.json gains
   ├ finalize 19 files (star-history.json 제외)
   ├ validate coverage: verified|retained|held 전수
   └ commit → deploy → verify
concurrency: 두 workflow 모두 group `daily-refresh`(cancel-in-progress: false) + deploy는 group `pages`
```

### 4.1 W1 — repository 단위 admission

repository 상태:

| 상태 | 조건 | 게시 |
|---|---|---|
| `verified` | 이번 run에서 exact v3 bundle이 모든 hard gate 통과 | 5-locale 요약 |
| `retained` | README identity(path·blob·content sha)가 같아 직전 검증본 재사용 | 직전 요약 |
| `held` | 초기+3 교정 뒤에도 hard defect 잔존, 또는 `insufficient_source`, 또는 run 상한·deadline 소진으로 미시도 | 요약 필드 없음. 카드에 locale별 고정 문구 "요약 검증 중"(static i18n, LLM 아님) + tooltip에 `held_reason`·`run_id` |

- `enrichment-index.json`에 repo마다 `status`, `held_reason`(`quality_defects`·`insufficient_source`·`budget_exhausted`·`deadline_exhausted`), `defect_codes[]`, `warnings[]`를 기록한다. 모델 출력 본문은 기록하지 않는다(기존 규칙 유지).
- candidate 성공 조건: active repo 전부가 세 상태 중 하나이고, `verified`+`retained` ≥ 1이며, `held` 비율이 **50%를 넘지 않는다**(넘으면 run 실패 — 산문 품질이 아니라 provider/runner 장애로 해석). 이 상한은 §8 열린 질문.
- `held` repo의 직전 검증본이 있으면(README identity가 바뀌어 pending이 된 경우) **직전 요약을 stale로 표시해 유지하지 않는다** — 정본 §3 13항(reuse는 동일 hash일 때만)을 유지하고 `held`로 표시한다.
- run 상한 `max(12, pending×3)`, repo당 초기+3 유지. 한 repo 실패가 다른 repo 시도를 막지 않는다(기존 "한 repository가 영구 실패하면 다른 worker는 새 요청을 시작하지 않는다" 규칙은 폐지).
- 검증 통과 bundle은 완료 즉시 candidate cache(`data/repo-summaries.json`)에 기록한다(run 끝에 일괄 기록하던 것을 repo 단위로). candidate 실패 시 tracked tree 불변은 그대로다(candidate는 temp).

### 4.2 validator 규칙 재분류

| 규칙 | 등급 | 비고 |
|---|---|---|
| envelope/schema shape, 5 locale × 5 field 존재, evidence line range·heading 결합, README provenance | **hard** | 무결성 |
| command(백틱) cross-locale exact parity | **hard** | 명령이 다르면 사용자가 잘못된 명령을 실행 |
| URL cross-locale parity(ASCII, 끝 문장부호 제외) | **hard** | 잘못된 링크 방지 |
| number/version/product **README 부분문자열 존재**(raw 또는 `**…**` 강조 변형) | **hard** | 사실 근거. canonical number 정규식은 **폐지** |
| number/version/product cross-locale 개수·필드 분포 비교 | **warning** | 오탐 4건, 사실 오류 0건 |
| inference field hedge 존재(`HEDGE_SCHEMA_PATTERNS`) | **warning** | 문체 규칙. 초기 프롬프트·correction schema pattern은 유지(warning이라도 모델에는 계속 요구) |
| marketing superlative, generic/placeholder(`TODO`·"README 참고") | generic/placeholder는 **hard**(정직성), marketing은 **warning** | "README 참고" 문구는 사용자 결정 |
| 영어 환산 길이 180~280단어 | **warning** | 길이 초과가 사실을 훼손하지 않음 |

warning은 `enrichment-index.json`과 bounded failure/coverage artifact에 code·locale·field만 기록하고 correction을 유발하지 않는다. hard defect가 있으면 기존 targeted correction 경로(validator-selected patch schema, 초기+3)를 그대로 쓴다.

### 4.3 W2 — 30분 스타 tick

- 트리거: `schedule: "*/30 * * * *"`, `workflow_dispatch`. 저장소 변수 `GH_TRENDING_TICKS`가 `enabled`일 때만 schedule 실행(daily-refresh와 같은 hold 패턴).
- 대상: **main의 `data/latest.json`에 게시된 repo 전부**(현재 55). 사용자 제안("아직 공식 trending에 남아 있는 repo만")은 채택하지 않는다 — 트렌딩에서 빠진 뒤의 하락도 카드가 답해야 할 정보("벌써 꺾였나")이고, 55회 REST 호출은 시간당 5,000 한도의 2%다. 트렌딩 페이지 재수집을 W2에서 하지 않아 W2는 GitHub 트렌딩 HTML 파서에 의존하지 않는다. (§8 열린 질문 1)
- 수집: `GET /repos/{owner}/{repo}` 1회/repo, `stargazers_count`·`pushed_at`·응답 `Date`. 404/451(이전·삭제·비공개)은 그 repo tick을 `unavailable`로 기록하고 run은 계속. 5xx·429는 기존 collector와 같은 2s/8s 2회 재시도 후 그 repo만 건너뛴다(fail-closed는 ledger 무결성에만).
- ledger `data/star-ticks.jsonl`(text, append-only): 한 줄 `{"at":"2026-09-03T00:30:12Z","slug":"owner/repo","stars":12345,"source":"github_rest","run_id":"..."}`. 파일 첫 줄은 헤더 `{"version":1,"created_at":...}`. 각 run은 ① 기존 파일 bytes의 sha256을 읽고 ② 새 줄만 append하며 ③ commit 전 "새 파일의 접두 bytes == 기존 bytes" 검사로 재작성을 거부한다. 회전: 파일이 8 MiB를 넘으면 `data/star-ticks/YYYY-MM.jsonl`로 월 단위 분할(후속 과제, 현재 예상 증가량 ≈ 250 KB/일).
- 산출: `star-history.json` v2(§5.1)를 ticks + `data/star-anchors.json`(W1이 갱신)에서 결정적으로 파생. `star-history-manifest.json`(§5.2)을 함께 쓴다.
- 커밋: allowlist는 정확히 `data/star-ticks.jsonl`, `star-history.json`, `star-history-manifest.json` 세 파일. `git diff --check`·비밀값 스캔·"origin/main이 checkout과 같다" 검사 통과 시 단일 commit `chore: star ticks <UTC>`를 push한다.
- 배포: 같은 run에서 `build-pages-artifact.mjs`를 v1 finalized 19파일 검증 + overlay 검증으로 실행하고 Pages deploy. `probe-production.mjs`가 19파일 hash와 overlay manifest를 각각 1:1 대조한다.
- 동시성: `concurrency.group: daily-refresh`(W1과 공유, `cancel-in-progress: false`)이므로 W1이 도는 동안 W2는 대기하고, W2가 커밋하는 동안 W1은 시작하지 않는다. 따라서 W1의 "exact main 미전진" 검사는 그대로 성립한다.
- 예산: GitHub REST 55×48 = 2,640/일(시간당 110). Actions는 공개 저장소라 무료. Pages 빌드 48/일(soft limit 10/시간 이내). git 증가 ≈ 250 KB/일.
- 간격 판단: 30분 유지. 15분은 REST·Actions 예산 안이지만 Pages 빌드 96/일과 커밋 노이즈가 늘고, sparkline(220px)에서 시각적 이득이 없다. 60분은 "하루 만에 형태"라는 목표에 못 미친다.

### 4.4 gain 역산 앵커 (W1)

W1 `derive` 단계가 `data/latest.json`의 repo별 `stars`와 `gains{daily,weekly,monthly}`, `created_at`으로 `data/star-anchors.json`을 만든다.

- 앵커: `{"at": run_observed_at − 1d, "stars": stars − gains.daily, "source": "github_trending_gain_daily"}`, weekly·monthly 동일. gain이 `null`(그 기간 목록에 없음)이면 그 앵커 없음. 음수·NaN이면 앵커 없음(그 repo에 `anchor_warning`).
- `created_at` 앵커(`stars: 0`)는 `created_at`이 run 시점 기준 **30일 이내**일 때만. 오래된 repo의 10년 평탄선을 만들지 않기 위해서다.
- 앵커는 근사다: 기간 순증가라 언스타를 무시한다. UI 문구와 `source`에 그 성격을 명시한다.
- W1이 돌 때마다 재계산·덮어쓴다(앵커는 파생물, ledger가 아니다). W2는 앵커를 읽기만 한다.

## 5. 데이터 계약

### 5.1 `star-history.json` v2

```json
{
  "version": 2,
  "generatedAt": "2026-09-03T00:30:12Z",
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
- observed 상한: 최근 14일은 모든 tick, 그 이전은 하루의 마지막 tick 1점(ledger에서 결정적 다운샘플). repo당 최대 2,000점. anchors 최대 4점.
- `normalizeCache`(star-history.js)는 v2만 수용한다. v1은 거부한다 — 같은 Pages artifact에 v2 데이터와 v2 UI가 함께 배포되므로 호환 기간이 필요 없다.
- 렌더: `displayPoints`는 anchors ∪ observed를 `at`으로 정렬. anchors는 점선·빈 원, observed는 실선. 문구: "이 사이트가 직접 관측한 총 스타(30분 간격) · 점선은 GitHub Trending 기간 집계로 역산한 앵커". 점 0개 → "관측 시작 대기", 1점 → "관측 1회".

### 5.2 `star-history-manifest.json` (overlay 계약)

```json
{ "version": 1, "sourceSha": "<main sha>", "ticksSha256": "<data/star-ticks.jsonl>", "anchorsSha256": "<data/star-anchors.json>", "starHistorySha256": "<star-history.json>", "generatedAt": "..." }
```

- `deployment-manifest.json`(finalized 19파일)과 별개 파일. `probe-production.mjs`는 둘을 모두 검증한다: finalized 19파일은 snapshot contract와, overlay 3파일은 이 manifest와.
- `derive_repository_artifacts.py export-contract`/`finalize`의 `PAGES_BASE_ARTIFACT_PATHS`에서 `star-history.json`을 제거한다. 기존 snapshot의 `artifact_hashes` 20행은 재작성하지 않는다(append-only). 새 snapshot부터 19행.

### 5.3 `enrichment-index.json` 확장

repo 항목에 `status: "verified"|"retained"|"held"`, `held_reason`, `defect_codes[]`, `warnings[]` 추가. `validate-enrichment-coverage.mjs`는 active set 전수가 세 상태 중 하나인지, `held` 비율 ≤ 50%인지, `held` repo의 `data/repo-summaries.json` 항목이 없는지(generic 문구 금지)를 검사한다. `update-trending.mjs`는 `held` repo 카드에 static 문구를 렌더하고 `summary: null, summary_status: "held"`를 export한다.

## 6. 오류 모드

| 상황 | 동작 |
|---|---|
| repo 1개 hard defect 잔존 | 그 repo `held`, run 계속 |
| held > 50% | run 실패, publish 0(provider/runner 장애 신호) |
| Claude rate limit(`CLAUDE_RATE_LIMITED`) | 남은 pending 전부 `held(budget_exhausted)`, 이미 verified는 publish. 다음 run이 held만 재시도 |
| enrichment deadline 소진 | 위와 같음(`deadline_exhausted`) |
| W2 GitHub 404/451 | 그 repo tick `unavailable`, 계속 |
| W2 ledger 접두 불일치(재작성 감지) | commit·deploy 중단, 실패 보고 |
| W2와 W1 동시 시각 | concurrency group으로 직렬화 |
| W2 deploy 중 finalized 19파일 hash 불일치 | 중단(코드 변경은 W1 publish로만) |
| Pages 빌드 한도 | W2 run 실패로 표면화, 다음 30분에 재시도(blind retry 아님 — 실패 사유가 로그에 남음) |

## 7. 테스트 범위

- validator: hard/warning 분류 전수 — 각 규칙 하나당 RED fixture 1개(number `15,704`/`9.9 percent`가 README에 있으면 통과, 없으면 hard defect; command 불일치 hard; hedge 누락 warning).
- admission: 1 held + N verified candidate가 coverage 통과, held 51%는 실패, held repo에 generic 문구가 있으면 실패, held repo export `summary: null`.
- 재시도: 한 repo 3회 소진 뒤 다음 repo 시도 계속, run 상한 소진 시 나머지 `budget_exhausted`.
- 캐시: repo 단위 즉시 기록, candidate 실패 시 tracked tree 불변.
- W2: ledger append-only(접두 검사 RED), 404 처리, 다운샘플 결정성, v2 스키마 exact keys, overlay manifest 결합, allowlist 3파일 외 변경 거부.
- 앵커: gain null·음수 처리, created_at 30일 규칙, W2가 앵커를 바꾸지 않음.
- UI: v2 파싱, v1 거부, anchors 점선 렌더, 0/1/N점 문구, XSS(slug 미보간) 유지, 축소 모션.
- workflow: actionlint, concurrency group 동일성, W2 allowlist, `GH_TRENDING_TICKS` hold.
- 운영 검증: W1 controlled dispatch 1회 → production manifest(19) + overlay manifest 확인 → `GH_TRENDING_TICKS=enabled` → W2 2회 연속 성공 → 카드 sparkline에 tick 증가 확인.

## 8. 열린 질문 (사용자 결정)

1. W2 대상: 게시된 전 repo(이 문서 기본) vs 공식 trending에 남은 repo만(사용자 제안). 기본 채택 이유는 §4.3. 반대하시면 W2가 트렌딩 3페이지를 추가 수집해 교집합을 취한다.
2. `held` 비율 상한 50% — 다른 값을 원하시는지.
3. 앵커 `created_at` 포함 창 30일 — 다른 값을 원하시는지.
4. W2 스케줄 hold 변수 `GH_TRENDING_TICKS`를 처음부터 `enabled`로 둘지, W1 첫 publish 검증 뒤 켤지(기본: 뒤에 켠다).

## 9. 후속 과제 (이 설계 범위 밖)

- OSS Insight 2025-05-22 이전 구간 하이브리드(active 55 중 15개 repo 효과).
- 실패 run의 검증 통과 bundle을 runner artifact로 보존해 다음 run이 재사용(admission 도입으로 우선순위 하락).
- `data/star-ticks.jsonl` 월 단위 회전(8 MiB 초과 시).
- `data/star-observations.sqlite`(하루 1점 exact ledger)와 tick ledger의 관계 정리 — 현재는 둘 다 유지(DB는 일 단위 정본, ticks는 표시용 고해상도).

## 10. 뒤집는 조건

- `held` 비율이 3 run 연속 20%를 넘으면 warning으로 내린 규칙 중 무엇이 원인인지 재검토한다(hard로 되돌리는 것이 아니라 프롬프트/모델 쪽을 본다).
- warning으로 내린 규칙에서 **사실 오류가 실제로 게시된 사례**가 확인되면 그 규칙 하나만 hard로 되돌린다.
- GitHub가 stargazer 타임스탬프 API를 다시 열면 앵커를 실제 타임라인으로 교체한다.
- W2가 Pages·REST 한도에 반복해서 걸리면 간격을 60분으로 늘리고 다운샘플 창을 조정한다.

## 11. 롤아웃 순서

1. 이 문서 리뷰·승인 → `writing-plans`로 계획 2개(Plan A: admission·validator 재분류·즉시 캐시, Plan B: overlay·v2 스키마·앵커·W2).
2. 두 계획을 각각 branch·PR·fable 리뷰·CodeQL로 merge한다. **W1 controlled dispatch는 두 PR이 모두 merge된 뒤 1회** — 코드 바이트 변경은 W1 publish로만 배포되기 때문(deploy-only는 byte-for-byte).
3. production 검증(19 + overlay manifest, held 카드 문구, sparkline) → `GH_TRENDING_TICKS=enabled` → W2 관찰 → `GH_TRENDING_REFRESH_SCHEDULE=enabled` 재개 결정.
