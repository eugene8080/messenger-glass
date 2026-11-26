# start-mail-facade.ps1: run the Gmail facade in the foreground, appending its log to .local/mail-facade.log.
# Started at logon by a scheduled task (conhost --headless, so no window). The log holds routes, status codes,
# counts and timings only; mail-facade.mjs never writes mail content.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $repo '.local\mail-facade.log'
$node = (Get-Command node -ErrorAction Stop).Source
Set-Location $repo
# *>> merges every output stream so a start-up failure (missing token, port in use) lands in the same log.
& $node (Join-Path $PSScriptRoot 'mail-facade.mjs') *>> $log
exit $LASTEXITCODE
