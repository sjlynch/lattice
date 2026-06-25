import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultRoot } from '../hooks/resolveDefaultRoot.ts';

// No-op sleep so backoff doesn't actually wait in tests.
const noSleep = () => Promise.resolve();

test('returns the root on first success', async () => {
  let calls = 0;
  const root = await resolveDefaultRoot({
    fetchRoot: async () => {
      calls += 1;
      return 'C:/proj';
    },
    sleep: noSleep,
  });
  assert.equal(root, 'C:/proj');
  assert.equal(calls, 1, 'no retry needed on first success');
});

// The regression: a transient boot-time failure (502 / parse error) must NOT
// strand the app on the empty shell — it retries and ends up with the root.
test('retries a transient failure then resolves to the root', async () => {
  let calls = 0;
  const root = await resolveDefaultRoot({
    fetchRoot: async () => {
      calls += 1;
      if (calls === 1) throw new Error('default-root failed: 502');
      return 'C:/proj';
    },
    sleep: noSleep,
  });
  assert.equal(root, 'C:/proj', 'app ends up on the resolved root, not the empty shell');
  assert.equal(calls, 2, 'fetched once more after the transient failure');
});

test('keeps retrying across several transient failures', async () => {
  let calls = 0;
  const root = await resolveDefaultRoot({
    fetchRoot: async () => {
      calls += 1;
      if (calls < 4) throw new Error('boom');
      return 'C:/late';
    },
    sleep: noSleep,
  });
  assert.equal(root, 'C:/late');
  assert.equal(calls, 4);
});

test('falls back to the empty shell only after exhausting all attempts', async () => {
  let calls = 0;
  const root = await resolveDefaultRoot({
    fetchRoot: async () => {
      calls += 1;
      throw new Error('still down');
    },
    maxAttempts: 3,
    sleep: noSleep,
  });
  assert.equal(root, '', 'concedes to the empty shell when the backend never recovers');
  assert.equal(calls, 3, 'tried exactly maxAttempts times');
});

test('a genuine empty default ("") is returned immediately, not treated as failure', async () => {
  let calls = 0;
  const root = await resolveDefaultRoot({
    fetchRoot: async () => {
      calls += 1;
      return '';
    },
    sleep: noSleep,
  });
  assert.equal(root, '');
  assert.equal(calls, 1, 'a successful empty response is not retried');
});

test('cancellation stops the retry loop and yields the empty shell', async () => {
  let calls = 0;
  let cancelled = false;
  const root = await resolveDefaultRoot({
    fetchRoot: async () => {
      calls += 1;
      cancelled = true; // e.g. the effect cleanup ran during the in-flight call
      throw new Error('boom');
    },
    isCancelled: () => cancelled,
    sleep: noSleep,
  });
  assert.equal(root, '');
  assert.equal(calls, 1, 'no further attempts once cancelled');
});

test('onRetry is invoked per retry with the attempt index, but not after the last', async () => {
  const attempts: number[] = [];
  await resolveDefaultRoot({
    fetchRoot: async () => {
      throw new Error('boom');
    },
    maxAttempts: 3,
    sleep: noSleep,
    onRetry: (_err, attempt) => attempts.push(attempt),
  });
  // 3 attempts → retries fire after attempt 0 and attempt 1, none after the
  // final (attempt 2) since we give up instead of scheduling another try.
  assert.deepEqual(attempts, [0, 1]);
});
