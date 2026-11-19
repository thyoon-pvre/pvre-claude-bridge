# PVRE 로컬 브리지 — 윈도우 설치·제거 스크립트가 같이 쓰는 함수(dot-source 전용, 직접 실행하지 않는다).
# Windows PowerShell 5.1 호환으로 쓴다(삼항·??·&& 없음). 이 파일은 UTF-8 BOM 으로 저장해야 5.1 이 한글을 읽는다.

# dot-source 될 때 이 파일 위치(windows\)의 부모 = 저장소 폴더
$PvreBridgeDir = Split-Path -Parent $PSScriptRoot

function Get-BridgeContext {
  param([ValidateSet('claude', 'codex')][string]$Engine = 'claude', [int]$Port = 0)
  $isCodex = $Engine -eq 'codex'
  if ($Port -eq 0) {
    if ($env:PVRE_BRIDGE_PORT) { $Port = [int]$env:PVRE_BRIDGE_PORT } elseif ($isCodex) { $Port = 8797 } else { $Port = 8799 }
  }
  $suffix = ''
  $taskName = 'PVRE Claude Bridge'
  if ($isCodex) { $suffix = '.codex'; $taskName = 'PVRE Codex Bridge' }
  # server.mjs 기본값과 같은 자리(homedir() = %USERPROFILE%)
  $configDir = Join-Path $HOME '.config\pvre'
  $stateDir = Join-Path $HOME '.local\state\pvre'
  return @{
    Engine     = $Engine
    Port       = $Port
    TaskName   = $taskName
    BridgeDir  = $PvreBridgeDir
    ConfigDir  = $configDir
    StateDir   = $stateDir
    TokenFile  = (Join-Path $configDir "bridge-token$suffix")
    ConfigFile = (Join-Path $configDir 'bridge.json')
    OutLog     = (Join-Path $stateDir "bridge$suffix.out.log")
    ErrLog     = (Join-Path $stateDir "bridge$suffix.err.log")
    Shortcut   = (Join-Path ([Environment]::GetFolderPath('Startup')) "$taskName.lnk")
  }
}

# 파일을 지금 사용자만 읽고 쓰게(상속 끊고 사용자 SID 하나만). 맥의 chmod 600 에 해당한다.
function Protect-UserFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $out = & icacls.exe $Path /inheritance:r /grant:r "*${sid}:(F)" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls 로 권한을 잠그지 못했다($LASTEXITCODE): $Path`n$out" }
}

# 네이티브 명령을 돌려 출력(표준 출력+오류)을 문자열로. 5.1 에서 stderr 가 예외로 바뀌지 않게 잠깐 Continue 로 둔다.
function Invoke-Quiet {
  param([string]$Exe, [string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    return (($lines | Where-Object { $_ }) -join ' ').Trim()
  } catch {
    return ''
  } finally {
    $ErrorActionPreference = $prev
  }
}

# 엔진 CLI 위치(안내용 — 실제 실행 경로는 server.mjs 가 다시 찾는다). .exe(네이티브) → .cmd(npm 전역) 순.
function Find-EngineCli {
  param([string]$Name)
  foreach ($n in @("$Name.exe", "$Name.cmd")) {
    $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
  }
  $cands = @((Join-Path $HOME ".local\bin\$Name.exe"))
  if ($env:APPDATA) { $cands += (Join-Path $env:APPDATA "npm\$Name.cmd") }
  foreach ($p in $cands) { if (Test-Path -LiteralPath $p) { return $p } }
  return $null
}

# 이 엔진의 브리지를 내린다: 작업 스케줄러 작업·시작프로그램 바로가기·실행기(powershell)·포트를 잡은 node(server.mjs)만.
function Stop-Bridge {
  param([hashtable]$Ctx)
  $task = Get-ScheduledTask -TaskName $Ctx.TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $Ctx.TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $Ctx.TaskName -Confirm:$false
    Write-Host "  작업 스케줄러 해제: $($Ctx.TaskName)"
  }
  if (Test-Path -LiteralPath $Ctx.Shortcut) {
    Remove-Item -LiteralPath $Ctx.Shortcut -Force
    Write-Host "  시작프로그램 바로가기 삭제: $($Ctx.Shortcut)"
  }
  # 실행기(무한 재시작 루프)를 먼저 끝내야 node 를 죽여도 다시 뜨지 않는다
  $runners = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-bridge.ps1*' -and $_.CommandLine -like "*-Engine $($Ctx.Engine)*" -and $_.ProcessId -ne $PID }
  foreach ($r in $runners) { Stop-Process -Id $r.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $conns = Get-NetTCPConnection -LocalPort $Ctx.Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
      if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -like '*server.mjs*') {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  기존 브리지 프로세스 종료: PID $($p.ProcessId)"
      }
    }
  }
}

# 포트를 잡고 있는 다른 프로그램(우리 브리지가 아닌 것)
function Get-PortOwner {
  param([int]$Port)
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $null }
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
  if ($p) { return "$($p.Name) (PID $($p.ProcessId))" }
  return "PID $($c.OwningProcess)"
}
