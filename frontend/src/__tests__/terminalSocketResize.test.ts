import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/xterm';
import {
  RESIZE_DEBOUNCE_MS,
  forwardTerminalInput,
  handleTerminalMessage,
} from '../components/terminal/terminalSocket.ts';

// The pty side of a terminal pane. Two regressions from the "Codex re-emits
// its whole transcript for minutes" investigation:
//
// 1. Every intermediate size of a sidebar drag used to reach the pty as its
//    own resize. Codex (and any full-screen TUI) repaints on each SIGWINCH —
//    Codex clears and re-emits up to thousands of transcript rows — so one
//    drag became dozens of full redraws. Only the settled size may be sent.
// 2. A reconnect appended the scrollback replay UNDER the pane's existing
//    content (only a brand-new session cleared it), so the transcript was
//    painted twice. The `attached` frame now clears the buffer unconditionally.

type Handler<T> = (arg: T) => void;

function fakeTerminal() {
  const calls: string[] = [];
  let onData: Handler<string> = () => {};
  let onResize: Handler<{ cols: number; rows: number }> = () => {};
  const term = {
    cols: 80,
    rows: 24,
    write: (s: string) => calls.push(`write:${s}`),
    clear: () => calls.push('clear'),
    reset: () => calls.push('reset'),
    onData: (h: Handler<string>) => { onData = h; return { dispose() {} }; },
    onResize: (h: Handler<{ cols: number; rows: number }>) => { onResize = h; return { dispose() {} }; },
  } as unknown as Terminal;
  return { term, calls, type: (s: string) => onData(s), resize: (cols: number, rows: number) => onResize({ cols, rows }) };
}

function fakeSocket() {
  const sent: unknown[] = [];
  const ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) } as unknown as WebSocket;
  return { ws, sent };
}

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: {
      setTimeout: (fn: () => void, _ms: number) => { const id = next++; pending.set(id, fn); return id; },
      clearTimeout: (h: unknown) => { pending.delete(h as number); },
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get count() { return pending.size; },
  };
}

test('resize events are trailing-debounced: a drag reaches the pty once, at its final size', () => {
  const t = fakeTerminal();
  const { ws, sent } = fakeSocket();
  const timers = manualTimers();
  const io = forwardTerminalInput(t.term, () => ws, timers.schedule);
  assert.ok(RESIZE_DEBOUNCE_MS >= 100, 'a drag delivers many moves per 100ms');

  t.resize(100, 30);
  t.resize(101, 30);
  t.resize(102, 30);
  assert.deepEqual(sent, [], 'nothing is sent while the size is still moving');
  assert.equal(timers.count, 1, 'each move replaces the pending timer, never stacks one');

  timers.fire();
  assert.deepEqual(sent, [{ type: 'resize', cols: 102, rows: 30 }]);

  // Input is never delayed.
  t.type('x');
  assert.deepEqual(sent.at(-1), { type: 'input', data: 'x' });

  // Disposing drops a pending resize instead of sending it to a socket the
  // pane no longer owns.
  t.resize(50, 10);
  io.dispose();
  timers.fire();
  assert.equal(sent.filter((m) => (m as { type: string }).type === 'resize').length, 1);
});

test('an attached frame clears the buffer (never a full reset) whether or not a replay follows', () => {
  for (const replayed of [true, false, undefined]) {
    const t = fakeTerminal();
    handleTerminalMessage(JSON.stringify({ type: 'attached', id: 'srv', replayed }), {
      term: t.term,
      serverId: 'srv',
      onAttached: () => t.calls.push('attached'),
      onServerId: () => t.calls.push('serverId'),
      onTerminated: () => t.calls.push('terminated'),
    });
    // `clear`, not `reset`: a RIS would also drop the TUI's bracketed-paste /
    // mouse / alt-screen modes, which the replay window rarely re-establishes.
    assert.deepEqual(t.calls, ['attached', 'clear'], `replayed=${String(replayed)}`);
  }
});
