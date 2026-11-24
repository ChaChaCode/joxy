# Puts a downloaded update in place of the portable JOXY.exe it updates, so shortcuts and pins keep working, and
# starts it. JOXY runs this hidden and quits; the script waits for it, then for the file to be free (the portable
# launcher holds it until the app inside has exited), swaps the files and starts the new one. If anything fails the old
# file is put back and started instead, so the user is never left without JOXY.
param(
  [Parameter(Mandatory)][int]$ParentPid,
  [Parameter(Mandatory)][string]$Source,
  [Parameter(Mandatory)][string]$Target,
  [switch]$Reconnect
)
$ErrorActionPreference = 'Stop'
$arguments = @(); if ($Reconnect) { $arguments += '--reconnect' }
function Start-Joxy { if ($arguments.Count) { Start-Process -FilePath $Target -ArgumentList $arguments } else { Start-Process -FilePath $Target } }

if (-not $Target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $Source -PathType Leaf)) { exit 1 }
try { Wait-Process -Id $ParentPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}

$backup = "$Target.old"
$moved = $false
for ($i = 0; $i -lt 120 -and -not $moved; $i++) {
  try {
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    Move-Item -LiteralPath $Target -Destination $backup -Force
    $moved = $true
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $moved) { Start-Joxy; exit 1 }
try {
  Move-Item -LiteralPath $Source -Destination $Target -Force
} catch {
  Move-Item -LiteralPath $backup -Destination $Target -Force
  Start-Joxy; exit 1
}
Start-Joxy
Start-Sleep -Seconds 3
Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
