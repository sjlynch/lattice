// Surviving a backend restart, transport level: retryTransient retries
// 502/503/504 and network errors but throws a real answer (4xx / 500) at once;
// with `retryIf` it retries only failures the backend never acted on (a 503
// drain or a refused connection — never a lost response that may have started a
// session); it stops when cancelled or out of time budget. And the navbar's
// backend-connection indicator is "down" while any live channel reconnects.
// Shared fixtures: backendRestartResilience.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../api/http.ts';
import {
  isTransientRequestError,
  mayHaveBeenApplied,
  retryTransient,
} from '../api/retry.ts';
import {
  isBackendConnectionDown,
  subscribeBackendConnection,
  subscribeWs,
} from '../api/ws.ts';
import { FakeWebSocket } from './domDoubles.ts';
import { installRestartGlobals, noSleep } from './backendRestartResilience.fixture.ts';

installRestartGlobals();

// ---------------------------------------------------------------- retry.ts

test('retryTransient retries 502/503/504 and network errors, then resolves', async () => {
  const errors: unknown[] = [
    new TypeError('Failed to fetch'),
    new HttpError(502, '[api-proxy]: ECONNREFUSED'),
    new HttpError(503, 'workflow recovery is still loading'),
    new HttpError(504, 'gateway timeout'),
  ];
  let calls = 0;
  const retried: unknown[] = [];
  const value = await retryTransient(
    async () => {
      const err = errors[calls++];
      if (err) throw err;
      return 'ok';
    },
    { sleep: noSleep, onRetry: (err) => retried.push(err) },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 5);
  assert.deepEqual(retried, errors);
});

test('retryTransient throws a real answer (4xx / 500) immediately', async () => {
  for (const status of [400, 404, 409, 500]) {
    let calls = 0;
    await assert.rejects(
      retryTransient(async () => {
        calls++;
        throw new HttpError(status, 'nope');
      }, { sleep: noSleep }),
      (err: unknown) => err instanceof HttpError && err.status === status,
    );
    assert.equal(calls, 1, `status ${status} is not retried`);
  }
});

test('retryTransient with retryIf retries only failures the backend never acted on', async () => {
  // A single merge / push / QA start: a 503 drain or a refused connection is
  // retried, a lost response (504 / network error) is not — it may have
  // started a session a retry would duplicate.
  const retryIf = (err: unknown) => !mayHaveBeenApplied(err);
  let calls = 0;
  const value = await retryTransient(async () => {
    calls++;
    if (calls === 1) throw new HttpError(503, 'backend-restarting');
    if (calls === 2) throw new HttpError(502, '[api-proxy]: ECONNREFUSED');
    return 'ok';
  }, { sleep: noSleep, retryIf });
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  for (const err of [new HttpError(504, 'gateway timeout'), new TypeError('Failed to fetch')]) {
    let n = 0;
    await assert.rejects(retryTransient(async () => { n++; throw err; }, { sleep: noSleep, retryIf }));
    assert.equal(n, 1);
  }
});

test('retryTransient stops when cancelled and when the time budget runs out', async () => {
  let calls = 0;
  let cancel = false;
  await assert.rejects(
    retryTransient(async () => {
      calls++;
      if (calls === 2) cancel = true;
      throw new HttpError(502, 'down');
    }, { sleep: noSleep, isCancelled: () => cancel }),
  );
  assert.equal(calls, 2, 'no attempt after cancellation');

  let t = 0;
  calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls++;
      throw new HttpError(503, 'down');
    }, {
      sleep: async (ms) => { t += ms; },
      now: () => t,
      maxElapsedMs: 10_000,
    }),
  );
  // 1s + 2s + 4s = 7s; the next 8s wait would exceed the 10s budget.
  assert.equal(calls, 4);
});

test('mayHaveBeenApplied only flags failures that could have reached the backend', () => {
  assert.equal(mayHaveBeenApplied(new HttpError(503, 'recovering')), false);
  assert.equal(mayHaveBeenApplied(new HttpError(502, '[api-proxy]: ECONNREFUSED (x)')), false);
  assert.equal(mayHaveBeenApplied(new HttpError(502, '[api-proxy]: ECONNRESET (x)')), true);
  assert.equal(mayHaveBeenApplied(new HttpError(504, 'timeout')), true);
  assert.equal(mayHaveBeenApplied(new TypeError('Failed to fetch')), true);
  assert.equal(isTransientRequestError(new SyntaxError('bad json')), false);
});

// ------------------------------------------------ connection indicator

test('backend connection is "down" while any live channel is reconnecting', () => {
  const seen: boolean[] = [];
  const unsubHealth = subscribeBackendConnection((down) => seen.push(down));
  const unsubA = subscribeWs('/ws/a?project=x', () => {});
  const unsubB = subscribeWs('/ws/b?project=x', () => {});
  const [a, b] = FakeWebSocket.instances;
  a.serverAccept();
  b.serverAccept();
  assert.equal(isBackendConnectionDown(), false);

  a.serverDrop();
  b.serverDrop();
  assert.equal(isBackendConnectionDown(), true);
  unsubA();
  assert.equal(isBackendConnectionDown(), true, 'b is still down');
  unsubB();
  assert.equal(isBackendConnectionDown(), false, 'torn-down channels never count');
  assert.deepEqual(seen, [true, false], 'notified once per transition');
  unsubHealth();
});
