import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerminalActivityRelayObserver,
  getObservedTerminalTitle,
  rawDataFrameMayCarryTitle,
} from '../terminalActivityRelay.js';

// The relay's title observer decides on the RAW frame bytes whether a data
// frame can move the title parser, before paying for the string copy and the
// JSON.parse. Plain output in the ground state is skipped; anything that could
// carry an OSC title (ESC as JSON's `\u001b`, or a C1 control byte) — and every
// non-data frame — is parsed.

const frame = (data: string) => Buffer.from(JSON.stringify({ type: 'data', data }));

test('rawDataFrameMayCarryTitle: plain output is skippable, escapes and other frames are not', () => {
  assert.equal(rawDataFrameMayCarryTitle(frame('hello world\r\n')), false);
  assert.equal(rawDataFrameMayCarryTitle(frame('a'.repeat(10_000))), false);
  assert.equal(rawDataFrameMayCarryTitle(frame('\x1b]0;Working\x07')), true, 'ESC → \\u001b');
  assert.equal(rawDataFrameMayCarryTitle(frame('\x9d0;Working\x9c')), true, 'C1 OSC/ST bytes');
  assert.equal(rawDataFrameMayCarryTitle(frame('café Ā')), false, 'other non-ASCII is not C1');
  assert.equal(rawDataFrameMayCarryTitle(Buffer.from('{"type":"attached","id":"x"}')), true);
  assert.equal(rawDataFrameMayCarryTitle(Buffer.from('{"type":"exit","exitCode":0}')), true);
  assert.equal(rawDataFrameMayCarryTitle(Buffer.from('{"data":"x","type":"data"}')), true, 'unexpected key order → parse');
  assert.equal(rawDataFrameMayCarryTitle(Buffer.from('{')), true);
});

test('observeRaw skips plain frames yet still tracks titles split across frames', () => {
  const obs = createTerminalActivityRelayObserver();
  obs.observeRaw(Buffer.from(JSON.stringify({ type: 'attached', id: 'raw-1', replayed: false })));
  assert.equal(obs.sessionId, 'raw-1');
  obs.observeRaw(frame('plain output that must not be parsed'));
  assert.equal(getObservedTerminalTitle('raw-1'), null);
  obs.observeRaw(frame('\x1b]0;Wor'));
  // The parser is now mid-escape (not ground), so a plain-looking continuation
  // must still be fed to it.
  obs.observeRaw(frame('king\x07'));
  assert.equal(getObservedTerminalTitle('raw-1'), 'Working');
  obs.observeRaw(frame('more plain output'));
  assert.equal(getObservedTerminalTitle('raw-1'), 'Working');
  obs.observeRaw(Buffer.from(JSON.stringify({ type: 'exit', exitCode: 0 })));
  assert.equal(getObservedTerminalTitle('raw-1'), undefined, 'exit frames are parsed and dispose');
});
