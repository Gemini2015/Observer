# Observer M3 验收脚本：从健康副本跨机修复损坏文件。
# 用法：pwsh ./scripts/drill-m3.ps1 [-Port 8899] [-KeepData] [-SkipBuild]
param(
  [int]$Port = 8899,
  [switch]$KeepData,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:Work = Join-Path $script:Root 'data\drill-m3'
$script:Base = "http://127.0.0.1:$Port"
$script:Failures = @()
$script:HubPid = $null
$script:AgentPids = @()
$script:Original = 'observer-m3-original-content'
$script:Corrupted = 'observer-m3-corrupted-content!'

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
    try { $null = Invoke-RestMethod "$script:Base/healthz" -TimeoutSec 2; return $true } catch { Start-Sleep -Milliseconds 300 }
  }
  return $false
}

function Start-Hub {
  $env:OBSERVER_DATA_DIR = $script:Work
  $env:OBSERVER_PORT = "$Port"
  $env:OBSERVER_ADMIN_PASSWORD = 'm3-pass'
  $env:OBSERVER_LOG_LEVEL = 'warn'
  $env:OBSERVER_SCHEDULER_ENABLED = 'false'
  $log = Join-Path $script:Work 'hub.log'
  $script:HubPid = (Start-Process -FilePath 'node' -ArgumentList 'hub/dist/main.js' -WorkingDirectory $script:Root `
    -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err").Id
  if (-not (Wait-Health)) {
    Write-Host (Get-Content "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 20)
    throw 'hub 启动失败'
  }
}

function Stop-AllAgents {
  foreach ($processId in $script:AgentPids) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
  $script:AgentPids = @()
}

function Stop-Hub {
  if ($script:HubPid) { Stop-Process -Id $script:HubPid -Force -ErrorAction SilentlyContinue; $script:HubPid = $null }
}

function New-EnrollToken {
  $env:OBSERVER_DATA_DIR = $script:Work
  $output = node hub/dist/cli/token.js 2>&1 | Out-String
  $match = [regex]::Match($output, '(?m)^\s{2}([A-Za-z0-9_-]{30,})\s*$')
  if (-not $match.Success) { throw "创建注册 token 失败: $output" }
  return $match.Groups[1].Value
}

function Start-Agent {
  param([string]$ConfigPath, [string]$EnrollToken)
  $env:OBSERVER_ENROLL_TOKEN = $EnrollToken
  $log = Join-Path $script:Work ("agent-" + $script:AgentPids.Count + ".log")
  $process = Start-Process -FilePath (Join-Path $script:Root 'agent\bin\observer-agent.exe') `
    -ArgumentList @('run', '-config', $ConfigPath, '-interval', '1s') -WorkingDirectory $script:Root `
    -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $script:AgentPids += $process.Id
}

function Login {
  $response = Invoke-WebRequest -Method Post -Uri "$script:Base/api/v1/auth/login" `
    -ContentType 'application/json' -Body '{"password":"m3-pass"}' `
    -SessionVariable session -SkipHttpErrorCheck
  if ($response.StatusCode -ne 200) { throw "登录失败: $($response.StatusCode)" }
  return $session
}

function Get-Json {
  param($Session, [string]$Path)
  $result = Invoke-RestMethod -Uri "$script:Base$Path" -WebSession $Session
  if ($null -eq $result) { return }
  foreach ($item in $result) { $item }
}

function Wait-JobDone {
  param($Session, [int]$MountId, [int]$JobId, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $detail = Get-Json -Session $Session -Path "/api/v1/mounts/$MountId"
    if ($detail.last_job -and [int]$detail.last_job.id -eq $JobId -and $detail.last_job.status -in @('completed', 'failed')) {
      return $detail
    }
    Start-Sleep -Milliseconds 300
  }
  return $null
}

function Trigger-Scan {
  param($Session, [int]$MountId, [string]$Mode)
  $response = Invoke-RestMethod -Method Post -Uri "$script:Base/api/v1/mounts/$MountId/scan" `
    -WebSession $Session -ContentType 'application/json' -Body (@{ mode = $Mode } | ConvertTo-Json)
  return [int]$response.job_id
}

try {
  Write-Host '== Observer M3 drill ==' -ForegroundColor Cyan
  Write-Host "work dir: $script:Work"

  if (-not $SkipBuild) {
    Write-Host '构建 hub / agent ...'
    $env:PATH = "C:\Program Files\Go\bin;$env:PATH"
    Push-Location $script:Root
    $null = pnpm --filter hub build 2>&1
    Push-Location (Join-Path $script:Root 'agent')
    $null = go build -o bin/observer-agent.exe ./cmd/observer-agent 2>&1
    Pop-Location
    Pop-Location
  }
  foreach ($required in @('hub\dist\main.js', 'agent\bin\observer-agent.exe')) {
    if (-not (Test-Path (Join-Path $script:Root $required))) { throw "缺少构建产物: $required" }
  }

  Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($name in 'mount-a', 'mount-b') {
    New-Item -ItemType Directory -Force -Path (Join-Path $script:Work $name) | Out-Null
    Set-Content (Join-Path $script:Work "$name\.observer-mount") "mount_id=$name" -NoNewline
    Set-Content (Join-Path $script:Work "$name\shared.txt") $script:Original -NoNewline
  }

  $workForYaml = $script:Work -replace '\\', '/'
  $agentA = @"
agent:
  machine_id: machine-a
  hub: http://127.0.0.1:$Port
  token_file: $workForYaml/state-a/token
mounts:
  - id: mount-a
    path: $workForYaml/mount-a
    sentinel: .observer-mount
    repair_allowed: true
    exclude:
      - "**/.observer-mount"
      - "**/.observer-quarantine/**"
"@
  $agentB = @"
agent:
  machine_id: machine-b
  hub: http://127.0.0.1:$Port
  token_file: $workForYaml/state-b/token
mounts:
  - id: mount-b
    path: $workForYaml/mount-b
    sentinel: .observer-mount
    repair_allowed: true
    exclude:
      - "**/.observer-mount"
      - "**/.observer-quarantine/**"
"@
  Set-Content (Join-Path $script:Work 'agent-a.yaml') $agentA -Encoding UTF8
  Set-Content (Join-Path $script:Work 'agent-b.yaml') $agentB -Encoding UTF8

  Start-Hub
  $tokenA = New-EnrollToken
  $tokenB = New-EnrollToken
  Start-Agent -ConfigPath (Join-Path $script:Work 'agent-a.yaml') -EnrollToken $tokenA
  Start-Agent -ConfigPath (Join-Path $script:Work 'agent-b.yaml') -EnrollToken $tokenB

  $session = Login
  $mounts = @()
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    $mounts = @(Get-Json -Session $session -Path '/api/v1/mounts')
    if ($mounts.Count -ge 2) { break }
    Start-Sleep -Milliseconds 300
  }
  Check '1. 两台 agent 注册成功' ($mounts.Count -ge 2) "(mounts=$($mounts.Count))"
  $mountA = ($mounts | Where-Object { $_.mount_id -eq 'mount-a' })[0]
  $mountB = ($mounts | Where-Object { $_.mount_id -eq 'mount-b' })[0]
  if (-not $mountA -or -not $mountB) { throw '未找到 mount-a/mount-b' }

  $jobA = Trigger-Scan -Session $session -MountId $mountA.id -Mode 'baseline'
  $jobB = Trigger-Scan -Session $session -MountId $mountB.id -Mode 'baseline'
  $detailA = Wait-JobDone -Session $session -MountId $mountA.id -JobId $jobA
  $detailB = Wait-JobDone -Session $session -MountId $mountB.id -JobId $jobB
  Check '2. 源/目标基线一致（覆盖率 100%）' `
    ($detailA -and $detailB -and $detailA.last_job.status -eq 'completed' -and $detailB.last_job.status -eq 'completed' -and `
     $detailB.coverage.ratio -eq 1) `
    "(A=$($detailA.coverage.ratio) B=$($detailB.coverage.ratio))"

  Set-Content (Join-Path $script:Work 'mount-b\shared.txt') $script:Corrupted -NoNewline
  $scanJob = Trigger-Scan -Session $session -MountId $mountB.id -Mode 'full'
  $null = Wait-JobDone -Session $session -MountId $mountB.id -JobId $scanJob

  $issues = @(Get-Json -Session $session -Path '/api/v1/issues?status=open')
  $issue = ($issues | Where-Object { $_.machine_id -eq 'machine-b' })[0]
  Check '3. 篡改后被 full 巡检发现（mismatch）' ($issue -and $issue.type -eq 'mismatch') "(issue=$($issue.id))"

  $detail = Get-Json -Session $session -Path "/api/v1/issues/$($issue.id)"
  $replicas = Get-Json -Session $session -Path "/api/v1/issues/$($issue.id)/replicas"
  $source = @($replicas.replicas)[0]
  Check '4. 副本查询命中健康源' `
    ($replicas.repair_allowed -and $source -and $source.machine_id -eq 'machine-a' -and $source.path_key -eq 'shared.txt') `
    "(source=$($source.machine_id)/$($source.path_key))"

  $repairResponse = Invoke-RestMethod -Method Post -Uri "$script:Base/api/v1/issues/$($issue.id)/repair" `
    -WebSession $session -ContentType 'application/json' -Body (@{ source_path_id = [int]$source.path_id } | ConvertTo-Json)
  $repairId = [int]$repairResponse.repair_id

  $repair = $null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $repair = Get-Json -Session $session -Path "/api/v1/repairs/$repairId"
    if ($repair.status -in @('completed', 'failed', 'canceled')) { break }
    Start-Sleep -Milliseconds 500
  }
  Check '5. 跨机修复完成（源上传 → 目标替换）' ($repair -and $repair.status -eq 'completed') "(status=$($repair.status) error=$($repair.error))"

  $restored = (Get-Content (Join-Path $script:Work 'mount-b\shared.txt') -Raw).TrimEnd("`r", "`n")
  Check '6. 目标文件内容恢复为原始值' ($restored -eq $script:Original)
  $restoredHash = (Get-FileHash (Join-Path $script:Work 'mount-b\shared.txt') -Algorithm SHA256).Hash.ToLower()
  Check '7. 恢复后哈希 = 期望哈希' ($restoredHash -eq $replicas.expected_hash) "(actual=$restoredHash expected=$($replicas.expected_hash))"

  $issueAfter = Get-Json -Session $session -Path "/api/v1/issues/$($issue.id)"
  Check '8. 异常自动关闭（resolved）' ($issueAfter.status -eq 'resolved')

  $quarantineFiles = @(Get-ChildItem (Join-Path $script:Work 'mount-b\.observer-quarantine') -Recurse -File -ErrorAction SilentlyContinue)
  $quarantineOk = $false
  if ($quarantineFiles.Count -ge 1) {
    $quarantined = (Get-Content $quarantineFiles[0].FullName -Raw).TrimEnd("`r", "`n")
    $quarantineOk = $quarantined -eq $script:Corrupted
  }
  Check '9. 被篡改的原文件进入 quarantine' $quarantineOk "(files=$($quarantineFiles.Count))"

  $audit = @(Get-Json -Session $session -Path '/api/v1/audit?limit=200')
  $actions = @($audit | ForEach-Object { $_.action })
  Check '10. 审计记录覆盖创建/上传/完成' `
    ($actions -contains 'repair.create' -and $actions -contains 'transfer.ready' -and $actions -contains 'repair.complete') `
    "(actions=$($actions -join ','))"
}
catch {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  $script:Failures += 'unexpected error'
}
finally {
  Stop-AllAgents
  Stop-Hub
  if (-not $KeepData) { Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host ''
  if ($script:Failures.Count -eq 0) {
    Write-Host 'ALL M3 CHECKS PASSED' -ForegroundColor Green
    exit 0
  } else {
    Write-Host "FAILED: $($script:Failures -join ', ')" -ForegroundColor Red
    exit 1
  }
}
