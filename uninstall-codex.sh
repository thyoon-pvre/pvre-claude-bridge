#!/bin/bash
# PVRE 로컬 브리지(Codex 엔진) 제거 — launchd 해제 + plist 삭제. Claude 브리지는 건드리지 않는다.
# 토큰은 남긴다. 지우려면 --purge-token.
set -euo pipefail
LABEL="com.pvre.codex-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TOKEN_FILE="$HOME/.config/pvre/bridge-token.codex"
echo "▶ PVRE 로컬 브리지(Codex 엔진) 제거"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "  launchd 해제 완료" || echo "  launchd 에 등록돼 있지 않다 (넘어감)"
if [ -f "$PLIST" ]; then rm -f "$PLIST"; echo "  삭제: $PLIST"; fi
if [ "${1:-}" = "--purge-token" ]; then
  if [ -f "$TOKEN_FILE" ]; then rm -f "$TOKEN_FILE"; echo "  삭제: $TOKEN_FILE"; fi
  echo "  다음 설치 때 새 토큰이 만들어진다 — 화면에 다시 붙여넣어야 한다."
else
  echo "  토큰 파일은 남겼다: $TOKEN_FILE (지우려면 --purge-token)"
fi
