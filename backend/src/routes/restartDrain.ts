// The dev runner's restart handshake (see ../restartDrain/CLAUDE.md and
// backend/scripts/dev/restartHandshake.mjs), plus the admission gate that
// refuses new top-level runs while a restart is being prepared.
//
// Internal-only: these routes can freeze every spawn on the backend for up to
// the drain TTL, so a browser page must never be able to reach them. The
// global origin check (server/app.ts) already rejects a cross-origin page; on
// top of that every request here must
//   - carry NO `Origin` header at all (the Lattice UI's own same-origin POSTs
//     through the vite proxy do carry one — the dev runner's fetch does not),
//   - carry the backend-only loopback secret in the custom
//     `x-lattice-terminal-token` header — the same token and header the
//     terminal-server's mutating routes require (../terminalServerAuth.ts),
//     which the dev runner already reads from ~/.lattice/terminalServerToken
//     for its shutdown call. A form POST cannot set a custom header and a page
//     cannot read the file.

import { Router, type RequestHandler } from 'express';
import {
  TERMINAL_SERVER_AUTH_HEADER,
  getTerminalServerAuthToken,
  tokenMatches,
} from '../terminalServerAuth.js';
import {
  beginRestartDrain,
  clampRestartDrainTtl,
  endRestartDrain,
  getRestartDrainState,
  isRestartDraining,
} from '../restartDrain/gate.js';
import { RESTART_SETTLE_DEFAULT_BUDGET_MS, settleForRestart } from '../restartDrain/settle.js';
import { describeLockHolders } from '../restartDrain/lockHolders.js';

export const RESTART_DRAIN_ROUTE_PREFIX = '/api/internal/restart-drain';
// Seconds a refused start should wait before retrying: long enough for the
// drain + restart + boot, short enough that a cancelled drain costs little.
export const RESTART_DRAIN_RETRY_AFTER_S = 5;

export const requireRestartDrainCaller: RequestHandler = (req, res, next) => {
  if (req.get('origin') !== undefined) {
    return res.status(403).json({ error: 'internal endpoint: browser requests are not accepted' });
  }
  if (!tokenMatches(getTerminalServerAuthToken(), req.get(TERMINAL_SERVER_AUTH_HEADER))) {
    return res.status(401).json({ error: 'internal endpoint: missing or invalid token' });
  }
  next();
};

function readString(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function buildRestartDrainRouter(): Router {
  const r = Router();
  r.use(RESTART_DRAIN_ROUTE_PREFIX, requireRestartDrainCaller);

  // Enter (or extend) the drain, wait for in-flight transitions to settle,
  // flush debounced state, and report. `ready: false` means the budget ran out
  // with work still pending — the caller restarts anyway (fail open) but has
  // the list to log. The drain STAYS on after the response: the restart is
  // expected next; a caller that changes its mind calls /cancel, and the TTL
  // covers one that never comes back.
  r.post(`${RESTART_DRAIN_ROUTE_PREFIX}/prepare`, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = readString(body.reason) || 'dev runner restart';
    const ttlMs = clampRestartDrainTtl(body.ttlMs);
    const budgetMs = typeof body.budgetMs === 'number' && Number.isFinite(body.budgetMs)
      ? body.budgetMs
      : RESTART_SETTLE_DEFAULT_BUDGET_MS;
    beginRestartDrain(reason, ttlMs);
    const result = await settleForRestart(budgetMs);
    // The settle can outlast a short TTL; re-assert so the kill still finds
    // the drain on (never shortens an existing one).
    beginRestartDrain(reason, ttlMs);
    if (result.ready) {
      console.log(`[restart-drain] ready for restart after ${result.waitedMs} ms (${reason})`);
    } else {
      console.warn(
        `[restart-drain] NOT settled after ${result.waitedMs} ms (${reason}) — still pending: ` +
          `${result.pending.join('; ') || 'none'}${result.flushed ? '' : '; state flush did not finish'}`,
      );
    }
    res.json({ ...result, pid: process.pid, drain: getRestartDrainState() });
  });

  r.post(`${RESTART_DRAIN_ROUTE_PREFIX}/cancel`, (req, res) => {
    const reason = readString((req.body as Record<string, unknown> | undefined)?.reason) || 'cancelled by the dev runner';
    res.json({ ended: endRestartDrain(reason) });
  });

  // Which run.lock holders are parked on a live agent (for the dev runner's
  // force-restart backstop — see ../restartDrain/lockHolders.ts). `pid` lets
  // the caller check the lock it sees really belongs to this process.
  r.get(`${RESTART_DRAIN_ROUTE_PREFIX}/lock-holders`, async (_req, res) => {
    res.json({ pid: process.pid, holders: await describeLockHolders() });
  });

  return r;
}

// Top-level "start X" requests are refused with 503 + Retry-After while
// draining: nothing has been done yet, and the frontend retries a 503 through
// a backend restart (frontend/src/api/retry.ts). Everything already running —
// Stop-hook `/complete` callbacks, cancels, reads — passes untouched; the
// in-process equivalents (a workflow's Merge step, a boot resume) wait at the
// run-lock / spawn-queue gates instead.
const REFUSED_WHILE_DRAINING = [
  '/api/workflows/:id/run',
  '/api/merge-runs',
  '/api/tasks/:id/merge',
  '/api/tasks/:id/run',
  '/api/tasks/:id/resume',
  '/api/push-runs',
  '/api/qa-runs',
];

export function buildRestartDrainAdmissionGate(): Router {
  const r = Router();
  r.post(REFUSED_WHILE_DRAINING, (_req, res, next) => {
    if (!isRestartDraining()) return next();
    res.setHeader('Retry-After', String(RESTART_DRAIN_RETRY_AFTER_S));
    res.status(503).json({
      error: 'the backend is about to restart (applying a code change); retry this request in a few seconds',
      code: 'backend-restarting',
    });
  });
  return r;
}
