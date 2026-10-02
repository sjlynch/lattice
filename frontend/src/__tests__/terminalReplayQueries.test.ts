import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/xterm';
import { createTerminalOutput } from '../components/terminal/terminalOutput.ts';
import { handleTerminalMessage } from '../components/terminal/terminalSocket.ts';

// Old startup DA/color queries in scrollback used to generate fresh onData
// replies on every attach. Codex displayed those late replies in its prompt.
// Control asynchronous parsing explicitly: history guards must survive until
// xterm's write callback, without suppressing live queries or user input.
function fixture() {
  type Callback = (...args: unknown[]) => boolean;
  const callbacks = new Map<string, Callback>();
  const writes: { data: string; done: () => void }[] = [];
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
    write: (data: string, done: () => void) => writes.push({ data, done }),
    clear() {},
  } as unknown as Terminal;
  const output = createTerminalOutput(term);
  const consume = (id: string, ...args: unknown[]) => callbacks.get(id)!(...args);
  return { term, output, writes, consume, get disposed() { return disposed; } };
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
