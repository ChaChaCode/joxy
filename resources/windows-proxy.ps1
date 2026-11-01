param(
  [Parameter(Mandatory=$true)][ValidateSet('enable','suspend','restore','watch','status')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Journal,
  [int]$Port=0,
  [int]$XrayPid=0,
  [int]$ParentPid=0
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$registryPath='HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$keys=@('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')

function Read-Settings {
  $p=Get-ItemProperty -LiteralPath $registryPath
  $result=@{}
  foreach($key in $keys) {
    $result[$key]=@{ exists=($p.PSObject.Properties.Name -contains $key); value=$p.$key }
  }
  return $result
}
function Notify-Internet {
  if(-not ('JomoInternet' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class JomoInternet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int option, IntPtr b, int length); }'
  }
  [void][JomoInternet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)
  [void][JomoInternet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)
}
function Restore-Settings {
  if(-not (Test-Path -LiteralPath $Journal)) { return @{ restored=$false } }
  $saved=Get-Content -LiteralPath $Journal -Raw | ConvertFrom-Json
  $current=(Get-ItemProperty -LiteralPath $registryPath).ProxyServer
  $restored=$false
  if($current -eq $saved.expected -and ($null -eq $saved.expectedEnable -or (Get-ItemProperty -LiteralPath $registryPath).ProxyEnable -eq $saved.expectedEnable)) {
    foreach($key in $keys) {
      $entry=$saved.before.$key
      if($entry.exists) {
        $kind=if($key -eq 'ProxyEnable'){'DWord'}else{'String'}
        New-ItemProperty -LiteralPath $registryPath -Name $key -Value $entry.value -PropertyType $kind -Force | Out-Null
      } else { Remove-ItemProperty -LiteralPath $registryPath -Name $key -ErrorAction SilentlyContinue }
    }
    Notify-Internet
    $restored=$true
  }
  Remove-Item -LiteralPath $Journal -Force
  return @{ restored=$restored; externalChangePreserved=(-not $restored) }
}

switch($Action) {
  'status' { Read-Settings | ConvertTo-Json -Depth 5 -Compress }
  'enable' {
    if($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid proxy port' }
    if(Test-Path -LiteralPath $Journal) { throw 'Unrecovered proxy transaction exists' }
    $before=Read-Settings
    $expected='127.0.0.1:'+$Port
    $core=Get-Process -Id $XrayPid -ErrorAction Stop
    if($core.ProcessName -ne 'xray') { throw 'Unexpected proxy process' }
    $record=@{ before=$before; expected=$expected; corePid=$XrayPid; coreStart=$core.StartTime.ToUniversalTime().Ticks.ToString() }
    $record | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $Journal -Encoding UTF8
    try {
      New-ItemProperty -LiteralPath $registryPath -Name ProxyServer -Value $expected -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $registryPath -Name ProxyOverride -Value '<local>;localhost;127.*;[::1];10.*;192.168.*' -PropertyType String -Force | Out-Null
      Remove-ItemProperty -LiteralPath $registryPath -Name AutoConfigURL -ErrorAction SilentlyContinue
      New-ItemProperty -LiteralPath $registryPath -Name ProxyEnable -Value 1 -PropertyType DWord -Force | Out-Null
      Notify-Internet
      @{ enabled=$true; address=$expected } | ConvertTo-Json -Compress
    } catch { [void](Restore-Settings); throw }
  }
  'restore' { Restore-Settings | ConvertTo-Json -Compress }
  'suspend' {
    if(Test-Path -LiteralPath $Journal) { throw 'Unrecovered proxy transaction exists' }
    $before=Read-Settings
    $core=Get-Process -Id $XrayPid -ErrorAction Stop
    if($core.ProcessName -ne 'xray') { throw 'Unexpected proxy process' }
    @{before=$before;expected=$before.ProxyServer.value;expectedEnable=0;corePid=$XrayPid;coreStart=$core.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $Journal -Encoding UTF8
    try {
      New-ItemProperty -LiteralPath $registryPath -Name ProxyEnable -Value 0 -PropertyType DWord -Force | Out-Null
      Remove-ItemProperty -LiteralPath $registryPath -Name AutoConfigURL -ErrorAction SilentlyContinue
      Notify-Internet
      @{suspended=$true} | ConvertTo-Json -Compress
    } catch { [void](Restore-Settings); throw }
  }
  'watch' {
    $parent=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    $parentStart=if($parent){$parent.StartTime.ToUniversalTime().Ticks.ToString()}else{''}
    while(Test-Path -LiteralPath $Journal) {
      Start-Sleep -Seconds 2
      $alive=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
      if(-not $alive -or $alive.StartTime.ToUniversalTime().Ticks.ToString() -ne $parentStart) {
        $record=Get-Content -LiteralPath $Journal -Raw | ConvertFrom-Json
        [void](Restore-Settings)
        $core=Get-Process -Id $record.corePid -ErrorAction SilentlyContinue
        if($core -and $core.ProcessName -eq 'xray' -and $core.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.coreStart) { Stop-Process -Id $core.Id -ErrorAction SilentlyContinue }
        break
      }
    }
  }
}
