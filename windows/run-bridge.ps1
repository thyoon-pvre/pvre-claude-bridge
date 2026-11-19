# PVRE 로컬 브리지 실행기 — 윈도우 작업 스케줄러(로그온 시)가 숨김 창으로 띄운다. install.ps1 이 등록한다.
# launchd 의 KeepAlive 대신: node 가 끝나면 10초 뒤 다시 띄운다. 출력은 %USERPROFILE%\.local\state\pvre\bridge*.out.log/.err.log
# 토큰 값은 이 출력에 찍히지 않는다(server.mjs 가 윈도우에서는 값을 출력하지 않는다).
param(
  [ValidateSet('claude', 'codex')][string]$Engine = 'claude',
  [int]$Port = 0,
  [string]$NodeBin = ''
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
$ctx = Get-BridgeContext -Engine $Engine -Port $Port
New-Item -ItemType Directory -Force -Path $ctx.StateDir | Out-Null

$env:PVRE_BRIDGE_ENGINE = $ctx.Engine
$env:PVRE_BRIDGE_PORT = "$($ctx.Port)"
$server = Join-Path $ctx.BridgeDir 'server.mjs'

while ($true) {
  # node 를 업데이트(재설치)해 경로가 바뀌어도 다시 찾는다
  $node = $NodeBin
  if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    $c = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $node = $c.Source } else { $node = $null }
  }
  if ($node) {
    try {
      # 5.1 의 Start-Process 는 인자를 따옴표 없이 잇는다 — 공백 경로라 직접 감싼다
      Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $ctx.BridgeDir -NoNewWindow -Wait `
        -RedirectStandardOutput $ctx.OutLog -RedirectStandardError $ctx.ErrLog
    } catch {
      Add-Content -LiteralPath $ctx.ErrLog -Value "[run-bridge] $(Get-Date -Format o) 실행 실패: $($_.Exception.Message)"
    }
  } else {
    Add-Content -LiteralPath $ctx.ErrLog -Value "[run-bridge] $(Get-Date -Format o) node.exe 를 찾지 못했다 — Node.js LTS 설치 후 install.ps1 재실행"
  }
  Start-Sleep -Seconds 10
}
