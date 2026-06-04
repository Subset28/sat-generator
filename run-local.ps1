param(
  [switch]$Sync,
  [switch]$NoSync,
  [switch]$NoBrowser,
  [switch]$Share
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $repoRoot 'run-local.cmd'
$cmdArgs = @()
if ($Sync) {
  $cmdArgs += '--sync'
}
if ($NoSync) {
  $cmdArgs += '--no-sync'
}
if ($NoBrowser) {
  $cmdArgs += '--no-browser'
}
if ($Share) {
  $cmdArgs += '--share'
}

$argLine = ($cmdArgs | ForEach-Object {
  if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ }
}) -join ' '

& cmd.exe /c "`"$launcher`" $argLine"
