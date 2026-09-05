# GITHUB INSIGHT

[English](README.md)

> 오늘 뜨는 저장소를 별 개수만 보고 지나치지 않고, 무엇을 하는지·어떻게 쓰는지·내게 맞는지를 한 화면에서 판단하는 정적 대시보드입니다.

<h2 align="center"><a href="https://nowwcastle-sudo.github.io/github-trending-daily/"><strong>GITHUB INSIGHT 열기</strong></a></h2>

서버 설치나 계정 생성 없이 바로 볼 수 있습니다. Google 로그인은 즐겨찾기를 동기화할 때만 선택합니다.

## 🔭 무엇을 하는 사이트인가

GITHUB INSIGHT는 GitHub Trending(일간·주간·월간)에 오르는 저장소를 지켜보면서, 다른 트렌딩 사이트에는 없는 두 가지를 저장소마다 제공합니다. 하나는 제3자 추정치가 아니라 이 사이트가 직접 측정한 스타 수, 다른 하나는 일반적인 설명이 아니라 그 저장소 자신의 README에서 검증해 생성한 요약입니다. 현재 보기를 필터·정렬·즐겨찾기·내보내기할 수 있고, 매번 직접 확인하는 대신 Atom feed를 구독할 수도 있습니다.

## ✅ 현재 구현 상태

다국어 인터페이스, Login(로그인)·Explore(탐색)·History(이력)·Export(내보내기) 4개 그룹의 Compact Rail 탐색, 출처 결합 README 뷰어, 5개 언어 요약 파이프라인은 현재 소스에 구현되어 있습니다. 저장소에는 로컬에서 재현·검증한 45개 저장소 v1 snapshot이 포함되며, 공개 사이트의 정확한 배포 revision은 deployment manifest로 별도 확인합니다. 일반 legacy 요약, README provenance 누락, 일부 언어 요약 누락은 v1 성공 배포로 인정하지 않습니다.

아래 이미지는 2026-09-05에 production에서 1440px와 390px로 캡처한 것으로, Login·Explore·History·Export 4개 레일 그룹이 모두 보입니다. production revision은 스크린샷이 아니라 deployment manifest로 증명합니다.

![1440px 데스크톱에서 본 GITHUB INSIGHT](docs/screenshots/desktop-1440.png)

<p align="center"><img src="docs/screenshots/mobile-sidebar-390.png" width="390" alt="패널이 열린 모바일 화면"></p>

## 🎛️ 네 개의 레일 그룹

왼쪽 64px 레일에는 버튼 4개가 있고, 각 버튼은 같은 패널을 그룹만 다르게 선택해 엽니다. 데스크톱에서는 hover 시 비모달 사이드바(포인터가 간격을 건널 짧은 close grace 포함)를, 클릭·키보드 실행 시 focus trap이 있는 고정 모달을 엽니다. 모바일은 오른쪽 가장자리 swipe로 열고 왼쪽 swipe로 닫으며, native 트리거 버튼은 화면 리더나 하드웨어 키보드로 접근할 때만 화면에 나타납니다.

- 🔑 **Login(로그인)**은 Google 로그인과 즐겨찾기 동기화를 담당합니다. 로그아웃 상태에서도 로컬 즐겨찾기는 그대로 동작합니다.
- 🧭 **Explore(탐색)**는 기간, 정렬, 즐겨찾기, 프로그래밍 언어, 분야, 형태, 기술, AI 제외 필터를 묶습니다. 같은 그룹 안은 OR, 서로 다른 그룹 사이는 AND입니다.
- 🕘 **History(이력)**는 **관심 없음**으로 숨긴 저장소(개별·전체 복구)와 최근 신규·재진입 저장소를 보여줍니다.
- 📤 **Export(내보내기)**는 현재 공개 보기의 CSV/JSON 내보내기와 복사 가능한 탐색 URL을 제공합니다.

키보드 단축키는 해당 그룹을 바로 엽니다: Login은 `a`, Explore는 `e`, History는 `h`, Export는 `x`. `/`는 검색으로 초점을 옮기고, `Escape`는 열려 있는 패널을 닫습니다.

## 🔍 필터 바

배지 안내 바로 아래에는 레일 패널을 열지 않아도 되는 필터 바가 항상 보입니다: 기간(일간/주간/월간/전체), 언어, **Exclude AI(AI 제외)** 토글, **New repositories only(신규 저장소만)** 토글, 그리고 현재 필터 상태를 공유 가능한 URL로 클립보드에 복사하는 **Copy link(링크 복사)**입니다. Explore 그룹 필터 중 자주 쓰는 일부를 그대로 반영하므로, 가장 흔한 필터는 사이드바를 열지 않고도 바로 조정할 수 있습니다.

## 🚦 저장소별 admission과 held 요약

저장소는 하나하나 독립적으로 게시 여부가 결정됩니다. 완전히 검증된 5개 언어 요약을 갖춘 채로 게시되거나, 그렇지 못하면 **held** 상태로 게시됩니다. held 저장소도 카드에는 측정된 데이터(스타, 포크, 활동, 순위)가 그대로 보이지만, AI 요약 대신 고정된 지역화 문구로 "요약 검증 중"임을 안내하고 다음 예약된 갱신(6시간마다)에 자동으로 다시 시도합니다. 저장소 하나가 held여도 다른 저장소는 전혀 영향받지 않습니다. GITHUB INSIGHT는 all-or-nothing 게시로 되돌아가지 않습니다.

## ⭐ 스타 히스토리

이 사이트의 스타 수는 추정치가 아닙니다. `star-ticks` workflow가 게시 중인 모든 저장소의 정확한 총 스타 수를 GitHub API로 직접 30분마다 측정해, 제3자 서비스의 파생값이 아니라 이 프로젝트 자체 데이터베이스(`data/star-ticks/YYYY-MM.jsonl`, `data/star-daily.jsonl`)에 append-only로 기록합니다.

카드에서 실선은 이렇게 직접 측정한 히스토리이고, 점선(속이 빈 마커)은 직접 관측이 아직 없는 구간을 GitHub Trending 자체의 기간 증가량(일간·주간·월간, 생성 30일 이내 저장소는 생성일 포함)으로 역산한 앵커로 이어 붙인 것입니다. 그래프는 점 두 개만 있으면 선을 그리므로, 관측 두 번(약 30분 간격)이면 첫 선이 뜰 수 있어 **최초 관측 후 약 1시간이면 첫 선이 보이고**, 하루치 움직임을 의미 있게 담은 곡선은 **최초 관측 후 최소 1일이면 히스토리 확인 가능**할 정도로 대략 첫날에 걸쳐 쌓입니다.

## 📜 요약 품질 계약

갱신 파이프라인은 Claude CLI OAuth를 통한 `claude-sonnet-5`로 설정되어 있으며 달러 비용 계산 단계는 두지 않습니다. 저장소와 README 수집이 성공하기 전에는 모델을 호출하지 않습니다.

저장소 하나는 5개 언어를 하나의 원자적 묶음으로 생성합니다.

- `goal`, `usage`, `pros`, `cons`, `fit`은 서로 겹치지 않고 각 역할을 지키며 검증된 README에 근거해야 합니다. 설치·실행 방법은 `usage`에 둡니다.
- 영어 묶음은 100~280단어를 허용합니다. 다른 언어는 영어와 단어 수·문장 수·표현·정보 순서를 똑같이 맞출 필요가 없습니다.
- README에 실제 있는 핵심 명령만 1~2개 인용하고, 언어가 달라도 같은 의미 필드에 둡니다.
- "README를 참고하라"는 일반 fallback은 무효입니다. 표현이 다소 주관적이라는 이유만으로 README 근거와 구조가 완전한 요약을 실패시키지는 않습니다.
- README path·blob·content hash·default-branch head는 공통 정본 출처와 stale 여부를 확인할 뿐, 언어별 문장을 byte 단위나 완전히 같은 의미로 강제하는 값이 아닙니다. 내부 증거는 README 섹션 제목과 줄 범위로 남기며 observation DB에는 README 전체 본문을 저장하지 않습니다.
- 기존 bounded attempt·token 정책 안에서 저장소별 품질 교정은 최대 3회입니다.
- 언어 하나 누락, 번역하면 안 되는 값의 잘못된 필드 배치·근거 불일치, 근거 부족, 스키마 오류 중 하나라도 있으면 해당 저장소와 갱신 전체가 실패합니다. 그 저장소는 대신 `held`로 게시됩니다.

UI에는 "검증된 저장소 README를 바탕으로 AI가 생성했다"고 정확히 표시하며 사람이 검증했다고 과장하지 않습니다.

## ✨ 주요 기능

- 정확한 기간 membership을 적용한 GitHub Trending 전체·일간·주간·월간 보기.
- 모든 보기의 총 스타와 일간·주간·월간의 정확한 기간 증가량·HOT, 포크, 이슈·PR, 기여자, 최근 커밋·릴리스.
- 이 사이트가 직접 관측한 스타 추세, 연속 관측, 직전 대비 변화, 신규, 재진입 신호.
- 검색과 프로그래밍 언어·분야·형태·기술·즐겨찾기·AI 제외 필터.
- 선택 기간의 Trending rank, 기간 증가량, 총 스타, 최근 push, 최근 release 정렬. 전체는 source 순서를 유지합니다.
- 공개 탐색 조건을 보존하는 공유 URL. 브라우저 로컬 숨김 목록은 포함하지 않습니다.
- 브라우저별 **관심 없음**, 즉시 되돌리기, 개별·전체 복구.
- 로그아웃 시 로컬 즐겨찾기, 선택적 Google 로그인 시 계정 동기화.
- 공개 필드만 담는 현재 보기 CSV·JSON과 현재 링크 복사.
- 상류 저장소 README 언어판만 표시. 저장소에 실제 존재하는 README 언어 파일만 버튼으로 보여주며, path·불변 blob SHA·기본 브랜치 head SHA·content SHA-256을 검증한 뒤 렌더합니다. 전체 README 생성 번역과 저장은 중단했습니다.
- 현재 저장소 전체 [feed.xml](https://nowwcastle-sudo.github.io/github-trending-daily/feed.xml), 신규·재진입 [changes.xml](https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml). 두 feed의 제목은 각각 `GITHUB INSIGHT — Current repositories`, `GITHUB INSIGHT — New and re-entered repositories`입니다.
- 라이트·다크 테마, 키보드 탐색, focus trap, 44px 터치 대상, reduced-motion·reduced-transparency, BFCache 복원, 반응형 레이아웃.
- `?` 키로 단축키 안내 대화상자를 엽니다. `/`, `e`, `a`, `h`, `x`, `Delete`, `Esc`, `?`를 모두 보여주고, 한 글자 단축키를 끄는 체크박스를 함께 제공합니다(WCAG 2.1.4). `/`, `?`, `Escape`는 어느 경우에도 동작합니다.
- 저장한 필터 프리셋: 지금의 탐색 필터를 이름으로 이 브라우저에 저장해 두고 한 번에 다시 적용합니다. 최대 20개까지 저장할 수 있습니다.
- 간단히 보기 모드: 카드 여백을 줄이고 분류 배지와 스파크라인을 감춰 한 화면에 보이는 저장소를 약 3배로 늘립니다. 선택은 이 브라우저에 기억됩니다.
- 지난 방문 이후 새로 올라온 저장소를 목록 제목과 카드 배지로 표시합니다. 이 브라우저가 지난번에 본 목록과 비교한 결과이며, 모든 방문자에게 동일한 기준선 기반 **New** 배지와는 별개입니다.

## ⚖️ 다른 트렌딩 사이트 대비 장점

- 스타 수는 이 사이트가 30분마다 직접 관측해 자체 데이터베이스에 기록한 값으로, 제3자 추정 서비스가 아닙니다. GitHub Trending 자체의 기간 증가량은 직접 관측이 아직 없는 구간을 잇는 점선 앵커로만 씁니다.
- 검증에 실패한 요약은 측정 데이터를 그대로 둔 채 `held`로 표시합니다. 부정확하거나 일반적인 요약을 조용히 내보내거나 저장소 자체를 숨기지 않습니다.
- 모든 요약은 해당 저장소 자신의 검증된 README에서 5개 언어로 생성되며, 출처 path·blob SHA·content hash를 provenance로 남깁니다.
- Atom feed는 하나가 아니라 둘입니다. 현재 저장소 전체 feed와 신규·재진입만 담는 feed를 따로 구독할 수 있습니다.
- 영어·한국어·중국어 간체·스페인어·일본어 5개 실제 UI 언어가 같은 메시지 키를 공유하며, 매 페이지마다 기계 번역하지 않습니다.
- `/`, `e`, `a`, `h`, `x`, `Escape`만으로 마우스 없이 모든 레일 그룹과 검색에 도달합니다.
- 목적이 분명한 4개 레일 그룹(Login, Explore, History, Export)이 하나의 잡다한 메뉴를 대신합니다.
- 계정 없이도 CSV/JSON 내보내기와 필터가 반영된 공유 URL을 쓸 수 있습니다.
- 전체 사이트가 정적입니다. 즐겨찾기 동기화용 선택적 Google 로그인 외에는 브라우저에서 하는 어떤 동작도 GITHUB INSIGHT가 운영하는 백엔드로 전송되지 않습니다.

## 🚀 사용 방법

1. [사이트](https://nowwcastle-sudo.github.io/github-trending-daily/)를 엽니다.
2. 헤더에서 사이트 언어를 고릅니다.
3. 항상 보이는 필터 바에서 기간, 언어, **Exclude AI**, **New repositories only**를 바로 쓰거나, **Explore(탐색)**(`e`) 그룹에서 기간·정렬·즐겨찾기·프로그래밍 언어·분야·형태·기술·AI 제외 조건을 전부 조합합니다. 같은 그룹 안은 OR, 서로 다른 그룹 사이는 AND입니다.
4. 데스크톱에서는 카드에 hover하거나 초점을 두고, 모바일에서는 탭해 헤더에서 선택한 사이트 언어의 전체 요약을 엽니다. `held` 저장소는 대신 "요약 검증 중" 안내가 뜨며 자동으로 재시도됩니다.
5. **View README**로 검증된 정본 README와 해당 저장소가 실제 제공하는 다른 언어판을 확인합니다.
6. **Login(로그인)**(`a`)에서 즐겨찾기를 로컬에 저장하거나 Google 로그인으로 동기화합니다. 저장소를 숨겨도 즐겨찾기는 지워지지 않습니다.
7. **History(이력)**(`h`)에서 숨긴 저장소를 확인·복구하거나, 최근 신규·재진입 저장소를 봅니다.
8. **Export(내보내기)**(`x`) 또는 필터 바의 **Copy link**로 현재 공개 보기를 CSV·JSON으로 내보내거나 URL을 복사하고, Atom feed를 구독합니다.

## 🔄 갱신·배포 안전장치

활성화된 경우 GitHub Actions는 하루 네 번, `Asia/Seoul` 기준 00시 07분, 06시 07분, 12시 07분, 18시 07분(UTC 03:07, 09:07, 15:07, 21:07)에 실행됩니다. 먼저 정본 저장소와 README 사실을 수집·동결한 뒤 enrichment 필요 여부를 판정합니다. 그다음 정확한 5개 언어 coverage 또는 저장소별 `held` admission, provenance 검증, 렌더, observation 기록, artifact 검증을 모두 마쳐야 publication으로 넘어갑니다.

예약된 갱신은 Claude CLI OAuth의 `claude-sonnet-5`를 기본 요약 producer로 유지합니다. Codex는 같은 frozen input에서 정확히 pending으로 남은 저장소에만 쓰는 fallback이며, 예약 실행의 기본 producer를 대체하거나 이미 완료된 저장소를 다시 생성하지 않습니다.

- **Code release**는 현재 Pages code bytes로 새 v1 snapshot을 record, derive, finalize한 뒤 배포합니다.
- **Finalized artifact redeploy**는 이미 finalize된 source와 byte-for-byte 같은 artifact만 다시 배포합니다. old finalized contract 아래에서 Pages bytes가 바뀌면 builder는 artifact나 manifest를 출력하기 전에 중단하고 full refresh를 요구합니다.

workflow는 fail-closed입니다.

- 수집 실패 시 모델 호출은 0회입니다.
- enrichment가 불완전하면 observation, 페이지, commit, Pages 배포는 모두 0입니다.
- 갱신 실패 시 tracked tree는 바뀌지 않습니다.
- README provenance 누락·stale, source mismatch, incomplete chunk, 모델 출력 오류, 비용 cap 초과, 옛 translation residue는 publication을 막습니다.
- provider API key는 브라우저에 전달하지 않습니다.

스타 히스토리는 이 사이트가 직접 관측합니다. star-ticks workflow가 게시 중인 저장소의 정확한 총 스타를 30분마다, 한 번이라도 게시된 저장소(7일 증가량 기준 상위 500개)의 총 스타를 하루 1회 기록하며, 기록은 `data/star-ticks/`와 `data/star-daily.jsonl`에 append-only로 쌓입니다. 점선 앵커는 GitHub Trending 기간 집계(일간·주간·월간, 생성 30일 이내 저장소는 생성일 포함)로 역산한 근사치입니다. `star-history.json`은 게시 중인 저장소만 담고 finalized snapshot contract에 포함되지 않으며, 갱신 사이에 star-ticks workflow가 다시 배포합니다. GH Archive 기반 추정치는 출처가 2026-05-01 이후 심각한 과소집계를 스스로 선언해 2026-09-02에 중단했습니다. CSV는 스프레드시트 호환을 위해 UTF-8 BOM을 포함하고 comma·quote·줄바꿈을 quoting하며 수식처럼 실행될 수 있는 값 앞에는 apostrophe를 붙입니다.

## 🗺️ 예정된 기능

희망 사항이 아니라 승인된 backlog이며, 일부러 짧게 유지합니다.

- **스타 관측 데이터베이스를 필요하면 git 밖으로 옮기는 것을 검토합니다.** observation ledger(`data/star-ticks/`, `data/star-daily.jsonl`)는 append-only이며 현재 이 저장소에 그대로 commit됩니다. 이 증가량이 저장소 크기나 clone/checkout 시간에 실질적인 영향을 주면 git 밖 저장소로 옮기는 방안을 검토 중입니다. 아직 옮긴 것은 없고 별도 데이터베이스 서비스도 없으며, 이관을 결정하고 실행하기 전까지 ledger는 계속 git 안에 남습니다.

**관측 데이터베이스.** 갱신마다 기록되는 SQLite 데이터베이스(`repository-observations.sqlite`)는 이 저장소에 커밋되지 않습니다. 각 갱신은 그 파일을 해당 월의 `observation-db-YYYY-MM` 프리릴리스 자산으로 올리고, 자산 이름과 SHA-256을 담은 `data/observation-db.pointer.json`만 커밋합니다. 모든 워크플로와 운영 점검은 자산을 익명으로 내려받아 해시를 검증한 뒤 사용하므로 체크아웃에는 데이터베이스가 없습니다. 현재 커밋이 가리키는 파일은 `node scripts/observation-db-store.mjs resolve --source-sha "$(git rev-parse HEAD)" --out repository-observations.sqlite`로 받을 수 있습니다.

## 📝 기능 요청

위 내용이 필요한 것을 다루지 못한다면 **Feature request** issue 템플릿으로 [기능을 요청](https://github.com/nowwcastle-sudo/github-trending-daily/issues/new/choose)해 주세요. 어떤 문제를 겪고 있는지, 대신 어떻게 동작하길 바라는지, 무엇을 이미 시도해봤는지를 물어보며, 첫 검토에는 이것으로 충분합니다. 구조화된 이 양식을 위해 blank issue는 비활성화되어 있습니다.

## 🧪 로컬 검증

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py"
```

PowerShell에서 저장소 루트로 이동한 뒤 실행합니다. production 활성화, workflow dispatch, Pages 배포는 별도의 통제 단계입니다.

## 📄 라이선스

이 프로젝트는 [MIT 라이선스](LICENSE)로 공개합니다. 사이트에 표시되는 트렌딩 데이터의 권리는 각 저장소 소유자와 GitHub에 있으며, 라이선스는 이 프로젝트의 코드·워크플로·생성 페이지에 적용됩니다.
