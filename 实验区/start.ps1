# D&D spell quickref filler - launcher
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI,
# so any non-ASCII here would be garbled. All paths come from $PSScriptRoot.

$ErrorActionPreference = 'Stop'

$env:PUB_CACHE = 'D:\quicklyFind\.pub-cache'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out 'start.log'

try { Start-Transcript -Path $log -Force | Out-Null } catch { }

try {
    $dart = (Get-Command dart -ErrorAction SilentlyContinue).Source
    if (-not $dart) { $dart = 'C:\flutter\bin\cache\dart-sdk\bin\dart.exe' }
    if (-not (Test-Path $dart)) { throw "dart not found. Install Flutter/Dart SDK first." }

    Write-Host "app   : D:\quicklyFind\dnd_quickref"
    Write-Host "data  : D:\quicklyFind\dnd-data"
    Write-Host "table : whatever you picked last in the UI (see .quickref.json)"
    Write-Host "log   : $log"
    Write-Host ""
    Write-Host "Tips: pick your sheet with the buttons at the bottom of the right pane."
    Write-Host ""

    Set-Location 'D:\quicklyFind\dnd_quickref'
    & $dart run bin/quickref.dart
    Write-Host ""
    Write-Host ("server exited with code " + $LASTEXITCODE)
}
catch {
    Write-Host ""
    Write-Host "=========== FAILED ==========="
    Write-Host $_.Exception.Message
    Write-Host "log: $log"
    Write-Host "=============================="
}
finally {
    try { Stop-Transcript | Out-Null } catch { }
}
