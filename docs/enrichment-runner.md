# Windows 요약 생성 러너 복구

## 적용 범위

전용 자체 호스팅 러너가 `offline`이고, 전체 갱신의 `Generate source-bound summaries` 작업이 시작되지 않을 때 확인한다. 별점 관측은 GitHub 호스팅 러너에서 별도로 성공할 수 있다.

2026-10-25 장애에서는 자동 업데이트가 성공한 뒤 listener가 종료 코드 3으로 끝났다. 설치된 래퍼가 `Runner.Listener.exe`를 직접 실행해서 공식 `run.cmd`의 업데이트 후 재시작 처리를 건너뛰었다. `scripts/run-enrichment-runner.ps1`은 공식 진입점을 사용하면서 기존 프로세스 환경 정리와 채널 대기시간 300초를 유지한다.

## 검사와 설치

PowerShell에서 저장소 루트에서 실행한다. `$runnerRoot` 한 곳만 해당 러너의 실제 설치 폴더로 지정한다. 아래 값은 이 장애를 복구한 호스트의 경로다.

```powershell
$runnerRoot = 'C:\actions-runner-gh-trending'
Get-ScheduledTask -TaskName 'GitHub Actions Runner - GitHub Trending Claude'
Get-ScheduledTaskInfo -TaskName 'GitHub Actions Runner - GitHub Trending Claude'
Get-ChildItem -LiteralPath (Join-Path $runnerRoot '_diag') -Filter 'SelfUpdate-*.succeed'
node --test tests/enrichment-runner.test.mjs
```

현재 실행 중인 작업과 listener가 없음을 확인한 뒤 설치한다. 실행 중인 갱신을 끊거나 다른 러너를 종료하지 않는다.

```powershell
$installed = Join-Path $runnerRoot 'run-sanitized.ps1'
$backup = Join-Path $runnerRoot ('_backup_run-sanitized_' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.ps1')
Copy-Item -LiteralPath $installed -Destination $backup
Copy-Item -LiteralPath '.\scripts\run-enrichment-runner.ps1' -Destination $installed
Get-FileHash -LiteralPath '.\scripts\run-enrichment-runner.ps1', $installed -Algorithm SHA256
Start-ScheduledTask -TaskName 'GitHub Actions Runner - GitHub Trending Claude'
gh api repos/nowwcastle-sudo/github-trending-daily/actions/runners --jq '.runners[] | {name,status,busy}'
```

두 파일의 SHA-256이 같고, 해당 러너가 `online`인지 확인한다. 예약 작업 기동만으로 전체 갱신이 완료된 것은 아니다. 전체 갱신 실행의 생성·검증·게시·운영 검사 결과와 `data/latest.json`의 새 스냅샷도 확인한다.

## 경계

- 이 래퍼를 러너 루트의 `run-sanitized.ps1`로 복사한다. 저장소의 `scripts/` 폴더에서 그대로 실행하면 그 폴더에서 `run.cmd`를 찾으므로 러너를 시작하지 못한다.
- 공식 launcher의 재시작 정책을 재사용한다. 세션 충돌 같은 종료를 임의 무한 재시도로 바꾸지 않는다.
- 사용자 환경의 OAuth·TypeSafe 자격 증명은 기존 workflow가 읽는다. 이 파일은 보안 저장소를 수정하거나 인증값을 출력하지 않는다.
- 호스트가 꺼졌거나 로그온 트리거가 아직 실행되지 않은 상태는 이 수정의 대상이 아니다.
