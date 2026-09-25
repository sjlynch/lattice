// The dev runner's half of the restart handshake: the policy asks the backend
// to drain before any restart (fail open), waits LOCK_SETTLE_MS after the last
// run.lock clears, re-defers if a lock appeared while draining, and skips the
// 15-min force backstop while the backend reports the holder parked on a live
// agent. Plus the HTTP client (restartHandshake.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeferAction,
  createRestartPolicy,
  locksParkedOnLiveAgents,
  DEFERRED_RESTART_POLL_MS,
  LOCK_SETTLE_MS,
  MAX_DEFER_MS,
  PARKED_PROBE_TTL_MS,
  type RunLock,
} from '../../scripts/dev/restartPolicy.mjs';
import {
  createRestartHandshake,
  HANDSHAKE_AUTH_HEADER,
  type PrepareResult,
} from '../../scripts/dev/restartHandshake.mjs';

async function flushPromises() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ---- pure decisions ----------------------------------------------------------

test('classifyDeferAction: a lock that cleared moments ago settles before applying', () => {
  const base = { deferredSince: 1, operationInFlight: false, workflowInFlight: false, settleMs: LOCK_SETTLE_MS };
  assert.equal(classifyDeferAction({ ...base, now: 10_000, lastLockSeenAt: 10_000 - 1_000 }), 'settle');
  assert.equal(classifyDeferAction({ ...base, now: 10_000, lastLockSeenAt: 10_000 - LOCK_SETTLE_MS }), 'apply');
  assert.equal(classifyDeferAction({ ...base, now: 10_000, lastLockSeenAt: 0 }), 'apply', 'never saw a lock → nothing to settle');
  assert.equal(
    classifyDeferAction({ deferredSince: 1, now: 10_000, operationInFlight: false, workflowInFlight: false }),
    'apply',
    'legacy callers (no settle params) keep the old decision',
  );
});

test('classifyDeferAction: past the window, a holder parked on a live agent is held, not forced', () => {
  const past = { deferredSince: 1, now: 1 + MAX_DEFER_MS + 1, operationInFlight: true };
  assert.equal(classifyDeferAction({ ...past, workflowInFlight: false, parkedOnLiveAgent: true }), 'hold-parked');
  assert.equal(classifyDeferAction({ ...past, workflowInFlight: false, parkedOnLiveAgent: false }), 'force');
  assert.equal(classifyDeferAction({ ...past, workflowInFlight: true, parkedOnLiveAgent: false }), 'hold-workflow');
  assert.equal(
    classifyDeferAction({ deferredSince: 1, now: 2, operationInFlight: true, workflowInFlight: false, parkedOnLiveAgent: true }),
    'hold',
    'inside the window it is an ordinary hold',
  );
});

test('locksParkedOnLiveAgents: every lock must be ours (pid) and parked', () => {
  const a: RunLock = { hash: 'aaa', label: 'merge-run', pid: 10, startedAt: 1 };
  const b: RunLock = { hash: 'bbb', label: 'manual-merge', pid: 10, startedAt: 1 };
  const report = {
    ok: true as const,
    pid: 10,
    holders: [
      { hash: 'aaa', parkedOn: 'conflict-resolver' },
      { hash: 'bbb', parkedOn: null },
    ],
  };
  assert.equal(locksParkedOnLiveAgents([a], report), true);
  assert.equal(locksParkedOnLiveAgents([a, b], report), false, 'one wedged holder is enough to force');
  assert.equal(locksParkedOnLiveAgents([{ ...a, pid: 11 }], report), false, 'a lock held by another process is not vouched for');
  assert.equal(locksParkedOnLiveAgents([a], { ok: false, why: 'down' }), false);
  assert.equal(locksParkedOnLiveAgents([a], null), false);
});

// ---- the policy with a handshake ------------------------------------------------

type Fixture = ReturnType<typeof fixture>;

function fixture(t: import('node:test').TestContext, opts: {
  prepare?: (reason: string) => Promise<PrepareResult>;
  holders?: () => Promise<unknown>;
  accept?: boolean;
  needsStart?: boolean;
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = {
    clock: 1_000_000,
    locks: [] as RunLock[],
    restarts: [] as string[],
    prepares: [] as string[],
    cancels: [] as string[],
    holderQueries: 0,
    logs: [] as string[],
    warns: [] as string[],
    resolvePrepare: null as null | ((r: PrepareResult) => void),
  };
  t.mock.method(console, 'log', (msg: unknown) => { f.logs.push(String(msg)); });
  t.mock.method(console, 'warn', (msg: unknown) => { f.warns.push(String(msg)); });
  const policy = createRestartPolicy({
    restartBackend: (reason) => { f.restarts.push(reason); return opts.accept ?? true; },
    readHeldRunLocks: () => f.locks,
    readNewestDistMtime: () => 100,
    now: () => f.clock,
    needsBackendStart: () => opts.needsStart ?? false,
    prepareRestart: (reason) => {
      f.prepares.push(reason);
      if (opts.prepare) return opts.prepare(reason);
      return new Promise<PrepareResult>((resolve) => { f.resolvePrepare = resolve; });
    },
    cancelRestartDrain: async (why) => { f.cancels.push(why); },
    queryLockHolders: opts.holders
      ? async () => { f.holderQueries += 1; return (await opts.holders!()) as never; }
      : undefined,
  });
  policy.resetDistBaseline();
  policy.startDeferredPoll();
  return { f, policy };
}

async function pollTick(t: import('node:test').TestContext, f: Fixture['f'], ms = DEFERRED_RESTART_POLL_MS) {
  f.clock += ms;
  t.mock.timers.tick(ms);
  await flushPromises();
}

test('a restart waits for the backend to drain, then applies', async (t) => {
  const { f, policy } = fixture(t);
  policy.onDistChanged(true);
  await flushPromises();
  assert.equal(f.prepares.length, 1, 'the backend is asked first');
  assert.equal(f.restarts.length, 0, 'no kill before it answers');
  policy.onDistChanged(true);
  assert.equal(f.prepares.length, 1, 'a second trigger coalesces into the in-flight handshake');
  f.resolvePrepare!({ ok: true, ready: true, pending: [], waitedMs: 40 });
  await flushPromises();
  assert.equal(f.restarts.length, 1);
  assert.match(f.logs.join('\n'), /backend drained for restart in 40 ms/);
  policy.stopDeferredPoll();
});

test('the handshake fails open: an unreachable or unsettled backend still gets restarted, with the reason logged', async (t) => {
  const down = fixture(t, { prepare: async () => ({ ok: false, why: 'backend unreachable: ECONNREFUSED' }) });
  down.policy.onDistChanged(true);
  await flushPromises();
  assert.equal(down.f.restarts.length, 1);
  assert.match(down.f.warns.join('\n'), /handshake unavailable \(backend unreachable: ECONNREFUSED\)/);
  down.policy.stopDeferredPoll();
  t.mock.timers.reset();

  const stuck = fixture(t, { prepare: async () => ({ ok: true, ready: false, pending: ['1 admitted spawn(s) still starting'], waitedMs: 45_000 }) });
  stuck.policy.onDistChanged(true);
  await flushPromises();
  assert.equal(stuck.f.restarts.length, 1);
  assert.match(stuck.f.warns.join('\n'), /did not settle within 45 s \(still in flight: 1 admitted spawn/);
  stuck.policy.stopDeferredPoll();
});

test('no running backend → no handshake (nothing to drain)', async (t) => {
  const { f, policy } = fixture(t, { needsStart: true });
  policy.onDistChanged(true);
  assert.equal(f.prepares.length, 0);
  assert.equal(f.restarts.length, 1);
  policy.stopDeferredPoll();
});

test('a run.lock taken while the backend drained re-defers the restart and releases the drain', async (t) => {
  const { f, policy } = fixture(t);
  policy.onDistChanged(true);
  await flushPromises();
  f.locks = [{ hash: 'beef', label: 'merge-run', pid: 42, startedAt: f.clock }];
  f.resolvePrepare!({ ok: true, ready: true, pending: [], waitedMs: 5 });
  await flushPromises();
  assert.equal(f.restarts.length, 0, 'never kill a run that started meanwhile');
  assert.equal(f.cancels.length, 1);
  assert.match(f.logs.join('\n'), /a run\.lock was taken while the backend drained/);

  // Deferred like any other: when the lock clears it settles, then re-asks.
  await pollTick(t, f);
  assert.equal(f.prepares.length, 1, 'still held');
  f.locks = [];
  await pollTick(t, f);
  assert.equal(f.prepares.length, 1, 'cleared 3 s after the last sighting — still settling');
  await pollTick(t, f);
  assert.equal(f.prepares.length, 2, 'settled — ask again');
  f.resolvePrepare!({ ok: true, ready: true, pending: [], waitedMs: 5 });
  await flushPromises();
  assert.deepEqual(f.restarts, ['run finished — applying deferred restart']);
  policy.stopDeferredPoll();
});

test('a dist change right after a lock cleared waits out the settle window', async (t) => {
  const { f, policy } = fixture(t);
  f.locks = [{ hash: 'cafe', label: 'workflow-merge:run_1', pid: 42, startedAt: f.clock }];
  policy.onDistChanged(true); // deferred
  f.locks = [];
  await pollTick(t, f, 1_000);
  assert.equal(f.prepares.length, 0);
  // The poll applies once LOCK_SETTLE_MS has passed since the last sighting.
  await pollTick(t, f, LOCK_SETTLE_MS);
  await flushPromises();
  assert.equal(f.prepares.length, 1);
  policy.stopDeferredPoll();
});

test('a restart the lifecycle refuses releases the drain instead of leaving the backend frozen', async (t) => {
  const { f, policy } = fixture(t, { accept: false, prepare: async () => ({ ok: true, ready: true, pending: [], waitedMs: 1 }) });
  policy.onDistChanged(true);
  await flushPromises();
  assert.equal(f.restarts.length, 1);
  assert.deepEqual(f.cancels, ['restart was not applied']);
  policy.stopDeferredPoll();
});

test('a handshake that straddles a backend respawn does not kill the new backend', async (t) => {
  const { f, policy } = fixture(t);
  policy.onDistChanged(true);
  await flushPromises();
  policy.onBackendSpawned({ mtime: 100, content: null, compileSequence: 0 });
  f.resolvePrepare!({ ok: true, ready: true, pending: [], waitedMs: 1 });
  await flushPromises();
  assert.equal(f.restarts.length, 0);
  assert.equal(f.cancels.length, 1);
  policy.stopDeferredPoll();
});

test('past the backstop, a merge run parked on a live resolver is NOT force-restarted; a wedged one is', async (t) => {
  let parked = true;
  const lock: RunLock = { hash: 'feed', label: 'merge-run', pid: 4242, startedAt: 1 };
  const { f, policy } = fixture(t, {
    holders: async () => ({
      ok: true, pid: 4242,
      holders: [{ hash: 'feed', parkedOn: parked ? 'conflict-resolver' : null, detail: parked ? 'merge run mr_1 parked on the conflict resolver for task t1' : 'merge run mr_1 running' }],
    }),
    prepare: async () => ({ ok: true, ready: true, pending: [], waitedMs: 1 }),
  });
  f.locks = [lock];
  policy.onDistChanged(true);
  f.clock += MAX_DEFER_MS;
  await pollTick(t, f); // past the window → asks the backend first
  assert.equal(f.holderQueries, 1);
  assert.equal(f.restarts.length, 0);
  await pollTick(t, f); // answer in: parked → hold
  assert.equal(f.restarts.length, 0);
  assert.match(f.logs.join('\n'), /parked on a live agent, not wedged.*conflict resolver for task t1/s);

  // The resolver finishes but the run wedges; the next refresh says so → force.
  parked = false;
  await pollTick(t, f, PARKED_PROBE_TTL_MS / 2);
  await pollTick(t, f);
  assert.deepEqual(f.restarts, ['forced after a long defer']);
  assert.match(f.warns.join('\n'), /forcing it.*not parked on a live agent: feed: merge run mr_1 running/s);
  policy.stopDeferredPoll();
});

test('past the backstop, a backend that cannot be asked gets the old force (fail open)', async (t) => {
  const { f, policy } = fixture(t, {
    holders: async () => ({ ok: false, why: 'backend unreachable: timed out' }),
    prepare: async () => ({ ok: false, why: 'backend unreachable: timed out' }),
  });
  f.locks = [{ hash: 'dead', label: 'manual-merge', pid: 7, startedAt: 1 }];
  policy.onDistChanged(true);
  f.clock += MAX_DEFER_MS;
  await pollTick(t, f);
  await pollTick(t, f);
  assert.deepEqual(f.restarts, ['forced after a long defer'], 'forced even though the lock is still held');
  assert.match(f.warns.join('\n'), /not parked on a live agent: backend unreachable: timed out/);
  policy.stopDeferredPoll();
});

// ---- the HTTP client ------------------------------------------------------------

test('handshake client: authenticated JSON calls to the loopback backend', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const hs = createRestartHandshake({
    port: 6000,
    readToken: () => 'tok'.repeat(12),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/prepare')) return new Response(JSON.stringify({ ready: true, pending: [], waitedMs: 12 }), { status: 200 });
      if (url.endsWith('/lock-holders')) return new Response(JSON.stringify({ pid: 9, holders: [{ hash: 'h', parkedOn: null }] }), { status: 200 });
      return new Response(JSON.stringify({ ended: true }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await hs.prepare('dist/ changed'), { ok: true, ready: true, pending: [], waitedMs: 12 });
  assert.equal(calls[0].url, 'http://127.0.0.1:6000/api/internal/restart-drain/prepare');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get(HANDSHAKE_AUTH_HEADER), 'tok'.repeat(12));
  const sent = JSON.parse(String(calls[0].init.body)) as { reason: string; ttlMs: number; budgetMs: number };
  assert.equal(sent.reason, 'dist/ changed');
  assert.ok(sent.ttlMs > sent.budgetMs, 'the drain outlives the settle wait');
  assert.deepEqual(await hs.lockHolders(), { ok: true, pid: 9, holders: [{ hash: 'h', parkedOn: null }] });
  assert.deepEqual(await hs.cancel('x'), { ok: true });
});

test('handshake client: every failure is a reason, never a throw', async () => {
  const noToken = createRestartHandshake({ readToken: () => null, fetchImpl: (() => { throw new Error('must not fetch'); }) as never });
  const r1 = await noToken.prepare('x');
  assert.equal(r1.ok, false);
  assert.match((r1 as { why: string }).why, /terminalServerToken/);

  const refused = createRestartHandshake({
    readToken: () => 't'.repeat(40),
    fetchImpl: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as never,
  });
  const r2 = await refused.prepare('x');
  assert.match((r2 as { why: string }).why, /backend unreachable: fetch failed \(ECONNREFUSED\)/);

  const old = createRestartHandshake({
    readToken: () => 't'.repeat(40),
    fetchImpl: (async () => new Response('<html>', { status: 404 })) as never,
  });
  const r3 = await old.lockHolders();
  assert.match((r3 as { why: string }).why, /HTTP 404/);
});
