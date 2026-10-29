# Observer 扫描性能基准：真实 hub + agent，测基线/增量/全量扫描吞吐与 agent 内存峰值。
# 用法：pwsh ./scripts/bench.ps1 [-Port 8892] [-Files 2000] [-SizeBytes 4096] [-SkipBuild]
param(
  [int]$Port = 8892,
  [int]$Files = 2000,
  [int]$SizeBytes = 4096,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:Work = Join-Path $script:Root 'data\bench'
$script:Base = "http://127.0.0.1:$Port"
$script:HubPid = $null
$script:AgentPid = $null
$script:Failures = @()
$script:Results = @()

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) {
    Write-Host "[PASS] $Name $Detail" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] $Name $Detail" -ForegroundColor Red
    $script:Failures += $Name
  }
}

function Wait-Health {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    try { $null = Invoke-RestMethod "$script:Base/healthz" -TimeoutSec 2; return $true } catch { Start-Sleep -Milliseconds 300 }
  }
  return $false
}

function Start-Hub {
  $env:OBSERVER_DATA_DIR = $script:Work
  $env:OBSERVER_PORT = "$Port"
  $env:OBSERVER_ADMIN_PASSWORD = 'bench-pass'
  $env:OBSERVER_LOG_LEVEL = 'error'
  $env:OBSERVER_SCHEDULER_ENABLED = 'false'
  $log = Join-Path $script:Work 'hub.log'
  $script:HubPid = (Start-Process -FilePath 'node' -ArgumentList 'hub/dist/main.js' -WorkingDirectory $script:Root `
    -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err").Id
  if (-not (Wait-Health)) { throw 'hub 启动失败' }
}

function Login {
  $response = Invoke-WebRequest -Method Post -Uri "$script:Base/api/v1/auth/login" `
    -ContentType 'application/json' -Body '{"password":"bench-pass"}' `
    -SessionVariable session -SkipHttpErrorCheck
  if ($response.StatusCode -ne 200) { throw "登录失败: $($response.StatusCode)" }
  return $session
}

function Get-MountId {
  param($Session)
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    try {
      $result = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts" -WebSession $Session
      $mounts = @($result)
      if ($mounts.Count -ge 1) { return [int]$mounts[0].id }
    } catch { }
    Start-Sleep -Milliseconds 300
  }
  throw 'mount 未注册'
}

function Sample-Memory {
  if ($script:AgentPid) {
    try {
      $process = Get-Process -Id $script:AgentPid -ErrorAction Stop
      return $process.WorkingSet64
    } catch { }
  }
  return 0
}

function Run-Scan {
  param($Session, [int]$MountId, [string]$Mode)
  $job = Invoke-RestMethod -Method Post -Uri "$script:Base/api/v1/mounts/$MountId/scan" `
    -WebSession $Session -ContentType 'application/json' -Body (@{ mode = $Mode } | ConvertTo-Json)
  $jobId = [int]$job.job_id
  $maxMemory = 0
  $detail = $null
  $deadline = (Get-Date).AddSeconds(180)
  while ((Get-Date) -lt $deadline) {
    $sample = Sample-Memory
    if ($sample -gt $maxMemory) { $maxMemory = $sample }
    $detail = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts/$MountId" -WebSession $Session
    if ($detail.last_job -and [int]$detail.last_job.id -eq $jobId -and $detail.last_job.status -in @('completed', 'failed')) {
      break
    }
    Start-Sleep -Milliseconds 150
  }
  if (-not $detail -or -not $detail.last_job -or [int]$detail.last_job.id -ne $jobId) {
    throw "扫描任务 $jobId 未完成"
  }
  $result = Invoke-RestMethod -Uri "$script:Base/api/v1/jobs" -WebSession $Session
  $jobs = @($result)
  $finished = ($jobs | Where-Object { [int]$_.id -eq $jobId })[0]
  $stats = $finished.stats
  return @{
    mode     = $Mode
    job_id   = $jobId
    status   = $detail.last_job.status
    duration = [double]($stats.duration_ms) / 1000.0
    seen     = [int]$stats.seen
    hashed   = [int]$stats.hashed
    skipped  = [int]$stats.skipped
    bytes    = [int64]$stats.bytes_read
    max_rss  = [int64]$maxMemory
  }
}

try {
  Write-Host '== Observer 性能基准 ==' -ForegroundColor Cyan
  Write-Host "files=$Files size=$SizeBytes port=$Port"

  if (-not $SkipBuild) {
    $env:PATH = "C:\Program Files\Go\bin;$env:PATH"
    Push-Location $script:Root
    $null = pnpm --filter hub build 2>&1
    Push-Location (Join-Path $script:Root 'agent')
    $null = go build -o bin/observer-agent.exe ./cmd/observer-agent 2>&1
    Pop-Location
    Pop-Location
  }

  Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue
  $mountDir = Join-Path $script:Work 'mount'
  New-Item -ItemType Directory -Force -Path (Join-Path $mountDir 'data') | Out-Null
  Set-Content (Join-Path $mountDir '.observer-mount') 'mount_id=bench' -NoNewline
  $payload = [byte[]]::new($SizeBytes)
  $random = [System.Random]::new(42)
  $random.NextBytes($payload)
  for ($i = 0; $i -lt $Files; $i++) {
    $filePath = Join-Path (Join-Path $mountDir 'data') ("file-{0:d5}.bin" -f $i)
    [System.IO.File]::WriteAllBytes($filePath, $payload)
  }

  $workForYaml = $script:Work -replace '\\', '/'
  $config = @"
agent:
  machine_id: bench-machine
  hub: http://127.0.0.1:$Port
  token_file: $workForYaml/state/token
mounts:
  - id: bench
    path: $workForYaml/mount
    sentinel: .observer-mount
    exclude:
      - "**/.observer-mount"
    limits:
      bytes_per_sec: 209715200
      files_per_sec: 20000
"@
  Set-Content (Join-Path $script:Work 'agent.yaml') $config -Encoding UTF8

  Start-Hub
  $env:OBSERVER_DATA_DIR = $script:Work
  $output = node hub/dist/cli/token.js 2>&1 | Out-String
  $match = [regex]::Match($output, '(?m)^\s{2}([A-Za-z0-9_-]{30,})\s*$')
  if (-not $match.Success) { throw "创建 token 失败: $output" }
  $env:OBSERVER_ENROLL_TOKEN = $match.Groups[1].Value
  $agentLog = Join-Path $script:Work 'agent.log'
  $script:AgentPid = (Start-Process -FilePath (Join-Path $script:Root 'agent\bin\observer-agent.exe') `
    -ArgumentList @('run', '-config', (Join-Path $script:Work 'agent.yaml'), '-interval', '300ms') `
    -WorkingDirectory $script:Root -PassThru -RedirectStandardOutput $agentLog -RedirectStandardError "$agentLog.err").Id

  $session = Login
  $mountId = Get-MountId -Session $session

  $baseline = Run-Scan -Session $session -MountId $mountId -Mode 'baseline'
  $incremental = Run-Scan -Session $session -MountId $mountId -Mode 'incremental'
  $full = Run-Scan -Session $session -MountId $mountId -Mode 'full'

  $script:Results = @($baseline, $incremental, $full)

  Write-Host ''
  foreach ($result in $script:Results) {
    $rate = if ($result.duration -gt 0) { $result.seen / $result.duration } else { 0 }
    $mib = if ($result.duration -gt 0) { $result.bytes / $result.duration / 1MB } else { 0 }
    "{0,-12} duration={1,6:N2}s seen={2,5} hashed={3,5} skipped={4,5} throughput={5,8:N1} files/s {6,7:N1} MiB/s rss={7:N1} MiB" -f `
      $result.mode, $result.duration, $result.seen, $result.hashed, $result.skipped, $rate, $mib, ($result.max_rss / 1MB)
  }

  $baselineRate = if ($baseline.duration -gt 0) { $baseline.seen / $baseline.duration } else { 0 }
  $fullRate = if ($full.duration -gt 0) { $full.seen / $full.duration } else { 0 }
  $fullMib = if ($full.duration -gt 0) { $full.bytes / $full.duration / 1MB } else { 0 }
  $maxRssMb = [Math]::Round((($script:Results | Measure-Object -Property max_rss -Maximum).Maximum) / 1MB, 1)

  Check '基线扫描文件速率 ≥ 100 files/s' ($baselineRate -ge 100) "(rate=$([Math]::Round($baselineRate, 1)))"
  Check '全量扫描文件速率 ≥ 100 files/s' ($fullRate -ge 100) "(rate=$([Math]::Round($fullRate, 1)))"
  $mibThreshold = if ($SizeBytes -ge 65536) { 20 } else { 0.5 }
  Check ("全量扫描吞吐 ≥ {0} MiB/s" -f $mibThreshold) ($fullMib -ge $mibThreshold) "(mib=$([Math]::Round($fullMib, 1)))"
  Check 'agent 内存峰值 ≤ 256 MiB' ($maxRssMb -le 256) "(rss=${maxRssMb}MiB)"
  Check '增量扫描跳过未变化文件' ($incremental.skipped -ge $Files -and $incremental.hashed -eq 0) `
    "(skipped=$($incremental.skipped) hashed=$($incremental.hashed))"
}
catch {
  $line = $_.InvocationInfo.ScriptLineNumber
  $text = $_.InvocationInfo.Line.Trim()
  Write-Host ("[ERROR] {0} at line {1}: {2}" -f $_.Exception.Message, $line, $text) -ForegroundColor Red
  $script:Failures += 'unexpected error'
}
finally {
  if ($script:AgentPid) { Stop-Process -Id $script:AgentPid -Force -ErrorAction SilentlyContinue }
  if ($script:HubPid) { Stop-Process -Id $script:HubPid -Force -ErrorAction SilentlyContinue }
  Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ''
  if ($script:Failures.Count -eq 0) {
    Write-Host 'BENCH PASSED' -ForegroundColor Green
    exit 0
  } else {
    Write-Host "BENCH FAILED: $($script:Failures -join ', ')" -ForegroundColor Red
    exit 1
  }
}
