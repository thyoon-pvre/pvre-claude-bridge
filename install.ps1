<#
PVRE 로컬 브리지 설치 — 윈도우(맥은 install.sh). 관리자 권한 없이 "내 계정 로그온 시 실행" 작업으로 등록한다.

  PowerShell 에서(저장소 폴더):
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1                      # Claude 엔진 · 127.0.0.1:8799
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex.ps1                # Codex 엔진  · 127.0.0.1:8797
    ... -AllowOrigin https://pvre-order-prototype.vercel.app                                # 허용 주소(bridge.json)에 이 주소 추가

  - 다시 실행하면 재시작이다(멈춤 → 재등록 → 시작). 토큰은 그대로 유지된다.
  - 토큰 값은 화면에 찍지 않는다. 클립보드로: Get-Content "$HOME\.config\pvre\bridge-token" | Set-Clipboard
  - 작업 스케줄러 등록이 막힌 PC(회사 정책)면 시작프로그램 바로가기로 대신 등록한다.
  - 되돌리기: .\uninstall.ps1  /  .\uninstall-codex.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet('claude', 'codex')][string]$Engine = 'claude',
  [int]$Port = 0,
  [string[]]$AllowOrigin = @()
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows\common.ps1')
$ctx = Get-BridgeContext -Engine $Engine -Port $Port
$label = 'Claude'
if ($Engine -eq 'codex') { $label = 'Codex' }

Write-Host "▶ PVRE 로컬 브리지($label 엔진) 설치 — 윈도우"
Write-Host "  위치: $($ctx.BridgeDir)"

# 1. node — 작업 스케줄러에 절대경로로 넣는다
$nodeCmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCmd) {
  Write-Host '✗ node 를 찾지 못했다. https://nodejs.org 에서 LTS 를 설치하고 PowerShell 을 새로 연 뒤 다시 실행해라.' -ForegroundColor Red
  exit 1
}
$NodeBin = $nodeCmd.Source
$nodeVer = Invoke-Quiet $NodeBin @('-v')
Write-Host "  node: $NodeBin ($nodeVer)"
if ($nodeVer -match '^v(\d+)\.' -and [int]$Matches[1] -lt 18) {
  Write-Host "✗ Node.js 18 이상이 필요하다(지금 $nodeVer)." -ForegroundColor Red
  exit 1
}

# 2. 엔진 CLI — 없어도 막지는 않는다(브리지는 뜨고 /v1/run 이 *_NOT_FOUND 를 준다)
$cli = Find-EngineCli $Engine
if (-not $cli) {
  Write-Host "⚠ $Engine CLI 를 찾지 못했다. 브리지는 뜨지만 실행 요청은 실패한다." -ForegroundColor Yellow
  if ($Engine -eq 'codex') { Write-Host "  npm i -g @openai/codex  →  codex login(ChatGPT 계정)  → 이 스크립트 다시 실행" } else { Write-Host "  Claude Code 설치(irm https://claude.ai/install.ps1 | iex 또는 npm i -g @anthropic-ai/claude-code) → claude 실행해 로그인 → 이 스크립트 다시 실행" }
} else {
  Write-Host "  ${Engine}: $cli ($(Invoke-Quiet $cli @('--version')))"
  if ($Engine -eq 'codex') {
    $login = Invoke-Quiet $cli @('login', 'status')
    Write-Host "  로그인: $login"
    if ($login -match 'ChatGPT') { } elseif ($login -match 'API') { Write-Host '⚠ API 키로 로그인돼 있다 — 호출마다 OpenAI API 종량 과금이 생긴다. ChatGPT 구독 로그인(codex login)을 권한다.' -ForegroundColor Yellow } else { Write-Host "⚠ 로그인 상태를 확인하지 못했다. 'codex login' 후 다시 실행해라." -ForegroundColor Yellow }
  }
}

# 3. 이미 떠 있는 이 엔진의 브리지를 내린다(재설치 = 재시작)
Stop-Bridge $ctx
Start-Sleep -Milliseconds 800
$owner = Get-PortOwner $ctx.Port
if ($owner) {
  Write-Host "✗ 포트 $($ctx.Port) 를 다른 프로그램이 쓰고 있다: $owner" -ForegroundColor Red
  Write-Host "  그 프로그램을 끄거나 -Port 로 다른 포트를 지정해라(이 경우 발주 시스템 화면의 '브릿지 주소 바꾸기'도 같이 바꿔야 한다)."
  exit 1
}

# 4. 설정 폴더·허용 주소(bridge.json)
New-Item -ItemType Directory -Force -Path $ctx.ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $ctx.StateDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)   # BOM 없이(있으면 node 가 JSON 을 못 읽던 버전이 있다)
if (-not (Test-Path -LiteralPath $ctx.ConfigFile)) {
  $example = [IO.File]::ReadAllText((Join-Path $ctx.BridgeDir 'bridge.example.json'))
  [IO.File]::WriteAllText($ctx.ConfigFile, $example, $utf8)
  Write-Host "  허용 주소 파일을 만들었다: $($ctx.ConfigFile)"
}
if ($AllowOrigin.Count -gt 0) {
  $cfg = [IO.File]::ReadAllText($ctx.ConfigFile).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $list = @()
  if ($cfg.PSObject.Properties.Name -contains 'allowedOrigins') { $list = @($cfg.allowedOrigins) }
  foreach ($o in $AllowOrigin) {
    $o = $o.Trim().TrimEnd('/')
    if ($o -notmatch '^https?://[^/\s]+$') { Write-Host "⚠ 주소 형식이 아니라 넣지 않았다: $o (예: https://pvre-order-prototype.vercel.app)" -ForegroundColor Yellow; continue }
    if ($list -notcontains $o) { $list += $o; Write-Host "  허용 주소 추가: $o" }
  }
  if ($cfg.PSObject.Properties.Name -contains 'allowedOrigins') { $cfg.allowedOrigins = [string[]]$list } else { $cfg | Add-Member -NotePropertyName allowedOrigins -NotePropertyValue ([string[]]$list) }
  [IO.File]::WriteAllText($ctx.ConfigFile, ($cfg | ConvertTo-Json -Depth 5), $utf8)
}

# 5. 토큰 — 서버가 만들면 출력 로그로 나갈 수 있어 여기서 미리 만든다. 값은 출력하지 않는다.
$needNew = $true
if (Test-Path -LiteralPath $ctx.TokenFile) { $needNew = ([IO.File]::ReadAllText($ctx.TokenFile).Trim().Length -lt 32) }
if ($needNew) {
  [IO.File]::WriteAllText($ctx.TokenFile, '', $utf8)   # 빈 파일 → 권한 잠금 → 값 쓰기 순서(값이 열린 권한으로 놓이는 순간이 없게)
  Protect-UserFile $ctx.TokenFile
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  [IO.File]::WriteAllText($ctx.TokenFile, ((-join ($bytes | ForEach-Object { $_.ToString('x2') })) + "`n"), $utf8)
  $bytes = $null
  Write-Host "  토큰을 새로 만들었다(내 계정만 읽기 가능): $($ctx.TokenFile)"
} else {
  Protect-UserFile $ctx.TokenFile
  Write-Host "  기존 토큰을 그대로 쓴다: $($ctx.TokenFile)"
}

# 6. 로그온 시 자동 실행 등록 — 작업 스케줄러(내 계정, 제한된 권한). 막히면 시작프로그램 바로가기.
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runner = Join-Path $ctx.BridgeDir 'windows\run-bridge.ps1'
$argLine = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Engine $Engine -Port $($ctx.Port) -NodeBin `"$NodeBin`""
$registered = 'task'
try {
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine -WorkingDirectory $ctx.BridgeDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  # 기본 실행 시간 제한(72시간)을 없앤다 — 상주 프로그램이다
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $ctx.TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "PVRE 로컬 AI 브리지($label) — 127.0.0.1:$($ctx.Port). 제거: uninstall.ps1" -Force | Out-Null
  Start-ScheduledTask -TaskName $ctx.TaskName
  Write-Host "  작업 스케줄러 등록: $($ctx.TaskName) (로그온 시 실행)"
} catch {
  $registered = 'startup'
  Write-Host "⚠ 작업 스케줄러에 등록하지 못했다($($_.Exception.Message)). 시작프로그램 바로가기로 대신 등록한다." -ForegroundColor Yellow
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($ctx.Shortcut)
  $lnk.TargetPath = $psExe
  $lnk.Arguments = $argLine
  $lnk.WorkingDirectory = $ctx.BridgeDir
  $lnk.WindowStyle = 7
  $lnk.Save()
  Start-Process -FilePath $psExe -ArgumentList $argLine -WindowStyle Hidden
  Write-Host "  시작프로그램 등록: $($ctx.Shortcut)"
}

# 7. 상태 확인
Write-Host ''
Write-Host "▶ 상태 확인 (engine 이 $Engine, engineAvailable 이 true 여야 한다)"
$health = $null
for ($i = 0; $i -lt 15 -and -not $health; $i++) {
  Start-Sleep -Seconds 1
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($ctx.Port)/v1/health" -TimeoutSec 3 } catch { $health = $null }
}
if (-not $health) {
  Write-Host "✗ /v1/health 응답이 없다. 로그를 봐라: $($ctx.ErrLog)" -ForegroundColor Red
  exit 1
}
Write-Host ('  ' + ($health | ConvertTo-Json -Compress))
if ($health.engine -ne $Engine) { Write-Host "⚠ 이 포트의 브리지 엔진이 $($health.engine) 이다." -ForegroundColor Yellow }
if (-not $health.engineAvailable) { Write-Host "⚠ $Engine CLI 를 찾지 못했다 — 설치·로그인 후 이 스크립트를 다시 실행해라." -ForegroundColor Yellow }

Write-Host ''
Write-Host '▶ 다음 단계'
Write-Host "  1. 토큰을 클립보드로(화면에 찍지 않는다):  Get-Content `"$($ctx.TokenFile)`" | Set-Clipboard"
Write-Host "  2. 발주 시스템 '내 AI 연결' → $label 브릿지 토큰 칸에 붙여넣고 [$label 토큰 저장]"
Write-Host '  3. Chrome·Edge 가 "로컬 네트워크 접근"을 물으면 [허용]. 거부하면 조용히 실패한다.'
Write-Host "  4. 허용 주소가 없다는 오류면: 이 스크립트를 -AllowOrigin <발주 시스템 주소> 를 붙여 다시 실행"
if ($registered -eq 'startup') { Write-Host '  (시작프로그램으로 등록됨 — 로그온 때마다 숨김 창으로 뜬다)' }
