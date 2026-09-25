import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTerminalServerStatus } from '../terminalServerStatus.js';

// The navbar's "terminal server update pending" chip reads this. A stale
// executor is kept alive (to preserve terminals) until it has zero sessions,
// which with the user's own terminals open can be indefinitely — so the state
// has to be visible, with the session count the update is waiting on.

const ready = (fingerprint: string) => async () => ({
  kind: 'ready' as const,
  info: { fingerprint, instanceId: 'i-1' },
});

test('current executor: no session count needed', async () => {
  let counted = false;
  const status = await getTerminalServerStatus({
    probe: ready('fp-new'), expectedFingerprint: 'fp-new',
    count: async () => { counted = true; return 3; },
  });
  assert.deepEqual(status, { state: 'current', sessions: null });
  assert.equal(counted, false);
});

test('stale executor reports the sessions the update is waiting on', async () => {
  const status = await getTerminalServerStatus({
    probe: ready('fp-old'), expectedFingerprint: 'fp-new', count: async () => 4,
  });
  assert.deepEqual(status, { state: 'stale', sessions: 4 });

  const uncountable = await getTerminalServerStatus({
    probe: ready('fp-old'), expectedFingerprint: 'fp-new', count: async () => null,
  });
  assert.deepEqual(uncountable, { state: 'stale', sessions: null });
});

test('absent and unavailable executors are never reported stale', async () => {
  assert.deepEqual(
    await getTerminalServerStatus({ probe: async () => ({ kind: 'absent' }), expectedFingerprint: 'x' }),
    { state: 'absent', sessions: 0 },
  );
  assert.deepEqual(
    await getTerminalServerStatus({
      probe: async () => ({ kind: 'unavailable', error: 'boom' }), expectedFingerprint: 'x',
    }),
    { state: 'unavailable', sessions: null },
  );
});
