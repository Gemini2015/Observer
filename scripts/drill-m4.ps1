# Observer M4 验收脚本：部署产物、Linux 交叉编译、告警聚合、性能、回归。
# 用法：pwsh ./scripts/drill-m4.ps1 [-SkipBuild] [-RunRegression]
param(
  [switch]$SkipBuild,
  [switch]$RunRegression
)

$ErrorActionPreference = 'Stop'
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:Work = Join-Path $script:Root 'data\drill-m4'
$script:Port = 8893
$script:Base = "http://127.0.0.1:$script:Port"
$script:Failures = @()
$script:HubPid = $null
$script:AgentPid = $null

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) {
    Write-Host "[PASS] $Name $Detail" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] $Name $Detail" -ForegroundColor Red
    $script:Failures += $Name
  }
}

function Skip {
  param([string]$Name, [string]$Reason)
  Write-Host "[SKIP] $Name ($Reason)" -ForegroundColor Yellow
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
  $env:OBSERVER_PORT = "$script:Port"
  $env:OBSERVER_ADMIN_PASSWORD = 'm4-pass'
  $env:OBSERVER_LOG_LEVEL = 'error'
  $env:OBSERVER_SCHEDULER_ENABLED = 'false'
  $log = Join-Path $script:Work 'hub.log'
  $script:HubPid = (Start-Process -FilePath 'node' -ArgumentList 'hub/dist/main.js' -WorkingDirectory $script:Root `
    -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err").Id
  if (-not (Wait-Health)) { throw 'hub 启动失败' }
}

function Login {
  $response = Invoke-WebRequest -Method Post -Uri "$script:Base/api/v1/auth/login" `
    -ContentType 'application/json' -Body '{"password":"m4-pass"}' `
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
  param($Session, [int]$MountId, [int]$JobId, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $detail = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts/$MountId" -WebSession $Session
    if ($detail.last_job -and [int]$detail.last_job.id -eq $JobId -and $detail.last_job.status -in @('completed', 'failed')) {
      return $detail
    }
    Start-Sleep -Milliseconds 300
  }
  return $null
}

try {
  Write-Host '== Observer M4 drill ==' -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path (Join-Path $script:Root 'data') | Out-Null

  # 1. 部署产物
  $artifacts = @(
    'deploy\Dockerfile.hub',
    'deploy\Dockerfile.agent',
    'deploy\docker-compose.yml',
    'deploy\observer-agent.service',
    'deploy\agent.example.yaml',
    'deploy\build-linux.ps1',
    'deploy\README.md',
    'docs\DEPLOY.md'
  )
  $missing = @($artifacts | Where-Object { -not (Test-Path (Join-Path $script:Root $_)) })
  Check '1. 部署产物齐全' ($missing.Count -eq 0) "missing=$($missing -join ',')"

  # 2. 关键指令
  $dockerfileAgent = Get-Content (Join-Path $script:Root 'deploy\Dockerfile.agent') -Raw
  $compose = Get-Content (Join-Path $script:Root 'deploy\docker-compose.yml') -Raw
  $service = Get-Content (Join-Path $script:Root 'deploy\observer-agent.service') -Raw
  $staticOk =
    ($dockerfileAgent -match 'CGO_ENABLED=0') -and
    ($dockerfileAgent -match 'distroless') -and
    ($compose -match 'read_only:\s*true') -and
    ($compose -match 'observer-agent-state') -and
    ($service -match 'Restart=on-failure') -and
    ($service -match 'ProtectSystem=strict') -and
    ($service -match 'ReadWritePaths=/var/lib/observer')
  Check '2. Dockerfile/compose/systemd 关键配置正确' $staticOk

  # 3. Linux 交叉编译
  if (-not $SkipBuild) {
    Write-Host '交叉编译 Linux agent ...'
    $output = pwsh -NoProfile -File (Join-Path $script:Root 'deploy\build-linux.ps1') 2>&1 | Out-String
    Write-Host $output.Trim()
  }
  $linuxOk = $true
  foreach ($arch in @('amd64', 'arm64')) {
    $binary = Join-Path $script:Root "dist\linux\observer-agent-linux-$arch"
    if (-not (Test-Path $binary)) { $linuxOk = $false; continue }
    $bytes = (Get-Item $binary).Length
    $magic = [System.IO.File]::ReadAllBytes($binary)[0..3] -join ','
    if ($magic -ne '127,69,76,70') { $linuxOk = $false }
    if ($bytes -gt 30MB) { $linuxOk = $false }
  }
  Check '3. Linux amd64/arm64 交叉编译且为 ELF（≤30MB）' $linuxOk

  # 4. Windows 构建产物
  $agentExe = Join-Path $script:Root 'agent\bin\observer-agent.exe'
  $desktopExe = Join-Path $script:Root 'agent\desktop\bin\observer-agent-desktop.exe'
  if (-not $SkipBuild) {
    Write-Host '构建 hub / agent ...'
    Push-Location $script:Root
    $null = pnpm --filter hub build 2>&1
    Pop-Location
    $env:PATH = "C:\Program Files\Go\bin;$env:PATH"
    Push-Location (Join-Path $script:Root 'agent')
    $null = go build -o bin/observer-agent.exe ./cmd/observer-agent 2>&1
    Pop-Location
    if (-not (Test-Path $desktopExe)) {
      Push-Location (Join-Path $script:Root 'agent\desktop')
      $null = wails3 build 2>&1
      Pop-Location
    }
  }
  Check '4. Windows agent / 桌面 exe 存在' ((Test-Path $agentExe) -and (Test-Path $desktopExe))

  # 5. 告警聚合（真实 hub + agent，制造一条 mismatch）
  if (-not (Test-Path (Join-Path $script:Root 'hub\dist\main.js'))) { throw '缺少 hub/dist，请先构建' }
  Remove-Item $script:Work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $script:Work 'mount') | Out-Null
  Set-Content (Join-Path $script:Work 'mount\.observer-mount') 'mount_id=m4' -NoNewline
  Set-Content (Join-Path $script:Work 'mount\shared.txt') 'trusted-m4' -NoNewline
  $workForYaml = $script:Work -replace '\\', '/'
  $config = @"
agent:
  machine_id: m4-machine
  hub: http://127.0.0.1:$script:Port
  token_file: $workForYaml/state/token
mounts:
  - id: m4
    path: $workForYaml/mount
    sentinel: .observer-mount
    exclude:
      - "**/.observer-mount"
"@
  Set-Content (Join-Path $script:Work 'agent.yaml') $config -Encoding UTF8
  Start-Hub
  $env:OBSERVER_DATA_DIR = $script:Work
  $output = node hub/dist/cli/token.js 2>&1 | Out-String
  $match = [regex]::Match($output, '(?m)^\s{2}([A-Za-z0-9_-]{30,})\s*$')
  if (-not $match.Success) { throw "创建 token 失败: $output" }
  $env:OBSERVER_ENROLL_TOKEN = $match.Groups[1].Value
  $agentLog = Join-Path $script:Work 'agent.log'
  $script:AgentPid = (Start-Process -FilePath $agentExe `
    -ArgumentList @('run', '-config', (Join-Path $script:Work 'agent.yaml'), '-interval', '300ms') `
    -WorkingDirectory $script:Root -PassThru -RedirectStandardOutput $agentLog -RedirectStandardError "$agentLog.err").Id

  $session = Login
  $mount = $null
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    $mountsResult = Invoke-RestMethod -Uri "$script:Base/api/v1/mounts" -WebSession $session
    $mounts = @($mountsResult)
    if ($mounts.Count -ge 1) { $mount = $mounts[0]; break }
    Start-Sleep -Milliseconds 300
  }
  if (-not $mount) { throw 'mount 未注册' }
  $job = Trigger-Scan -Session $session -MountId $mount.id -Mode 'baseline'
  $null = Wait-Job -Session $session -MountId $mount.id -JobId $job
  Set-Content (Join-Path $script:Work 'mount\shared.txt') 'corrupted-m4' -NoNewline
  $job = Trigger-Scan -Session $session -MountId $mount.id -Mode 'full'
  $null = Wait-Job -Session $session -MountId $mount.id -JobId $job
  $overview = Invoke-RestMethod -Uri "$script:Base/api/v1/overview" -WebSession $session
  $aggregationOk =
    ($overview.issues_by_type.mismatch -eq 1) -and
    (@($overview.issues_by_machine).Count -eq 1) -and
    ($overview.issues_by_machine[0].machine_id -eq 'm4-machine')
  Check '5. 总览返回按类型/机器聚合' $aggregationOk `
    "(mismatch=$($overview.issues_by_type.mismatch) machines=$(@($overview.issues_by_machine).Count))"

  # 6. 性能基准
  Write-Host '运行性能基准（500 文件）...'
  $bench = Start-Process -FilePath (Get-Command pwsh).Source `
    -ArgumentList @('-NoProfile', '-File', (Join-Path $script:Root 'scripts\bench.ps1'), '-SkipBuild', '-Files', '500') `
    -Wait -PassThru -RedirectStandardOutput (Join-Path $script:Root 'data\bench-m4.log') `
    -RedirectStandardError (Join-Path $script:Root 'data\bench-m4.log.err')
  Check '6. 性能基准达标' ($bench.ExitCode -eq 0) "(exit=$($bench.ExitCode), log=data\bench-m4.log)"

  if ($RunRegression) {
    Write-Host '运行 M2 回归 ...'
    $m2 = Start-Process -FilePath (Get-Command pwsh).Source `
      -ArgumentList @('-NoProfile', '-File', (Join-Path $script:Root 'scripts\drill-m2.ps1'), '-SkipBuild') `
      -Wait -PassThru -RedirectStandardOutput (Join-Path $script:Root 'data\m2-regression.log') `
      -RedirectStandardError (Join-Path $script:Root 'data\m2-regression.log.err')
    Check '7. M2 回归通过（含 M1）' ($m2.ExitCode -eq 0) "(exit=$($m2.ExitCode))"

    Write-Host '运行 M3 回归 ...'
    $m3 = Start-Process -FilePath (Get-Command pwsh).Source `
      -ArgumentList @('-NoProfile', '-File', (Join-Path $script:Root 'scripts\drill-m3.ps1'), '-SkipBuild') `
      -Wait -PassThru -RedirectStandardOutput (Join-Path $script:Root 'data\m3-regression.log') `
      -RedirectStandardError (Join-Path $script:Root 'data\m3-regression.log.err')
    Check '8. M3 回归通过' ($m3.ExitCode -eq 0) "(exit=$($m3.ExitCode))"
  } else {
    Skip '7. M2 回归' '未指定 -RunRegression'
    Skip '8. M3 回归' '未指定 -RunRegression'
  }
}
catch {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  $script:Failures += 'unexpected error'
}
finally {
  if ($script:AgentPid) { Stop-Process -Id $script:AgentPid -Force -ErrorAction SilentlyContinue }
  if ($script:HubPid) { Stop-Process -Id $script:HubPid -Force -ErrorAction SilentlyContinue }
  Write-Host ''
  if ($script:Failures.Count -eq 0) {
    Write-Host 'ALL M4 CHECKS PASSED' -ForegroundColor Green
    exit 0
  } else {
    Write-Host "FAILED: $($script:Failures -join ', ')" -ForegroundColor Red
    exit 1
  }
}
