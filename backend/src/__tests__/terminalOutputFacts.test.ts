import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalOutputFacts } from '../terminal/outputFacts.js';
import { wireSessionPtyEvents } from '../terminal/sessionLifecycle.js';
import { addSession, deleteSession, listSessions } from '../terminal/sessionStore.js';
import type { Session } from '../terminal/sessionTypes.js';
import { EMPTY_TERMINAL_ACTIVITY, stepTerminalActivity } from '../terminalActivity.js';

const NOW = 1_700_000_000_000;
// Captured from an isolated, non-working Codex 0.154.0 Windows PTY. It emits
// these synchronized-redraw controls roughly every 80ms while awaiting input.
const IDLE_CODEX_FRAME = '\x1b[?2026l\x1b[?2026h';

test('Codex control-only idle frames never create a printable-output run', () => {
  const facts = new TerminalOutputFacts();
  let state = EMPTY_TERMINAL_ACTIVITY;
  for (let tick = 0; tick < 12; tick++) {
    const at = NOW + tick * 1_000;
    for (let frame = 0; frame < 13; frame++) facts.write(IDLE_CODEX_FRAME, at);
    const next = stepTerminalActivity([
      { id: 'codex', initialCommand: 'codex --yolo', lastOutputAt: at,
        lastTextOutputAt: facts.lastTextOutputAt },
    ], state, at);
    assert.deepEqual(next.busy, []);
    state = next.state;
  }
  assert.equal(facts.lastTextOutputAt, 0);
});

test('Codex work becomes busy and stops despite continuing idle redraw traffic', () => {
  const facts = new TerminalOutputFacts();
  let state = EMPTY_TERMINAL_ACTIVITY;
  const busy: string[][] = [];
  for (let tick = 0; tick < 8; tick++) {
    const at = NOW + tick * 1_000;
    // A startup screen is one burst; later a turn renders its progress and
    // final answer. Control traffic keeps arriving after the turn finishes.
    if (tick === 0) facts.write('Codex ready > ', at);
    if (tick >= 2 && tick <= 4) facts.write(`\x1b[1GWorking ${tick}s\x1b[K`, at);
    facts.write(IDLE_CODEX_FRAME, at);
    const next = stepTerminalActivity([
      { id: 'codex', initialCommand: 'codex', lastOutputAt: at,
        lastTextOutputAt: facts.lastTextOutputAt },
    ], state, at);
    busy.push(next.busy);
    state = next.state;
  }
  assert.deepEqual(busy, [[], [], [], ['codex'], ['codex'], ['codex'], [], []]);
});

test('ANSI control sequences remain non-printing at every possible chunk split', () => {
  const controls = [
    IDLE_CODEX_FRAME, '\x1b[?25l\x1b[?25h', '\x1b[6n', '\x1b[38;2;10;20;30m',
    '\x1b]0;Codex - project\x07', '\x1b]2;window title\x1b\\',
    '\x1b]8;;https://example.invalid\x1b\\', '\x1b]52;c;base64clipboard\x07',
    '\x1bPprintable-looking device control\x1b\\', '\x1b_ignored application data\x1b\\',
    '\x1b(B\x1b)0', '\x9b?2026h\x9d0;title\x9c',
    '\r\n\b\t   \x07',
  ];
  for (const control of controls) {
    for (let split = 0; split <= control.length; split++) {
      const facts = new TerminalOutputFacts();
      facts.write(control.slice(0, split), NOW);
      facts.write(control.slice(split), NOW + 1);
      assert.equal(facts.lastTextOutputAt, 0, JSON.stringify({ control, split }));
      facts.write('actual text', NOW + 2);
      assert.equal(facts.lastTextOutputAt, NOW + 2, 'parser returns to printable text');
    }
  }
});

test('printable text, Unicode progress and hyperlink labels still count', () => {
  const facts = new TerminalOutputFacts();
  for (const [index, text] of ['hello', '\x1b[32mworking\x1b[0m', '\u28cb',
    '\x1b]8;;https://example.invalid\x1b\\label\x1b]8;;\x1b\\'].entries()) {
    facts.write(text, NOW + index);
    assert.equal(facts.lastTextOutputAt, NOW + index);
  }
});

test('large or canceled escape payloads never turn into printable output', () => {
  const facts = new TerminalOutputFacts();
  facts.write('\x1b]52;c;' + 'x'.repeat(300_000), NOW);
  facts.write('\x07', NOW + 1);
  assert.equal(facts.lastTextOutputAt, 0);
  facts.write('\x1bPignored\x18real output', NOW + 2);
  assert.equal(facts.lastTextOutputAt, NOW + 2);
  facts.write('\x1b[123\x1a', NOW + 3);
  assert.equal(facts.lastTextOutputAt, NOW + 2);
});

test('session output records printable facts without dropping raw traffic or changing lastOutputAt', (t) => {
  let at = NOW;
  t.mock.method(Date, 'now', () => at);
  let onData!: (data: string) => void;
  const scrollback: string[] = [];
  const broadcast: string[] = [];
  const session = {
    id: 'output-facts-fixture', cols: 80, rows: 24, cwd: '/fixture', shell: 'shell',
    projectPath: '/fixture', createdAt: NOW, lastOutputAt: NOW, initialCommand: 'codex',
    outputFacts: new TerminalOutputFacts(), killing: false,
    pty: { onData: (handler: typeof onData) => { onData = handler; }, onExit: () => {} },
    scrollback: { append: (data: string) => scrollback.push(data), dispose: () => {}, size: 0 },
    subscribers: new Set([{ OPEN: 1, readyState: 1, send: (message: string) => broadcast.push(message) }]),
  } as unknown as Session;
  addSession(session);
  t.after(() => deleteSession(session.id));
  wireSessionPtyEvents(session);
  onData(IDLE_CODEX_FRAME);
  assert.equal(listSessions().find(s => s.id === session.id)?.lastTextOutputAt, 0);
  at++;
  onData('working');
  at++;
  onData(IDLE_CODEX_FRAME);
  const snapshot = listSessions().find(s => s.id === session.id)!;
  assert.equal(snapshot.lastOutputAt, NOW + 2);
  assert.equal(snapshot.lastTextOutputAt, NOW + 1);
  assert.deepEqual(scrollback, [IDLE_CODEX_FRAME, 'working', IDLE_CODEX_FRAME]);
  assert.deepEqual(broadcast.map(message => JSON.parse(message).data), scrollback);
});
