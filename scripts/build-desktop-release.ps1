#!/usr/bin/env pwsh
# 构建 Observer Agent Windows 桌面端（Wails v3）发布产物。
#
# 用法（Windows）：
#   pwsh scripts/build-desktop-release.ps1 -Version 1.2.0
#   pwsh scripts/build-desktop-release.ps1 -Version 1.2.0 -OutDir dist/release
#
# 产物：<OutDir>/observer-agent-desktop_<version>_windows_amd64.zip
#       <OutDir>/observer-agent-desktop_<version>_windows_amd64.zip.sha256
#
# 环境要求：Windows x64、Go（见 agent/desktop/go.mod）、Node.js 20.19+/22.12+、
#           wails3 v3.0.0（go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0）。
#
# 说明：本脚本只做 Windows 原生构建；CI 使用 .github/workflows/release.yml 的 desktop job。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$OutDir = "dist/release",
    [switch]$SkipFrontend,
    [switch]$SkipSyso
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments
        $code = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($code -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $code"
    }
}

function Restore-EnvironmentVariable {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][string]$Value
    )
    if ([string]::IsNullOrEmpty($Value)) {
        Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
    else {
        Set-Item -LiteralPath "Env:$Name" -Value $Value
    }
}

function Assert-GuiExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -lt 5MB) {
        throw "built executable is too small ($($file.Length) bytes): $Path"
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 1024 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw "not a PE executable: $Path"
    }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -le 0 -or ($peOffset + 24 + 70) -ge $bytes.Length) {
        throw "invalid PE header offset in $Path"
    }
    if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45) {
        throw "missing PE signature in $Path"
    }
    $magic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
    if ($magic -ne 0x20B) {
        throw ("unexpected PE optional header magic 0x{0:X} in {1} (want PE32+)" -f $magic, $Path)
    }
    $subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68)
    if ($subsystem -ne 2) {
        throw "PE subsystem is $subsystem in $Path, want 2 (WINDOWS_GUI); check -H windowsgui"
    }
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    if (-not $text.Contains($ExpectedVersion)) {
        throw "version string '$ExpectedVersion' not found in $Path (check -X observer/agent/internal/version.Version)"
    }
}

function Assert-ZipContent {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string[]]$ExpectedEntries
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    }
    finally {
        $archive.Dispose()
    }
    foreach ($expected in $ExpectedEntries) {
        if ($entries -notcontains $expected) {
            throw "zip $ZipPath missing entry '$expected' (entries: $($entries -join ', '))"
        }
    }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "build-desktop-release.ps1 must run on Windows (use GitHub Actions windows-latest or a Windows machine)"
}

$Version = $Version -replace '^[vV]', ''
$versionPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
if ($Version -notmatch $versionPattern) {
    throw "invalid version '$Version' (want 1.2.0 or 1.2.0-rc.1)"
}

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$desktopDir = Join-Path $root "agent/desktop"
$frontendDir = Join-Path $desktopDir "frontend"
$buildDir = Join-Path $desktopDir "build"
$infoTemplate = Join-Path $buildDir "windows/info.json"
$iconPath = Join-Path $buildDir "windows/icon.ico"
$manifestPath = Join-Path $buildDir "windows/wails.exe.manifest"
$desktopReadme = Join-Path $root "deploy/agent-desktop-README.txt"
$sysoPath = Join-Path $desktopDir "wails_windows_amd64.syso"
$stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("observer-desktop-" + [Guid]::NewGuid().ToString("N"))
$outputDir = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
$zipPath = Join-Path $outputDir "observer-agent-desktop_${Version}_windows_amd64.zip"
$exePath = Join-Path $stagingDir "observer-agent-desktop.exe"
$tempInfo = $null

foreach ($path in @($desktopDir, $frontendDir, $infoTemplate, $iconPath, $manifestPath, $desktopReadme)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "missing required path: $path"
    }
}
foreach ($tool in @("go", "npm", "wails3")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "missing required tool '$tool' (install Go, Node.js and wails3 v3.0.0)"
    }
}

New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$savedGoos = $env:GOOS
$savedGoarch = $env:GOARCH
$savedCgo = $env:CGO_ENABLED

try {
    Write-Host "==> observer-agent-desktop ${Version}"
    Invoke-Native -FilePath "go" -Arguments @("mod", "download") -WorkingDirectory $desktopDir

    if (-not $SkipFrontend) {
        Invoke-Native -FilePath "npm" -Arguments @("ci", "--include=dev", "--no-audit", "--no-fund") -WorkingDirectory $frontendDir
        Invoke-Native -FilePath "wails3" -Arguments @("generate", "bindings", "-f", "-tags production", "-clean=true", "-time-type=Date") -WorkingDirectory $desktopDir
        Invoke-Native -FilePath "npm" -Arguments @("run", "build") -WorkingDirectory $frontendDir
    }
    $distIndex = Join-Path $frontendDir "dist/index.html"
    if (-not (Test-Path -LiteralPath $distIndex)) {
        throw "missing frontend build output: $distIndex (run without -SkipFrontend)"
    }

    if (-not $SkipSyso) {
        $tempInfo = Join-Path ([System.IO.Path]::GetTempPath()) ("observer-desktop-info-" + [Guid]::NewGuid().ToString("N") + ".json")
        $info = Get-Content -LiteralPath $infoTemplate -Raw | ConvertFrom-Json
        # Windows 文件版本资源只接受数字段（如 1.2.0）；预发布后缀只写进 ProductVersion 与 ldflags。
        $numericVersion = $Version.Split('-')[0]
        $info.fixed.file_version = $numericVersion
        $info.info.'0409'.ProductVersion = $Version
        $json = $info | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($tempInfo, $json, (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Native -FilePath "wails3" -Arguments @(
            "generate", "syso",
            "-arch", "amd64",
            "-icon", "windows/icon.ico",
            "-manifest", "windows/wails.exe.manifest",
            "-info", $tempInfo,
            "-out", "../wails_windows_amd64.syso"
        ) -WorkingDirectory $buildDir
    }

    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    $env:CGO_ENABLED = "0"
    $ldflags = "-s -w -H windowsgui -X observer/agent/internal/version.Version=$Version"
    Invoke-Native -FilePath "go" -Arguments @(
        "build",
        "-tags", "production",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags", $ldflags,
        "-o", $exePath,
        "."
    ) -WorkingDirectory $desktopDir

    Assert-GuiExecutable -Path $exePath -ExpectedVersion $Version

    Copy-Item -LiteralPath $desktopReadme -Destination (Join-Path $stagingDir "README-WINDOWS.txt")
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stagingDir,
        $zipPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    Assert-ZipContent -ZipPath $zipPath -ExpectedEntries @("observer-agent-desktop.exe", "README-WINDOWS.txt")

    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $shaPath = "${zipPath}.sha256"
    $shaLine = "$hash  $([System.IO.Path]::GetFileName($zipPath))`n"
    [System.IO.File]::WriteAllText($shaPath, $shaLine, [System.Text.Encoding]::ASCII)

    Write-Host "==> $(Split-Path -Leaf $zipPath)"
    Write-Host "    $((Get-Item -LiteralPath $zipPath).Length) bytes"
    Write-Host "    sha256 $(Split-Path -Leaf $shaPath)"
    Write-Host "    output $outputDir"
}
finally {
    Restore-EnvironmentVariable -Name "GOOS" -Value $savedGoos
    Restore-EnvironmentVariable -Name "GOARCH" -Value $savedGoarch
    Restore-EnvironmentVariable -Name "CGO_ENABLED" -Value $savedCgo
    Remove-Item -LiteralPath $sysoPath -Force -ErrorAction SilentlyContinue
    if ($tempInfo) {
        Remove-Item -LiteralPath $tempInfo -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
}
