#!/usr/bin/env node
// PVRE 로컬 Claude 브리지 v0 (+ Codex 엔진, v0.2.0)
//
// 엔진(PVRE_BRIDGE_ENGINE): claude(기본) | codex. 기동 시 한 번 정해지고 요청으로 바꿀 수 없다.
//  codex 엔진은 같은 코드(인증·Origin·큐·로그 규칙 그대로)를 다른 포트·토큰·로그로 띄우고, 모델 호출만 `codex exec`로 바꾼다.
//  codex 실행은 잠근다: 사용자 config.toml 무시(MCP·플러그인·훅 없음) · 셸/코드 실행·웹 검색·이미지·브라우저·하위 에이전트 끔 ·
//  읽기 전용 샌드박스 · 빈 임시 작업 폴더 · 세션 기록 안 남김(--ephemeral). 응답은 마지막 메시지 파일에서만 읽는다.
//
// 서버(Vercel)는 Claude 를 부르지 않는다. 각 사용자의 브라우저가 자기 맥에서 도는
// 이 프로그램을 직접 부르고, 이 프로그램이 `claude -p` 를 실행한다.
// 설계 원칙: 과금·키·프롬프트 본문이 서버에 남지 않게 한다.
//
// 원칙
//  - 런타임 의존성 0. node: 내장 모듈만 쓴다. 팀원 맥에 npm install 을 요구하지 않는다.
//  - 127.0.0.1 에만 바인딩한다. LAN 에 노출되면 안 된다.
//  - 프롬프트·응답 본문을 로그에 쓰지 않는다. 업무 문서가 로그에 쌓이면 안 된다.
//  - 포트·토큰·로그 경로를 하드코딩하지 않는다. 전부 환경변수 기본값이다 — 운영/검증 격리 때문이다.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  appendFileSync, accessSync, constants as FS,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const VERSION = '0.2.0';

// ─────────────────────────────────────────────────────────────────────────────
// 설정 — 전부 환경변수. 기본값은 "운영", verify 모드면 별도 경로로 갈린다.
// ─────────────────────────────────────────────────────────────────────────────

/** ~ 를 실제 홈으로 편다. 환경변수로 받은 경로에 ~ 가 들어오는 일이 잦다. */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// 모드는 기동 시 한 번 정해지고, 이후 어떤 요청으로도 바뀌지 않는다.
// verify -> prod 로 되돌리는 경로를 코드에 두지 않는다. 검증 프로세스가 운영으로 승격되는 길을 막는다.
const MODE = process.env.PVRE_BRIDGE_MODE === 'verify' ? 'verify' : 'prod';
const IS_VERIFY = MODE === 'verify';
// 엔진도 기동 시 한 번. 알 수 없는 값은 claude(기존 동작) — codex는 명시적으로 켤 때만.
const ENGINE = process.env.PVRE_BRIDGE_ENGINE === 'codex' ? 'codex' : 'claude';
const IS_CODEX = ENGINE === 'codex';

// codex 엔진은 포트·토큰·로그를 claude 와 따로 쓴다(같은 맥에서 둘 다 띄운다).
const SUFFIX = IS_CODEX ? '.codex' : '';
const DEFAULTS = IS_VERIFY
  ? {
      port: IS_CODEX ? 8796 : 8798,
      tokenFile: join(homedir(), `.config/pvre/bridge-token${SUFFIX}.verify`),
      logFile: join(homedir(), `.local/state/pvre/bridge${SUFFIX}.verify.log`),
    }
  : {
      port: IS_CODEX ? 8797 : 8799,
      tokenFile: join(homedir(), `.config/pvre/bridge-token${SUFFIX}`),
      logFile: join(homedir(), `.local/state/pvre/bridge${SUFFIX}.log`),
    };

const PORT = Number(process.env.PVRE_BRIDGE_PORT || DEFAULTS.port);
const HOST = '127.0.0.1'; // 고정. 0.0.0.0 으로 바꿀 수 있는 경로를 두지 않는다.
const TOKEN_FILE = expandHome(process.env.PVRE_BRIDGE_TOKEN_FILE || DEFAULTS.tokenFile);
const LOG_FILE = expandHome(process.env.PVRE_BRIDGE_LOG_FILE || DEFAULTS.logFile);
const CONFIG_FILE = expandHome(process.env.PVRE_BRIDGE_CONFIG || join(homedir(), '.config/pvre/bridge.json'));

// DRY_RUN 은 켜는 방향으로만 간다. 요청·설정파일로 끌 수 없다.
const DRY_RUN = process.env.PVRE_BRIDGE_DRY_RUN === '1';

const MAX_QUEUE = Number(process.env.PVRE_BRIDGE_MAX_QUEUE || 5);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PROMPT_BYTES = 1_048_576; // 1MB

const BUILTIN_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function loadConfigFile() {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    // 설정 파일이 깨졌다고 브리지가 죽으면 안 된다. 다만 조용히 넘기지도 않는다.
    console.error(`[bridge] 설정 파일을 읽지 못했다 (${CONFIG_FILE}): ${e.message}`);
    return {};
  }
}

const cfg = loadConfigFile();
const ALLOWED_ORIGINS = new Set([
  ...BUILTIN_ORIGINS,
  ...String(process.env.PVRE_BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  ...(Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : []),
]);

// ─────────────────────────────────────────────────────────────────────────────
// 토큰 — 첫 실행에 만들고 0600 으로 저장한다. 터미널에 한 번만 출력한다.
// ─────────────────────────────────────────────────────────────────────────────

function ensureToken() {
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return { token: t, created: false };
    console.error(`[bridge] 토큰 파일이 비었거나 너무 짧다. 새로 만든다: ${TOKEN_FILE}`);
  }
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return { token, created: true };
}

const { token: TOKEN, created: TOKEN_CREATED } = ensureToken();

/** 길이가 달라도 타이밍이 새지 않게 비교한다. */
function tokenMatches(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) {
    // 길이만으로 조기 반환하면 길이가 새지만, 그래도 비교 자체는 한 번 돌려 둔다.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// claude 바이너리 위치 — launchd 의 PATH 는 좁다. 직접 찾아 절대경로로 실행한다.
// ─────────────────────────────────────────────────────────────────────────────

function resolveClaudeBin() {
  const override = expandHome(IS_CODEX ? process.env.PVRE_CODEX_BIN : process.env.PVRE_CLAUDE_BIN);
  if (override) return isAbsolute(override) && canExec(override) ? override : null;
  const dirs = [
    ...String(process.env.PATH || '').split(':').filter(Boolean),
    join(homedir(), '.local/bin'),
    join(homedir(), '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const d of dirs) {
    const p = join(d, ENGINE);
    if (canExec(p)) return p;
  }
  return null;
}

function canExec(p) {
  try { accessSync(p, FS.X_OK); return true; } catch { return false; }
}

let CLAUDE_BIN = resolveClaudeBin();

// ─────────────────────────────────────────────────────────────────────────────
// 로그 — 한 줄 JSON. 프롬프트·응답 본문은 절대 넣지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), mode: MODE, engine: ENGINE, ...entry });
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch (e) {
    // 로그를 못 써도 서비스는 계속한다. 다만 삼키지 않고 stderr 에 남긴다.
    console.error(`[bridge] 로그 기록 실패 (${LOG_FILE}): ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 큐 — 전역 1개로 직렬화한다. 동시에 claude 를 여러 개 띄우지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

let queue = Promise.resolve();
let queued = 0;
let busy = false;

function enqueue(fn) {
  queued += 1;
  const run = queue.then(async () => {
    queued -= 1;
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }, async () => {
    queued -= 1;
    busy = true;
    try { return await fn(); } finally { busy = false; }
  });
  queue = run.then(() => {}, () => {});
  return run;
}

// ─────────────────────────────────────────────────────────────────────────────
// claude -p 실행 — 프롬프트는 argv 가 아니라 stdin 으로 넣는다 (ARG_MAX 회피).
// ─────────────────────────────────────────────────────────────────────────────

function runClaude(prompt, timeoutMs) {
  return new Promise((resolve) => {
    if (DRY_RUN) {
      resolve({ ok: true, text: `[dry-run] claude 를 실행하지 않았다. prompt ${prompt.length}자.`, exitCode: 0 });
      return;
    }
    if (!CLAUDE_BIN) {
      CLAUDE_BIN = resolveClaudeBin(); // 설치 직후 재시작 없이 붙게 한 번 더 찾는다.
      if (!CLAUDE_BIN) {
        resolve({ ok: false, code: 'CLAUDE_NOT_FOUND', error: 'claude CLI 를 찾지 못했다 (PATH 확인)' });
        return;
      }
    }

    let child;
    try {
      child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'text'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, code: 'CLAUDE_NOT_FOUND', error: `claude 실행 실패: ${e.message}` });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 이미 죽었으면 무시 */ }
      finish({ ok: false, code: 'TIMEOUT', error: `${timeoutMs}ms 안에 끝나지 않아 중단했다` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, code: 'CLAUDE_NOT_FOUND', error: `claude 실행 실패: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, text: out, exitCode: 0 });
      // stderr 를 통째로 돌려주면 그 안에 프롬프트 조각이 실릴 수 있다. 앞 500자만.
      else finish({ ok: false, code: 'NONZERO_EXIT', error: `claude 종료코드 ${code}: ${err.slice(0, 500)}`, exitCode: code });
    });

    child.stdin.on('error', (e) => finish({ ok: false, code: 'NONZERO_EXIT', error: `stdin 쓰기 실패: ${e.message}` }));
    child.stdin.end(prompt);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// codex exec 실행 — claude 와 같은 계약(stdin 프롬프트 → 텍스트 응답). 도구를 잠그고 마지막 메시지만 돌려준다.
// ─────────────────────────────────────────────────────────────────────────────

// 끄는 기능: 셸·코드 실행·하위 에이전트·이미지·브라우저·컴퓨터 제어·플러그인·앱·훅·기억·스킬 검색.
// codex 버전마다 기능 이름이 다를 수 있다 — 모르는 이름은 codex 가 무시한다(0.162.1 에서 확인).
const CODEX_DISABLE = [
  'shell_tool', 'unified_exec', 'code_mode_host', 'multi_agent', 'image_generation', 'browser_use', 'computer_use',
  'in_app_browser', 'view_image', 'plugins', 'apps', 'hooks', 'memories', 'skill_search', 'tool_suggest', 'goals',
];

function codexArgs(workDir, outFile) {
  const args = [
    'exec',
    '--ephemeral',               // 세션 기록(~/.codex/sessions)에 메일 원문을 남기지 않는다
    '--skip-git-repo-check',
    '--ignore-user-config',      // config.toml 의 MCP 서버(카톡·메일 등)·플러그인·notify 를 싣지 않는다. 인증은 CODEX_HOME 그대로
    '--ignore-rules',
    '--sandbox', 'read-only',
    '-C', workDir,
    '--color', 'never',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'web_search="disabled"',
    '-o', outFile,
  ];
  for (const f of CODEX_DISABLE) args.push('--disable', f);
  if (process.env.PVRE_CODEX_MODEL) args.push('-m', process.env.PVRE_CODEX_MODEL);
  if (process.env.PVRE_CODEX_REASONING) args.push('-c', `model_reasoning_effort="${process.env.PVRE_CODEX_REASONING.replace(/[^a-z]/g, '')}"`);
  args.push('-');                // 프롬프트는 stdin
  return args;
}

/**
 * codex 의 stderr 에는 프롬프트가 그대로 다시 찍힌다("user\n<프롬프트>"). 그대로 돌려주면 메일 원문이 오류 메시지로 새어 나간다.
 * codex 로그 형식의 ERROR 줄만 골라 앞 300자만 준다.
 */
export function codexErrorSummary(stderr) {
  // 메일 본문에도 "Error:" 같은 줄이 있을 수 있다 → codex 자체 로그 형식(ISO 시각 + ERROR)인 줄만 쓴다.
  const lines = String(stderr).split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+ERROR\s/.test(l));
  return lines.slice(-2).join(' | ').slice(0, 300) || '(codex 로그에 오류 줄 없음 — 터미널에서 codex login status 확인)';
}

function runCodex(prompt, timeoutMs) {
  return new Promise((resolve) => {
    if (DRY_RUN) {
      resolve({ ok: true, text: `[dry-run] codex 를 실행하지 않았다. prompt ${prompt.length}자.`, exitCode: 0 });
      return;
    }
    if (!CLAUDE_BIN) {
      CLAUDE_BIN = resolveClaudeBin();
      if (!CLAUDE_BIN) {
        resolve({ ok: false, code: 'CODEX_NOT_FOUND', error: 'codex CLI 를 찾지 못했다 (PATH 확인)' });
        return;
      }
    }
    let workDir;
    try {
      workDir = mkdtempSync(join(tmpdir(), 'pvre-codex-'));
    } catch (e) {
      resolve({ ok: false, code: 'NONZERO_EXIT', error: `임시 폴더를 만들지 못했다: ${e.message}` });
      return;
    }
    const outFile = join(workDir, 'last-message.txt');
    const cleanup = () => { try { rmSync(workDir, { recursive: true, force: true }); } catch (e) { console.error(`[bridge] 임시 폴더 정리 실패: ${e.message}`); } };

    let child;
    try {
      child = spawn(CLAUDE_BIN, codexArgs(workDir, outFile), {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // codex.js → 네이티브 바이너리. 타임아웃 때 프로세스 그룹째 죽인다
        // codex 는 `#!/usr/bin/env node` 스크립트다. launchd 의 좁은 PATH 에서도 이 node 를 찾게 앞에 붙인다.
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` },
      });
    } catch (e) {
      cleanup();
      resolve({ ok: false, code: 'CODEX_NOT_FOUND', error: `codex 실행 실패: ${e.message}` });
      return;
    }

    let err = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); resolve(r); } };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 이미 끝남 */ } }
      finish({ ok: false, code: 'TIMEOUT', error: `${timeoutMs}ms 안에 끝나지 않아 중단했다` });
    }, timeoutMs);

    child.stdout.on('data', () => { /* 진행 출력은 버린다 — 응답은 -o 파일에서만 읽는다 */ });
    child.stderr.on('data', (d) => { if (err.length < 200_000) err += d; });
    child.on('error', (e) => finish({ ok: false, code: 'CODEX_NOT_FOUND', error: `codex 실행 실패: ${e.message}` }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, code: 'NONZERO_EXIT', error: `codex 종료코드 ${code}: ${codexErrorSummary(err)}`, exitCode: code });
        return;
      }
      let text = '';
      try { text = readFileSync(outFile, 'utf8'); } catch (e) {
        finish({ ok: false, code: 'NONZERO_EXIT', error: `codex 응답 파일을 읽지 못했다: ${e.message}`, exitCode: 0 });
        return;
      }
      if (!text.trim()) finish({ ok: false, code: 'EMPTY_RESPONSE', error: 'codex 가 빈 응답을 냈다', exitCode: 0 });
      else finish({ ok: true, text, exitCode: 0 });
    });
    child.stdin.on('error', (e) => finish({ ok: false, code: 'NONZERO_EXIT', error: `stdin 쓰기 실패: ${e.message}` }));
    child.stdin.end(prompt);
  });
}

const runEngine = IS_CODEX ? runCodex : runClaude;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return 'no-origin'; // curl 등. CORS 는 브라우저 규약이라 헤더를 줄 필요가 없다.
  if (!ALLOWED_ORIGINS.has(origin)) return 'blocked';
  res.setHeader('Access-Control-Allow-Origin', origin); // '*' 금지
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  return 'allowed';
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 본문을 읽는다. 상한을 넘으면 내용은 버리되 **연결은 끊지 않고 끝까지 받아낸다** —
 * 소켓을 먼저 죽이면 413 응답이 클라이언트에 전달되지 않는다(실측: curl 이 100 만 받고 끝난다).
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const ENVELOPE_SLACK = 4096;           // JSON 봉투(app·task·timeoutMs) 여유분
    const LIMIT = MAX_PROMPT_BYTES + ENVELOPE_SLACK;
    const HARD_CAP = LIMIT * 8;            // 이만큼 넘어가면 드레인도 그만둔다
    let size = 0;
    let over = false;
    let chunks = [];

    req.on('data', (c) => {
      size += c.length;
      if (size > LIMIT) {
        over = true;
        chunks = [];                       // 들고 있을 이유가 없다
        if (size > HARD_CAP) { req.destroy(); resolve({ over: true }); }
        return;                            // 나머지는 받아서 버린다 (응답 전달 목적)
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? { over: true } : { over: false, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const cors = applyCors(req, res);

  if (cors === 'blocked') {
    log({ path: url.pathname, ok: false, code: 'ORIGIN_NOT_ALLOWED' });
    send(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED', error: '허용되지 않은 Origin' });
    return;
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /v1/health — 인증 불필요. 민감정보를 담지 않는다.
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    if (!CLAUDE_BIN) CLAUDE_BIN = resolveClaudeBin();
    const engineAvailable = Boolean(CLAUDE_BIN) || DRY_RUN;
    send(res, 200, {
      ok: true,
      version: VERSION,
      mode: MODE,            // "verify" 가 보이지 않으면 사람이 착각한다
      engine: ENGINE,        // 0.2.0 — 화면이 "Claude 자리에 Codex 브릿지"를 붙이지 않게 확인한다
      engineAvailable,
      dryRun: DRY_RUN,
      // 0.1.x 화면 호환: claude 엔진일 때만 true. codex 데몬을 Claude 자리에 붙이면 "claude 없음"으로 보인다
      claudeAvailable: !IS_CODEX && engineAvailable,
      busy,
      queued,
      maxQueue: MAX_QUEUE,
    });
    return;
  }

  // ── POST /v1/run — 토큰 필수
  if (req.method === 'POST' && url.pathname === '/v1/run') {
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!tokenMatches(given)) {
      log({ path: url.pathname, ok: false, code: 'UNAUTHORIZED' });
      send(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '토큰이 일치하지 않는다' });
      return;
    }

    let read;
    try {
      read = await readBody(req);
    } catch (e) {
      log({ path: url.pathname, ok: false, code: 'BAD_REQUEST' });
      send(res, 400, { ok: false, code: 'BAD_REQUEST', error: `요청 본문을 읽지 못했다: ${e.message}` });
      return;
    }
    if (read.over) {
      log({ path: url.pathname, ok: false, code: 'PROMPT_TOO_LARGE' });
      send(res, 413, { ok: false, code: 'PROMPT_TOO_LARGE', error: '프롬프트가 1MB 를 넘는다' });
      return;
    }
    const raw = read.raw;

    let body;
    try { body = JSON.parse(raw); } catch {
      send(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'JSON 파싱 실패' });
      return;
    }

    const app = typeof body.app === 'string' ? body.app.slice(0, 40) : 'unknown';
    const task = typeof body.task === 'string' ? body.task.slice(0, 40) : 'unknown';
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt) { send(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'prompt 가 비었다' }); return; }
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      log({ app, task, promptChars: prompt.length, ok: false, code: 'PROMPT_TOO_LARGE' });
      send(res, 413, { ok: false, code: 'PROMPT_TOO_LARGE', error: '프롬프트가 1MB 를 넘는다' });
      return;
    }

    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
      MAX_TIMEOUT_MS,
    );

    if (queued >= MAX_QUEUE) {
      log({ app, task, promptChars: prompt.length, ok: false, code: 'QUEUE_FULL' });
      send(res, 200, { ok: false, code: 'QUEUE_FULL', error: `대기열이 찼다 (최대 ${MAX_QUEUE})` });
      return;
    }

    const started = Date.now();
    const result = await enqueue(() => runEngine(prompt, timeoutMs));
    const elapsedMs = Date.now() - started;

    log({ app, task, promptChars: prompt.length, elapsedMs, ok: result.ok, code: result.code || null });
    // 실패도 200 으로 내려보내고 본문에 사유를 담는다 — 브라우저 fetch 가 HTTP 오류와 실행 실패를 구분하기 쉽다.
    send(res, 200, result.ok
      ? { ok: true, text: result.text, elapsedMs, exitCode: result.exitCode, mode: MODE }
      : { ok: false, code: result.code, error: result.error, elapsedMs, mode: MODE });
    return;
  }

  send(res, 404, { ok: false, code: 'NOT_FOUND', error: '없는 경로' });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[bridge] 포트 ${PORT} 가 이미 쓰이고 있다. PVRE_BRIDGE_PORT 로 바꾸거나 기존 프로세스를 확인해라.`);
    process.exit(1);
  }
  console.error(`[bridge] 서버 오류: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] PVRE 로컬 브리지 v${VERSION} — 엔진 ${ENGINE}`);
  console.log(`[bridge] 모드      : ${MODE}${DRY_RUN ? ' (dry-run)' : ''}`);
  console.log(`[bridge] 주소      : http://${HOST}:${PORT}`);
  console.log(`[bridge] 토큰 파일 : ${TOKEN_FILE}`);
  console.log(`[bridge] 로그 파일 : ${LOG_FILE}`);
  console.log(`[bridge] ${ENGINE.padEnd(6)}    : ${CLAUDE_BIN || `찾지 못함 — ${ENGINE} CLI 설치 확인`}`);
  console.log(`[bridge] 허용 Origin: ${[...ALLOWED_ORIGINS].join(', ') || '(없음)'}`);
  if (TOKEN_CREATED && IS_CODEX) {
    // codex 엔진은 토큰을 화면·launchd 로그(/tmp/*.out)에 찍지 않는다. 파일에서 클립보드로 복사하게 안내만 한다.
    console.log(`[bridge] 토큰을 새로 만들었다(값은 출력하지 않는다): pbcopy < ${TOKEN_FILE}`);
  } else if (TOKEN_CREATED) {
    console.log('');
    console.log('  ── 토큰을 새로 만들었다. 백오피스 /settings/bridge 에 붙여넣어라. ──');
    console.log(`  ${TOKEN}`);
    console.log('');
  } else {
    console.log(`[bridge] 토큰은 이미 있다. 값이 필요하면: cat ${TOKEN_FILE}`);
  }
  log({ event: 'listen', port: PORT, ok: true });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log({ event: 'shutdown', signal: sig, ok: true });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
