import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalOutputFacts } from '../terminal/outputFacts.js';
import { stepTerminalActivity, type TerminalActivityState } from '../terminalActivity.js';

// OSC status bytes/timing captured from an isolated Codex 0.154 Windows PTY:
// startup, completed turn, interrupted turn, failed turn, graceful shutdown.
// Only public status strings are retained; no session/project/prompt content.
const titleTrace = [
  [363, 'Ready'], [8115, 'Working'], [11782, 'Ready'],
  [14614, 'Working'], [17639, 'Ready'], [20648, 'Working'],
  [22501, 'Ready'], [26642, ''],
] as const;

test('captured Codex status transitions reach the activity classifier immediately', () => {
  const facts = new TerminalOutputFacts();
  let state: TerminalActivityState = new Map();
  for (const [at, title] of titleTrace) {
    // A transport may split even the short native OSC frame.
    facts.write('\x1b]0;', at);
    facts.write(title, at);
    facts.write('\x07', at);
    const result = stepTerminalActivity([{
      id: 'codex-capture', initialCommand: 'codex --yolo',
      terminalTitle: facts.terminalTitle, lastOutputAt: at,
      lastTextOutputAt: facts.lastTextOutputAt,
    }], state, at);
    state = result.state;
    assert.deepEqual(result.busy, title === 'Working' ? ['codex-capture'] : []);
  }
});

test('idle artwork stays printable without changing native Codex activity', () => {
  const facts = new TerminalOutputFacts();
  facts.write('\x1b]0;Ready\x07', 1000);
  for (let tick = 1; tick <= 60; tick++) {
    const at = 1000 + tick * 80;
    facts.write('\x1b[?2026h\x1b[10;2H\x1b[38;2;80;120;160m⠄⡀⠈⠠⠁⢀\x1b[?2026l', at);
    assert.equal(facts.lastTextOutputAt, at);
    assert.deepEqual(stepTerminalActivity([{
      id: 'codex-artwork', initialCommand: 'codex --yolo',
      terminalTitle: facts.terminalTitle,
      lastTextOutputAt: at, lastOutputAt: at,
    }], new Map(), at).busy, []);
  }
  facts.write('\x1b]0;Working\x07', 6000);
  // A long tool wait may emit only terminal controls, with no printable text.
  facts.write('\x1b[?2026h\x1b[?2026l', 66_000);
  assert.deepEqual(stepTerminalActivity([{
    id: 'codex-artwork', initialCommand: 'codex --yolo',
    terminalTitle: facts.terminalTitle, lastOutputAt: 66_000,
    lastTextOutputAt: facts.lastTextOutputAt,
  }], new Map(), 66_000).busy, ['codex-artwork']);
});

test('a captured animations-disabled Codex turn stays busy through twenty seconds without output', () => {
  // Native Codex fixture: Working at 7679ms; no raw output for 20023ms;
  // delayed loopback response completes at 27749ms, Ready arrives at 27803ms.
  const facts = new TerminalOutputFacts();
  facts.write('\x1b]0;Working\x07', 7679);
  const session = { id: 'quiet-codex', initialCommand: 'codex', lastOutputAt: 7679,
    terminalTitle: facts.terminalTitle };
  assert.deepEqual(stepTerminalActivity([session], new Map(), 27_700).busy, ['quiet-codex']);
  facts.write('\x1b]0;Ready\x07', 27803);
  assert.deepEqual(stepTerminalActivity([{ ...session, lastOutputAt: 27803,
    terminalTitle: facts.terminalTitle }], new Map(), 27803).busy, []);
});
