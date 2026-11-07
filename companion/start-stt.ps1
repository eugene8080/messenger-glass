# start-stt.ps1: run the STT companion in the foreground, appending its log to .local/stt.log.
# Started at logon by a scheduled task (conhost --headless, so no window). The log holds status codes,
# sizes and timings only; stt-server.mjs never writes audio or transcripts.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $repo '.local\stt.log'
$node = (Get-Command node -ErrorAction Stop).Source
Set-Location $repo
# 2>&1 merges stderr so a start-up failure (bad config path, port in use) is visible in the same log.
& $node (Join-Path $PSScriptRoot 'stt-server.mjs') *>> $log
exit $LASTEXITCODE
