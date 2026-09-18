# PVRE 로컬 Claude 브리지 v0

백오피스(Vercel)는 Claude 를 부르지 않는다. **당신의 브라우저가 당신 맥에서 도는 이 프로그램을 부르고,
이 프로그램이 당신 계정의 `claude -p` 를 실행한다.** 그래서 회사에 종량 과금이 발생하지 않고,
서버에 API 키가 저장되지 않는다.

정본 저장소: https://github.com/thyoon-pvre/pvre-claude-bridge (public).

## 설치 (5단계)

저장소는 public 이라 초대나 GitHub 로그인 없이 받을 수 있다.
팀원용 단계별 안내는 [`README-팀원설치.md`](README-팀원설치.md) 에 있다.

```bash
git clone https://github.com/thyoon-pvre/pvre-claude-bridge.git ~/pvre-claude-bridge   # 1. 저장소 받기
cd ~/pvre-claude-bridge

mkdir -p ~/.config/pvre                                                          # 2. 허용 Origin 등록
cp bridge.example.json ~/.config/pvre/bridge.json                                #    (발간 도구 https://pvre-threads-publish.vercel.app 가 들어 있다)

./install.sh                                                                     # 3. launchd 등록 + 토큰 생성·출력
                                                                                 # 4. 출력된 토큰을 백오피스 /settings/bridge 에 붙여넣기
                                                                                 # 5. Chrome 이 "로컬 네트워크 접근"을 물으면 [허용]
```

2번을 빼먹으면 브리지는 뜨지만 배포된 화면에서 부르는 요청이 `ORIGIN_NOT_ALLOWED`(403) 로 막힌다.
`bridge.json` 은 `~/.config/pvre/` 에만 두고 저장소에는 `bridge.example.json` 샘플만 있다.

전제: 맥에 `claude` CLI 가 설치돼 있고 로그인돼 있어야 한다 (`which claude`).

**4단계를 흘려보내지 마라.** Chrome 142+ 는 공개 사이트가 `127.0.0.1` 을 부를 때 권한을 묻는다.
거부하면 요청이 **조용히 실패**하고, 모르면 원인을 찾는 데 시간을 태운다.

## 확인

```bash
curl -s http://127.0.0.1:8799/v1/health
# {"ok":true,"version":"0.1.0","mode":"prod","dryRun":false,
#  "claudeAvailable":true,"busy":false,"queued":0,"maxQueue":5}
```

## 제거

```bash
./uninstall.sh                # launchd 해제 + plist 삭제 (토큰은 남김)
./uninstall.sh --purge-token  # 토큰까지 삭제
```

브리지를 지워도 백오피스는 그대로 돈다. LLM 기능만 비활성화된다.

## API

| 메서드 | 경로 | 인증 | 용도 |
|---|---|---|---|
| `GET` | `/v1/health` | 불필요 | 연결 확인. 민감정보를 담지 않는다 |
| `POST` | `/v1/run` | `Authorization: Bearer <token>` | `claude -p` 실행 |
| `OPTIONS` | `*` | — | CORS 프리플라이트 |

```jsonc
// POST /v1/run
{ "app": "legal", "task": "infer", "prompt": "...", "timeoutMs": 120000 }

// → 200 성공
{ "ok": true, "text": "...", "elapsedMs": 13731, "exitCode": 0, "mode": "prod" }

// → 200 실패 (실행 실패도 200 으로 내려보내고 본문에 사유를 담는다)
{ "ok": false, "code": "CLAUDE_NOT_FOUND", "error": "claude CLI 를 찾지 못했다 (PATH 확인)" }
```

에러 코드: `CLAUDE_NOT_FOUND` · `TIMEOUT` · `NONZERO_EXIT` · `QUEUE_FULL` ·
`UNAUTHORIZED`(401) · `ORIGIN_NOT_ALLOWED`(403) · `PROMPT_TOO_LARGE`(413) · `BAD_REQUEST`(400)

동작 규칙:
- 프롬프트는 **stdin** 으로 넣는다. argv 로 넘기면 길어질 때 `ARG_MAX` 에 걸린다.
- 호출은 **전역 큐 1개로 직렬화**한다. 대기 5건 초과는 즉시 `QUEUE_FULL`.
- 타임아웃 기본 120초, 요청별 지정 가능, **상한 300초**. 초과 시 `SIGKILL`.
- 프롬프트 상한 1MB.
- **모델을 강제하지 않는다.** 각자 CLI 설정의 모델을 쓴다 — "각자 자기 클로드"라는 요구 그대로다.

## 보안

| 위협 | 막는 지점 |
|---|---|
| 임의 웹사이트가 브리지 호출 | Origin 허용목록 + Chrome LNA 권한 |
| 같은 맥의 다른 프로세스 | Bearer 토큰 (`timingSafeEqual` 비교) |
| LAN 의 다른 기기 | `127.0.0.1` 바인딩 (`0.0.0.0` 으로 바꿀 수 있는 경로 없음) |
| 토큰이 서버에서 유출 | **서버가 토큰을 모른다.** 브라우저 localStorage 에만 있다 |

- 허용 Origin 기본값은 `http://localhost:3000` 계열뿐이다. 배포 URL 은 아래 둘 중 하나로 추가한다:
  - 환경변수 `PVRE_BRIDGE_ALLOWED_ORIGINS=https://<프로젝트>.vercel.app`
  - 또는 `~/.config/pvre/bridge.json` → `{"allowedOrigins":["https://<프로젝트>.vercel.app"]}`
- `Access-Control-Allow-Origin: *` 를 쓰지 않는다.
- 토큰 회전: `./uninstall.sh --purge-token` 후 `./install.sh` → 새 토큰을 다시 붙여넣는다.

## 로그

`~/.local/state/pvre/bridge.log` 에 한 줄씩. **프롬프트와 응답 본문은 쓰지 않는다.**

```jsonc
{"ts":"2026-09-16T01:20:00.000Z","mode":"prod","app":"legal","task":"infer",
 "promptChars":812,"elapsedMs":13731,"ok":true,"code":null}
```

검토 대상 문구나 초안 원고 같은 업무 내용이 로그에 쌓이면 안 되기 때문이다.

## 검증 실행 — 운영과 섞지 않는다

테스트·시연은 **반드시** `verify-bridge.sh` 로 한다. 포트·토큰·로그가 전부 갈린다.

```bash
./verify-bridge.sh    # 8798 / bridge-token.verify / bridge.verify.log
```

`/v1/health` 응답의 `"mode":"verify"` 로 지금 어느 쪽이 떠 있는지 확인한다.
`PVRE_BRIDGE_DRY_RUN=1` 을 주면 `claude` 를 아예 실행하지 않는다 —
**켜는 방향으로만 동작하고, 요청이나 설정 파일로는 끌 수 없다.**

## 설정 환경변수

| 변수 | 운영 기본값 | 검증 기본값 |
|---|---|---|
| `PVRE_BRIDGE_PORT` | `8799` | `8798` |
| `PVRE_BRIDGE_TOKEN_FILE` | `~/.config/pvre/bridge-token` | `~/.config/pvre/bridge-token.verify` |
| `PVRE_BRIDGE_LOG_FILE` | `~/.local/state/pvre/bridge.log` | `~/.local/state/pvre/bridge.verify.log` |
| `PVRE_BRIDGE_ALLOWED_ORIGINS` | (localhost:3000 내장) | 〃 |
| `PVRE_BRIDGE_MODE` | `prod` | `verify` |
| `PVRE_BRIDGE_DRY_RUN` | 없음 | 선택 (`1`) |
| `PVRE_CLAUDE_BIN` | 자동 탐색 | 〃 |

경로와 포트를 코드에 하드코딩하지 않는다. 하드코딩되어 있으면 격리가 불가능해진다.

## 한계

- 맥이 켜져 있고 브리지가 떠 있어야 한다. **모바일·태블릿 불가.**
- 브라우저 탭을 닫으면 진행 중 호출이 끊긴다. 긴 배치는 브리지가 아니라 로컬 CLI 로.
- 사용자마다 CLI 모델 설정이 다를 수 있다 → 같은 프롬프트가 사람마다 다른 결과를 낼 수 있다.
  판정 재현성이 필요한 작업에는 `--model` 고정을 검토한다.
- `KeepAlive` 는 맥이 잠들면 멈추고 깨어나면 돌아온다. 브리지는 요청 응답형이라 캐치업 문제가 없다.
