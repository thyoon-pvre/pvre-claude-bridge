// node --test test/ — 상시 작업자(v0.4.0). 가짜 발주 서버(node:http) · 가짜 엔진(함수·가짜 claude 바이너리)로 루프·인증·백오프·로그 규칙을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, backoffMs, createWorker, DEFAULTS, validServerUrl } from '../worker-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = `pvw1_${'Ab9_-'.repeat(8)}xyz`; // 43자
const SECRET_PROMPT = '고객 메일 원문: 송장번호 1234-5678 비밀 본문 PROMPT_MARKER';
const SECRET_TEXT = '{"schema":"reply-parse/v2","RESULT_MARKER":true}';
const TICKET = 'eyJqIjoiMSJ9.TICKET_MARKER_SIG';

/** 가짜 발주 서버: 큐(jobs)를 주고 받은 요청을 기록한다 */
function fakeServer({ jobs = [], status = {} } = {}) {
  const seen = [];
  const q = [...jobs];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url.replace('/api/claude/worker/', '');
      seen.push({ path, auth: req.headers.authorization, body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const forced = status[path.split('/')[0]];
      if (forced) { const s = typeof forced === 'function' ? forced() : forced; if (s) return send(s, { ok: false, code: s === 401 ? 'UNAUTHENTICATED' : 'INTERNAL' }); }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, code: 'UNAUTHENTICATED' });
      if (path === 'presence') return send(200, { ok: true, data: { provider: body.provider, claimable: q.length, connectedAdmins: 0 } });
      if (path === 'claim') return send(200, { ok: true, data: q.shift() ?? null });
      if (path.startsWith('jobs/')) return send(200, { ok: true, data: body.text ? { status: 'DONE', proposalId: 'p1', replayed: false } : { status: 'QUEUED', reason: `BRIDGE_${body.failure.code}` } });
      send(404, { ok: false, code: 'NOT_FOUND' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, seen })));
}
const job = (id) => ({ jobId: id, ticket: TICKET, prompt: SECRET_PROMPT, kind: 'REPLY_PARSE', attempt: 1, timeoutMs: 240_000 });

test('정상 흐름: 연결 신호 → 집기 → 엔진 실행(프롬프트 그대로) → 완료(작업표·응답) → 빈 큐면 idle', async () => {
  const s = await fakeServer({ jobs: [job('j1')] });
  const logs = [];
  const runs = [];
  try {
    const w = createWorker({ serverUrl: s.url, token: TOKEN, provider: 'claude', version: '0.4.0', log: (e) => logs.push(e), run: async (p, ms) => { runs.push({ p, ms }); return { ok: true, text: SECRET_TEXT }; } });
    assert.equal(await w.tick(), 'worked');
    assert.equal(await w.tick(), 'idle');
    assert.deepEqual(s.seen.map((x) => x.path), ['presence', 'claim', 'jobs/j1/complete', 'claim']);
    assert.ok(s.seen.every((x) => x.auth === `Bearer ${TOKEN}`));
    assert.deepEqual(s.seen[0].body, { provider: 'claude', bridgeVersion: '0.4.0', available: true });
    assert.deepEqual(runs, [{ p: SECRET_PROMPT, ms: 240_000 }]);
    assert.deepEqual(s.seen[2].body, { ticket: TICKET, text: SECRET_TEXT });
    const done = logs.find((l) => l.event === 'job_completed');
    assert.equal(done.status, 'DONE');
    assert.equal(done.textChars, SECRET_TEXT.length);
  } finally { s.srv.close(); }
});

test('로그 규칙: 프롬프트·응답 본문·작업표·토큰이 로그에 없다(실패 경로 포함)', async () => {
  const s = await fakeServer({ jobs: [job('j1'), job('j2')] });
  const logs = [];
  try {
    let n = 0;
    const w = createWorker({ serverUrl: s.url, token: TOKEN, provider: 'claude', log: (e) => logs.push(e), run: async () => (++n === 1 ? { ok: true, text: SECRET_TEXT } : { ok: false, code: 'NONZERO_EXIT', error: `claude 종료코드 1: ${SECRET_PROMPT}` }) });
    await w.tick();
    await w.tick();
    const all = JSON.stringify(logs);
    for (const m of ['PROMPT_MARKER', 'RESULT_MARKER', 'TICKET_MARKER', TOKEN, 'Ab9_-']) assert.ok(!all.includes(m), `로그에 ${m}`);
    // 실패는 코드로 서버에 보고(메시지는 서버 쪽 error_note용 300자) — 로그에는 코드만
    const fail = s.seen.find((x) => x.path === 'jobs/j2/complete').body;
    assert.equal(fail.failure.code, 'NONZERO_EXIT');
    assert.ok(fail.failure.message.length <= 300);
    assert.equal(logs.find((l) => l.event === 'job_completed' && l.jobId === 'j2').engineCode, 'NONZERO_EXIT');
  } finally { s.srv.close(); }
});

test('엔진이 없으면 연결 신호에 available=false 로 나가고 집지 않는다', async () => {
  const s = await fakeServer({ jobs: [job('j1')] });
  try {
    const w = createWorker({ serverUrl: s.url, token: TOKEN, provider: 'codex', available: () => false, run: async () => assert.fail('실행하면 안 된다') });
    assert.equal(await w.tick(), 'idle');
    assert.deepEqual(s.seen.map((x) => x.path), ['presence']);
    assert.equal(s.seen[0].body.available, false);
    assert.equal(s.seen[0].body.provider, 'codex');
  } finally { s.srv.close(); }
});

test('401(폐기된 토큰): 최소 10분 쉰다 · 5xx·네트워크 오류: 지수 백오프(5초→최대 10분) · 성공하면 실패 수 0', async () => {
  assert.equal(backoffMs(0), 0);
  const fixed = () => 0.5; // 흔들기 없이
  assert.equal(backoffMs(1, DEFAULTS, fixed), 5_000);
  assert.equal(backoffMs(2, DEFAULTS, fixed), 10_000);
  assert.equal(backoffMs(4, DEFAULTS, fixed), 40_000);
  assert.equal(backoffMs(20, DEFAULTS, fixed), 600_000);
  const w = createWorker({ serverUrl: 'http://127.0.0.1:1', token: TOKEN, provider: 'claude', run: async () => ({ ok: true, text: '' }) });
  assert.ok(w.onError(new ApiError(401, 'UNAUTHENTICATED')) >= 600_000);
  w.state.failures = 0;
  const a = w.onError(new ApiError(500, 'INTERNAL'));
  const b = w.onError(new ApiError(0, 'NETWORK'));
  assert.ok(a >= 4_000 && a <= 6_000, String(a));
  assert.ok(b >= 8_000 && b <= 12_000, String(b));
  // 실제 서버가 꺼져 있으면 NETWORK 로 던진다
  await assert.rejects(w.tick(), (e) => e instanceof ApiError && e.status === 0 && e.code === 'NETWORK');
});

test('루프: 401 이면 10분 대기를 요청하고, 절전 복귀(시계 점프)를 감지해 연결 신호부터 다시 보낸다', async () => {
  let presence401 = true;
  const s = await fakeServer({ status: { presence: () => (presence401 ? 401 : 0) } });
  const logs = [];
  let clock = 1_000_000;
  const waits = [];
  const ac = new AbortController();
  try {
    const w = createWorker({
      serverUrl: s.url, token: TOKEN, provider: 'claude', log: (e) => logs.push(e), now: () => clock,
      run: async () => ({ ok: true, text: '' }),
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 1) { presence401 = false; clock += ms; return; } // 401 뒤 10분 대기
        if (waits.length === 2) { clock += ms + 3_600_000; return; } // idle 대기 중 1시간 절전
        ac.abort();
      },
    });
    await w.runForever(ac.signal);
    assert.ok(waits[0] >= 600_000, `401 대기 ${waits[0]}`);
    assert.equal(waits[1], DEFAULTS.idleMs);
    assert.ok(logs.some((l) => l.event === 'resume_after_sleep' && l.lateMs >= 3_600_000));
    const presences = s.seen.filter((x) => x.path === 'presence').length;
    assert.ok(presences >= 3, `연결 신호 ${presences}회`); // 첫(401) → 복구 → 절전 복귀 뒤 다시
    assert.equal(w.state.failures, 0);
  } finally { s.srv.close(); }
});

test('완료 전송이 일시 실패(503)하면 같은 작업표·같은 응답으로 다시 보낸다(최대 3번)', async () => {
  let fails = 2;
  const s = await fakeServer({ jobs: [job('j1')], status: { jobs: () => (fails-- > 0 ? 503 : 0) } });
  try {
    const w = createWorker({ serverUrl: s.url, token: TOKEN, provider: 'claude', sleep: async () => {}, run: async () => ({ ok: true, text: SECRET_TEXT }) });
    assert.equal(await w.tick(), 'worked');
    const sent = s.seen.filter((x) => x.path === 'jobs/j1/complete');
    assert.equal(sent.length, 3);
    assert.ok(sent.every((x) => x.body.ticket === TICKET && x.body.text === SECRET_TEXT));
  } finally { s.srv.close(); }
});

test('서버 주소: https 만(개발용 localhost http 허용)', () => {
  assert.equal(validServerUrl('https://pvre-order-prototype.vercel.app/x'), 'https://pvre-order-prototype.vercel.app');
  assert.equal(validServerUrl('http://localhost:3310'), 'http://localhost:3310');
  assert.equal(validServerUrl('http://evil.example'), null);
  assert.equal(validServerUrl('not a url'), null);
});

test('worker.mjs 통합: 토큰 파일 권한이 넓으면 시작 거부 · 600이면 가짜 claude 로 1건 처리하고 로그에 본문·토큰 없음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvre-worker-test-'));
  const tokenFile = join(dir, 'worker-token');
  const logFile = join(dir, 'worker.log');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o644 });
  chmodSync(tokenFile, 0o644);
  const s = await fakeServer({ jobs: [job('j1')] });
  const start = (extra = {}) => spawn(process.execPath, [join(HERE, '..', 'worker.mjs')], {
    env: { ...process.env, PVRE_WORKER_SERVER: s.url.replace('127.0.0.1', 'localhost'), PVRE_WORKER_TOKEN_FILE: tokenFile, PVRE_WORKER_LOG_FILE: logFile, PVRE_CLAUDE_BIN: join(HERE, 'fake-claude.mjs'), PVRE_WORKER_IDLE_MS: '200', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const bad = start();
    const code = await new Promise((r) => bad.on('exit', r));
    assert.equal(code, 78);
    chmodSync(tokenFile, 0o600);
    const ok = start();
    let out = '';
    ok.stdout.on('data', (d) => { out += d; });
    ok.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 50 && !s.seen.some((x) => x.path === 'jobs/j1/complete'); i++) await new Promise((r) => setTimeout(r, 100));
    ok.kill('SIGTERM');
    await new Promise((r) => ok.on('exit', r));
    const sent = s.seen.find((x) => x.path === 'jobs/j1/complete');
    assert.ok(sent, `완료 없음: ${out}`);
    assert.equal(sent.body.text, `echo:${SECRET_PROMPT.length}`); // 가짜 claude 는 받은 stdin 글자 수를 돌려준다
    assert.ok(existsSync(logFile));
    const log = readFileSync(logFile, 'utf8');
    for (const m of ['PROMPT_MARKER', 'TICKET_MARKER', TOKEN]) assert.ok(!log.includes(m) && !out.includes(m), `로그/출력에 ${m}`);
    assert.match(log, /"event":"job_completed"/);
    assert.match(log, /"event":"shutdown"/);
  } finally { s.srv.close(); }
});
