# PVRE 로컬 Claude 브리지 — 팀원 설치 안내

쓰레드 발간 도구(https://pvre-threads-publish.vercel.app)는 서버에서 Claude 를 부르지 않는다.
**당신 브라우저가 당신 PC(맥·윈도우)에서 도는 이 작은 프로그램(브리지)을 부르고, 브리지가 당신 계정의 `claude`(또는 `codex`)를 실행한다.**

> 윈도우 PC는 아래 [윈도우 설치](#윈도우-설치-powershell) 절을 따른다(v0.5.0부터). 이 위쪽은 맥 기준이다.
그래서 회사에 API 과금이 없고, 서버에 키가 저장되지 않는다.

브리지는 public 저장소 https://github.com/thyoon-pvre/pvre-claude-bridge 에 있다.
초대나 GitHub 로그인 없이 `git clone` 만 하면 된다.

## 전제 (설치 전에 확인)

| 필요 | 확인 명령 | 없으면 |
|---|---|---|
| macOS (윈도우는 아래 별도 절) | — | 아이폰·아이패드 불가 |
| Node.js 18+ | `node -v` | https://nodejs.org 에서 LTS 설치 |
| git | `git --version` | Xcode CLT(`xcode-select --install`) 또는 `brew install git` |
| Claude Code CLI, 로그인 상태 | `claude --version` 그리고 `claude -p "hi"` 가 답하는지 | `npm i -g @anthropic-ai/claude-code` 후 `claude` 실행해 로그인 |
| Chrome (Safari 불가) | — | WebKit 은 https 페이지의 127.0.0.1 호출을 막는다. 설정으로 못 푼다 |

## 설치 (터미널에서 그대로)

```bash
# 1. 저장소를 홈 아래에 받는다 (위치를 옮기면 재설치해야 한다)
git clone https://github.com/thyoon-pvre/pvre-claude-bridge.git ~/pvre-claude-bridge && cd ~/pvre-claude-bridge

# 2. 허용 주소 파일을 자리에 놓는다 (발간 도구 주소가 이미 들어 있다)
mkdir -p ~/.config/pvre
cp bridge.example.json ~/.config/pvre/bridge.json

# 3. 설치 — launchd 에 등록되고 토큰이 화면에 출력된다
chmod +x install.sh uninstall.sh verify-bridge.sh
./install.sh
```

`install.sh` 가 끝나면 이렇게 나온다:

```
{"ok":true,"version":"0.1.0","mode":"prod","dryRun":false,"claudeAvailable":true,...}

▶ 브리지 토큰 — 백오피스 /settings/bridge 에 붙여넣어라
  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- `claudeAvailable` 가 `false` 면 `claude` CLI 가 PATH 에 없다. 설치·로그인 후 `./install.sh` 를 다시 돌려라.
- 토큰 줄을 복사해 둔다. (`cat ~/.config/pvre/bridge-token` 으로 언제든 다시 볼 수 있다.)
- "백오피스 /settings/bridge" 라고 나오지만, 발간 도구에서는 아래 배지 화면에 붙여넣으면 된다.

## 발간 도구에 연결

1. Chrome 으로 https://pvre-threads-publish.vercel.app 접속 → PIN 로그인
2. 상단 **"내 Claude · 연결 안 됨"** 배지 클릭 → 토큰 붙여넣기 → 저장
3. Chrome 이 **"로컬 네트워크 장치에 접근하도록 허용하시겠습니까?"** 라고 물으면 **[허용]**
   — 거부하면 아무 오류 없이 조용히 실패한다. 실수로 거부했으면 주소창 왼쪽 자물쇠 → 사이트 설정 → "로컬 네트워크 접근" 을 허용으로.
4. 배지가 **"연결됨"** 으로 바뀌면 끝. 초안 생성 1회로 확인.

토큰은 브라우저 localStorage 에만 저장되고 Vercel 서버로 가지 않는다.

## 업데이트

브리지가 바뀌면 안내가 갈 것이다. 그때는 아래 두 줄이면 된다.

```bash
cd ~/pvre-claude-bridge && git pull
./install.sh                  # 재등록. 토큰은 그대로 유지된다
```

## 안 될 때

| 증상 | 원인 | 조치 |
|---|---|---|
| `curl -s http://127.0.0.1:8799/v1/health` 응답 없음 | 브리지가 안 떠 있음 | `launchctl kickstart -k gui/$(id -u)/com.pvre.claude-bridge` · 로그 `/tmp/pvre-bridge.err` |
| install.sh 가 "포트 8799 를 이미 누군가 쓰고 있다" | 다른 프로그램이 점유 | 표시된 프로세스를 끄거나 `PVRE_BRIDGE_PORT=8797 ./install.sh` (이 경우 화면 설정에서 포트도 바꿔야 한다) |
| 화면에서 "연결 안 됨" 인데 curl 은 된다 | ① Chrome 로컬 네트워크 접근 거부 ② `bridge.json` 에 이 주소가 없음 | ① 위 3번 ② 화면의 실패 안내 ③번 칸에 나온 `bridge.json` 내용을 `~/.config/pvre/bridge.json` 에 복사 후 kickstart |
| "토큰 다시 등록" | 토큰 불일치 | `cat ~/.config/pvre/bridge-token` 값을 다시 붙여넣기 |
| `claude 를 찾지 못함` | CLI 미설치·미로그인 | `which claude`, `claude -p "hi"` 확인 후 `./install.sh` 재실행 |
| Safari/아이폰 | 지원 안 함 | Chrome 데스크톱 |

맥이 잠들면 브리지도 멈추고 깨어나면 돌아온다. 발간 도구를 쓸 때 맥이 켜져 있으면 된다.

## 제거

```bash
cd ~/pvre-claude-bridge
./uninstall.sh                # launchd 해제 (토큰은 남김)
./uninstall.sh --purge-token  # 토큰까지 삭제
```

## 윈도우 설치 (PowerShell)

v0.5.0부터 윈도우 10/11 에서도 돈다. launchd 대신 **작업 스케줄러(내 계정 로그온 시 실행)** 로 등록하며 **관리자 권한이 필요 없다**.
회사 정책으로 작업 스케줄러 등록이 막히면 스크립트가 알아서 **시작프로그램 바로가기**로 대신 등록한다.
명령은 전부 **PowerShell**(시작 → "PowerShell" 검색) 기준이다. 관리자 권한으로 열지 않는다.

### 전제

| 필요 | 확인 명령 | 없으면 |
|---|---|---|
| Node.js 18+ (LTS) | `node -v` | https://nodejs.org 에서 LTS 설치 → PowerShell 새로 열기 |
| Git for Windows | `git --version` | https://git-scm.com/download/win (Claude Code 도 이것을 쓴다) |
| Claude Code, 로그인 | `where.exe claude` 그리고 `claude.cmd -p "hi"`(네이티브 설치면 `claude -p "hi"`) | `irm https://claude.ai/install.ps1 \| iex` 또는 `npm i -g @anthropic-ai/claude-code` → `claude` 실행해 로그인 |
| (Codex 쓸 때) Codex CLI, ChatGPT 로그인 | `codex.cmd login status` → `Logged in using ChatGPT` | `npm i -g @openai/codex` → `codex.cmd login` |
| Chrome 또는 Edge | — | 둘 다 된다. "로컬 네트워크 접근" 질문에 [허용] |

PowerShell 에서 `claude`·`codex` 를 치면 "이 시스템에서 스크립트를 실행할 수 없으므로…" 오류가 날 수 있다(npm 이 만든 `.ps1` 래퍼가 실행 정책에 막힘).
그때는 `claude.cmd`·`codex.cmd` 로 부르면 된다. 브리지는 이 래퍼를 쓰지 않으므로 영향이 없다.

### 설치

```powershell
# 1. 저장소를 홈 아래에 받는다 (위치를 옮기면 재설치)
git clone https://github.com/thyoon-pvre/pvre-claude-bridge.git "$HOME\pvre-claude-bridge"; cd "$HOME\pvre-claude-bridge"

# 2. Claude 브리지(127.0.0.1:8799) — 발주 시스템 주소를 허용 목록에 같이 넣는다
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AllowOrigin https://pvre-order-prototype.vercel.app

# 3. (Codex도 쓸 때) Codex 브리지(127.0.0.1:8797)
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex.ps1 -AllowOrigin https://pvre-order-prototype.vercel.app
```

`-ExecutionPolicy Bypass` 는 이 한 번 실행에만 적용된다(PC 설정을 바꾸지 않는다).
설치가 끝나면 `{"ok":true,"version":"0.5.0","engine":"claude","engineAvailable":true,...}` 가 나와야 한다. 토큰 값은 화면에 찍히지 않는다.

### 토큰 복사 · 연결

```powershell
Get-Content "$HOME\.config\pvre\bridge-token" | Set-Clipboard          # Claude
Get-Content "$HOME\.config\pvre\bridge-token.codex" | Set-Clipboard    # Codex
```

발주 시스템 › **내 AI 연결** › 해당 브릿지 토큰 칸에 붙여넣고 저장 → [연결 테스트]. Chrome·Edge 가 로컬 네트워크 접근을 물으면 [허용].

### 상태 확인 · 재시작 · 제거

```powershell
Invoke-RestMethod http://127.0.0.1:8799/v1/health        # Codex 는 8797
Get-ScheduledTask "PVRE Claude Bridge"                   # 등록 확인(시작프로그램으로 등록됐으면 없음)
# 재시작 = 설치 스크립트 다시 실행(토큰 유지)
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\pvre-claude-bridge\install.ps1"
# 제거(토큰 남김) / 토큰까지
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\pvre-claude-bridge\uninstall.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\pvre-claude-bridge\uninstall.ps1" -PurgeToken
# Codex 는 install-codex.ps1 / uninstall-codex.ps1
```

업데이트: `cd "$HOME\pvre-claude-bridge"; git pull` 후 설치 스크립트 다시 실행.

### 윈도우에서 다른 점

| 항목 | 맥 | 윈도우 |
|---|---|---|
| 자동 실행 | launchd (`com.pvre.*-bridge`) | 작업 스케줄러 `PVRE Claude Bridge`·`PVRE Codex Bridge` (막히면 시작프로그램) |
| 실행 로그 | `/tmp/pvre-*.out/.err` | `%USERPROFILE%\.local\state\pvre\bridge*.out.log/.err.log` |
| 토큰 권한 | `chmod 600` | `icacls` 로 상속 끊고 내 계정만 |
| 엔진 실행 | `claude`·`codex` 그대로 | `claude.exe` 그대로, npm 의 `claude.cmd`·`codex.cmd` 는 안의 `cli.js`·`codex.js` 를 node 로 직접 실행(cmd.exe 를 거치지 않는다 — 인자 주입 방지) |
| 상시 작업자(worker) | `install-worker.sh` | **아직 설치 스크립트 없음**(코드는 돌지만 등록 스크립트 미제공) |

### 윈도우에서 안 될 때

| 증상 | 조치 |
|---|---|
| `Invoke-RestMethod …/v1/health` 실패 | 설치 스크립트 다시 실행 · `%USERPROFILE%\.local\state\pvre\bridge.err.log` 확인 |
| "포트 8799 를 다른 프로그램이 쓰고 있다" | 그 프로그램 종료 또는 `-Port 8796` (화면의 "브릿지 주소 바꾸기"도 같이) |
| `engineAvailable:false` | `where.exe claude`(또는 codex) 로 설치 확인 → 설치·로그인 후 설치 스크립트 다시 실행 |
| 화면은 "연결 안 됨"인데 health 는 됨 | ① Chrome/Edge 사이트 설정에서 로컬 네트워크 접근 허용 ② 설치 스크립트를 `-AllowOrigin <발주 시스템 주소>` 로 다시 실행 |
| `.cmd 안에서 실행 대상을 찾지 못했다` | npm 래퍼 형식이 다르다. 환경변수 `PVRE_CLAUDE_BIN`(또는 `PVRE_CODEX_BIN`)에 `claude.exe` 나 `cli.js` 절대경로를 넣고 재설치 |

PC가 절전에 들어가면 브리지도 멈추고, 깨어나면 다시 응답한다. 로그오프하면 멈추고 다시 로그온하면 뜬다.

## 보안 메모

- 브리지는 `127.0.0.1` 에만 붙는다. 같은 와이파이의 다른 기기는 접근할 수 없다.
- 허용 주소는 `~/.config/pvre/bridge.json` 의 것뿐이다. 임의 사이트가 부를 수 없다.
- 로그(`~/.local/state/pvre/bridge.log`)에 프롬프트·응답 본문은 남지 않는다.
- 토큰(`~/.config/pvre/bridge-token`)은 채팅·슬랙에 붙여넣지 마라. 유출 시 `./uninstall.sh --purge-token && ./install.sh` 로 회전.
- `bridge.json`·토큰은 `~/.config/pvre/` 에만 있다. 저장소 폴더 안에는 만들지 마라 (커밋될 수 있다).

원본 개발 문서: [`README.md`](README.md) (API·환경변수·검증 모드).
