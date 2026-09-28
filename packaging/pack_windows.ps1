# Assemble a self-contained, ready-to-zip Windows package for the desktop app.
#
#   powershell -ExecutionPolicy Bypass -File packaging\pack_windows.ps1
#
# Result:
#   <workspace>\<package name>\      <- double-click and run, move anywhere
#   <workspace>\<package name>.zip   <- hand this to other people
#
# Names come from packaging\names.txt (line 1: package folder, line 2: shell exe)
# so that this script itself stays pure ASCII -- Windows PowerShell 5.1 reads
# BOM-less script files as ANSI, and any non-ASCII byte here would come out garbled.
#
# names.txt lines:
#   1 package folder / zip base name
#   2 shell exe name (what users double-click)
#   3 doc file name copied into the package
#   4 browser-mode .bat name copied into the package
#   5 card template glob copied from card\ into the package
#     (only the current baseline template ships: bump this to
#      "空白卡vX.Y.Z.xlsx" whenever card\ gets a newer blank card --
#      quickref.exe picks the newest 空白卡*.xlsx it finds, but the
#      package should stay small; old templates are reference only)
#
# Switches:
#   -SkipServer   do not recompile quickref.exe (reuse the one already in the package folder)
#   -SkipShell    do not rebuild the Flutter shell
#   -NoVcRuntime  do not copy the Microsoft VC++ runtime next to the shell exe
#   -NoZip        leave the folder, skip the .zip

param(
    [switch]$SkipServer,
    [switch]$SkipShell,
    [switch]$NoVcRuntime,
    [switch]$NoZip
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$names = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'names.txt') -Encoding UTF8 |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($names.Count -lt 5) { throw 'packaging\names.txt must have 5 non-empty lines (see header comment)' }

$pkgName = $names[0]
$shellExe = $names[1]
$docName = $names[2]
$batName = $names[3]
$cardGlob = $names[4]
$stage = Join-Path $root $pkgName
$zipPath = Join-Path $root ($pkgName + '.zip')
$serverDir = Join-Path $root 'dnd_quickref'
$shellDir = Join-Path $root 'desktop_app'
$cacheDir = Join-Path $root '.pub-cache'

function Say([string]$msg) { Write-Host $msg }
function Ensure([string]$path, [string]$what) {
    if (-not (Test-Path -LiteralPath $path)) { throw "$what not found: $path" }
}

# Locate the newest x64 Microsoft.VC*.CRT redistributable folder shipped by a
# local Visual Studio install. Returns $null when there is none.
function Find-CrtDir {
    $search = New-Object System.Collections.Generic.List[string]
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        foreach ($i in @(& $vswhere -latest -products * -property installationPath 2>$null)) {
            if ($i) { $search.Add($i) }
        }
    }
    foreach ($base in @("$env:ProgramFiles\Microsoft Visual Studio", "${env:ProgramFiles(x86)}\Microsoft Visual Studio")) {
        if (Test-Path -LiteralPath $base) {
            Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { $search.Add($_.FullName) }
        }
    }
    if ($env:VCToolsRedistDir) { $search.Add($env:VCToolsRedistDir) }
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($s in $search) {
        if ((Split-Path -Leaf $s) -eq 'MSVC') { $redist = $s } else { $redist = Join-Path $s 'VC\Redist\MSVC' }
        if (-not (Test-Path -LiteralPath $redist)) { continue }
        foreach ($ver in (Get-ChildItem -LiteralPath $redist -Directory -ErrorAction SilentlyContinue)) {
            $x64 = Join-Path $ver.FullName 'x64'
            if (-not (Test-Path -LiteralPath $x64)) { continue }
            foreach ($crt in (Get-ChildItem -LiteralPath $x64 -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue)) {
                $candidates.Add($crt.FullName)
            }
        }
    }
    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Sort-Object | Select-Object -Last 1)
}

Say ''
Say "== 1/7 prepare =="
if (Test-Path -LiteralPath $stage) {
    # Only ever wipe a folder that looks like a package we made: it must contain
    # quickref.exe or the doc file, and it must not be the workspace root itself.
    $looksLikePackage = (Test-Path -LiteralPath (Join-Path $stage 'quickref.exe')) -or
                        (Test-Path -LiteralPath (Join-Path $stage $docName))
    if ((Test-Path -LiteralPath $stage -PathType Container) -eq $false) {
        throw "output path exists but is not a folder: $stage"
    }
    if (-not $looksLikePackage) {
        throw "refusing to delete $stage -- it does not look like a package (no quickref.exe / $docName). Move it away first."
    }
    if ([System.IO.Path]::GetFullPath($stage).TrimEnd('\') -eq [System.IO.Path]::GetFullPath($root).TrimEnd('\')) {
        throw 'refusing to delete the workspace root'
    }
    Say "   cleaning $stage"
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'card') | Out-Null
$env:PUB_CACHE = $cacheDir

Say ''
Say "== 2/7 server (dart compile exe) =="
if ($SkipServer) {
    Say '   skipped'
} else {
    Push-Location $serverDir
    try {
        & dart pub get
        if ($LASTEXITCODE -ne 0) { throw 'dart pub get failed' }
        & dart compile exe bin/quickref.dart -o (Join-Path $stage 'quickref.exe')
        if ($LASTEXITCODE -ne 0) { throw 'dart compile exe failed' }
    } finally {
        Pop-Location
    }
}
Ensure (Join-Path $stage 'quickref.exe') 'quickref.exe'

Say ''
Say "== 3/7 shell (flutter build windows --release) =="
if ($SkipShell) {
    Say '   skipped'
} else {
    Push-Location $shellDir
    try {
        & flutter pub get
        if ($LASTEXITCODE -ne 0) { throw 'flutter pub get failed' }
        & flutter build windows --release
        if ($LASTEXITCODE -ne 0) { throw 'flutter build windows failed' }
    } finally {
        Pop-Location
    }
}
$builtShell = Join-Path $shellDir 'build\windows\x64\runner\Release'
Ensure $builtShell 'flutter build output'

# Flutter's own exe gets renamed to the name users double-click
$builtExe = Get-ChildItem -LiteralPath $builtShell -Filter '*.exe' | Select-Object -First 1
if (-not $builtExe) { throw "no .exe in $builtShell" }
Copy-Item -LiteralPath $builtExe.FullName -Destination (Join-Path $stage $shellExe) -Force
foreach ($f in @('flutter_windows.dll', 'webview_windows_plugin.dll', 'WebView2Loader.dll')) {
    $src = Join-Path $builtShell $f
    Ensure $src $f
    Copy-Item -LiteralPath $src -Destination (Join-Path $stage $f) -Force
}
Copy-Item -LiteralPath (Join-Path $builtShell 'data') -Destination (Join-Path $stage 'data') -Recurse -Force

Say ''
Say "== 4/7 data: web / dnd-data / card =="
Copy-Item -LiteralPath (Join-Path $serverDir 'web') -Destination (Join-Path $stage 'web') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'dnd-data') -Destination (Join-Path $stage 'dnd-data') -Recurse -Force
foreach ($tpl in Get-ChildItem -LiteralPath (Join-Path $root 'card') -Filter '*.xlsx' -File) {
    if ($tpl.Name -like $cardGlob) {
        Copy-Item -LiteralPath $tpl.FullName -Destination (Join-Path $stage 'card') -Force
    }
}
Ensure (Join-Path $stage 'web\index.html') 'web\index.html'
Ensure (Join-Path $stage 'dnd-data\spells.json') 'dnd-data\spells.json'
$tplCount = (Get-ChildItem -LiteralPath (Join-Path $stage 'card') -File).Count
if ($tplCount -eq 0) { throw "no card template copied -- check line 5 of names.txt ($cardGlob)" }

Say ''
Say "== 5/7 VC++ runtime (app-local) =="
if ($NoVcRuntime) {
    Say '   skipped'
} else {
    # Flutter's release shell links the MSVC CRT dynamically. Copying those few
    # dlls next to the exe keeps the package runnable on a clean Windows box
    # that never had the "VC++ 2015-2022 redustributable" installed.
    $crtDir = Find-CrtDir
    if (-not $crtDir) {
        Say '   VC redist not found -- skipped (target machines may need to install it)'
    } else {
        $crtFiles = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll')
        $copied = 0
        foreach ($f in $crtFiles) {
            $src = Join-Path $crtDir $f
            if (Test-Path -LiteralPath $src) {
                Copy-Item -LiteralPath $src -Destination (Join-Path $stage $f) -Force
                $copied++
            }
        }
        Say "   copied $copied dll(s) from $crtDir"
    }
}

Say ''
Say "== 6/7 docs =="
Copy-Item -LiteralPath (Join-Path $PSScriptRoot $docName) -Destination (Join-Path $stage $docName) -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot $batName) -Destination (Join-Path $stage $batName) -Force

Say ''
Say "== 7/7 zip =="
if ($NoZip) {
    Say '   skipped'
} else {
    if (Test-Path -LiteralPath $zipPath) {
        $bak = "$zipPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Move-Item -LiteralPath $zipPath -Destination $bak
        Say "   old zip kept as $bak"
    }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
}

$files = Get-ChildItem -LiteralPath $stage -Recurse -File
$mb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
Say ''
Say "package : $stage"
Say "files   : $($files.Count)   $mb MB"
if (-not $NoZip) { Say "zip     : $zipPath" }
Say ''
