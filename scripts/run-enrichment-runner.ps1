$ErrorActionPreference = "Stop"

foreach ($name in @(
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX"
)) {
  Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}

# Runner.Worker.exe has taken 32-37s to start on this host under memory pressure (2026-09-24),
# past the listener's default 30s job hand-off, so the job was killed and reported lost.
# 300 is the runner's upper bound (JobDispatcher.cs, v2.337.0).
$env:GITHUB_ACTIONS_RUNNER_CHANNEL_TIMEOUT = "300"

# 공식 진입점이 업데이트 종료 코드 3/4와 재시도 코드 2를 처리한다.
Push-Location -LiteralPath $PSScriptRoot
try {
  & (Join-Path $PSScriptRoot "run.cmd")
  $runnerExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $runnerExitCode
