// Regression for the 2026-08-20 backend death that left NO evidence anywhere.
//
// `dist/index.js` exited with code 3221225477 and the dev runner printed it as
// a bare number, which reads like an ordinary non-zero exit. It isn't:
// 3221225477 is 0xC0000005, STATUS_ACCESS_VIOLATION — the OS killed the process
// for dereferencing a bad pointer. Nothing inside that process can log such a
// death (no JS runs), so the exit code is the ONLY signal that says "stop
// looking for a JS bug". It has to be legible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeExitCode, isHardFault } from '../../scripts/dev/exitStatus.mjs';

test('the access violation that killed the backend is named, not left as a number', () => {
  const text = describeExitCode(3221225477);
  assert.match(text, /0xC0000005/, 'the hex form must be present to look up');
  assert.match(text, /STATUS_ACCESS_VIOLATION/);
  assert.match(text, /native/i, 'it must say this was not a JS-level exception');
  assert.equal(isHardFault(3221225477), true);
});

test('an OOM/V8 abort is distinguished from a bad-pointer crash', () => {
  // These two look equally alarming as raw numbers but call for completely
  // different investigations — and unlike an access violation, this one DOES
  // leave a report.*.json behind.
  const text = describeExitCode(3221226505); // 0xC0000409
  assert.match(text, /STATUS_STACK_BUFFER_OVERRUN/);
  assert.match(text, /OOM|abort/i);
  assert.notEqual(text, describeExitCode(3221225477));
});

test('ordinary exits are left alone and never misread as faults', () => {
  // The decoder keys off the 0x80000000+ range, so a normal exit code can't be
  // mistaken for an NTSTATUS.
  assert.equal(describeExitCode(0), 'code 0');
  assert.equal(describeExitCode(1), 'code 1');
  assert.equal(describeExitCode(255), 'code 255');
  for (const code of [0, 1, 3, 255, -1]) {
    assert.equal(isHardFault(code), false, `code ${code} must not read as a fault`);
  }
});

test('a signal wins over the code, and an unknown fault still renders usefully', () => {
  assert.equal(describeExitCode(null, 'SIGTERM'), 'signal SIGTERM');
  // Not in the table, but still clearly a fault — and rendered in the hex form
  // an NTSTATUS lookup actually takes.
  assert.equal(isHardFault(0xc0000029), true);
  assert.match(describeExitCode(0xc0000029), /0xC0000029/);
});

test('unsigned exit -1 is not diagnosed as a native crash', () => {
  for (const code of [-1, 4294967295]) {
    assert.equal(isHardFault(code), false);
    assert.match(describeExitCode(code), /0xFFFFFFFF.*exit -1/);
    assert.match(describeExitCode(code), /does not identify the cause/);
  }
});
