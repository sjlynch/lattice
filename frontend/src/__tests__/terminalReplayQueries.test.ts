import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/xterm';
import { MAX_PENDING_OUTPUT_CHARS, createTerminalOutput } from '../components/terminal/terminalOutput.ts';
import { handleTerminalMessage } from '../components/terminal/terminalSocket.ts';

// Old startup DA/color queries in scrollback used to generate fresh onData
// replies on every attach. Codex displayed those late replies in its prompt.
// Control asynchronous parsing explicitly: history guards must survive until
// xterm's write callback, without suppressing live queries or user input.
function fixture(onOverflow?: () => void) {
  type Callback = (...args: unknown[]) => boolean;
  const callbacks = new Map<string, Callback>();
  const writes: { data: string; done: () => void }[] = [];
  // write/clear order as xterm saw it.
  const events: string[] = [];
  let disposed = 0;
  const register = (id: string, callback: Callback) => {
    callbacks.set(id, callback);
    return { dispose() { disposed++; callbacks.delete(id); } };
  };
  const term = {
    parser: {
      registerCsiHandler: (id: object, callback: Callback) => register(`csi:${JSON.stringify(id)}`, callback),
      registerEscHandler: (id: object, callback: Callback) => register(`esc:${JSON.stringify(id)}`, callback),
      registerDcsHandler: (id: object, callback: Callback) => register(`dcs:${JSON.stringify(id)}`, callback),
      registerOscHandler: (id: number, callback: Callback) => register(`osc:${id}`, callback),
    },
    write: (data: string, done: () => void) => {
      events.push(`write:${data}`);
      writes.push({ data, done });
    },
    clear: () => events.push('clear'),
  } as unknown as Terminal;
  const output = createTerminalOutput(term, onOverflow);
  const consume = (id: string, ...args: unknown[]) => callbacks.get(id)!(...args);
  return { term, output, writes, events, consume, get disposed() { return disposed; } };
}

test('legacy history blocks DA/color replies until parsed, while live output waits and then answers normally', () => {
  const h = fixture();
  h.output.beginReplay();
  h.output.write('startup\x1b[c\x1b]10;?\x1b\\\x1b]11;?\x07');
  h.output.write('fresh live output', false);
  assert.equal(h.writes.length, 1, 'live bytes cannot change the guard before history has parsed');
  assert.equal(h.consume('csi:{"final":"c"}', [0]), true);
  assert.equal(h.consume('osc:10', '?'), true);
  assert.equal(h.consume('osc:11', '?'), true);
  assert.equal(h.consume('osc:10', '#123456'), false, 'historical color changes still reach xterm');
  assert.equal(h.consume('csi:{"final":"t"}', [8, 24, 80]), false, 'actual window operations are preserved');
  h.writes[0].done();
  assert.equal(h.writes[1].data, 'fresh live output');
  assert.equal(h.consume('csi:{"final":"c"}', [0]), false);
  assert.equal(h.consume('osc:10', '?'), false);
  assert.equal(h.consume('osc:11', '?'), false);
  h.writes[1].done();
  h.output.dispose();
});

test('empty replay boundaries preserve the first live query and reattach restores the history guard', () => {
  const h = fixture();
  const handlers = { term: h.term, output: h.output, onAttached() {}, onServerId() {}, onTerminated() {} };
  handleTerminalMessage(JSON.stringify({ type: 'attached', id: 'same-session', replayed: true }), handlers);
  handleTerminalMessage(JSON.stringify({ type: 'data', data: '', replayed: true }), handlers);
  h.writes[0].done();
  handleTerminalMessage(JSON.stringify({ type: 'data', data: '\x1b]11;?\x1b\\' }), handlers);
  assert.equal(h.consume('osc:11', '?'), false, 'empty history never swallows a live startup query');
  h.writes[1].done();
  handleTerminalMessage(JSON.stringify({ type: 'attached', id: 'same-session', replayed: true }), handlers);
  handleTerminalMessage(JSON.stringify({ type: 'data', data: '\x1b]11;?\x1b\\' }), handlers);
  assert.equal(h.consume('osc:11', '?'), true, 'retained executors without replay metadata still get the fix');
  h.output.write('queued live data', false);
  h.output.dispose();
  h.writes[2].done();
  assert.equal(h.writes.length, 3, 'teardown releases pending writes without sending them to a disposed terminal');
  assert.ok(h.disposed >= 10, 'all parser listeners are disposed');
});

// A hidden browser tab throttles xterm's parse timers while ws.onmessage keeps
// firing, so a busy pane's queue grew without limit and crashed the tab.
test('a pane more than the cap behind drops its backlog once and keeps flowing', () => {
  let overflows = 0;
  const h = fixture(() => { overflows++; });
  h.output.write('in flight', false);
  h.output.write('x'.repeat(MAX_PENDING_OUTPUT_CHARS), false);
  assert.equal(overflows, 0, 'a backlog of exactly the cap is kept');
  h.output.write('y', false);
  assert.equal(overflows, 1);
  h.writes[0].done();
  assert.equal(h.writes.length, 1, 'the dropped backlog never reaches xterm');
  h.output.write('after', false);
  h.output.write('more', false);
  assert.equal(h.writes[1].data, 'after');
  h.writes[1].done();
  assert.equal(h.writes[2].data, 'more');
  h.writes[2].done();
  assert.equal(overflows, 1, 'the counter restarts after a drop');
  h.output.dispose();
});

test('a reattach drops stale queued output and clears only after the chunk xterm is parsing', () => {
  const h = fixture();
  const handlers = { term: h.term, output: h.output, onAttached() {}, onServerId() {}, onTerminated() {} };
  h.output.write('parsing', false);
  h.output.write('stale 1', false);
  h.output.write('stale 2', false);
  handleTerminalMessage(JSON.stringify({ type: 'attached', id: 'same-session' }), handlers);
  handleTerminalMessage(JSON.stringify({ type: 'data', data: 'history\x1b[c', replayed: true }), handlers);
  assert.deepEqual(h.events, ['write:parsing'], 'the clear waits for the in-flight chunk');
  h.writes[0].done();
  assert.deepEqual(h.events, ['write:parsing', 'clear', 'write:history\x1b[c'], 'stale output is never parsed');
  assert.equal(h.consume('csi:{"final":"c"}', [0]), true, 'replay still consumes history queries');
  h.writes[1].done();
  handleTerminalMessage(JSON.stringify({ type: 'data', data: 'live' }), handlers);
  assert.deepEqual(h.events.slice(3), ['write:live']);
  h.writes[2].done();
  h.output.dispose();
});
