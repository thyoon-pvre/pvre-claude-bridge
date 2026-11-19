// node --test test/ — 플랫폼 분기(v0.5.0 윈도우). 실제 윈도우 없이 platform·env·파일 읽기를 주입해 분기 규칙을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineCandidates, envWithNodeOnPath, parseCmdShim, pathKeyOf, resolveEngineBin, spawnPlan } from '../engines.mjs';
import { tokenModeTooOpen } from '../worker.mjs';

const WIN_HOME = 'C:\\Users\\kim';
const WIN_ENV = {
  Path: 'C:\\Program Files\\nodejs\\;"C:\\Program Files\\Git\\cmd";;C:\\Windows\\system32',
  APPDATA: 'C:\\Users\\kim\\AppData\\Roaming',
};

// npm cmd-shim 이 실제로 만드는 claude.cmd 형식(npm 10)
const NPM_JS_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');
const NPM_EXE_SHIM = '@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@openai\\codex\\vendor\\codex.exe"   %*\r\n';

test('윈도우 후보: PATH 는 ; 로 자르고(따옴표·빈 칸 정리) .exe 를 .cmd 보다 먼저, 확장자 없는 sh 래퍼는 후보에 없다', () => {
  const c = engineCandidates('claude', { platform: 'win32', env: WIN_ENV, home: WIN_HOME });
  assert.deepEqual(c.slice(0, 4), [
    'C:\\Program Files\\nodejs\\claude.exe',
    'C:\\Program Files\\nodejs\\claude.cmd',
    'C:\\Program Files\\Git\\cmd\\claude.exe',
    'C:\\Program Files\\Git\\cmd\\claude.cmd',
  ]);
  assert.ok(c.includes('C:\\Users\\kim\\.local\\bin\\claude.exe'), '네이티브 설치 경로');
  assert.ok(c.includes('C:\\Users\\kim\\AppData\\Roaming\\npm\\claude.cmd'), 'npm 전역 경로');
  assert.ok(c.every((p) => /\.(exe|cmd)$/.test(p)));
  assert.ok(c.indexOf('C:\\Users\\kim\\.local\\bin\\claude.exe') > c.indexOf('C:\\Windows\\system32\\claude.cmd'), 'PATH 가 먼저');
});

test('맥 후보는 0.4.0 과 같다: PATH(:) → ~/.local/bin → ~/.claude/local → /opt/homebrew/bin → /usr/local/bin', () => {
  const c = engineCandidates('codex', { platform: 'darwin', env: { PATH: '/a/bin:/b/bin' }, home: '/Users/kim' });
  assert.deepEqual(c, ['/a/bin/codex', '/b/bin/codex', '/Users/kim/.local/bin/codex', '/Users/kim/.claude/local/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex']);
});

test('resolveEngineBin: 처음 존재하는 후보 · override 는 절대경로만(윈도우 드라이브 경로 인식)', () => {
  const has = new Set(['C:\\Users\\kim\\AppData\\Roaming\\npm\\codex.cmd']);
  const opts = { platform: 'win32', env: WIN_ENV, home: WIN_HOME, exists: (p) => has.has(p) };
  assert.equal(resolveEngineBin('codex', undefined, opts), 'C:\\Users\\kim\\AppData\\Roaming\\npm\\codex.cmd');
  assert.equal(resolveEngineBin('claude', undefined, opts), null);
  assert.equal(resolveEngineBin('claude', 'D:\\tools\\claude.exe', { ...opts, exists: () => true }), 'D:\\tools\\claude.exe');
  assert.equal(resolveEngineBin('claude', 'claude.exe', { ...opts, exists: () => true }), null, '상대경로 거부');
});

test('npm .cmd 래퍼 해석: js 대상·exe 대상·알 수 없는 형식', () => {
  assert.equal(parseCmdShim(NPM_JS_SHIM, 'C:\\Users\\kim\\AppData\\Roaming\\npm\\claude.cmd'),
    'C:\\Users\\kim\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
  assert.equal(parseCmdShim(NPM_EXE_SHIM, 'C:\\npm\\codex.cmd'), 'C:\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe');
  assert.equal(parseCmdShim('@echo off\r\nnode something %*', 'C:\\npm\\x.cmd'), null);
});

test('spawnPlan: 윈도우 .cmd 는 shell 없이 node+cli.js 또는 exe 로 · 인자는 그대로(프롬프트는 인자에 없다) · 맥은 그대로', () => {
  const args = ['-p', '--output-format', 'text'];
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const js = spawnPlan('C:\\npm\\claude.cmd', args, { platform: 'win32', nodePath: node, readFile: () => NPM_JS_SHIM });
  assert.deepEqual(js, { command: node, args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', ...args] });
  const exe = spawnPlan('C:\\npm\\codex.cmd', ['exec', '-'], { platform: 'win32', nodePath: node, readFile: () => NPM_EXE_SHIM });
  assert.deepEqual(exe, { command: 'C:\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe', args: ['exec', '-'] });
  assert.deepEqual(spawnPlan('C:\\Users\\kim\\.local\\bin\\claude.exe', args, { platform: 'win32' }), { command: 'C:\\Users\\kim\\.local\\bin\\claude.exe', args });
  assert.deepEqual(spawnPlan('D:\\x\\fake-claude.mjs', args, { platform: 'win32', nodePath: node }), { command: node, args: ['D:\\x\\fake-claude.mjs', ...args] });
  assert.throws(() => spawnPlan('C:\\npm\\weird.cmd', args, { platform: 'win32', readFile: () => 'echo hi' }), (e) => e.code === 'ENGINE_SHIM');
  assert.throws(() => spawnPlan('C:\\npm\\gone.cmd', args, { platform: 'win32', readFile: () => { throw new Error('ENOENT'); } }), (e) => e.code === 'ENGINE_SHIM');
  // 맥: .js 여도 바꾸지 않는다(0.4.0 동작 — shebang 으로 실행)
  assert.deepEqual(spawnPlan('/opt/homebrew/bin/codex', args, { platform: 'darwin' }), { command: '/opt/homebrew/bin/codex', args });
  assert.deepEqual(spawnPlan('/x/fake-claude.mjs', args, { platform: 'darwin' }), { command: '/x/fake-claude.mjs', args });
});

test('codex env: node 폴더를 PATH 앞에 — 윈도우는 기존 Path 키 하나만 고치고 ; 로 잇는다', () => {
  const w = envWithNodeOnPath({ Path: 'C:\\Windows', X: '1' }, { platform: 'win32', nodePath: 'C:\\nodejs\\node.exe' });
  assert.equal(w.Path, 'C:\\nodejs;C:\\Windows');
  assert.equal(Object.keys(w).filter((k) => k.toUpperCase() === 'PATH').length, 1);
  assert.equal(pathKeyOf({ PATH: 'a' }, 'win32'), 'PATH');
  const m = envWithNodeOnPath({ PATH: '/usr/bin' }, { platform: 'darwin', nodePath: '/opt/homebrew/bin/node' });
  assert.equal(m.PATH, '/opt/homebrew/bin:/usr/bin');
  assert.equal(envWithNodeOnPath({}, { platform: 'darwin', nodePath: '/n/node' }).PATH, '/n:/usr/bin:/bin');
});

test('작업자 토큰 파일 권한: 맥은 600 만 · 윈도우는 mode 비트로 판단하지 않는다(설치 스크립트가 icacls 로 잠근다)', () => {
  assert.equal(tokenModeTooOpen(0o600, 'darwin'), false);
  assert.equal(tokenModeTooOpen(0o644, 'darwin'), true);
  assert.equal(tokenModeTooOpen(0o666, 'win32'), false);
});
