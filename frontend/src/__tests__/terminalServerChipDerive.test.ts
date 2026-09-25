import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTerminalServerChip } from '../components/terminalServerChipDerive.ts';

// The navbar chip for a deferred terminal-server update: shown ONLY for a
// stale executor, and its tooltip names how many terminals the update waits on.

test('no chip unless the executor is stale', () => {
  assert.equal(deriveTerminalServerChip(null), null);
  assert.equal(deriveTerminalServerChip({ state: 'current', sessions: null }), null);
  assert.equal(deriveTerminalServerChip({ state: 'absent', sessions: 0 }), null);
  assert.equal(deriveTerminalServerChip({ state: 'unavailable', sessions: null }), null);
});

test('stale executor: label + tooltip with the terminal count', () => {
  const many = deriveTerminalServerChip({ state: 'stale', sessions: 5 });
  assert.equal(many?.label, 'Terminal server update pending');
  assert.match(many?.title ?? '', /once all 5 terminals are closed/);
  assert.match(many?.title ?? '', /full restart of `npm run dev`/);

  assert.match(deriveTerminalServerChip({ state: 'stale', sessions: 1 })?.title ?? '', /once its 1 terminal is closed/);
  assert.match(deriveTerminalServerChip({ state: 'stale', sessions: null })?.title ?? '', /once all terminals are closed/);
});
