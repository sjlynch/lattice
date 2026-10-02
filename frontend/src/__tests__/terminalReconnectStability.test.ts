import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Terminal } from '@xterm/xterm';
import { useTerminalConnection } from '../components/terminal/useTerminalConnection.ts';
import { RECONNECT_STABLE_MS } from '../components/terminal/terminalSocket.ts';
import type { TerminalStatus } from '../terminal/terminalTypes.ts';
import {
  FakeWebSocket,
  installFakeWebSocket,
  installGlobal,
  installManualTimers,
  installWindow,
  type ManualTimers,
  type ScheduledTimer,
} from './domDoubles.ts';

// Regression: useTerminalConnection used to reset its reconnect backoff
// (`attempt = 0`) the instant `onopen` fired. Against a backend that completes
// the WS upgrade (101 → onopen) and then immediately closes — a half-booted
// backend behind a proxy — the counter never accumulated: reconnectDelay(0)
// pinned the loop at the 250ms floor, shouldGiveUpReconnect (needs
// attempt >= MAX) was never reached, and a SERVERLESS terminal re-ran its
// initialCommand (spawning a fresh pty) every ~250ms forever. The fix mirrors
// api/ws.ts's subscribeWs: reset the backoff only once the socket survives
// RECONNECT_STABLE_MS — a timer armed in onopen and CLEARED in onclose — so a
// flapping backend backs off (250ms→…) and a serverless terminal still honours
// the give-up cap.
//
// This drives the *real* hook headlessly (react-test-renderer + a fake xterm
// Terminal + manual timers + a scriptable WebSocket), the same way
// useWorkflowRunsProjectScope.test.ts exercises a real hook with no DOM. The
// hook reaches for `WebSocket`, `window.location`, and the timer globals at call
// time; the shared doubles stub all three so the reconnect lifecycle is
// hand-driven and the scheduled backoff delays directly assertable. React's
// scheduler uses MessageChannel (not setTimeout) in node, so replacing the timer
// globals doesn't perturb its work loop.

let timers: ManualTimers;
let restoreWs: () => void;
let restoreWindow: () => void;
let restoreReact: () => void;
let restoreActEnv: () => void;

const g = globalThis as unknown as Record<string, unknown>;

/** A Terminal stand-in covering the slice the connection hook touches. */
function makeFakeTerminal(): Terminal {
  return {
    cols: 80,
    rows: 24,
    write: (_data: string, callback?: () => void) => callback?.(),
    parser: {
      registerCsiHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerEscHandler: () => ({ dispose() {} }),
    },
    clear: () => {},
    reset: () => {},
    onData: () => ({ dispose() {} }),
    onResize: () => ({ dispose() {} }),
  } as unknown as Terminal;
}

/** The socket created by the most recent connect(). */
function latestSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'expected the hook to have opened a terminal WebSocket');
  return ws;
}

/** The single timer pending at an inspection point. */
function onlyTimer(): ScheduledTimer {
  assert.equal(
    timers.scheduled.length,
    1,
    `expected exactly one pending timer, saw ${timers.scheduled.length}`,
  );
  return timers.scheduled[0];
}

type HarnessProps = {
  termRef: { current: Terminal | null };
  serverId?: string;
  onStatus: (status: TerminalStatus, exitCode?: number) => void;
};

function Harness({ termRef, serverId, onStatus }: HarnessProps) {
  useTerminalConnection({
    termRef,
    cwd: 'C:/proj',
    initialCommand: 'npm run dev',
    serverId,
    onStatus,
  });
  return null;
}

/** Mount the hook and fire the deferred `setTimeout(connect, 0)` so the first
 *  socket exists. Returns the renderer + the captured status transitions. */
function mountConnected(serverId?: string) {
  const termRef = { current: makeFakeTerminal() };
  const statuses: TerminalStatus[] = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(Harness, {
        termRef,
        serverId,
        onStatus: (s) => statuses.push(s),
      }),
    );
  });
  // The effect defers the WS open by one task tick (StrictMode-cleanup guard).
  timers.fireAll();
  return { renderer, statuses };
}

/** One accept-then-immediate-close cycle on the latest socket. */
function acceptThenDrop() {
  const ws = latestSocket();
  ws.serverAccept(); // 101 upgrade completes → onopen arms the stability timer
  ws.serverDrop(); // …then the backend drops it before it can prove healthy
}

beforeEach(() => {
  timers = installManualTimers();
  restoreWs = installFakeWebSocket();
  restoreWindow = installWindow({
    location: { protocol: 'http:', host: 'localhost:5184' },
  });
  restoreActEnv = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // tsx compiles the app's .tsx with the classic JSX runtime (root tsconfig has
  // no `jsx` option), so components emit `React.createElement` without importing
  // React — expose it globally so they render under the test runner.
  restoreReact = installGlobal('React', React);
});

afterEach(() => {
  restoreReact();
  restoreActEnv();
  restoreWindow();
  restoreWs();
  timers.restore();
});

// --- The regression: accept-then-close must grow the backoff and give up -----

test('serverless accept-then-close grows the backoff then gives up after the cap', () => {
  const { renderer, statuses } = mountConnected(); // serverless: no serverId

  // Six accept→close cycles. Each one previously reset `attempt` to 0 in onopen,
  // pinning the reconnect at reconnectDelay(0)=250ms; with the stability-timer
  // fix the close clears the (never-fired) stability timer, so the counter
  // accumulates and the delay climbs the documented curve.
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    acceptThenDrop();
    delays.push(onlyTimer().delay); // the pending reconnect
    timers.fireAll(); // reconnect → connect() → next socket
  }

  // Strictly growing — NOT the flat 250ms loop the pre-fix onopen reset produced.
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 8000]);
  for (let i = 1; i < delays.length; i++) {
    assert.ok(
      delays[i] > delays[i - 1],
      `backoff must grow monotonically, saw ${JSON.stringify(delays)}`,
    );
  }

  // The 7th close hits the cap (attempt === MAX_RECONNECT_ATTEMPTS): a serverless
  // terminal that never attached gives up rather than spawning yet another pty.
  acceptThenDrop();
  assert.equal(
    timers.scheduled.length,
    0,
    'a serverless terminal must stop reconnecting once it exhausts the cap',
  );
  assert.ok(
    statuses.includes('dead'),
    'giving up should report a dead connection',
  );

  act(() => renderer.unmount());
});

// --- A connection that proves stable still resets the backoff ----------------

test('a connection surviving RECONNECT_STABLE_MS resets the backoff', () => {
  const { renderer } = mountConnected('srv-1'); // re-attachable: never gives up

  // Drive the backoff up with a few unstable cycles.
  for (let i = 0; i < 3; i++) {
    acceptThenDrop();
    timers.fireAll();
  }

  // This connection proves stable: open it, then let the stability timer fire.
  const ws = latestSocket();
  ws.serverAccept();
  const stable = onlyTimer(); // the only pending timer is the stability one
  assert.equal(
    stable.delay,
    RECONNECT_STABLE_MS,
    'onopen should arm the stability timer, not reset the backoff outright',
  );
  timers.fireAll(); // stability window elapses → attempt reset to 0

  // A subsequent drop now backs off from the base delay again.
  ws.serverDrop();
  assert.equal(
    onlyTimer().delay,
    250,
    'after a healthy window the backoff should restart at the base delay',
  );

  act(() => renderer.unmount());
});

// --- A drop within the stability window does NOT reset the backoff -----------

test('a drop within RECONNECT_STABLE_MS leaves the backoff growing', () => {
  const { renderer } = mountConnected('srv-1');

  // First unstable cycle: delay 250, attempt advances to 1.
  acceptThenDrop();
  assert.equal(onlyTimer().delay, 250);
  timers.fireAll();

  // Second connection opens (arming the stability timer) but drops before the
  // window elapses — the close must clear the stability timer, so the next delay
  // reflects attempt=1, not a reset to the base.
  acceptThenDrop();
  assert.equal(
    onlyTimer().delay,
    500,
    'a drop inside the stability window must not reset the backoff',
  );

  act(() => renderer.unmount());
});
