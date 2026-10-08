// createEmitter is the one in-process pub/sub shape (emitter.ts). Pins the two
// properties the hand-rolled sets it replaced did not all have: emit iterates
// a snapshot, and a throwing listener cannot starve the rest. Plus its gauge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmitter } from '../emitter.js';
import { readMemGauges } from '../memDiag/gauges.js';

test('emit iterates a snapshot: (un)subscribing during an emit affects the next one', () => {
  const e = createEmitter<[number]>('test-snapshot');
  const seen: string[] = [];
  let offB: () => void = () => {};
  e.subscribe((n) => {
    seen.push(`a${n}`);
    offB();
    e.subscribe((m) => seen.push(`late${m}`));
  });
  offB = e.subscribe((n) => seen.push(`b${n}`));
  e.emit(1);
  assert.deepEqual(seen, ['a1', 'b1'], 'b still runs this emit; the late listener does not');
  seen.length = 0;
  e.emit(2);
  assert.deepEqual(seen.filter((s) => !s.startsWith('a')), ['late2']);
});

test('a throwing listener is isolated, and the subscriber count is a memory gauge', () => {
  const e = createEmitter<[string]>('test-isolation');
  const got: string[] = [];
  const offBad = e.subscribe(() => {
    throw new Error('boom');
  });
  const off = e.subscribe((s) => got.push(s));
  const original = console.error;
  console.error = () => {};
  try {
    e.emit('x');
  } finally {
    console.error = original;
  }
  assert.deepEqual(got, ['x']);
  assert.equal(readMemGauges()['listeners.test-isolation'], 2);
  offBad();
  off();
  assert.equal(e.size, 0);
});
