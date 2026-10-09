import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createTerminalLifecycle } from '../terminalServerLifecycle.js';

const absent = () => Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
const health = (fingerprint = 'new', instanceId = 'executor') => ({
  ok: true, fingerprint, instanceId, protocolVersion: 1,
  capabilities: { idempotentCreate: true, shutdownIfIdle: true },
});

function fixture(options: {
  initial?: 'current' | 'legacy' | 'old' | 'absent' | 'unknown' | 'html' | 'incompatible';
  busy?: boolean; hangShutdown?: boolean; launchFailure?: 'error' | 'exit' | 'timeout' | 'throw' | 'lost-bind';
  // Health probes that time out before the executor answers (its event loop
  // blocked by a burst of ConPTY spawns).
  busyProbes?: number;
} = {}) {
  let time = 0;
  let busyProbes = options.busyProbes ?? 0;
  let state = options.initial ?? 'current';
  const calls = { launches: 0, idleShutdowns: 0, unsafeShutdowns: 0 };
  const healthChecks = { count: 0 };
  const children: EventEmitter[] = [];
  let firstLaunch = true;
  const lifecycle = createTerminalLifecycle({
    base: 'http://fixture.invalid', fingerprint: 'new', now: () => time,
    startupTimeoutMs: 300, shutdownTimeoutMs: 300,
    sleep: async (ms) => { time += ms; },
    fetch: (async (url) => {
      const target = String(url);
      if (target.endsWith('/shutdown')) { calls.unsafeShutdowns++; throw new Error('unsafe shutdown'); }
      if (target.endsWith('/shutdown-if-idle')) {
        calls.idleShutdowns++;
        if (options.busy) return Response.json({ busy: true }, { status: 409 });
        if (!options.hangShutdown) state = 'absent';
        return Response.json({ ok: true, instanceId: 'executor' }, { status: 202 });
      }
      healthChecks.count++;
      if (busyProbes > 0) { busyProbes--; throw new DOMException('probe timed out', 'TimeoutError'); }
      if (state === 'absent') throw absent();
      if (state === 'unknown') throw new DOMException('probe timed out', 'TimeoutError');
      if (state === 'html') return new Response('<html>unrelated listener</html>');
      if (state === 'incompatible') return Response.json({ ...health(), protocolVersion: 999 });
      if (state === 'legacy') return Response.json({ ok: true, fingerprint: 'old' });
      return Response.json(health(state === 'old' ? 'old' : 'new'));
    }) as typeof fetch,
    launch: () => {
      calls.launches++;
      const child = new EventEmitter();
      Object.assign(child, { unref() {} });
      children.push(child);
      if (firstLaunch && options.launchFailure) {
        firstLaunch = false;
        if (options.launchFailure === 'throw') throw new Error('spawn failed synchronously');
        if (options.launchFailure === 'error') queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
        if (options.launchFailure === 'exit') queueMicrotask(() => child.emit('exit', 1, null));
        if (options.launchFailure === 'lost-bind') {
          state = 'current';
          queueMicrotask(() => child.emit('exit', 1, null));
        }
      } else state = 'current';
      return child as ChildProcess;
    },
  });
  return { lifecycle, calls, children, healthChecks };
}

test('current server is reused without upgrade requests', async () => {
  const f = fixture();
  assert.equal((await f.lifecycle.ensure()).fingerprint, 'new');
  assert.deepEqual(f.calls, { launches: 0, idleShutdowns: 0, unsafeShutdowns: 0 });
});

// A restore pass after a full restart relaunched every tab at once; the probes
// of the later spawns timed out while the executor was busy spawning the
// earlier ones, and those tabs ended `restore-failed`.
test('a busy executor whose health probes time out is re-probed and reused, never failed or replaced', async () => {
  const f = fixture({ busyProbes: 3 });
  const [a, b] = await Promise.all([f.lifecycle.ensure(), f.lifecycle.ensure()]);
  assert.equal(a.fingerprint, 'new');
  assert.equal(b, a, 'concurrent spawns share the one re-probing ensure');
  assert.deepEqual(f.calls, { launches: 0, idleShutdowns: 0, unsafeShutdowns: 0 });
  assert.equal(f.healthChecks.count, 4);
});

test('a listener that never answers still fails after the busy budget, without spawning', async () => {
  const f = fixture({ initial: 'unknown' });
  await assert.rejects(f.lifecycle.ensure(), /Terminal server unavailable: probe timed out/);
  assert.ok(f.healthChecks.count > 1, 'a timeout is re-probed before giving up');
  assert.equal(f.calls.launches, 0);
});

test('legacy fingerprint mismatch preserves every live session without attempting shutdown', async () => {
  const f = fixture({ initial: 'legacy' });
  assert.equal((await f.lifecycle.ensure()).fingerprint, 'old');
  await f.lifecycle.respawn();
  assert.deepEqual(f.calls, { launches: 0, idleShutdowns: 0, unsafeShutdowns: 0 });
});

test('a compatible old executor with sessions is reused and its upgrade deferred', async () => {
  const f = fixture({ initial: 'old', busy: true });
  assert.equal((await f.lifecycle.ensure()).fingerprint, 'old');
  assert.deepEqual(f.calls, { launches: 0, idleShutdowns: 1, unsafeShutdowns: 0 });
});

test('a confirmed idle executor upgrades once, shared by ensure and repair callers', async () => {
  const f = fixture({ initial: 'old' });
  const first = f.lifecycle.ensure();
  const second = f.lifecycle.respawn();
  assert.equal(first, second, 'repair cannot reset the startup singleton');
  assert.equal((await first).fingerprint, 'new');
  assert.deepEqual(f.calls, { launches: 1, idleShutdowns: 1, unsafeShutdowns: 0 });
});

test('an idle shutdown timeout leaves the listener untouched and reports failure', async () => {
  const f = fixture({ initial: 'old', hangShutdown: true });
  await assert.rejects(f.lifecycle.ensure(), /did not finish/);
  assert.equal(f.calls.launches, 0);
  assert.equal(f.calls.unsafeShutdowns, 0);
});

test('a child that loses the bind race adopts the compatible winner', async () => {
  const f = fixture({ initial: 'absent', launchFailure: 'lost-bind' });
  assert.equal((await f.lifecycle.ensure()).fingerprint, 'new');
  assert.equal(f.calls.launches, 1);
  assert.equal(f.calls.unsafeShutdowns, 0);
});

for (const initial of ['unknown', 'html', 'incompatible'] as const) {
  test(`an ${initial} listener does not authorize a spawn or shutdown`, async () => {
    const f = fixture({ initial });
    await assert.rejects(f.lifecycle.ensure(), /unavailable/);
    assert.deepEqual(f.calls, { launches: 0, idleShutdowns: 0, unsafeShutdowns: 0 });
  });
}

for (const launchFailure of ['error', 'exit', 'timeout', 'throw'] as const) {
  test(`spawn ${launchFailure} rejects explicitly and releases the singleton for the next attempt`, async () => {
    const f = fixture({ initial: 'absent', launchFailure });
    await assert.rejects(f.lifecycle.ensure(), /spawn|exited|did not start/);
    assert.equal((await f.lifecycle.ensure()).fingerprint, 'new');
    assert.equal(f.calls.launches, 2);
    assert.equal(f.calls.unsafeShutdowns, 0);
  });
}
