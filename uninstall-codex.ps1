<#
PVRE 로컬 브리지(Codex 엔진) 제거(윈도우). Claude 브리지는 건드리지 않는다. 맥은 uninstall-codex.sh.
  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-codex.ps1 [-PurgeToken]
#>
[CmdletBinding()]
param([int]$Port = 0, [switch]$PurgeToken)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'uninstall.ps1') -Engine codex -Port $Port -PurgeToken:$PurgeToken
