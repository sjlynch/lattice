import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerminalReconnectController,
  type ReconnectTimerHandle,
} from '../components/terminal/terminalReconnectController.ts';
import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_STABLE_MS,
} from '../components/terminal/terminalSocket.ts';
import type { TerminalStatus } from '../terminal/terminalTypes.ts';

// createTerminalReconnectController is the reconnect state machine behind
// useTerminalConnection. Its two stops matter more than its backoff curve:
//   - `terminated` (a clean pty `exit` or a backend `session_lost`) is what
//     bounds the deleted-worktree runaway — without it every WS close after the
//     pty died triggered a fresh connect, respawning thousands of doomed ptys.
//   - `attachedOnce` is what lets a terminal that started serverless ride out a
//     backend restart: once it has captured a session id it re-attaches (an
//     idempotent re-subscribe) forever instead of giving up at the cap.
// Every side effect is injected, so this drives the controller directly with a
// hand-cranked timer table — no React, no WebSocket.

type PendingTimer = { id: number; callback: () => void; delay: number };

function makeHarness(serverId?: string) {
  let nextId = 1;
  const pending: PendingTimer[] = [];
  const cleared: number[] = [];
  const statuses: Array<{ status: TerminalStatus; exitCode?: number }> = [];
  const counts = { reconnect: 0, reconnected: 0, reconnecting: 0, gaveUp: 0 };

  const controller = createTerminalReconnectController({
    getServerId: () => serverId,
    reconnect: () => {
      counts.reconnect += 1;
    },
    setTimer: (callback, delay) => {
      const id = nextId++;
      pending.push({ id, callback, delay });
      return id as unknown as ReconnectTimerHandle;
    },
    clearTimer: (timer) => {
      const id = timer as unknown as number;
      cleared.push(id);
      const idx = pending.findIndex((t) => t.id === id);
      if (idx >= 0) pending.splice(idx, 1);
    },
    onStatus: (status, exitCode) => {
      statuses.push({ status, exitCode });
    },
    onReconnected: () => {
      counts.reconnected += 1;
    },
    onReconnecting: () => {
      counts.reconnecting += 1;
    },
    onGaveUp: () => {
      counts.gaveUp += 1;
    },
  });

  /** Fire every currently-pending timer (not ones they schedule). */
  const fireAll = () => {
    const due = pending.splice(0, pending.length);
    for (const t of due) t.callback();
  };

  /** The single pending timer at an inspection point. */
  const onlyTimer = (): PendingTimer => {
    assert.equal(
      pending.length,
      1,
      `expected exactly one pending timer, saw ${pending.length}`,
    );
    return pending[0];
  };

  /**
   * Drive `n` failed reconnect cycles: each close must schedule a retry, which
   * is fired (calling `reconnect`) and whose connection then drops again
   * without ever opening. Returns the scheduled retry delays in order.
   */
  const failCycles = (n: number): number[] => {
    const delays: number[] = [];
    for (let i = 0; i < n; i++) {
      controller.handleClose();
      delays.push(onlyTimer().delay);
      fireAll();
    }
    return delays;
  };

  return { controller, pending, cleared, statuses, counts, fireAll, onlyTimer, failCycles };
}

const lastStatus = (h: ReturnType<typeof makeHarness>) => h.statuses.at(-1)?.status;

// --- 1. terminated stops the reconnect loop ----------------------------------

test('a clean exit followed by the socket close schedules no reconnect', () => {
  const h = makeHarness('srv-1'); // re-attachable: would otherwise retry forever
  h.controller.startConnecting();
  h.controller.handleOpen();
  h.controller.handleAttached();
  assert.equal(h.onlyTimer().delay, RECONNECT_STABLE_MS, 'open arms the stability timer');

  // The pty exits cleanly; the server then closes the WS behind it.
  h.controller.handleTerminated('exited', 0);
  h.controller.handleClose();

  assert.equal(h.pending.length, 0, 'close after terminate must not schedule a retry');
  h.fireAll();
  assert.equal(h.counts.reconnect, 0, 'reconnect must never be called');
  assert.equal(h.counts.reconnecting, 0);
  assert.equal(h.counts.gaveUp, 0);
  assert.deepEqual(h.statuses.at(-1), { status: 'exited', exitCode: 0 });
  assert.equal(h.controller.canConnect(), false);
});

test('session_lost (dead) stops a server-backed terminal on every later close', () => {
  const h = makeHarness('srv-1');
  h.controller.handleOpen();
  h.controller.handleTerminated('dead');

  // Repeated closes — the runaway shape — all stay inert.
  for (let i = 0; i < MAX_RECONNECT_ATTEMPTS + 3; i++) h.controller.handleClose();

  assert.equal(h.pending.length, 0);
  assert.equal(h.counts.reconnect, 0);
  assert.equal(lastStatus(h), 'dead');
  assert.equal(h.statuses.filter((s) => s.status === 'reconnecting').length, 0);

  // A late open after termination is ignored too (no stability timer, no 'live').
  h.controller.handleOpen();
  assert.equal(h.pending.length, 0);
  assert.equal(lastStatus(h), 'dead');
});

// --- 2. attachedOnce lets a serverless terminal reconnect past the cap -------

test('a serverless terminal that never attached gives up after the cap', () => {
  const h = makeHarness(); // no serverId, never attached

  const delays = h.failCycles(MAX_RECONNECT_ATTEMPTS);
  assert.equal(delays.length, MAX_RECONNECT_ATTEMPTS);
  assert.equal(h.counts.reconnect, MAX_RECONNECT_ATTEMPTS);

  // The next close hits the cap: a reconnect here could spawn a fresh pty.
  h.controller.handleClose();
  assert.equal(h.pending.length, 0, 'must not schedule past the cap');
  assert.equal(h.counts.gaveUp, 1);
  assert.equal(lastStatus(h), 'dead');
  assert.equal(h.controller.canConnect(), false);

  // Giving up is itself a stop: further closes do nothing.
  h.controller.handleClose();
  assert.equal(h.pending.length, 0);
  assert.equal(h.counts.gaveUp, 1);
});

test('a serverless terminal that attached once keeps reconnecting past the cap', () => {
  const h = makeHarness(); // no serverId…
  h.controller.startConnecting();
  h.controller.handleOpen();
  h.controller.handleAttached(); // …but it captured a session on first attach
  h.fireAll(); // let the first connection prove stable

  const cycles = MAX_RECONNECT_ATTEMPTS + 4;
  const delays = h.failCycles(cycles);

  assert.equal(delays.length, cycles, 'every close past the cap still schedules a retry');
  assert.equal(h.counts.reconnect, cycles);
  assert.equal(h.counts.gaveUp, 0);
  assert.notEqual(lastStatus(h), 'dead');
  assert.equal(h.controller.canConnect(), true);
  // The reconnecting notice is shown once per outage, not per attempt.
  assert.equal(h.counts.reconnecting, 1);

  // When it finally reconnects, the outage notice is cleared.
  h.controller.handleOpen();
  assert.equal(h.counts.reconnected, 1);
  assert.equal(lastStatus(h), 'live');
});

// --- 3. server-backed terminals retry forever with capped backoff ------------

test('a server-backed terminal keeps reconnecting past the cap with capped backoff', () => {
  const h = makeHarness('srv-1'); // never attached in this session — serverId suffices

  const delays = h.failCycles(MAX_RECONNECT_ATTEMPTS + 6);

  assert.deepEqual(
    delays,
    [250, 500, 1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000, 10000],
  );
  assert.equal(h.counts.reconnect, delays.length);
  assert.equal(h.counts.gaveUp, 0);
  assert.equal(h.statuses.filter((s) => s.status === 'dead').length, 0);
  assert.equal(lastStatus(h), 'reconnecting');
  assert.equal(h.controller.canConnect(), true);
});

// --- 4. cancel clears a pending retry ----------------------------------------

test('cancel clears a pending retry so reconnect never fires', () => {
  const h = makeHarness('srv-1');
  h.controller.handleOpen();
  h.controller.handleClose(); // clears the stability timer, schedules a retry
  const retry = h.onlyTimer();
  assert.equal(retry.delay, 250);

  h.controller.cancel();
  assert.ok(h.cleared.includes(retry.id), 'cancel must clear the pending retry timer');
  assert.equal(h.pending.length, 0);
  h.fireAll();
  assert.equal(h.counts.reconnect, 0, 'reconnect must never fire after cancel');
  assert.equal(h.controller.canConnect(), false);

  // A close arriving after cancel (the unmount's own ws.close()) is a no-op.
  const statusCount = h.statuses.length;
  h.controller.handleClose();
  assert.equal(h.pending.length, 0);
  assert.equal(h.counts.reconnect, 0);
  assert.equal(h.counts.gaveUp, 0);
  assert.equal(h.statuses.length, statusCount, 'no status change after cancel');
});

test('cancel also clears a pending stability timer', () => {
  const h = makeHarness('srv-1');
  h.controller.handleOpen();
  const stable = h.onlyTimer();
  assert.equal(stable.delay, RECONNECT_STABLE_MS);

  h.controller.cancel();
  assert.ok(h.cleared.includes(stable.id));
  assert.equal(h.pending.length, 0);

  // Opens after cancel are ignored.
  h.controller.handleOpen();
  assert.equal(h.pending.length, 0);
});
