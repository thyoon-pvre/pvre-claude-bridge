// 상시 작업자(headless worker, v0.4.0) 핵심 루프 — 순수 로직. 네트워크(fetch)·엔진 실행(run)·시계(now·sleep)·로그(log)는 주입한다(테스트가 가짜로 바꾼다).
//
// 흐름(브라우저 화면이 하던 일을 서버 쪽 API 로 대신):
//   연결 신호(60초마다) → 집기(claim) → 엔진 실행(claude -p 기본, codex 선택) → 완료(complete) → 바로 다음 집기
//   받을 작업이 없으면 idleMs(기본 20초) 쉬고, waitSec>0 이면 서버가 그만큼 기다려 준다(긴 폴링).
// 서버 계약(pvre-order 0041): /api/claude/worker/presence · /claim · /jobs/:id/complete, Authorization: Bearer <기기 토큰>
//   중복 없음은 서버가 보장한다(같은 메일당 진행 작업 1개, SKIP LOCKED 집기, 작업표 1회용·기기 묶음). 작업자는 한 번에 1건만 돈다.
// 실패 처리
//   - 네트워크·5xx: 연속 실패 수에 따라 지수 백오프(5초 → 최대 10분, ±20% 흔들기). 성공하면 0으로.
//   - 401(토큰 폐기·발급 관리자 권한 상실): 최소 10분 쉰다(서버를 두드리지 않는다). 토큰을 바꾸면 재시작.
//   - 409 NOT_LIVE(운영 전)·연결 신호 없음: 다음 주기에 연결 신호부터 다시.
//   - 완료 전송 실패: 같은 작업표·같은 응답으로 3번까지 다시 보낸다(서버는 같은 응답 재전송을 멱등 처리 — replayed).
//     끝내 못 보내면 버린다 → 임대(10분) 만료 뒤 다른 곳이 다시 해석한다.
// 절전: 쉬는 동안 벽시계가 예정보다 30초 넘게 지나 있으면 "절전 복귀"로 보고 연결 신호부터 다시 보낸다(macOS 는 타이머가 멈춘다).
// 로그 규칙: 작업 id·코드·글자 수·시간만. 프롬프트·응답 본문·작업표·토큰은 절대 넣지 않는다.

export const DEFAULTS = Object.freeze({
  heartbeatMs: 60_000,
  idleMs: 20_000,
  waitSec: 0,
  backoffBaseMs: 5_000,
  backoffMaxMs: 600_000,
  unauthorizedMs: 600_000,
  sleepGapMs: 30_000,
  maxRunMs: 300_000,
  completeRetries: 3,
});

export class ApiError extends Error {
  constructor(status, code, reason) {
    super(`api ${status} ${code}${reason ? ` ${reason}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.reason = reason || '';
  }
}

export function backoffMs(failures, o = DEFAULTS, rand = Math.random) {
  if (failures <= 0) return 0;
  const raw = Math.min(o.backoffMaxMs, o.backoffBaseMs * 2 ** (failures - 1));
  return Math.round(raw * (0.8 + rand() * 0.4));
}

/** 오류 문구에서 로그·서버로 보낼 수 있는 부분만: 제어문자 제거, 300자 */
const clip = (v, n = 300) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, n);

/**
 * @param {object} o
 * @param {string} o.serverUrl  https://… (개발은 http://localhost·127.0.0.1 허용)
 * @param {string} o.token      기기 토큰(pvw1_…)
 * @param {'claude'|'codex'} o.provider
 * @param {(prompt: string, timeoutMs: number) => Promise<{ok: boolean, text?: string, code?: string, error?: string}>} o.run
 * @param {() => boolean} [o.available]  엔진 CLI 를 실행할 수 있는가(연결 신호에 실린다)
 * @param {typeof fetch} [o.fetch]
 * @param {(entry: object) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [o.sleep]
 */
export function createWorker(o) {
  const cfg = { ...DEFAULTS, ...(o.options || {}) };
  const f = o.fetch || fetch;
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  }));
  const available = o.available || (() => true);
  const base = String(o.serverUrl || '').replace(/\/+$/, '');
  const state = { lastHeartbeat: 0, failures: 0, needHeartbeat: true, jobs: 0, stopped: false };

  async function api(path, body) {
    let res;
    try {
      res = await f(`${base}/api/claude/worker/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json', 'user-agent': `pvre-ai-worker/${o.version || '0'}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(path === 'claim' ? 60_000 : 30_000),
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK', clip(e?.name || 'fetch_failed', 40));
    }
    let j = null;
    try { j = await res.json(); } catch { /* 본문 없음 */ }
    if (!res.ok || !j || j.ok !== true) throw new ApiError(res.status, j?.code || 'HTTP', j?.reason || '');
    return j.data;
  }

  async function heartbeat() {
    const avail = Boolean(available());
    const d = await api('presence', { provider: o.provider, bridgeVersion: o.version || '', available: avail });
    state.lastHeartbeat = now();
    state.needHeartbeat = false;
    log({ event: 'heartbeat', ok: true, available: avail, claimable: d?.claimable ?? null });
    return d;
  }

  async function complete(job, body) {
    for (let i = 0; ; i++) {
      try {
        return await api(`jobs/${encodeURIComponent(job.jobId)}/complete`, body);
      } catch (e) {
        // 서버가 판단한 거절(4xx)은 다시 보내도 같다. 네트워크·5xx만 다시
        const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
        if (!retryable || i + 1 >= cfg.completeRetries) throw e;
        await sleep(2_000 * (i + 1));
      }
    }
  }

  /** 한 바퀴: 'worked' | 'idle' */
  async function tick() {
    if (state.needHeartbeat || now() - state.lastHeartbeat >= cfg.heartbeatMs) await heartbeat();
    if (!available()) return 'idle'; // 엔진이 없으면 집지 않는다(연결 신호에도 available=false로 나가 서버가 0건으로 본다)
    const job = await api('claim', { provider: o.provider, waitSec: cfg.waitSec });
    if (!job) return 'idle';
    const started = now();
    log({ event: 'job_claimed', jobId: job.jobId, kind: job.kind, attempt: job.attempt, promptChars: job.prompt?.length ?? 0 });
    const timeoutMs = Math.min(Math.max(Number(job.timeoutMs) || 120_000, 1_000), cfg.maxRunMs);
    let r;
    try {
      r = await o.run(job.prompt, timeoutMs);
    } catch (e) {
      r = { ok: false, code: 'WORKER_ERROR', error: clip(e?.message) };
    }
    const body = r.ok ? { ticket: job.ticket, text: r.text } : { ticket: job.ticket, failure: { code: String(r.code || 'BRIDGE_ERROR').replace(/[^A-Z_]/g, '').slice(0, 40) || 'BRIDGE_ERROR', message: clip(r.error) } };
    const runMs = now() - started;
    try {
      const d = await complete(job, body);
      state.jobs += 1;
      log({ event: 'job_completed', jobId: job.jobId, ok: r.ok, engineCode: r.ok ? null : body.failure.code, status: d?.status ?? null, reason: d?.reason ?? null, replayed: d?.replayed ?? null, textChars: r.ok ? r.text.length : 0, runMs });
    } catch (e) {
      log({ event: 'job_complete_failed', jobId: job.jobId, ok: false, status: e.status ?? null, code: e.code ?? 'UNKNOWN', reason: e.reason || null, runMs });
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 401)) throw e; // 연결 문제는 바깥 백오프로
    }
    return 'worked';
  }

  /** 다음까지 쉴 시간과 로그 */
  function onError(e) {
    state.failures += 1;
    state.needHeartbeat = true;
    const status = e instanceof ApiError ? e.status : 0;
    const code = e instanceof ApiError ? e.code : 'UNKNOWN';
    let wait = backoffMs(state.failures, cfg);
    if (status === 401) wait = Math.max(wait, cfg.unauthorizedMs);
    if (status === 409) wait = Math.max(wait, cfg.idleMs); // 운영 전·연결 신호 없음 — 너무 자주 묻지 않는다
    log({ event: 'error', ok: false, status, code, reason: e?.reason || null, failures: state.failures, waitMs: wait });
    return wait;
  }

  async function runForever(signal) {
    log({ event: 'start', ok: true, provider: o.provider, server: base.replace(/^(https?:\/\/[^/]+).*/, '$1') });
    while (!signal?.aborted && !state.stopped) {
      let wait;
      try {
        const out = await tick();
        state.failures = 0;
        wait = out === 'worked' ? 0 : cfg.idleMs;
      } catch (e) {
        wait = onError(e);
      }
      if (!wait) continue;
      const planned = now() + wait;
      await sleep(wait, signal);
      const late = now() - planned;
      if (late > cfg.sleepGapMs) {
        state.needHeartbeat = true;
        log({ event: 'resume_after_sleep', ok: true, lateMs: late });
      }
    }
    log({ event: 'stop', ok: true, jobs: state.jobs });
  }

  return { tick, heartbeat, runForever, onError, state, stop: () => { state.stopped = true; } };
}

/** 서버 주소 검증: https 만(개발용 localhost·127.0.0.1 http 허용) */
export function validServerUrl(v) {
  try {
    const u = new URL(v);
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return u.origin;
  } catch { /* 아래 */ }
  return null;
}
