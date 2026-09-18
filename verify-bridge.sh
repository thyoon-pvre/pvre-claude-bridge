#!/bin/bash
# 검증·시연 전용 브리지 — 운영과 포트·토큰·로그를 전부 나눈다.
#
# 검증 흔적이 운영 로그·토큰에 섞이면 안 된다.
# 사람이 매번 환경변수를 손으로 넣게 하면 언젠가 빠뜨린다. 그래서 스크립트로 고정한다.
#
#   운영: 8799 / ~/.config/pvre/bridge-token      / ~/.local/state/pvre/bridge.log
#   검증: 8798 / ~/.config/pvre/bridge-token.verify / ~/.local/state/pvre/bridge.verify.log
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PVRE_BRIDGE_MODE=verify
export PVRE_BRIDGE_PORT="${PVRE_BRIDGE_PORT:-8798}"
export PVRE_BRIDGE_TOKEN_FILE="${PVRE_BRIDGE_TOKEN_FILE:-$HOME/.config/pvre/bridge-token.verify}"
export PVRE_BRIDGE_LOG_FILE="${PVRE_BRIDGE_LOG_FILE:-$HOME/.local/state/pvre/bridge.verify.log}"
# 검증 페이지는 3100 에서 띄운다 (3000 은 다른 개발 서버가 쓰고 있을 수 있다).
export PVRE_BRIDGE_ALLOWED_ORIGINS="${PVRE_BRIDGE_ALLOWED_ORIGINS:-http://localhost:3100,http://127.0.0.1:3100}"

echo "▶ 검증 모드로 뜬다 — 운영 경로를 건드리지 않는다"
echo "  포트  : $PVRE_BRIDGE_PORT"
echo "  토큰  : $PVRE_BRIDGE_TOKEN_FILE"
echo "  로그  : $PVRE_BRIDGE_LOG_FILE"
echo ""

exec node "$BRIDGE_DIR/server.mjs"
