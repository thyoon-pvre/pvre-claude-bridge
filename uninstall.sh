#!/bin/bash
# PVRE 로컬 Claude 브리지 제거 — launchd 해제 + plist 삭제.
# 토큰 파일은 기본적으로 남긴다. 지우려면 --purge-token 을 붙인다.
set -euo pipefail

LABEL="com.pvre.claude-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TOKEN_FILE="${PVRE_BRIDGE_TOKEN_FILE:-$HOME/.config/pvre/bridge-token}"

echo "▶ PVRE 로컬 Claude 브리지 제거"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "  launchd 해제 완료" || echo "  launchd 에 등록돼 있지 않다 (넘어감)"

if [ -f "$PLIST" ]; then rm -f "$PLIST"; echo "  삭제: $PLIST"; fi

if [ "${1:-}" = "--purge-token" ]; then
  if [ -f "$TOKEN_FILE" ]; then rm -f "$TOKEN_FILE"; echo "  삭제: $TOKEN_FILE"; fi
  echo "  토큰을 지웠다. 다음 실행 때 새 토큰이 만들어진다 — 백오피스에 다시 붙여넣어야 한다."
else
  echo "  토큰 파일은 남겼다: $TOKEN_FILE"
  echo "  (완전히 지우려면: ./uninstall.sh --purge-token)"
fi

echo ""
echo "브리지를 지워도 백오피스는 그대로 돈다. LLM 기능만 비활성화된다."
