param(
  [Parameter(Mandatory=$true)][ValidateSet('restore')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Journal
)
# Windows removes the Wintun adapter, its routes and DNS, and Xray's dynamic WFP filters together with the core
# process. Weak host send that Xray turned off is the one change a hard kill leaves behind, plus a core JOXY failed
# to stop. JOXY writes the journal; this script only reads and deletes it, and needs administrator rights.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
function Is-Admin { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Read-Session {
  $record=Get-Content -LiteralPath $Journal -Raw | ConvertFrom-Json
  if($record.version -ne 2){throw 'Unexpected TUN session record'}
  return $record
}
function Owned-Core($id, $binary) {
  if(-not $id -or -not $binary){return $null}
  $process=Get-Process -Id $id -ErrorAction SilentlyContinue
  if($process -and $process.ProcessName -eq 'xray' -and $process.Path -eq $binary){return $process}
  return $null
}
function Restore-Session {
  if(-not (Test-Path -LiteralPath $Journal)){return @{restored=$false}}
  if(-not (Is-Admin)){return @{restored=$false;requiresElevation=$true}}
  $digest=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Journal)))).Replace('-','')
  $mutex=New-Object Threading.Mutex($false,('Local\JOXY-TUN-'+$digest))
  try {
    try { [void]$mutex.WaitOne() } catch [Threading.AbandonedMutexException] {}
    if(-not (Test-Path -LiteralPath $Journal)){return @{restored=$false}}
    $record=Read-Session
    $core=Owned-Core $record.corePid $record.binary
    if($core){Stop-Process -Id $core.Id -Force; Wait-Process -Id $core.Id -Timeout 5 -ErrorAction SilentlyContinue}
    foreach($before in @($record.weakHostSend)) {
      $adapter=Get-NetAdapter -InterfaceIndex $before.index -ErrorAction SilentlyContinue
      if(-not $adapter -or $adapter.InterfaceGuid.ToString() -ne $before.guid){continue}
      $current=Get-NetIPInterface -InterfaceIndex $before.index -AddressFamily $before.family -ErrorAction SilentlyContinue
      if($current -and $current.WeakHostSend -eq 'Disabled'){Set-NetIPInterface -InterfaceIndex $before.index -AddressFamily $before.family -WeakHostSend Enabled}
    }
    Remove-Item -LiteralPath $Journal -Force
    return @{restored=$true}
  } finally { try{$mutex.ReleaseMutex()}catch{}; $mutex.Dispose() }
}
Restore-Session | ConvertTo-Json -Compress
