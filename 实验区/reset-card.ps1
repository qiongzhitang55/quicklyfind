# Reset the lab card to a fresh copy of the pristine character sheet.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI,
# so a Chinese path literal here would be garbled. The pristine card is located
# at runtime instead of being hard-coded:
#   first choice = the baseline blank card (card\*v<major>.<minor>*.xlsx, newest
#   version by name) -- that is what "blank" means in this project;
#   fallback = the oldest .xlsx, for a workspace without a versioned template.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cardDir = 'D:\quicklyFind\card'
$target = Join-Path $root 'cards\miriel-lab.xlsx'

$pristine = Get-ChildItem -LiteralPath $cardDir -Filter '*.xlsx' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'v\d+\.\d+' -and $_.Name -notmatch 'DND|filled|lab|backup' } |
    Sort-Object Name -Descending |
    Select-Object -First 1

if (-not $pristine) {
    $pristine = Get-ChildItem -LiteralPath $cardDir -Filter '*.xlsx' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'filled|lab|backup' } |
        Sort-Object LastWriteTime |
        Select-Object -First 1
}

if (-not $pristine) {
    Write-Host "ERROR: no pristine card found in $cardDir"
    exit 1
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null

if (Test-Path -LiteralPath $target) {
    $bak = Join-Path $root ('cards\backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xlsx')
    Move-Item -LiteralPath $target -Destination $bak
    Write-Host "old lab card backed up: $bak"
}
Copy-Item -LiteralPath $pristine.FullName -Destination $target
Write-Host "source : $($pristine.FullName)"
Write-Host "lab    : $target"
Write-Host "pristine card was only read, never modified."
