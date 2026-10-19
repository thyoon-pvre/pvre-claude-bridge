#!/bin/bash
# 검증·시연 전용 Codex 브리지 — 운영(8797)과 포트·토큰·로그를 나눈다.
#   검증: 8796 / ~/.config/pvre/bridge-token.codex.verify / ~/.local/state/pvre/bridge.codex.verify.log
# PVRE_BRIDGE_DRY_RUN=1 이면 codex 를 실행하지 않는다.
set -euo pipefail
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PVRE_BRIDGE_ENGINE=codex
export PVRE_BRIDGE_MODE=verify
export PVRE_BRIDGE_PORT="${PVRE_BRIDGE_PORT:-8796}"
export PVRE_BRIDGE_TOKEN_FILE="${PVRE_BRIDGE_TOKEN_FILE:-$HOME/.config/pvre/bridge-token.codex.verify}"
export PVRE_BRIDGE_LOG_FILE="${PVRE_BRIDGE_LOG_FILE:-$HOME/.local/state/pvre/bridge.codex.verify.log}"
export PVRE_BRIDGE_ALLOWED_ORIGINS="${PVRE_BRIDGE_ALLOWED_ORIGINS:-http://localhost:3100,http://127.0.0.1:3100}"
echo "▶ Codex 엔진 검증 모드 — 운영 경로를 건드리지 않는다"
echo "  포트  : $PVRE_BRIDGE_PORT"
echo "  토큰  : $PVRE_BRIDGE_TOKEN_FILE"
echo "  로그  : $PVRE_BRIDGE_LOG_FILE"
exec node "$BRIDGE_DIR/server.mjs"
