// The dev runner's half of the restart handshake with dist/index.js (the
// backend half is backend/src/restartDrain/ + routes/restartDrain.ts).
//
// Before this runner kills the backend to apply a rebuild it asks the backend
// to PREPARE: stop starting new work (spawns, run-lock operations, workflow /
// merge / task starts), let what is already in flight land (a workflow step
// advance, a control step's lock hand-off, a pty create, an admitted spawn),
// and flush every debounced write. The kill is TerminateProcess on Windows —
// nothing in the backend gets to clean up after it — so this is the only
// moment the backend can put its house in order.
//
// Everything here FAILS OPEN. The handshake exists to make restarts smoother,
// never to make them impossible: a backend that is down, wedged, too old to
// know the endpoint, or slow to answer gets today's plain restart, with a log
// line saying why. The drain itself carries a TTL on the backend side, so a
// runner that dies after asking can't leave the backend frozen.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mirrors backend/src/server/config.ts — the port dist/index.js binds.
export const HANDSHAKE_BACKEND_PORT = Number(process.env.PORT) || 5184;
export const HANDSHAKE_ROUTE_PREFIX = '/api/internal/restart-drain';
// Same backend-only loopback secret + custom header the terminal-server's
// mutating routes use; the backend checks it on the handshake routes.
export const HANDSHAKE_AUTH_HEADER = 'x-lattice-terminal-token';
// Server-side wait for in-flight work to settle. Admissions are paused for
// the whole wait, so this only ever counts DOWN (worktree checkouts are the
// slow case; at most two run at once).
export const PREPARE_SETTLE_BUDGET_MS = 45_000;
// Client-side ceiling on the whole prepare call: settle budget + the flush +
// slack. Past it we restart anyway.
export const PREPARE_TIMEOUT_MS = PREPARE_SETTLE_BUDGET_MS + 20_000;
// How long the backend stays drained if no restart follows. Covers the settle
// wait plus the time from "ready" to the kill landing.
export const DRAIN_TTL_MS = PREPARE_TIMEOUT_MS + 30_000;
// The dev console's soft stop (`r` / `d`, dev/devShutdown.mjs) drains too, but
// on a much shorter budget: the orchestrator force-kills the runner's tree once
// SOFT_STOP_TIMEOUT_MS (scripts/orchestrate/devControl.mjs) passes, and the
// kill plus dist/index.js's exit still have to fit inside it after the drain.
export const SOFT_STOP_SETTLE_BUDGET_MS = 10_000;
export const SOFT_STOP_PREPARE_TIMEOUT_MS = SOFT_STOP_SETTLE_BUDGET_MS + 5_000;
export const SOFT_STOP_DRAIN_TTL_MS = SOFT_STOP_PREPARE_TIMEOUT_MS + 30_000;
export const CANCEL_TIMEOUT_MS = 3_000;
export const LOCK_HOLDERS_TIMEOUT_MS = 8_000;

export function readHandshakeToken() {
  // Read-only, like shutdownTerminalServer: the runner never creates or
  // rotates the token (the backend owns it). Missing → the handshake is
  // skipped (fail open).
  try {
    const token = fs.readFileSync(path.join(os.homedir(), '.lattice', 'terminalServerToken'), 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
  const cause = err.cause && (err.cause.code || err.cause.message);
  return cause ? `${err.message} (${cause})` : String(err.message ?? err);
}

export function createRestartHandshake({
  port = HANDSHAKE_BACKEND_PORT,
  readToken = readHandshakeToken,
  fetchImpl = (...args) => globalThis.fetch(...args),
  prepareTimeoutMs = PREPARE_TIMEOUT_MS,
  settleBudgetMs = PREPARE_SETTLE_BUDGET_MS,
  drainTtlMs = DRAIN_TTL_MS,
} = {}) {
  const base = `http://127.0.0.1:${port}${HANDSHAKE_ROUTE_PREFIX}`;

  async function call(method, route, body, timeoutMs) {
    const token = readToken();
    if (!token) return { ok: false, why: 'no ~/.lattice/terminalServerToken to authenticate with' };
    let res;
    try {
      res = await fetchImpl(`${base}${route}`, {
        method,
        headers: {
          [HANDSHAKE_AUTH_HEADER]: token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { ok: false, why: `backend unreachable: ${describeError(err)}` };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON — handled below */
    }
    if (!res.ok) {
      // 404 = a backend from before the handshake existed.
      const detail = data && typeof data.error === 'string' ? `: ${data.error}` : '';
      return { ok: false, why: `backend answered HTTP ${res.status}${detail}` };
    }
    if (!data || typeof data !== 'object') return { ok: false, why: 'backend answered with no JSON body' };
    return { ok: true, data };
  }

  // → { ok: true, ready, pending: string[], waitedMs } | { ok: false, why }
  async function prepare(reason) {
    const r = await call('POST', '/prepare', { reason, ttlMs: drainTtlMs, budgetMs: settleBudgetMs }, prepareTimeoutMs);
    if (!r.ok) return r;
    return {
      ok: true,
      ready: r.data.ready === true,
      pending: Array.isArray(r.data.pending) ? r.data.pending.map(String) : [],
      waitedMs: Number(r.data.waitedMs) || 0,
    };
  }

  // Best-effort: end a drain we asked for but won't follow with a restart.
  async function cancel(reason) {
    const r = await call('POST', '/cancel', { reason }, CANCEL_TIMEOUT_MS);
    return r.ok ? { ok: true } : r;
  }

  // → { ok: true, pid, holders: [{hash, project, parkedOn, detail}] } | { ok: false, why }
  async function lockHolders() {
    const r = await call('GET', '/lock-holders', null, LOCK_HOLDERS_TIMEOUT_MS);
    if (!r.ok) return r;
    return {
      ok: true,
      pid: Number(r.data.pid) || 0,
      holders: Array.isArray(r.data.holders) ? r.data.holders : [],
    };
  }

  return { prepare, cancel, lockHolders };
}
