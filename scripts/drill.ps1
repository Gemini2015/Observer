# Observer M1 验收脚本：启动真实 hub + agent，逐条断言 M1 的 9 项验收。
# 用法：pwsh ./scripts/drill.ps1 [-Port 8899] [-KeepData] [-SkipBuild]
param(
  [int]$Port = 8899,
  [switch]$KeepData,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$script:Failures = @()
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:Work = Join-Path $script:Root 'data\drill'
$script:Base = "http://127.0.0.1:$Port"
$script:Hubs = @()
$script:Agents = @()
$script:AgentIndex = 0

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) {
    Write-Host "[PASS] $Name" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] $Name $Detail" -ForegroundColor Red
    $script:Failures += $Name
  }
}

function Wait-Health {
  param([int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $null = Invoke-RestMethod "$script:Base/healthz" -TimeoutSec 2
      return $true
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  return $false
}

function Start-Hub {
  $env:OBSERVER_DATA_DIR = $script:Work
  $env:OBSERVER_PORT = "$Port"
  $env:OBSERVER_ADMIN_PASSWORD = 'drill-pass'
  $env:OBSERVER_LOG_LEVEL = 'warn'
  $log = Join-Path $script:Work 'hub.log'
  $process = Start-Process -FilePath 'node' -ArgumentList 'hub/dist/main.js' -WorkingDirectory $script:Root `
    -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $script:Hubs += $process.Id
  if (-not (Wait-Health)) {
    Write-Host (Get-Content "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 20)
    throw 'hub 启动失败'
  }
}

function Stop-Hub {
  foreach ($processId in $script:Hubs) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  $script:Hubs = @()
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 200
  }
}

function Start-Agent {
  $script:AgentIndex++
  $arguments = @('run', '-config', (Join-Path $script:Work 'agent.yaml'), '-interval', '2s')
  $log = Join-Path $script:Work "agent-$($script:AgentIndex).log"
  $process = Start-Process -FilePath (Join-Path $script:Root 'agent\bin\observer-agent.exe') `
    -ArgumentList $arguments -WorkingDirectory $script:Root -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $script:Agents += $process.Id
  Start-Sleep -Milliseconds 800
  if ($process.HasExited) {
    Write-Host "[agent] 启动后立即退出 code=$($process.ExitCode)" -ForegroundColor Yellow
    Get-Content "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 6 | ForEach-Object { Write-Host "  $_" }
  }
}

function Stop-Agents {
  foreach ($processId in $script:Agents) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  $script:Agents = @()
  Start-Sleep -Milliseconds 500
}

function Login {
  $response = Invoke-WebRequest -Method Post -Uri "$script:Base/api/v1/auth/login" `
    -ContentType 'application/json' -Body '{"password":"drill-pass"}' `
    -SessionVariable session -SkipHttpErrorCheck
  if ($response.StatusCode -ne 200) { throw "登录失败: $($response.StatusCode)" }
  return $session
}

function Trigger-Scan {
  param($Session, [int]$MountId, [string]$Mode)
  $response = Invoke-RestMethod -Method Post -Uri "$script:Base/api/v1/mounts/$MountId/scan" `
    -WebSession $Session -ContentType 'application/json' -Body (@{ mode = $Mode } | ConvertTo-Json)
  return [int]$response.job_id
}

function Wait-Job {
  param($Session, [int]$MountId, [int]$MinJobId, [int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $last = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts/$MountId" -WebSession $Session
      if ($last.last_job -and [int]$last.last_job.id -ge $MinJobId -and $last.last_job.status -in @('completed', 'failed')) {
        return $last
      }
    } catch {
      # hub 重启期间忽略
    }
    Start-Sleep -Milliseconds 500
  }
  return $last
}

function Get-Issues {
  param($Session, [string]$Status)
  return @(Invoke-RestMethod -Uri "$script:Base/api/v1/issues?status=$Status" -WebSession $Session)
}

function Get-Stats {
  param($Job)
  if (-not $Job -or -not $Job.stats_json) { return @{} }
  try { return ($Job.stats_json | ConvertFrom-Json) } catch { return @{} }
}

try {
  if ($PSVersionTable.PSLanguageMode -eq 'ConstrainedLanguage') {
    throw 'drill 需要 FullLanguage（当前为 ConstrainedLanguage）'
  }

  Write-Host "== Observer M1 drill ==" -ForegroundColor Cyan
  Write-Host "work dir: $script:Work"

  # ---------- 准备 ----------
  if (-not $SkipBuild) {
    Write-Host '构建 hub 与 agent ...'
    Push-Location $script:Root
    $null = pnpm --filter hub build 2>&1
    $env:PATH = "C:\Program Files\Go\bin;$env:PATH"
    Push-Location (Join-Path $script:Root 'agent')
    $null = go build -o bin/observer-agent.exe ./cmd/observer-agent 2>&1
    Pop-Location
    Pop-Location
  }
  if (-not (Test-Path 'hub\dist\main.js')) { throw '缺少 hub/dist/main.js，请先构建' }
  if (-not (Test-Path 'agent\bin\observer-agent.exe')) { throw '缺少 agent 二进制，请先构建' }

  Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $script:Work 'mount') | Out-Null
  $mountPath = Join-Path $script:Work 'mount'
  for ($i = 1; $i -le 1000; $i++) {
    $name = 'file{0:D4}.txt' -f $i
    Set-Content -Path (Join-Path $mountPath $name) -Value "content-$i" -NoNewline
  }
  Set-Content -Path (Join-Path $mountPath '.observer-mount') -Value 'mount_id=drill' -NoNewline

  $config = @"
agent:
  machine_id: drill-agent
  label: Drill Agent
  hub: http://127.0.0.1:$Port
  token_file: $($script:Work -replace '\\','/')/agent-token
mounts:
  - id: drill
    label: Drill
    path: $($mountPath -replace '\\','/')
    sentinel: .observer-mount
    fs_kind: local
    exclude: ["**/.observer-mount"]
"@
  Set-Content -Path (Join-Path $script:Work 'agent.yaml') -Value $config -Encoding UTF8

  Start-Hub
  Check '1. hub 启动且 /healthz 可用' ((Invoke-WebRequest "$script:Base/healthz" -SkipHttpErrorCheck).StatusCode -eq 200)

  $env:OBSERVER_DATA_DIR = $script:Work
  $tokenOutput = node hub/dist/cli/token.js 2>&1 | Out-String
  $match = [regex]::Match($tokenOutput, '(?m)^\s{2}([A-Za-z0-9_-]{30,})\s*$')
  if (-not $match.Success) { throw "创建注册 token 失败: $tokenOutput" }
  $env:OBSERVER_ENROLL_TOKEN = $match.Groups[1].Value

  Start-Agent
  $session = Login
  $mount = $null
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $mounts = @(Invoke-RestMethod -Uri "$script:Base/api/v1/mounts" -WebSession $session)
    if ($mounts.Count -gt 0) { $mount = $mounts[0]; break }
    Start-Sleep -Milliseconds 300
  }
  if (-not $mount) { throw 'agent 未注册出挂载点' }
  $mountId = [int]$mount.id
  Check '2. agent 注册成功且挂载点可见' ($mountId -gt 0)

  # ---------- 3. 基线 ----------
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'baseline'
  $detail = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId
  $stats = Get-Stats -Job $detail.last_job
  Check '3. 1000 文件基线扫描完成且覆盖率 100%' `
    ($detail.last_job.status -eq 'completed' -and $detail.coverage.total -eq 1000 -and $detail.coverage.ratio -eq 1 -and $stats.hashed -eq 1000) `
    "(status=$($detail.last_job.status) total=$($detail.coverage.total) hashed=$($stats.hashed))"

  # ---------- 4. 翻转字节且保持 mtime ----------
  $victim = Join-Path $mountPath 'file0001.txt'
  $bytes = [IO.File]::ReadAllBytes($victim)
  $mtime = [IO.File]::GetLastWriteTimeUtc($victim)
  $bytes[0] = $bytes[0] -bxor 0xFF
  [IO.File]::WriteAllBytes($victim, $bytes)
  [IO.File]::SetLastWriteTimeUtc($victim, $mtime)
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'full'
  $detail = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId
  $issues = Get-Issues -Session $session -Status 'open'
  $mismatch = $issues | Where-Object { $_.type -eq 'mismatch' -and $_.path_key -eq 'file0001.txt' -and $_.confidence -eq 'high' }
  Check '4. 翻转字节且保持 mtime 被 full 巡检发现（high）' ($null -ne $mismatch)

  # ---------- 5. 删除 -> missing；恢复 -> resolved ----------
  $deleted = Join-Path $mountPath 'file0002.txt'
  Remove-Item $deleted -Force
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'incremental'
  $null = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId
  $open = Get-Issues -Session $session -Status 'open'
  $missing = $open | Where-Object { $_.type -eq 'missing' -and $_.path_key -eq 'file0002.txt' }
  Set-Content -Path $deleted -Value 'content-2' -NoNewline
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'incremental'
  $null = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId
  $resolved = Get-Issues -Session $session -Status 'resolved'
  $recovered = $resolved | Where-Object { $_.type -eq 'missing' -and $_.path_key -eq 'file0002.txt' }
  Check '5. 删除文件生成 missing，恢复后自动关闭' (($null -ne $missing) -and ($null -ne $recovered))

  # ---------- 6. 扫描中重启 hub ----------
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'full'
  Start-Sleep -Seconds 1
  Stop-Hub
  Start-Sleep -Seconds 2
  Start-Hub
  $session = Login
  $detail = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId -TimeoutSeconds 180
  Check '6. 扫描中重启 hub 后任务恢复且路径总数不变' `
    ($detail.last_job.status -in @('completed', 'failed') -and $detail.coverage.total -eq 1000) `
    "(status=$($detail.last_job.status) total=$($detail.coverage.total))"

  # ---------- 7. hub 停机期间扫描结果进 spool 并补发 ----------
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'full'
  Start-Sleep -Milliseconds 800
  Stop-Hub
  Start-Sleep -Seconds 5
  Start-Hub
  $session = Login
  $detail = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId -TimeoutSeconds 180
  $spoolPath = Join-Path $script:Work 'spool.jsonl'
  $pending = 0
  if (Test-Path $spoolPath) {
    $pending = @(Get-Content $spoolPath | Where-Object { $_.Trim() -ne '' }).Count
  }
  Check '7. hub 停机期间结果落 spool，恢复后补发成功' `
    ($detail.last_job.status -in @('completed', 'failed') -and $pending -eq 0) `
    "(status=$($detail.last_job.status) spool_lines=$pending)"

  # ---------- 8. sentinel 缺失 -> unavailable，不产生成批 missing ----------
  $openBefore = (Get-Issues -Session $session -Status 'open').Count
  Rename-Item (Join-Path $mountPath '.observer-mount') '.observer-mount.bak'
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'incremental'
  $detail = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId
  $openAfter = (Get-Issues -Session $session -Status 'open').Count
  Rename-Item (Join-Path $mountPath '.observer-mount.bak') '.observer-mount'
  Check '8. sentinel 缺失时 mount 置 unavailable 且不产生成批 missing' `
    ($detail.state -eq 'unavailable' -and $openAfter -eq $openBefore) `
    "(state=$($detail.state) issues $openBefore->$openAfter)"

  # ---------- 9. 缓存丢失后从清单恢复 ----------
  Stop-Agents
  Remove-Item (Join-Path $script:Work 'state.db') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $script:Work 'state.db.lock') -Force -ErrorAction SilentlyContinue
  Start-Agent
  Start-Sleep -Seconds 3
  $jobId = Trigger-Scan -Session $session -MountId $mountId -Mode 'incremental'
  $detail = Wait-Job -Session $session -MountId $mountId -MinJobId $jobId
  $stats = Get-Stats -Job $detail.last_job
  $hashed = [int]$stats.hashed
  $seen = [int]$stats.seen
  Check '9. 缓存丢失后从清单恢复，不全量重算' `
    ($detail.last_job.status -eq 'completed' -and $seen -ge 1000 -and $hashed -le [math]::Floor($seen * 0.05)) `
    "(hashed=$hashed seen=$seen)"
}
catch {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  $script:Failures += 'unexpected error'
}
finally {
  Stop-Agents
  Stop-Hub
  if (-not $KeepData) {
    Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host ''
  if ($script:Failures.Count -eq 0) {
    Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green
    exit 0
  } else {
    Write-Host "FAILED: $($script:Failures -join ', ')" -ForegroundColor Red
    exit 1
  }
}
