import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRequestRegistry } from '../terminalServer/sessionRequests.js';
import { SESSION_REQUEST_MAX_AGE_MS, SESSION_REQUEST_RETENTION_MS } from '../terminalProtocol.js';

test('full dedupe registry refuses admission without evicting pending or completed requests', async () => {
  let now = 1_000_000;
  const registry = createSessionRequestRegistry({ now: () => now, maxEntries: 1 });
  let finish!: (result: { id: string }) => void;
  let allocations = 0;
  const body = { requestId: 'request-fixture-0001', requestTimestamp: now };
  const pending = registry(body, () => new Promise((r) => { allocations++; finish = r; }));
  await Promise.resolve();
  const next = () => registry({ requestId: 'request-fixture-0002', requestTimestamp: now }, async () => ({ id: 'next' }));
  assert.ok('error' in await next());
  now += SESSION_REQUEST_RETENTION_MS * 2;
  assert.ok('error' in await next(), 'pending entry is never evicted by age');
  finish({ id: 'first' });
  assert.deepEqual(await pending, { id: 'first' });
  assert.ok('error' in await registry(body, async () => { allocations++; return { id: 'duplicate' }; }));
  assert.equal(allocations, 1, 'expired identity cannot allocate again');
  now += SESSION_REQUEST_RETENTION_MS + 1;
  assert.deepEqual(await next(), { id: 'next' });
});

test('invalid, future and expired identities are refused before allocation', async () => {
  const now = 1_000_000;
  const registry = createSessionRequestRegistry({ now: () => now });
  for (const body of [
    { requestId: '', requestTimestamp: now },
    { requestId: 'request-fixture-0001' },
    { requestId: 'request-fixture-0001', requestTimestamp: now - SESSION_REQUEST_MAX_AGE_MS - 1 },
    { requestId: 'request-fixture-0001', requestTimestamp: now + 60_001 },
  ]) {
    assert.ok('error' in await registry(body, async () => { throw new Error('must not allocate'); }));
  }
});

test('failed allocation is remembered so an uncertain retry never executes twice', async () => {
  const registry = createSessionRequestRegistry();
  const body = { requestId: 'request-fixture-0001', requestTimestamp: Date.now() };
  let allocations = 0;
  const create = async () => { allocations++; throw new Error('PTY bookkeeping failed'); };
  const first = await registry(body, create);
  assert.ok('error' in first);
  assert.deepEqual(await registry(body, create), first);
  assert.equal(allocations, 1);
});
