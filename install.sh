#!/bin/bash
# PVRE 로컬 Claude 브리지 설치 — launchd 등록 + 토큰 생성.
# 되돌리려면 ./uninstall.sh 를 실행한다.
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.pvre.claude-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PVRE_BRIDGE_PORT:-8799}"

echo "▶ PVRE 로컬 Claude 브리지 설치"
echo "  위치: $BRIDGE_DIR"

# 1. node 확인 — launchd 는 PATH 가 좁아서 절대경로를 plist 에 박아야 한다.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ node 를 찾지 못했다. Node.js 를 설치한 뒤 다시 실행해라." >&2
  exit 1
fi
echo "  node: $NODE_BIN ($("$NODE_BIN" -v))"

# 2. claude CLI 확인 — 없으면 브리지가 의미 없다. 막지는 않고 경고한다.
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "⚠ claude CLI 를 찾지 못했다."
  echo "  브리지는 뜨지만 /v1/run 이 CLAUDE_NOT_FOUND 를 돌려준다."
  echo "  Claude Code 를 설치하고 로그인한 뒤 ./install.sh 를 다시 실행해라."
else
  echo "  claude: $CLAUDE_BIN ($("$CLAUDE_BIN" --version 2>/dev/null || echo 'version 확인 실패'))"
fi

# 3. 포트 선점 확인 — 다른 프로그램이 쓰고 있으면 먼저 알려준다.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠ 포트 $PORT 를 이미 누군가 쓰고 있다:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/    /'
  echo "  PVRE_BRIDGE_PORT 로 다른 포트를 지정하거나 기존 프로세스를 정리한 뒤 다시 실행해라."
  exit 1
fi

# 4. launchd plist 생성
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@BRIDGE_DIR@|$BRIDGE_DIR|g" \
    -e "s|@PORT@|$PORT|g" \
    "$BRIDGE_DIR/com.pvre.claude-bridge.plist" > "$PLIST"

# 5. 등록 (이미 떠 있으면 내리고 다시 올린다)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "  launchd 등록: $PLIST"
sleep 1.5

# 6. 상태 확인
echo ""
echo "▶ 상태 확인"
if curl -fsS -m 5 "http://127.0.0.1:$PORT/v1/health"; then
  echo ""
else
  echo "✗ /v1/health 응답이 없다. 로그를 봐라: /tmp/pvre-bridge.err" >&2
  exit 1
fi

# 7. 토큰 출력
TOKEN_FILE="${PVRE_BRIDGE_TOKEN_FILE:-$HOME/.config/pvre/bridge-token}"
echo ""
echo "▶ 브리지 토큰 — 백오피스 /settings/bridge 에 붙여넣어라"
echo "  (이 값은 브라우저 localStorage 에만 저장된다. Vercel 서버로 가지 않는다.)"
echo ""
echo "  $(cat "$TOKEN_FILE")"
echo ""
echo "▶ 다음 단계"
echo "  1. 위 토큰을 백오피스 설정 화면에 붙여넣는다"
echo "  2. Chrome 이 '로컬 네트워크 접근'을 물어보면 반드시 [허용] 을 누른다"
echo "     — 거부하면 요청이 조용히 실패하고 원인을 찾기 어렵다"
