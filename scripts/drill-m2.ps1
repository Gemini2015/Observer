# Observer M2 验收脚本：两台 agent、自动调度、离线标记、桌面客户端单实例。
# 用法：pwsh ./scripts/drill-m2.ps1 [-Port 8899] [-KeepData] [-SkipBuild]
param(
  [int]$Port = 8899,
  [switch]$KeepData,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:Work = Join-Path $script:Root 'data\drill-m2'
$script:Base = "http://127.0.0.1:$Port"
$script:Failures = @()
$script:HubPid = $null
$script:AgentPids = @()
$script:AgentIndex = 0
$script:GuiPid = $null

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
  $env:OBSERVER_ADMIN_PASSWORD = 'm2-pass'
  $env:OBSERVER_LOG_LEVEL = 'warn'
  $env:OBSERVER_SCHEDULER_ENABLED = 'true'
  $env:OBSERVER_SCHEDULER_INTERVAL_MS = '2000'
  $env:OBSERVER_OFFLINE_AFTER_SECONDS = '5'
  $log = Join-Path $script:Work 'hub.log'
  $process = Start-Process -FilePath 'node' -ArgumentList 'hub/dist/main.js' -WorkingDirectory $script:Root `
    -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $script:HubPid = $process.Id
  if (-not (Wait-Health)) {
    Write-Host (Get-Content "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 20)
    throw 'hub 启动失败'
  }
}

function Stop-Hub {
  if ($script:HubPid) { Stop-Process -Id $script:HubPid -Force -ErrorAction SilentlyContinue; $script:HubPid = $null }
  Start-Sleep -Milliseconds 400
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
  $script:AgentIndex++
  $env:OBSERVER_ENROLL_TOKEN = $EnrollToken
  $log = Join-Path $script:Work "agent-$($script:AgentIndex).log"
  $process = Start-Process -FilePath (Join-Path $script:Root 'agent\bin\observer-agent.exe') `
    -ArgumentList @('run', '-config', $ConfigPath, '-interval', '2s') -WorkingDirectory $script:Root `
    -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $script:AgentPids += $process.Id
}

function Stop-Agent {
  param([int]$Index)
  $pidValue = $script:AgentPids[$Index]
  if ($pidValue) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
}

function Stop-AllAgents {
  foreach ($pidValue in $script:AgentPids) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
  $script:AgentPids = @()
}

function Login {
  $response = Invoke-WebRequest -Method Post -Uri "$script:Base/api/v1/auth/login" `
    -ContentType 'application/json' -Body '{"password":"m2-pass"}' `
    -SessionVariable session -SkipHttpErrorCheck
  if ($response.StatusCode -ne 200) { throw "登录失败: $($response.StatusCode)" }
  return $session
}

function Get-Mounts {
  param($Session)
  $result = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts" -WebSession $Session
  if ($null -eq $result) { return }
  foreach ($item in $result) { $item }
}
function Get-Machines {
  param($Session)
  $result = Invoke-RestMethod -Uri "$script:Base/api/v1/machines" -WebSession $Session
  if ($null -eq $result) { return }
  foreach ($item in $result) { $item }
}

function Trigger-Scan {
  param($Session, [int]$MountId, [string]$Mode)
  $response = Invoke-RestMethod -Method Post -Uri "$script:Base/api/v1/mounts/$MountId/scan" `
    -WebSession $Session -ContentType 'application/json' -Body (@{ mode = $Mode } | ConvertTo-Json)
  return [int]$response.job_id
}

function Wait-Job {
  param($Session, [int]$MountId, [int]$JobId, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $detail = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts/$MountId" -WebSession $Session
    if ($detail.last_job -and [int]$detail.last_job.id -eq $JobId -and $detail.last_job.status -in @('completed', 'failed')) {
      return $detail
    }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

function Wait-NewJob {
  param($Session, [int]$MountId, [int]$AfterJobId, [int]$TimeoutSeconds = 150)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $detail = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts/$MountId" -WebSession $Session
    if ($detail.last_job -and [int]$detail.last_job.id -gt $AfterJobId -and $detail.last_job.status -in @('completed', 'failed')) {
      return $detail
    }
    Start-Sleep -Milliseconds 1000
  }
  return $null
}

try {
  Write-Host '== Observer M2 drill ==' -ForegroundColor Cyan
  Write-Host "work dir: $script:Work"

  if (-not $SkipBuild) {
    Write-Host '构建 hub / agent / desktop ...'
    $env:PATH = "C:\Program Files\Go\bin;$env:USERPROFILE\go\bin;$env:PATH"
    Push-Location $script:Root
    $null = pnpm --filter hub build 2>&1
    Push-Location (Join-Path $script:Root 'agent')
    $null = go build -o bin/observer-agent.exe ./cmd/observer-agent 2>&1
    Pop-Location
    Push-Location (Join-Path $script:Root 'agent\desktop')
    $null = wails3 build 2>&1
    Pop-Location
    Pop-Location
  }
  foreach ($required in @('hub\dist\main.js', 'agent\bin\observer-agent.exe', 'agent\desktop\bin\observer-agent-desktop.exe')) {
    if (-not (Test-Path (Join-Path $script:Root $required))) { throw "缺少构建产物: $required" }
  }

  # ---------- 环境 ----------
  Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($name in 'mount-a', 'mount-b', 'gui-mount') {
    New-Item -ItemType Directory -Force -Path (Join-Path $script:Work $name) | Out-Null
    Set-Content (Join-Path $script:Work "$name\.observer-mount") "mount_id=$name" -NoNewline
    foreach ($file in 'a.txt', 'b.txt', 'c.txt') {
      Set-Content (Join-Path $script:Work "$name\$file") "$name/$file" -NoNewline
    }
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
    schedule:
      window: "00:00-23:59"
      interval_minutes: 1
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
"@
  $guiConfig = @"
agent:
  machine_id: machine-gui
  hub: http://127.0.0.1:$Port
  token_file: $workForYaml/state-gui/token
mounts:
  - id: gui-mount
    path: $workForYaml/gui-mount
    sentinel: .observer-mount
"@
  Set-Content (Join-Path $script:Work 'agent-a.yaml') $agentA -Encoding UTF8
  Set-Content (Join-Path $script:Work 'agent-b.yaml') $agentB -Encoding UTF8
  Set-Content (Join-Path $script:Work 'gui.yaml') $guiConfig -Encoding UTF8

  Start-Hub
  $tokenA = New-EnrollToken
  $tokenB = New-EnrollToken
  $tokenGui = New-EnrollToken
  Start-Agent -ConfigPath (Join-Path $script:Work 'agent-a.yaml') -EnrollToken $tokenA
  Start-Agent -ConfigPath (Join-Path $script:Work 'agent-b.yaml') -EnrollToken $tokenB

  $session = Login
  $mounts = @()
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    $mounts = @(Get-Mounts -Session $session)
    if ($mounts.Count -ge 2) { break }
    Start-Sleep -Milliseconds 400
  }
  Check '1. 两台 agent 注册成功' ($mounts.Count -ge 2) "(mounts=$($mounts.Count))"
  $mountA = ($mounts | Where-Object { $_.mount_id -eq 'mount-a' })[0]
  $mountB = ($mounts | Where-Object { $_.mount_id -eq 'mount-b' })[0]
  if (-not $mountA -or -not $mountB) { throw '未找到 mount-a/mount-b' }

  # ---------- 并行基线 ----------
  $jobA = Trigger-Scan -Session $session -MountId $mountA.id -Mode 'baseline'
  $jobB = Trigger-Scan -Session $session -MountId $mountB.id -Mode 'baseline'
  $detailA = Wait-Job -Session $session -MountId $mountA.id -JobId $jobA
  $detailB = Wait-Job -Session $session -MountId $mountB.id -JobId $jobB
  Check '2. 两台机器并行完成基线巡检（覆盖率 100%）' `
    ($detailA -and $detailB -and $detailA.last_job.status -eq 'completed' -and $detailB.last_job.status -eq 'completed' -and `
     $detailA.coverage.ratio -eq 1 -and $detailB.coverage.ratio -eq 1) `
    "(A=$($detailA.last_job.status)/$($detailA.coverage.ratio) B=$($detailB.last_job.status)/$($detailB.coverage.ratio))"

  $machines = Get-Machines -Session $session
  Check '3. 机器列表显示两台在线' `
    ((@($machines | Where-Object { $_.machine_id -in @('machine-a', 'machine-b') -and $_.status -eq 'online' })).Count -eq 2) `
    "(machines=$($machines.Count))"

  # ---------- 桌面客户端 ----------
  $env:OBSERVER_ENROLL_TOKEN = $tokenGui
  $guiExe = Join-Path $script:Root 'agent\desktop\bin\observer-agent-desktop.exe'
  $guiArgs = @('-config', (Join-Path $script:Work 'gui.yaml'))
  $gui1 = Start-Process -FilePath $guiExe -ArgumentList $guiArgs -WorkingDirectory $script:Root -PassThru
  $script:GuiPid = $gui1.Id
  Start-Sleep -Seconds 6
  $gui1.Refresh()
  Check '4. 桌面客户端启动（窗口存在）' ((-not $gui1.HasExited) -and $gui1.MainWindowTitle -eq 'Observer Agent') "(alive=$(-not $gui1.HasExited) title=[$($gui1.MainWindowTitle)])"

  $gui2 = Start-Process -FilePath $guiExe -ArgumentList $guiArgs -WorkingDirectory $script:Root -PassThru
  Start-Sleep -Seconds 4
  $gui1.Refresh(); $gui2.Refresh()
  $guiRunning = @(Get-Process -Name observer-agent-desktop -ErrorAction SilentlyContinue)
  Check '5. 桌面客户端单实例' ($gui2.HasExited -and $guiRunning.Count -eq 1) "(second_exited=$($gui2.HasExited) running=$($guiRunning.Count))"
  Stop-Process -Id $gui1.Id -Force -ErrorAction SilentlyContinue
  $script:GuiPid = $null

  # ---------- 离线标记 ----------
  Stop-Agent -Index 1
  $deadline = (Get-Date).AddSeconds(40)
  $offline = $false
  while ((Get-Date) -lt $deadline) {
    $machines = Get-Machines -Session $session
    $machineB = ($machines | Where-Object { $_.machine_id -eq 'machine-b' })[0]
    if ($machineB -and $machineB.status -eq 'offline') { $offline = $true; break }
    Start-Sleep -Milliseconds 1000
  }
  Check '6. agent 心跳超时后机器标记 offline' $offline

  # ---------- 调度器自动派发 ----------
  $baselineJobA = [int]$detailA.last_job.id
  $scheduled = Wait-NewJob -Session $session -MountId $mountA.id -AfterJobId $baselineJobA -TimeoutSeconds 150
  Check '7. 调度器在窗口内自动派发新任务' `
    ($null -ne $scheduled -and $scheduled.last_job.mode -eq 'incremental') `
    "(job=$($scheduled.last_job.id) mode=$($scheduled.last_job.mode) status=$($scheduled.last_job.status))"


  # ---------- M1 回归 ----------
  Stop-AllAgents
  Stop-Hub
  $m1Log = Join-Path $script:Work 'm1-regression.log'
  $m1 = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoProfile', '-File', (Join-Path $script:Root 'scripts\drill.ps1'), '-Port', '8900', '-SkipBuild') -Wait -PassThru -RedirectStandardOutput $m1Log -RedirectStandardError "$m1Log.err"
  Check '8. M1 回归 drill 通过' ($m1.ExitCode -eq 0) "(exit=$($m1.ExitCode), log=$m1Log)"
}
catch {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  $script:Failures += 'unexpected error'
}
finally {
  if ($script:GuiPid) { Stop-Process -Id $script:GuiPid -Force -ErrorAction SilentlyContinue }
  Stop-AllAgents
  Stop-Hub
  if (-not $KeepData) { Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host ''
  if ($script:Failures.Count -eq 0) {
    Write-Host 'ALL M2 CHECKS PASSED' -ForegroundColor Green
    exit 0
  } else {
    Write-Host "FAILED: $($script:Failures -join ', ')" -ForegroundColor Red
    exit 1
  }
}
