param([switch]$SkipCoreDownload)
$ErrorActionPreference='Stop'
$projectDir=$PSScriptRoot
$previousPath=$env:Path
$previousDirectory=Get-Location
try {
  $nodeExecutable=(Get-Command node -ErrorAction SilentlyContinue).Source
  $suitable=$false
  if($nodeExecutable) { $major=[int]((& $nodeExecutable --version) -replace '^v(\d+).*','$1'); $suitable=$major -ge 24 }
  if(-not $suitable) {
    $existing=Join-Path $env:TEMP 'zagran-toolchain\node-v24.22.2-win-x64\node.exe'
    if(Test-Path -LiteralPath $existing) { $nodeExecutable=$existing }
    else {
      $toolDir=Join-Path $env:LOCALAPPDATA 'ZAGRAN-build'
      New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
      $archiveName='node-v24.22.2-win-x64.zip'
      $base='https://nodejs.org/dist/v24.22.2/'
      $archivePath=Join-Path $toolDir $archiveName
      Write-Host 'Downloading a private Node.js 24 LTS toolchain. Global Node.js will not change.'
      $checks=(Invoke-WebRequest ($base+'SHASUMS256.txt') -UseBasicParsing).Content
      $line=($checks -split '\n' | Where-Object { $_.TrimEnd().EndsWith(' '+$archiveName) })
      if(-not $line){throw 'Official Node.js checksum is missing'}
      $expected=($line.Trim() -split '\s+')[0]
      Invoke-WebRequest ($base+$archiveName) -OutFile $archivePath -UseBasicParsing
      if((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLower() -ne $expected){throw 'Node.js SHA256 mismatch'}
      Expand-Archive -LiteralPath $archivePath -DestinationPath $toolDir -Force
      $nodeExecutable=Join-Path $toolDir 'node-v24.22.2-win-x64\node.exe'
    }
  }
  $nodeDir=Split-Path -Parent $nodeExecutable
  $env:Path="$nodeDir;$previousPath"
  $npmExecutable=Join-Path $nodeDir 'npm.cmd'
  Set-Location -LiteralPath $projectDir
  & $npmExecutable ci
  if($LASTEXITCODE -ne 0){throw 'npm ci failed'}
  if(-not $SkipCoreDownload -or -not (Test-Path -LiteralPath 'resources\xray\manifest.json') -or -not (Test-Path -LiteralPath 'resources\xray\wintun.dll')) {
    & $npmExecutable run fetch:core
    if($LASTEXITCODE -ne 0){throw 'Xray verification failed'}
  }
  & $npmExecutable test
  if($LASTEXITCODE -ne 0){throw 'Tests failed'}
  & $npmExecutable run pack
  if($LASTEXITCODE -ne 0){throw 'Packaging failed'}
  $package=Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
  Write-Host ('Ready: '+$package.build.directories.output+'\'+$package.productName+'-'+$package.version+'-Windows-x64.exe')
} finally {
  $env:Path=$previousPath
  Set-Location -LiteralPath $previousDirectory.Path
}
