#!/usr/bin/env node
// PVRE 상시 작업자(v0.4.0) — 브라우저 없이 이 맥에서 pvre-order 해석 작업을 끌어와 로컬 claude(기본)·codex 로 처리한다.
//  launchd(com.pvre.ai-worker) 로 띄운다: ./install-worker.sh. 브라우저 브리지(server.mjs)와 따로 돈다(같이 켜 둬도 된다 — 서버가 한 곳만 준다).
//
// 설정(환경변수 — plist 에 적는다)
//  PVRE_WORKER_SERVER            발주시스템 주소(https). 예: https://pvre-order-prototype.vercel.app
//  PVRE_WORKER_ENGINE            claude(기본) | codex
//  PVRE_WORKER_TOKEN_FILE        기기 토큰 파일(기본 ~/.config/pvre/worker-token, 권한 600 아니면 시작 거부)
//  PVRE_WORKER_KEYCHAIN_SERVICE  있으면 파일 대신 macOS 키체인에서 읽는다(security find-generic-password -s <값> -w)
//  PVRE_WORKER_LOG_FILE          기본 ~/.local/state/pvre/worker.log (한 줄 JSON — 본문·토큰 없음)
//  PVRE_WORKER_IDLE_MS / PVRE_WORKER_WAIT_SEC   빈 큐일 때 쉬는 시간(기본 20000) / 서버 긴 폴링(기본 0, 최대 20)
//  PVRE_CLAUDE_BIN / PVRE_CODEX_BIN             엔진 경로 고정(없으면 PATH·~/.local/bin·/opt/homebrew/bin 에서 찾는다)
//  PVRE_BRIDGE_DRY_RUN=1          엔진을 부르지 않는다(연결 확인용 — 서버에는 스키마 불일치로 보고돼 다시 대기로 간다)
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, resolveEngineBin, runClaudeBin, runCodexBin } from './engines.mjs';
import { createWorker, validServerUrl } from './worker-core.mjs';

const VERSION = '0.4.0';
const ENGINE = process.env.PVRE_WORKER_ENGINE === 'codex' ? 'codex' : 'claude';
const LOG_FILE = expandHome(process.env.PVRE_WORKER_LOG_FILE || join(homedir(), '.local/state/pvre/worker.log'));
const TOKEN_FILE = expandHome(process.env.PVRE_WORKER_TOKEN_FILE || join(homedir(), '.config/pvre/worker-token'));
const DRY_RUN = process.env.PVRE_BRIDGE_DRY_RUN === '1';

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), app: 'ai-worker', engine: ENGINE, ...entry });
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch (e) {
    console.error(`[worker] 로그 기록 실패 (${LOG_FILE}): ${e.message}`);
  }
}

/** 토큰: 키체인(설정 시) → 파일(600). 값은 출력하지 않는다 */
export function loadToken() {
  const svc = process.env.PVRE_WORKER_KEYCHAIN_SERVICE;
  if (svc) {
    try {
      return execFileSync('/usr/bin/security', ['find-generic-password', '-s', svc, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new Error(`키체인에서 토큰을 찾지 못했다(서비스 ${svc}). install-worker.sh 안내대로 등록했는지 확인`);
    }
  }
  if (!existsSync(TOKEN_FILE)) throw new Error(`토큰 파일이 없다: ${TOKEN_FILE}`);
  const mode = statSync(TOKEN_FILE).mode & 0o777;
  if (mode & 0o077) throw new Error(`토큰 파일 권한이 너무 넓다(${mode.toString(8)}). chmod 600 ${TOKEN_FILE}`);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

function main() {
  const server = validServerUrl(process.env.PVRE_WORKER_SERVER || '');
  if (!server) {
    console.error('[worker] PVRE_WORKER_SERVER 가 없거나 https 주소가 아니다.');
    log({ event: 'config_error', ok: false, code: 'SERVER_URL' });
    process.exit(78); // EX_CONFIG — launchd 가 바로 다시 띄우지 않게 plist 에 ThrottleInterval
  }
  let token;
  try {
    token = loadToken();
  } catch (e) {
    console.error(`[worker] ${e.message}`);
    log({ event: 'config_error', ok: false, code: 'TOKEN' });
    process.exit(78);
  }
  if (!/^pvw1_[A-Za-z0-9_-]{43}$/.test(token)) {
    console.error('[worker] 토큰 형식이 아니다(pvw1_…). 발주시스템 › 내 AI 연결 › 상시 작업자에서 발급한 값을 그대로 넣어라.');
    log({ event: 'config_error', ok: false, code: 'TOKEN_FORMAT' });
    process.exit(78);
  }
  let bin = resolveEngineBin(ENGINE);
  const available = () => {
    if (DRY_RUN) return true;
    if (!bin) bin = resolveEngineBin(ENGINE); // 설치 직후 재시작 없이 붙게
    return Boolean(bin);
  };
  const run = (prompt, ms) => (ENGINE === 'codex' ? runCodexBin(bin, prompt, ms, { dryRun: DRY_RUN }) : runClaudeBin(bin, prompt, ms, { dryRun: DRY_RUN }));
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  const w = createWorker({
    serverUrl: server, token, provider: ENGINE, run, available, log, version: VERSION,
    options: { idleMs: num(process.env.PVRE_WORKER_IDLE_MS, 20_000), waitSec: Math.min(20, Math.max(0, num(process.env.PVRE_WORKER_WAIT_SEC, 0))) },
  });
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log({ event: 'shutdown', signal: sig, ok: true }); ac.abort(); });
  console.log(`[worker] PVRE 상시 작업자 v${VERSION} — 엔진 ${ENGINE}${DRY_RUN ? ' (dry-run)' : ''} · 서버 ${server} · 로그 ${LOG_FILE}`);
  console.log(`[worker] ${ENGINE}: ${bin || '찾지 못함 — CLI 설치·로그인 확인'}`);
  w.runForever(ac.signal).then(() => process.exit(0), (e) => {
    console.error(`[worker] 중단: ${e?.message}`);
    log({ event: 'crash', ok: false, code: e?.name || 'Error' });
    process.exit(1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
