#!/bin/bash
# PVRE 상시 작업자 제거 — launchd 해제 + plist 삭제. 토큰 파일·키체인 항목은 남긴다(--purge-token 이면 파일만 지운다).
# 서버 쪽 기기 토큰은 발주시스템 화면에서 [폐기]해야 무효가 된다(이 스크립트는 서버를 건드리지 않는다).
set -euo pipefail
LABEL="com.pvre.ai-worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "launchd 해제: $LABEL"
if [ "${1:-}" = "--purge-token" ]; then
  rm -f "${PVRE_WORKER_TOKEN_FILE:-$HOME/.config/pvre/worker-token}"
  echo "토큰 파일 삭제(키체인 항목은 직접: security delete-generic-password -s pvre-ai-worker)"
fi
