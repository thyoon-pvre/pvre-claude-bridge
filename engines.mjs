// 엔진 실행(v0.4.0에서 server.mjs 에서 떼어 냈다) — HTTP 브리지(server.mjs)와 상시 작업자(worker.mjs)가 같은 실행 규칙을 쓴다.
//
//  claude : `claude -p --output-format text` (프롬프트는 stdin). 0.1.0부터 같은 인자.
//  codex  : `codex exec` 잠금 실행(사용자 config·MCP·셸·웹 검색·하위 에이전트 끔, 읽기 전용 샌드박스, 빈 임시 폴더, --ephemeral). 0.2.0과 같은 인자.
// 프롬프트·응답 본문은 여기서 어디에도 쓰지 않는다(로그 없음). 오류 문구는 stderr 앞부분만(codex 는 프롬프트가 stderr 에 다시 찍혀 ERROR 줄만).
// 윈도우(v0.5.0): .cmd 래퍼를 shell 없이 풀어 실행한다(spawnPlan). 맥 동작은 그대로.
// 런타임 의존성 0.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants as FS, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function canExec(p) {
  try { accessSync(p, FS.X_OK); return true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 플랫폼 대응(v0.5.0 윈도우). 맥(darwin)·리눅스 동작은 0.4.0 그대로다 — 윈도우 분기만 더했다.
//  윈도우의 npm 전역 설치 CLI 는 claude.cmd·codex.cmd(배치 래퍼)다. Node 는 .cmd 를 shell 없이 spawn 하지 못하고(EINVAL),
//  shell:true 로 돌리면 cmd.exe 가 인자를 다시 해석한다(인자 주입 위험). 그래서 .cmd 안에 적힌 실제 대상(cli.js·codex.js·*.exe)을
//  읽어 node(현재 실행 중인 node) 또는 그 exe 를 shell 없이 직접 실행한다. 프롬프트는 계속 stdin 으로만 넘긴다.
// ─────────────────────────────────────────────────────────────────────────────

const pathApi = (platform) => (platform === 'win32' ? win32 : posix);

/** env 안의 PATH 키 이름(윈도우는 보통 'Path'). 없으면 'PATH' */
export function pathKeyOf(env, platform = process.platform) {
  if (platform !== 'win32') return 'PATH';
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
}

/** 엔진 바이너리 후보 경로(순서대로). 실행 가능 여부는 보지 않는다 — 테스트가 이 목록을 고정한다 */
export function engineCandidates(engine, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  const P = pathApi(platform);
  const pathDirs = String(env[pathKeyOf(env, platform)] || '').split(P.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (platform === 'win32') {
    const dirs = [
      ...pathDirs,
      P.join(home, '.local', 'bin'),                                // Claude Code 네이티브 설치(claude.exe)
      env.APPDATA ? P.join(env.APPDATA, 'npm') : P.join(home, 'AppData', 'Roaming', 'npm'), // npm 전역(claude.cmd·codex.cmd)
    ];
    // .exe 를 .cmd 보다 먼저 — 같은 폴더에 둘 다 있으면 래퍼 해석이 필요 없는 쪽을 쓴다. 확장자 없는 파일(npm 의 sh 래퍼)은 실행할 수 없어 뺀다.
    return dirs.flatMap((d) => [P.join(d, `${engine}.exe`), P.join(d, `${engine}.cmd`)]);
  }
  const dirs = [
    ...pathDirs,
    P.join(home, '.local/bin'),
    P.join(home, '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return dirs.map((d) => P.join(d, engine));
}

/** 엔진 바이너리 절대경로. override(PVRE_CLAUDE_BIN·PVRE_CODEX_BIN)가 있으면 그것만(절대경로·실행 가능일 때) */
export function resolveEngineBin(
  engine,
  override = engine === 'codex' ? process.env.PVRE_CODEX_BIN : process.env.PVRE_CLAUDE_BIN,
  { platform = process.platform, env = process.env, home = homedir(), exists = canExec } = {},
) {
  const o = expandHome(override);
  if (o) return pathApi(platform).isAbsolute(o) && exists(o) ? o : null;
  for (const p of engineCandidates(engine, { platform, env, home })) {
    if (exists(p)) return p;
  }
  return null;
}

/**
 * npm cmd-shim(.cmd) 안의 실제 실행 대상. 예:
 *   ... "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
 *   ... "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
 * 마지막 "%dp0%\…" %* 를 쓴다. 못 찾으면 null.
 */
export function parseCmdShim(text, shimPath) {
  const re = /"%~?dp0%?\\?([^"]+)"\s*%\*/g;
  let m;
  let last = null;
  while ((m = re.exec(String(text))) !== null) last = m[1];
  if (!last) return null;
  return win32.join(win32.dirname(shimPath), last);
}

const SCRIPT_EXT = /\.(c|m)?js$/i;

/**
 * 실제로 spawn 할 명령. shell 은 언제나 false 다.
 *  - 맥·리눅스: bin 그대로(0.4.0 과 같다)
 *  - 윈도우 *.js : 현재 node 로 실행
 *  - 윈도우 *.cmd/*.bat : 래퍼 안의 대상을 읽어 node 또는 exe 로 실행. 해석 못 하면 Error(code ENGINE_SHIM)
 */
export function spawnPlan(bin, args, { platform = process.platform, nodePath = process.execPath, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (platform !== 'win32') return { command: bin, args };
  if (SCRIPT_EXT.test(bin)) return { command: nodePath, args: [bin, ...args] };
  if (/\.(cmd|bat)$/i.test(bin)) {
    let target = null;
    try { target = parseCmdShim(readFile(bin), bin); } catch (e) {
      const err = new Error(`${bin} 를 읽지 못했다: ${e.message}`);
      err.code = 'ENGINE_SHIM';
      throw err;
    }
    if (target && SCRIPT_EXT.test(target)) return { command: nodePath, args: [target, ...args] };
    if (target && /\.exe$/i.test(target)) return { command: target, args };
    const err = new Error(`${bin} 안에서 실행 대상(cli.js·*.exe)을 찾지 못했다. PVRE_CLAUDE_BIN/PVRE_CODEX_BIN 에 .exe 또는 .js 절대경로를 지정해라`);
    err.code = 'ENGINE_SHIM';
    throw err;
  }
  return { command: bin, args };
}

/** 엔진 프로세스 실행 — 플랫폼 차이(.cmd 래퍼·콘솔 창 숨김)를 여기서만 흡수한다. shell 은 쓰지 않는다 */
export function spawnEngine(bin, args, options = {}) {
  const plan = spawnPlan(bin, args);
  return spawn(plan.command, plan.args, { ...options, shell: false, windowsHide: true });
}

/** 타임아웃 때 프로세스를 끝낸다. 윈도우는 taskkill /T 로 자식(codex.exe 등)까지, 그 밖은 group 이면 프로세스 그룹째 */
export function killEngine(child, { group = false, platform = process.platform } = {}) {
  if (!child || !child.pid) return;
  if (platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (e) => {
      if (e) { try { child.kill(); } catch { /* 이미 끝남 */ } }
    });
    return;
  }
  if (group) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* 그룹이 없으면 아래 */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 이미 끝남 */ }
}

/** codex 실행 env: 지금 node 가 있는 폴더를 PATH 맨 앞에(launchd·작업 스케줄러의 좁은 PATH 대비) */
export function envWithNodeOnPath(base = process.env, { platform = process.platform, nodePath = process.execPath } = {}) {
  const P = pathApi(platform);
  const key = pathKeyOf(base, platform);
  const fallback = platform === 'win32' ? '' : '/usr/bin:/bin';
  const env = { ...base };
  env[key] = `${P.dirname(nodePath)}${P.delimiter}${base[key] || fallback}`;
  return env;
}

/** claude -p 실행 — 프롬프트는 argv 가 아니라 stdin 으로 넣는다 (ARG_MAX 회피). */
export function runClaudeBin(bin, prompt, timeoutMs, { dryRun = false } = {}) {
  return new Promise((resolve) => {
    if (dryRun) {
      resolve({ ok: true, text: `[dry-run] claude 를 실행하지 않았다. prompt ${prompt.length}자.`, exitCode: 0 });
      return;
    }
    if (!bin) {
      resolve({ ok: false, code: 'CLAUDE_NOT_FOUND', error: 'claude CLI 를 찾지 못했다 (PATH 확인)' });
      return;
    }
    let child;
    try {
      child = spawnEngine(bin, ['-p', '--output-format', 'text'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: 'CLAUDE_NOT_FOUND', error: `claude 실행 실패: ${e.message}` });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      killEngine(child);
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

// 끄는 기능: 셸·코드 실행·하위 에이전트·이미지·브라우저·컴퓨터 제어·플러그인·앱·훅·기억·스킬 검색.
// codex 버전마다 기능 이름이 다를 수 있다 — 모르는 이름은 codex 가 무시한다(0.162.1 에서 확인).
export const CODEX_DISABLE = [
  'shell_tool', 'unified_exec', 'code_mode_host', 'multi_agent', 'image_generation', 'browser_use', 'computer_use',
  'in_app_browser', 'view_image', 'plugins', 'apps', 'hooks', 'memories', 'skill_search', 'tool_suggest', 'goals',
];

export function codexArgs(workDir, outFile) {
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

export function runCodexBin(bin, prompt, timeoutMs, { dryRun = false } = {}) {
  return new Promise((resolve) => {
    if (dryRun) {
      resolve({ ok: true, text: `[dry-run] codex 를 실행하지 않았다. prompt ${prompt.length}자.`, exitCode: 0 });
      return;
    }
    if (!bin) {
      resolve({ ok: false, code: 'CODEX_NOT_FOUND', error: 'codex CLI 를 찾지 못했다 (PATH 확인)' });
      return;
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
      child = spawnEngine(bin, codexArgs(workDir, outFile), {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        // codex.js → 네이티브 바이너리. 타임아웃 때 프로세스 그룹째 죽인다. 윈도우는 detached 면 새 콘솔이 생겨 끄고 taskkill /T 로 죽인다
        detached: process.platform !== 'win32',
        // codex 는 `#!/usr/bin/env node` 스크립트다. launchd·작업 스케줄러의 좁은 PATH 에서도 이 node 를 찾게 앞에 붙인다.
        env: envWithNodeOnPath(process.env),
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
      killEngine(child, { group: true });
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
