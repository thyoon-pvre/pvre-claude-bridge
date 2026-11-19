<#
PVRE 로컬 브리지 제거(윈도우) — 작업 스케줄러 작업·시작프로그램 바로가기 해제, 떠 있는 브리지 종료. 맥은 uninstall.sh.
토큰 파일은 기본적으로 남긴다. 지우려면 -PurgeToken.
  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 [-PurgeToken]
#>
[CmdletBinding()]
param([ValidateSet('claude', 'codex')][string]$Engine = 'claude', [int]$Port = 0, [switch]$PurgeToken)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows\common.ps1')
$ctx = Get-BridgeContext -Engine $Engine -Port $Port
Write-Host "▶ PVRE 로컬 브리지($Engine 엔진) 제거 — 윈도우"
Stop-Bridge $ctx
if ($PurgeToken) {
  if (Test-Path -LiteralPath $ctx.TokenFile) { Remove-Item -LiteralPath $ctx.TokenFile -Force; Write-Host "  삭제: $($ctx.TokenFile)" }
  Write-Host '  토큰을 지웠다. 다음 설치 때 새 토큰이 만들어진다 — 발주 시스템 화면에 다시 붙여넣어야 한다.'
} else {
  Write-Host "  토큰 파일은 남겼다: $($ctx.TokenFile) (지우려면 -PurgeToken)"
}
Write-Host ''
Write-Host '브리지를 지워도 발주 시스템은 그대로 돈다. 이 PC 의 AI 해석만 꺼진다.'
