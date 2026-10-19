#!/bin/bash
# PVRE 로컬 브리지 — Codex 엔진 설치. Claude 브리지(com.pvre.claude-bridge, 8799)와 별개로 하나 더 띄운다.
#   포트 8797 · 토큰 ~/.config/pvre/bridge-token.codex · 로그 ~/.local/state/pvre/bridge.codex.log · launchd com.pvre.codex-bridge
#   허용 Origin 은 Claude 브리지와 같은 ~/.config/pvre/bridge.json 을 읽는다.
# 토큰 값은 화면에 찍지 않는다(채팅·화면 공유로 새지 않게). pbcopy 로 클립보드에 넣는 명령만 안내한다.
# 되돌리려면 ./uninstall-codex.sh
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.pvre.codex-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PVRE_BRIDGE_PORT:-8797}"
TOKEN_FILE="$HOME/.config/pvre/bridge-token.codex"

echo "▶ PVRE 로컬 브리지(Codex 엔진) 설치"
echo "  위치: $BRIDGE_DIR"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ node 를 찾지 못했다. Node.js 를 설치한 뒤 다시 실행해라." >&2
  exit 1
fi
echo "  node: $NODE_BIN ($("$NODE_BIN" -v))"

CODEX_BIN="$(command -v codex || true)"
if [ -z "$CODEX_BIN" ]; then
  echo "⚠ codex CLI 를 찾지 못했다. 브리지는 뜨지만 /v1/run 이 CODEX_NOT_FOUND 를 돌려준다."
  echo "  Codex CLI 를 설치하고 'codex login'(ChatGPT 계정)으로 로그인한 뒤 다시 실행해라."
else
  echo "  codex: $CODEX_BIN ($("$CODEX_BIN" --version 2>/dev/null || echo 'version 확인 실패'))"
  LOGIN="$("$CODEX_BIN" login status 2>&1 || true)"
  echo "  로그인: $LOGIN"
  case "$LOGIN" in
    *ChatGPT*) ;;
    *API*|*api*) echo "⚠ API 키로 로그인돼 있다 — 호출마다 OpenAI API 종량 과금이 생긴다. ChatGPT 구독 로그인(codex login)을 권한다." ;;
    *) echo "⚠ 로그인 상태를 확인하지 못했다. 'codex login' 후 다시 실행해라." ;;
  esac
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠ 포트 $PORT 를 이미 누군가 쓰고 있다:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/    /'
  echo "  PVRE_BRIDGE_PORT 로 다른 포트를 지정하거나 기존 프로세스를 정리한 뒤 다시 실행해라(화면의 Codex 브릿지 주소도 바꿔야 한다)."
  exit 1
fi

# 토큰을 미리 만든다(서버가 만들면 launchd 로그로 나갈 수 있다). 이미 있으면 그대로 쓴다.
mkdir -p "$(dirname "$TOKEN_FILE")"
chmod 700 "$(dirname "$TOKEN_FILE")"
if [ ! -s "$TOKEN_FILE" ]; then
  (umask 077 && "$NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex")+"\n")' > "$TOKEN_FILE")
  echo "  토큰을 새로 만들었다: $TOKEN_FILE (0600)"
else
  chmod 600 "$TOKEN_FILE"
  echo "  기존 토큰을 그대로 쓴다: $TOKEN_FILE"
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@BRIDGE_DIR@|$BRIDGE_DIR|g" \
    -e "s|@PORT@|$PORT|g" \
    "$BRIDGE_DIR/com.pvre.codex-bridge.plist" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "  launchd 등록: $PLIST"
sleep 1.5

echo ""
echo "▶ 상태 확인 (engine 이 codex, engineAvailable 이 true 여야 한다)"
if curl -fsS -m 5 "http://127.0.0.1:$PORT/v1/health"; then
  echo ""
else
  echo "✗ /v1/health 응답이 없다. 로그를 봐라: /tmp/pvre-codex-bridge.err" >&2
  exit 1
fi

echo ""
echo "▶ 다음 단계"
echo "  1. 토큰을 클립보드로:  pbcopy < $TOKEN_FILE"
echo "  2. 발주 시스템 '내 AI 연결' → Codex 브릿지 토큰 칸에 붙여넣고 [Codex 토큰 저장]"
echo "  3. 허용 주소가 없다는 오류면 ~/.config/pvre/bridge.json 의 allowedOrigins 에 발주 시스템 주소를 넣고:"
echo "     launchctl kickstart -k gui/\$(id -u)/$LABEL"
