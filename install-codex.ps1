<#
PVRE 로컬 브리지 — Codex 엔진 설치(윈도우). install.ps1 -Engine codex 와 같다. 맥은 install-codex.sh.
  포트 8797 · 토큰 %USERPROFILE%\.config\pvre\bridge-token.codex · 작업 스케줄러 "PVRE Codex Bridge"
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex.ps1 [-AllowOrigin https://…] [-Port 8797]
#>
[CmdletBinding()]
param([int]$Port = 0, [string[]]$AllowOrigin = @())
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') -Engine codex -Port $Port -AllowOrigin $AllowOrigin
exit $LASTEXITCODE
