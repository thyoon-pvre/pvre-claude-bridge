// 엔진 실행(v0.4.0에서 server.mjs 에서 떼어 냈다) — HTTP 브리지(server.mjs)와 상시 작업자(worker.mjs)가 같은 실행 규칙을 쓴다.
//
//  claude : `claude -p --output-format text` (프롬프트는 stdin). 0.1.0부터 같은 인자.
//  codex  : `codex exec` 잠금 실행(사용자 config·MCP·셸·웹 검색·하위 에이전트 끔, 읽기 전용 샌드박스, 빈 임시 폴더, --ephemeral). 0.2.0과 같은 인자.
// 프롬프트·응답 본문은 여기서 어디에도 쓰지 않는다(로그 없음). 오류 문구는 stderr 앞부분만(codex 는 프롬프트가 stderr 에 다시 찍혀 ERROR 줄만).
// 런타임 의존성 0.
import { spawn } from 'node:child_process';
import { accessSync, constants as FS, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function canExec(p) {
  try { accessSync(p, FS.X_OK); return true; } catch { return false; }
}

/** 엔진 바이너리 절대경로. override(PVRE_CLAUDE_BIN·PVRE_CODEX_BIN)가 있으면 그것만(절대경로·실행 가능일 때) */
export function resolveEngineBin(engine, override = engine === 'codex' ? process.env.PVRE_CODEX_BIN : process.env.PVRE_CLAUDE_BIN) {
  const o = expandHome(override);
  if (o) return isAbsolute(o) && canExec(o) ? o : null;
  const dirs = [
    ...String(process.env.PATH || '').split(':').filter(Boolean),
    join(homedir(), '.local/bin'),
    join(homedir(), '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const d of dirs) {
    const p = join(d, engine);
    if (canExec(p)) return p;
  }
  return null;
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
      child = spawn(bin, ['-p', '--output-format', 'text'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      child = spawn(bin, codexArgs(workDir, outFile), {
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
