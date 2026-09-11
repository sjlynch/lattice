import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyCreateSession } from '../terminalServerClient/createSession.js';
import { EXPECTED_TERMINAL_FINGERPRINT } from '../terminalServerLifecycle.js';
import { createSessionRequestRegistry } from '../terminalServer/sessionRequests.js';
import type { TerminalSessionRequestBody } from '../terminalServer/createSessionHandler.js';

// A fake transport runs the real dedupe registry, allocates, and then loses the
// reply. Retrying must retrieve that allocation, never start a second agent.
async function withTransport(
  opts: { legacy?: boolean; alwaysFail?: boolean; failure?: 'socket' | 'html' | 'empty' | 'timeout' | 'cap'; afterFailure?: 'changed' | 'unknown' | 'absent' } = {},
) {
  const original = globalThis.fetch;
  const counts = { health: 0, posts: 0, allocations: 0, shutdown: 0 };
  const bodies: TerminalSessionRequestBody[] = [];
  const registry = createSessionRequestRegistry();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      counts.health++;
      if (counts.posts && opts.afterFailure === 'unknown') throw new TypeError('fetch failed');
      if (counts.posts && opts.afterFailure === 'absent') throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      return Response.json({ ok: true, fingerprint: EXPECTED_TERMINAL_FINGERPRINT,
        ...(opts.legacy ? {} : { protocolVersion: 1, instanceId: counts.posts && opts.afterFailure === 'changed' ? 'replacement' : 'executor-1',
          capabilities: { idempotentCreate: true, shutdownIfIdle: true } }) });
    }
    if (url.includes('/shutdown')) { counts.shutdown++; throw new Error('must never shut down peers'); }
    assert.ok(url.endsWith('/sessions'));
    counts.posts++;
    if (opts.failure === 'cap') return Response.json({ error: 'at capacity', code: 'CAP' }, { status: 503 });
    const body = JSON.parse(String(init?.body)) as TerminalSessionRequestBody;
    bodies.push(body);
    const allocation = await registry(body, async () => ({ id: `allocated-${++counts.allocations}` }));
    if (counts.posts === 1 || opts.alwaysFail) {
      if (opts.failure === 'html') return new Response('<html>broken reply</html>');
      if (opts.failure === 'empty') return new Response('');
      if (opts.failure === 'timeout') throw new DOMException('timeout', 'TimeoutError');
      throw new TypeError('fetch failed after allocation');
    }
    return Response.json(allocation);
  }) as typeof fetch;
  try {
    const result = await proxyCreateSession({ initialCommand: 'bash' });
    return { result, counts, bodies };
  } finally { globalThis.fetch = original; }
}

for (const failure of ['socket', 'html', 'empty', 'timeout'] as const) {
  test(`lost ${failure} reply reuses the same allocation without killing peers`, async () => {
    const { result, counts, bodies } = await withTransport({ failure });
    assert.deepEqual(result, { id: 'allocated-1' });
    assert.equal(counts.allocations, 1);
    assert.equal(counts.posts, 2);
    assert.equal(counts.shutdown, 0);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.ok(bodies[0].requestId);
    assert.equal(bodies[0].serverInstanceId, 'executor-1');
  });
}

test('legacy executor receives no ambiguous retry', async () => {
  const { result, counts } = await withTransport({ legacy: true });
  assert.ok('error' in result && /outcome is unknown/.test(result.error));
  assert.equal(counts.posts, 1);
  assert.equal(counts.allocations, 1);
  assert.equal(counts.shutdown, 0);
});

for (const afterFailure of ['changed', 'unknown', 'absent'] as const) {
  test(`ambiguous allocation is not replayed when executor is ${afterFailure}`, async () => {
    const { result, counts } = await withTransport({ afterFailure });
    assert.ok('error' in result);
    assert.equal(counts.posts, 1);
    assert.equal(counts.allocations, 1);
    assert.equal(counts.shutdown, 0);
  });
}

test('a slow legacy request reports uncertain outcome without replay or peer shutdown', async () => {
  const { result, counts } = await withTransport({ failure: 'timeout', legacy: true });
  assert.ok('error' in result && /within 30000ms/.test(result.error) && /outcome is unknown/.test(result.error));
  assert.equal(counts.posts, 1);
  assert.equal(counts.shutdown, 0);
});

test('two lost replies stop at one retry and report uncertain allocation', async () => {
  const { result, counts } = await withTransport({ failure: 'timeout', alwaysFail: true });
  assert.ok('error' in result && /outcome remains unknown/.test(result.error));
  assert.equal(counts.posts, 2);
  assert.equal(counts.allocations, 1);
  assert.equal(counts.shutdown, 0);
});

test('capacity errors retain CAP without retrying or restarting', async () => {
  const { result, counts } = await withTransport({ failure: 'cap' });
  assert.deepEqual(result, { error: 'at capacity', code: 'CAP' });
  assert.equal(counts.posts, 1);
  assert.equal(counts.shutdown, 0);
});
