# 交叉编译 Linux agent 并验证（可在 Windows 上运行）。
param(
  [string]$Output = 'dist/linux'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir = Join-Path $root $Output
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$env:PATH = "C:\Program Files\Go\bin;$env:PATH"
$env:CGO_ENABLED = '0'

Push-Location (Join-Path $root 'agent')
try {
  foreach ($arch in @('amd64', 'arm64')) {
    $target = Join-Path $outDir "observer-agent-linux-$arch"
    $env:GOOS = 'linux'
    $env:GOARCH = $arch
    go build -trimpath -ldflags='-s -w' -o $target ./cmd/observer-agent
    $bytes = (Get-Item $target).Length
    $magic = [System.IO.File]::ReadAllBytes($target)[0..3] -join ','
    $isElf = ($magic -eq '127,69,76,70')
    "{0,-28} size={1:N1} MiB elf={2}" -f "observer-agent-linux-$arch", ($bytes / 1MB), $isElf
    if (-not $isElf) { throw "不是 ELF 文件: $target" }
  }
}
finally {
  Remove-Item Env:GOOS -ErrorAction SilentlyContinue
  Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
  Pop-Location
}
