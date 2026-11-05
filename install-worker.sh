#!/bin/bash
# PVRE 상시 작업자 설치 — launchd(com.pvre.ai-worker) 등록. 브라우저 없이 이 맥이 발주시스템의 메일 해석 작업을 처리한다.
# 되돌리려면 ./uninstall-worker.sh
#
# 사용:
#   1) 발주시스템 › 내 AI 연결 › 상시 작업자 기기에서 [기기 토큰 발급](총괄) → 토큰을 클립보드로 복사
#   2) 토큰을 파일(600) 또는 키체인에 넣는다 — 화면·셸 기록에 남기지 않게 클립보드에서 바로:
#        파일:   mkdir -p ~/.config/pvre && (umask 077; pbpaste > ~/.config/pvre/worker-token)
#        키체인: security add-generic-password -U -a "$USER" -s pvre-ai-worker -w "$(pbpaste)"
#   3) PVRE_WORKER_SERVER=https://pvre-order-prototype.vercel.app ./install-worker.sh            (claude, 토큰 파일)
#      PVRE_WORKER_SERVER=… PVRE_WORKER_KEYCHAIN_SERVICE=pvre-ai-worker ./install-worker.sh      (키체인)
#      PVRE_WORKER_SERVER=… PVRE_WORKER_ENGINE=codex ./install-worker.sh                          (codex)
#   --dry-run : plist 만 만들어 보여 주고 launchd 에 등록하지 않는다
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.pvre.ai-worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVER="${PVRE_WORKER_SERVER:-}"
ENGINE="${PVRE_WORKER_ENGINE:-claude}"
KEYCHAIN="${PVRE_WORKER_KEYCHAIN_SERVICE:-}"
TOKEN_FILE="${PVRE_WORKER_TOKEN_FILE:-$HOME/.config/pvre/worker-token}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

echo "▶ PVRE 상시 작업자 설치"
echo "  위치: $BRIDGE_DIR"

case "$SERVER" in
  https://*) ;;
  *) echo "✗ PVRE_WORKER_SERVER 에 발주시스템 https 주소를 넣어라 (예: https://pvre-order-prototype.vercel.app)" >&2; exit 1 ;;
esac
case "$ENGINE" in claude|codex) ;; *) echo "✗ PVRE_WORKER_ENGINE 은 claude 또는 codex" >&2; exit 1 ;; esac

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "✗ node 를 찾지 못했다." >&2; exit 1; fi
echo "  node: $NODE_BIN ($("$NODE_BIN" -v))"

ENGINE_BIN="$(command -v "$ENGINE" || true)"
if [ -z "$ENGINE_BIN" ]; then
  echo "⚠ $ENGINE CLI 를 찾지 못했다 — 작업자는 뜨지만 연결 신호에 '실행 불가'로 나가 작업을 집지 않는다."
else
  echo "  $ENGINE: $ENGINE_BIN"
  [ "$ENGINE" = "codex" ] && echo "  (codex 는 ChatGPT 로그인이어야 한다: codex login status — API 키 로그인은 종량 과금)"
fi

# 토큰 위치 확인 — 값은 읽어서 출력하지 않는다
if [ -n "$KEYCHAIN" ]; then
  if ! security find-generic-password -s "$KEYCHAIN" >/dev/null 2>&1; then
    echo "✗ 키체인에 '$KEYCHAIN' 항목이 없다. 위 2) 키체인 명령으로 먼저 넣어라." >&2; exit 1
  fi
  TOKEN_ENV_KEY="PVRE_WORKER_KEYCHAIN_SERVICE"; TOKEN_ENV_VALUE="$KEYCHAIN"
  echo "  토큰: 키체인 서비스 $KEYCHAIN"
else
  if [ ! -f "$TOKEN_FILE" ]; then echo "✗ 토큰 파일이 없다: $TOKEN_FILE (위 2) 참고)" >&2; exit 1; fi
  chmod 600 "$TOKEN_FILE"
  if ! grep -Eq '^pvw1_[A-Za-z0-9_-]{43}$' "$TOKEN_FILE"; then echo "✗ 토큰 형식이 아니다(pvw1_…): $TOKEN_FILE" >&2; exit 1; fi
  TOKEN_ENV_KEY="PVRE_WORKER_TOKEN_FILE"; TOKEN_ENV_VALUE="$TOKEN_FILE"
  echo "  토큰: 파일 $TOKEN_FILE (600)"
fi

OUT="$PLIST"
[ "$DRY" = 1 ] && OUT="$(mktemp -t pvre-ai-worker)"
mkdir -p "$(dirname "$OUT")"
sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@BRIDGE_DIR@|$BRIDGE_DIR|g" \
    -e "s|@SERVER@|$SERVER|g" \
    -e "s|@ENGINE@|$ENGINE|g" \
    -e "s|@TOKEN_ENV_KEY@|$TOKEN_ENV_KEY|g" \
    -e "s|@TOKEN_ENV_VALUE@|$TOKEN_ENV_VALUE|g" \
    -e "s|@HOME@|$HOME|g" \
    "$BRIDGE_DIR/com.pvre.ai-worker.plist" > "$OUT"
plutil -lint "$OUT" >/dev/null

if [ "$DRY" = 1 ]; then
  echo "  (dry-run) plist 만 만들었다: $OUT — launchd 에 등록하지 않았다"
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "  launchd 등록: $PLIST"
sleep 3

LOG="${PVRE_WORKER_LOG_FILE:-$HOME/.local/state/pvre/worker.log}"
echo ""
echo "▶ 상태 확인"
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit code" | sed 's/^/  /' || true
if [ -f "$LOG" ]; then echo "  최근 로그:"; tail -n 3 "$LOG" | sed 's/^/    /'; fi
echo ""
echo "▶ 다음 단계"
echo "  발주시스템 › 내 AI 연결 › 상시 작업자 기기 목록에서 '연결됨'이 보이면 끝."
echo "  안 보이면: tail -f $LOG  /  cat /tmp/pvre-ai-worker.err"
