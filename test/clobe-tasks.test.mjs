// node --test test/  — 런타임 의존성 0(node:test). 클로브 조회 작업의 도구 잠금·원문 수집·회귀를 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOBE_TASKS, CLOBE_TOOL_PREFIX, claudeProjectDirFor, allowedToolsFor, claudeToolArgs, claudeToolEnv, parseToolStream, judgeToolRun, sanitizeValue, sanitizeOutputText, ENVELOPE_FORMAT,
} from '../clobe-tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const P = CLOBE_TOOL_PREFIX;
// 클로브 MCP 도구 목록(2026-10-21 실측) 중 데이터를 바꾸는 도구 — 어떤 작업에도 허용되면 안 된다
const WRITE_TOOLS = ['issue_tax_invoice', 'issue_tax_invoices', 'issue_modified_tax_invoice', 'preview_issue_tax_invoice', 'upsert_tax_invoice_memo', 'upsert_bank_transaction_memo',
  'settle_tax_invoice_immediately', 'complete_tax_invoice_settlement', 'request_connect_collection', 'run_workflow', 'run_workflow_step', 'bulk_label_transactions', 'create_journal_entry', 'submit_efiling'];

test('작업별 허용 도구는 조회 도구뿐이고 쓰기 도구는 어디에도 없다', () => {
  assert.deepEqual(allowedToolsFor('clobe.pull_invoices'), [`${P}get_my_context`, `${P}get_tax_invoices`]);
  assert.deepEqual(allowedToolsFor('clobe.pull_bank'), [`${P}get_my_context`, `${P}get_bank_accounts`, `${P}get_labeled_transactions`]);
  for (const tools of Object.values(CLOBE_TASKS)) for (const w of WRITE_TOOLS) assert.ok(!tools.includes(w), w);
  for (const t of Object.values(CLOBE_TASKS).flat()) assert.match(t, /^get_/);
  assert.equal(allowedToolsFor('clobe.issue'), null);
});

test('claude 인자: 내장 도구 0개 · 허용 목록 · dontAsk · 사용자 설정 미적재 · 세션 미저장', () => {
  const a = claudeToolArgs('clobe.pull_bank');
  const at = (k) => a[a.indexOf(k) + 1];
  assert.equal(at('--tools'), 'ToolSearch');
  assert.equal(at('--allowedTools'), allowedToolsFor('clobe.pull_bank').join(','));
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--setting-sources'), '');
  assert.equal(at('--output-format'), 'stream-json');
  for (const f of ['-p', '--verbose', '--disable-slash-commands', '--no-session-persistence']) assert.ok(a.includes(f), f);
  for (const f of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--mcp-config']) assert.ok(!a.includes(f), f);
  assert.throws(() => claudeToolArgs('clobe.issue'));
  assert.equal(claudeToolEnv({}).MCP_CONNECTION_NONBLOCKING, 'false');
});

test('데이터 최소화: 계좌번호는 끝 4자리, 잔액 키는 삭제', () => {
  const v = sanitizeValue({ accounts: [{ bankAccountId: 1, accountNumber: '100000001234', displayAccountNumber: '100-000-001234', balance: 5, krwBalance: 5, accountName: '보통예금' }],
    summary: { checkingBalanceSum: 1, loanBalanceSum: 2 }, content: [{ transactionId: 9, afterBalance: 3, accountNumber: '100-000-001234', inAmount: 10 }] });
  assert.deepEqual(v.accounts[0], { bankAccountId: 1, accountLast4: '1234', accountName: '보통예금' });
  assert.deepEqual(v.summary, {});
  assert.deepEqual(v.content[0], { transactionId: 9, accountLast4: '1234', inAmount: 10 });
  assert.equal(sanitizeOutputText('오류: 계좌 100-000-001234 조회 실패'), '오류: 계좌 ****1234 조회 실패');
  assert.equal(sanitizeOutputText('기간 2026-10-01~2026-10-21 계좌 100000001234'), '기간 2026-10-01~2026-10-21 계좌 ****1234');
});

const line = (o) => JSON.stringify(o);
function stream({ tools, mcp = 'connected', result = 'DONE', denials = [] }) {
  const out = [line({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'claude.ai colbe', status: mcp }, { name: 'claude.ai Gmail', status: 'connected' }] })];
  out.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ts', name: 'ToolSearch', input: { query: 'select:x' } }] } }));
  out.push(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ts', content: [{ type: 'tool_reference', tool_name: 'x' }] }] } }));
  tools.forEach(([name, input, output, asString], i) => {
    out.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name, input }] } }));
    out.push(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: asString ? output : [{ type: 'text', text: output }] }] } }));
  });
  out.push(line({ type: 'result', result, is_error: false, permission_denials: denials }));
  return `${out.join('\n')}\n`;
}

test('stream-json → 허용 도구 호출 원문(순서 유지), ToolSearch는 무시, 문자열/블록 결과 둘 다', () => {
  const s = stream({ tools: [
    [`${P}get_my_context`, { input: {} }, '{"companies":[]}'],
    [`${P}get_tax_invoices`, { input: { page: 0 } }, '{"content":[],"hasNext":false}', true],
  ] });
  const p = parseToolStream(s, 'clobe.pull_invoices');
  assert.equal(p.mcpStatus, 'connected');
  assert.deepEqual(p.calls.map((c) => c.tool), ['get_my_context', 'get_tax_invoices']);
  assert.deepEqual(p.calls[1].input, { input: { page: 0 } });
  const v = judgeToolRun('clobe.pull_invoices', p);
  assert.equal(v.ok, true);
  const env = JSON.parse(v.text);
  assert.equal(env.format, ENVELOPE_FORMAT);
  assert.equal(env.calls[1].output, '{"content":[],"hasNext":false}');
});

test('허용 목록 밖 도구가 출력에 보이면 결과 전체를 버린다(TOOL_NOT_ALLOWED)', () => {
  const s = stream({ tools: [[`${P}get_my_context`, {}, '{}'], [`${P}issue_tax_invoice`, { input: {} }, '{"ok":true}']] });
  const v = judgeToolRun('clobe.pull_invoices', parseToolStream(s, 'clobe.pull_invoices'));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TOOL_NOT_ALLOWED');
  // 다른 작업의 조회 도구도 이 작업에서는 밖이다
  const s2 = stream({ tools: [[`${P}get_bank_accounts`, {}, '{}']] });
  assert.equal(judgeToolRun('clobe.pull_invoices', parseToolStream(s2, 'clobe.pull_invoices')).code, 'TOOL_NOT_ALLOWED');
});

test('커넥터 미연결·도구 미호출은 실패로 돌려준다(조용히 빈 결과를 성공 처리하지 않는다)', () => {
  assert.equal(judgeToolRun('clobe.pull_bank', parseToolStream(stream({ tools: [], mcp: 'pending' }), 'clobe.pull_bank')).code, 'CLOBE_NOT_CONNECTED');
  assert.equal(judgeToolRun('clobe.pull_bank', parseToolStream(stream({ tools: [], result: '연결 중' }), 'clobe.pull_bank')).code, 'NO_TOOL_CALLS');
});

test('큰 결과가 파일로 빠지면(<persisted-output>) 원문이 아니므로 실패', () => {
  const s = stream({ tools: [[`${P}get_my_context`, {}, '{}'], [`${P}get_labeled_transactions`, {}, '<persisted-output>\nOutput too large (61KB). Full output saved to: /x']] });
  assert.equal(judgeToolRun('clobe.pull_bank', parseToolStream(s, 'clobe.pull_bank')).code, 'TOOL_OUTPUT_TOO_LARGE');
  assert.equal(claudeProjectDirFor('/private/var/folders/x7/T/pvre-clobe-Ab1', '/Users/u'), '/Users/u/.claude/projects/-private-var-folders-x7-T-pvre-clobe-Ab1');
});

// ─── 데몬 통합: 가짜 claude 로 띄워 회귀(기존 작업 인자 그대로)와 클로브 경로를 확인한다
function startBridge(env) {
  const dir = mkdtempSync(join(tmpdir(), 'pvre-bridge-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [join(HERE, '..', 'server.mjs')], {
    env: { ...process.env, PVRE_BRIDGE_MODE: 'verify', PVRE_BRIDGE_PORT: String(port), PVRE_BRIDGE_TOKEN_FILE: tokenFile, PVRE_BRIDGE_LOG_FILE: join(dir, 'log'),
      PVRE_BRIDGE_CONFIG: join(dir, 'none.json'), PVRE_CLAUDE_BIN: join(HERE, 'fake-claude.mjs'), PVRE_CODEX_BIN: join(HERE, 'fake-claude.mjs'), FAKE_ARGS_FILE: join(dir, 'args'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('주소')) resolve({ child, port, dir }); });
    child.on('exit', (c) => reject(new Error(`bridge exit ${c}`)));
  });
}
const run = (port, body) => fetch(`http://127.0.0.1:${port}/v1/run`, { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test('데몬: 기존 작업(reply-parse)은 0.2.0과 같은 인자, 클로브 작업은 잠긴 인자 + 원문 봉투', async () => {
  const dir0 = mkdtempSync(join(tmpdir(), 'pvre-stream-'));
  const streamFile = join(dir0, 's.jsonl');
  writeFileSync(streamFile, stream({ tools: [[`${P}get_my_context`, { input: {} }, '{"companies":[{"companyId":"c1","businessRegNo":"1234567890"}]}'],
    [`${P}get_bank_accounts`, { input: { companyId: 'c1' } }, '{"accounts":[{"bankAccountId":1,"accountNumber":"100000001234","balance":99}]}']] }));
  const home = mkdtempSync(join(tmpdir(), 'pvre-home-'));
  const b = await startBridge({ FAKE_STREAM: streamFile, FAKE_PERSIST: '1', HOME: home });
  try {
    const h = await (await fetch(`http://127.0.0.1:${b.port}/v1/health`)).json();
    assert.equal(h.version, '0.3.0');
    assert.deepEqual(h.tasks, ['clobe.pull_invoices', 'clobe.pull_bank']);
    const r1 = await run(b.port, { app: 'pvre-order', task: 'reply-parse', prompt: 'hello' });
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.text, 'echo:5');
    const r2 = await run(b.port, { app: 'pvre-order', task: 'clobe.pull_bank', prompt: 'go' });
    assert.equal(r2.body.ok, true, JSON.stringify(r2.body));
    const env = JSON.parse(r2.body.text);
    assert.equal(env.calls.length, 2);
    assert.ok(!r2.body.text.includes('100000001234'));
    assert.ok(!r2.body.text.includes('balance'));
    const r3 = await run(b.port, { app: 'pvre-order', task: 'clobe.issue', prompt: 'x' });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.code, 'UNKNOWN_TASK');
    const calls = readFileSync(join(b.dir, 'args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls[0].args, ['-p', '--output-format', 'text']);
    assert.equal(calls[0].nonblocking, null);
    assert.deepEqual(calls[1].args, claudeToolArgs('clobe.pull_bank'));
    assert.equal(calls[1].nonblocking, 'false');
    assert.notEqual(calls[1].cwd, process.cwd());
    assert.ok(!existsSync(calls[1].cwd), '임시 작업 폴더는 지운다');
    assert.ok(!existsSync(claudeProjectDirFor(calls[1].cwd, home)), 'Claude Code 프로젝트 폴더(큰 결과 파일)도 지운다');
  } finally {
    b.child.kill();
  }
});

test('데몬(codex 엔진): 클로브 작업은 TASK_NOT_SUPPORTED, health.tasks 비어 있음', async () => {
  const b = await startBridge({ PVRE_BRIDGE_ENGINE: 'codex' });
  try {
    const h = await (await fetch(`http://127.0.0.1:${b.port}/v1/health`)).json();
    assert.deepEqual(h.tasks, []);
    const r = await run(b.port, { app: 'pvre-order', task: 'clobe.pull_invoices', prompt: 'x' });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'TASK_NOT_SUPPORTED');
  } finally {
    b.child.kill();
  }
});
