# GitHub Trending Daily

[English](README.md)

> 오늘 뜨는 저장소를 별 개수만 보고 지나치지 않고, 무엇을 하는지·어떻게 쓰는지·내게 맞는지를 한 화면에서 판단하는 정적 대시보드입니다.

<h2 align="center"><a href="https://nowwcastle-sudo.github.io/github-trending-daily/"><strong>GitHub Trending Daily 열기</strong></a></h2>

서버 설치나 계정 생성 없이 바로 볼 수 있습니다. Google 로그인은 즐겨찾기를 동기화할 때만 선택합니다.

## 현재 구현 상태

다국어 인터페이스, Compact Rail 탐색, 출처 결합 README 뷰어, 5개 언어 요약 파이프라인은 현재 후보 소스에 구현되어 있습니다. 다만 실제 production 데이터는 사용자가 controlled refresh와 Pages 배포를 별도로 승인하기 전까지 이전 legacy 요약 상태입니다. 후보는 일반 문구 요약, README provenance 누락, 일부 언어 요약 누락을 성공 배포로 인정하지 않습니다.

아래 이미지는 2026-08-31 후보 소스를 1440px와 390px에서 로컬 캡처한 것입니다. production 배포 증거로 표시하지 않습니다.

![Compact Rail이 적용된 데스크톱 후보 화면](docs/screenshots/candidate-desktop-1440.png)

<p align="center"><img src="docs/screenshots/candidate-mobile-sidebar-390.png" width="390" alt="Explore 사이드바를 연 모바일 후보 화면"></p>

## 이번 버전의 핵심 변경

- **영문 README 기본화** — 정본 영문 문서는 `README.md`입니다. 전체 한글 문서는 이 `README.ko.md`이며, `README.en.md`는 기존 링크 호환용 안내만 유지합니다.
- **사이트 기본 틀 5개 언어** — 영어·한국어·중국어 간체·스페인어·일본어로 안정적인 UI 문구를 전환합니다. 갱신 때 바뀌는 저장소 카드 원천 데이터는 매번 기계 번역하지 않습니다.
- **5개 언어 요약 묶음** — 모든 enrichment 저장소는 영어·한국어·중국어 간체·스페인어·일본어 요약을 함께 제공해야 합니다. 사실, 명령, 숫자, 경고, 제품명은 언어 사이에서 정확히 같아야 합니다.
- **웹·모바일 동일 요약 수준** — 반응형 레이아웃은 표시 방식만 바꾸며 모바일에서 요약 내용을 줄이거나 약화하지 않습니다.
- **Compact Rail 탐색** — 데스크톱의 64px Explore 레일은 hover 시 비모달 사이드바를, 클릭·키보드 실행 시 focus trap이 있는 고정 모달을 엽니다. 모바일은 명시적인 44px 버튼과 가장자리 swipe 동작을 유지합니다.
- **상류 저장소 README 언어판만 표시** — 저장소에 실제 존재하는 README 언어 파일만 버튼으로 보여줍니다. path, 불변 blob SHA, 기본 브랜치 head SHA, content SHA-256을 검증한 뒤 렌더합니다. 전체 README 생성 번역과 저장은 중단했습니다.
- **툴팁 동선 개선** — 첫 줄에는 5개 요약 언어, 두 번째 줄에는 **View README**, 그 아래에는 목표·사용법·장점·주의점·적합한 사용자가 나옵니다.

## 요약 품질 계약

갱신 파이프라인은 승인된 영구 단가인 입력 $2·출력 $10/백만 토큰 기준의 `claude-sonnet-5`로 설정되어 있습니다. 저장소와 README 수집이 성공하기 전에는 모델을 호출하지 않습니다.

저장소 하나는 5개 언어를 하나의 원자적 묶음으로 생성합니다.

- `goal`, `usage`, `pros`, `cons`, `fit`은 서로 겹치지 않고 검증된 README에 근거해야 합니다.
- 영어 환산 전체 길이는 180~280단어이며 목표는 200~240단어입니다.
- README에 실제 있는 핵심 명령만 1~2개 인용합니다.
- 홍보성 최상급 표현과 “README를 참고하라”는 일반 fallback은 무효입니다.
- 내부 증거는 README 섹션 제목과 줄 범위로 남기며 observation DB에는 README 전체 본문을 저장하지 않습니다.
- 기존 전체 retry·토큰 cap 안에서 저장소별 품질 교정은 최대 1회입니다.
- 언어 하나 누락, 언어 간 불변값 불일치, 근거 부족, 스키마 오류 중 하나라도 있으면 해당 저장소와 candidate 전체가 실패합니다.

UI에는 “검증된 저장소 README를 바탕으로 AI가 생성했다”고 정확히 표시하며 사람이 검증했다고 과장하지 않습니다.

## 주요 기능

- GitHub Trending 전체·일간·주간·월간 보기.
- 총 스타, 기간 증가량, 포크, 이슈·PR, 기여자, 최근 커밋·릴리스.
- 스타 추세, 연속 관측, 직전 대비 변화, HOT, 신규, 재진입 신호.
- 검색과 프로그래밍 언어·분야·형태·기술·즐겨찾기·AI 제외 필터.
- 원래 Trending 순서, 기간 증가량, 총 스타, 최근 push, 최근 release 정렬.
- 공개 탐색 조건을 보존하는 공유 URL. 브라우저 로컬 숨김 목록은 포함하지 않습니다.
- 브라우저별 **관심 없음**, 즉시 되돌리기, 개별·전체 복구.
- 로그아웃 시 로컬 즐겨찾기, 선택적 Google 로그인 시 계정 동기화.
- 공개 필드만 담는 현재 보기 CSV·JSON과 현재 링크 복사.
- 현재 저장소 전체 [feed.xml](https://nowwcastle-sudo.github.io/github-trending-daily/feed.xml), 신규·재진입 [changes.xml](https://nowwcastle-sudo.github.io/github-trending-daily/changes.xml).
- 라이트·다크 테마, 키보드 탐색, focus trap, 44px 터치 대상, reduced-motion·reduced-transparency, BFCache 복원, 반응형 레이아웃.

## 사용 방법

1. [사이트](https://nowwcastle-sudo.github.io/github-trending-daily/)를 엽니다.
2. 헤더에서 사이트 언어를 고릅니다.
3. **Explore**에서 기간, 정렬, 즐겨찾기, 프로그래밍 언어, 분야, 형태, 기술, AI 제외 조건을 조합합니다. 같은 그룹 안은 OR, 서로 다른 그룹 사이는 AND입니다.
4. 데스크톱에서는 카드에 hover하거나 초점을 두고, 모바일에서는 탭해 전체 요약을 엽니다. 언어를 바꿔도 요약 수준은 같아야 합니다.
5. **View README**로 검증된 정본 README와 해당 저장소가 실제 제공하는 다른 언어판을 확인합니다.
6. 즐겨찾기는 로컬에 저장하거나 Google 로그인으로 동기화합니다. 저장소를 숨겨도 즐겨찾기는 지워지지 않습니다.
7. 현재 공개 보기를 CSV·JSON으로 내보내거나 URL을 복사하고, Atom feed를 구독합니다.

## 갱신·배포 안전장치

활성화된 경우 GitHub Actions는 `Asia/Seoul` 기준 홀수 시각 07분, 약 2시간 간격으로 실행됩니다. 먼저 정본 저장소와 README 사실을 수집·동결한 뒤 enrichment 필요 여부를 판정합니다. 그다음 정확한 5개 언어 coverage, provenance 검증, 렌더, observation 기록, artifact 검증을 모두 마쳐야 publication으로 넘어갑니다.

workflow는 fail-closed입니다.

- 수집 실패 시 모델 호출은 0회입니다.
- enrichment가 불완전하면 observation, 페이지, commit, Pages 배포는 모두 0입니다.
- candidate 실패 시 tracked tree는 바뀌지 않습니다.
- README provenance 누락·stale, source mismatch, incomplete chunk, 모델 출력 오류, 비용 cap 초과, 옛 translation residue는 publication을 막습니다.
- provider API key는 브라우저에 전달하지 않습니다.

과거 스타 차트에는 GH Archive 기반 추정치가 섞일 수 있고 현재 총 스타는 GitHub 기준입니다. CSV는 스프레드시트 호환을 위해 UTF-8 BOM을 포함하고 comma·quote·줄바꿈을 quoting하며 수식처럼 실행될 수 있는 값 앞에는 apostrophe를 붙입니다.

## 로컬 검증

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py"
```

PowerShell에서 저장소 루트로 이동한 뒤 실행합니다. production 활성화, workflow dispatch, Pages 배포는 별도의 통제 단계입니다.
