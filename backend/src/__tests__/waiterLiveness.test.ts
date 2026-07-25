import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitResolverWaiter,
  type WaiterLivenessConfig,
  type WaiterLivenessDeps,
} from '../mergeRuns/waiterLiveness.js';
import {
  createRunState,
  registerConflictWaiter,
  signalConflictWaiterInState,
} from '../mergeRuns/state.js';

// Part B regression: a merge-run worker parked on a conflict waiter must have a
// bounded lifetime. registerConflictWaiter has no timeout, so a resolver that
// dies WITHOUT hitting any callback (crash / OOM / user kills the pty / missed
// Stop hook) used to leave the worker awaiting forever — finalizeMergeRun's
// releaseLock never runs, the cross-process project run-lock stays held, and
// every later merge/merge-run/workflow-Merge returns 409 until a backend
// restart. awaitResolverWaiter gives the wait a pty-liveness backstop so a dead
// resolver releases the run instead.

// A synchronous, deterministic timer harness: setTimer records the callback and
// a virtual fire-time; advance() fires everything due. now() reads virtual time.
function fakeClock() {
  let virtualNow = 0;
  type Scheduled = { at: number; fn: () => void; handle: symbol };
  let scheduled: Scheduled[] = [];
  const deps = {
    now: () => virtualNow,
    setTimer: (fn: () => void, ms: number) => {
      const handle = Symbol('timer');
      scheduled.push({ at: virtualNow + ms, fn, handle });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      scheduled = scheduled.filter((s) => s.handle !== handle);
    },
  };
  // Advance virtual time by `ms`, firing every timer whose deadline passed (in
  // order). Yields to the microtask queue between fires so a timer callback that
  // awaits (the liveness probe) can settle and schedule its successor.
  async function advance(ms: number): Promise<void> {
    const target = virtualNow + ms;
    // Loop because each fire can enqueue a new timer within [virtualNow, target].
    for (;;) {
      const due = scheduled
        .filter((s) => s.at <= target)
        .sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const next = due[0];
      scheduled = scheduled.filter((s) => s !== next);
      virtualNow = next.at;
      next.fn();
      // Let the async tick body (isResolverPtyAlive → listSessions) resolve.
      await Promise.resolve();
      await Promise.resolve();
    }
    virtualNow = target;
  }
  return { deps, advance };
}

const FAST_CONFIG: WaiterLivenessConfig = {
  graceMs: 100,
  pollMs: 100,
  deadStrikes: 3,
  maxWaitMs: 10_000,
};

test('a signalled waiter resolves as "signalled" and cancels the liveness timer', async () => {
  const state = createRunState();
  const clock = fakeClock();
  // Session list would report the resolver alive, but the signal wins anyway.
  const deps: WaiterLivenessDeps = {
    ...clock.deps,
    listSessions: async () => [{ cwd: '/wt/task-a' }],
  };

  const waited = awaitResolverWaiter(
    state,
    'run-1',
    'task-a',
    '/wt/task-a',
    FAST_CONFIG,
    deps,
  );
  // The real completion path fires.
  assert.equal(signalConflictWaiterInState(state, 'task-a'), true);
  assert.equal(await waited, 'signalled');
});

test('a resolver pty that vanishes releases the run as "resolver-dead" after consecutive strikes', async () => {
  const state = createRunState();
  const clock = fakeClock();
  let calls = 0;
  const deps: WaiterLivenessDeps = {
    ...clock.deps,
    // Terminal-server reachable, but no session under the worktree: dead.
    listSessions: async () => {
      calls += 1;
      return [];
    },
  };

  const waited = awaitResolverWaiter(
    state,
    'run-2',
    'task-b',
    '/wt/task-b',
    FAST_CONFIG,
    deps,
  );

  // grace (100) + 3 strikes * poll (100) = ~400ms of virtual time to declare death.
  await clock.advance(1_000);
  assert.equal(await waited, 'resolver-dead');
  assert.ok(calls >= FAST_CONFIG.deadStrikes, `probed at least ${FAST_CONFIG.deadStrikes}x`);

  // The waiter entry was abandoned (not left dangling): a late signal finds nothing.
  assert.equal(
    signalConflictWaiterInState(state, 'task-b'),
    false,
    'the abandoned waiter is gone — a stray late callback finds no phantom entry',
  );
});

test('a transient "can\'t tell" probe (terminal-server unreachable) does NOT count as death', async () => {
  const state = createRunState();
  const clock = fakeClock();
  // null == can't tell; a lone [] (dead) between nulls must reset the strike
  // count so death is only ever declared on CONSECUTIVE misses. This sequence
  // never has two [] in a row, and defaults to null (can't tell) once exhausted.
  const probeReturns: (unknown[] | null)[] = [null, [], null, [], null, []];
  let i = 0;
  const deps: WaiterLivenessDeps = {
    ...clock.deps,
    listSessions: async () => (i < probeReturns.length ? probeReturns[i++] : null),
  };

  const waited = awaitResolverWaiter(
    state,
    'run-3',
    'task-c',
    '/wt/task-c',
    FAST_CONFIG,
    deps,
  );

  // Advance enough to run several probes; the interleaved nulls keep strikes < 3.
  await clock.advance(700);
  // Still parked — signal it to finish cleanly and prove it never died.
  assert.equal(signalConflictWaiterInState(state, 'task-c'), true);
  assert.equal(await waited, 'signalled');
});

test('the absolute wall-clock cap releases the run as "timeout" when liveness can never be established', async () => {
  const state = createRunState();
  const clock = fakeClock();
  const deps: WaiterLivenessDeps = {
    ...clock.deps,
    // Always "can't tell" — strikes never accumulate, so only maxWaitMs can fire.
    listSessions: async () => null,
  };

  const waited = awaitResolverWaiter(
    state,
    'run-4',
    'task-d',
    '/wt/task-d',
    FAST_CONFIG,
    deps,
  );

  await clock.advance(FAST_CONFIG.maxWaitMs + FAST_CONFIG.pollMs);
  assert.equal(await waited, 'timeout');
});

test('a resolver the probe keeps confirming alive is NEVER wall-clock-killed (liveness > pure cap)', async () => {
  const state = createRunState();
  const clock = fakeClock();
  const deps: WaiterLivenessDeps = {
    ...clock.deps,
    // Always alive under the worktree — the cap resets every probe.
    listSessions: async () => [{ cwd: '/wt/task-live' }],
  };

  const waited = awaitResolverWaiter(
    state,
    'run-live',
    'task-live',
    '/wt/task-live',
    FAST_CONFIG,
    deps,
  );

  // Run well past the wall-clock cap; a live resolver must not be timed out.
  await clock.advance(FAST_CONFIG.maxWaitMs * 3);
  // Still parked — only a real completion (or death) ends it.
  assert.equal(signalConflictWaiterInState(state, 'task-live'), true);
  assert.equal(await waited, 'signalled');
});

test('cancelRun-style unblock (signalConflictWaiterInState) still wins over the backstop', async () => {
  // Sanity: the registry-level release paths keep working through the new wrapper.
  const state = createRunState();
  const clock = fakeClock();
  const deps: WaiterLivenessDeps = {
    ...clock.deps,
    listSessions: async () => [],
  };
  // Register directly (as the run does) then wrap — matches how the park sites
  // call awaitResolverWaiter, which registers synchronously before returning.
  const waited = awaitResolverWaiter(
    state,
    'run-5',
    'task-e',
    undefined, // no worktree ⇒ liveness is "can't tell"; only signal/timeout apply
    FAST_CONFIG,
    deps,
  );
  assert.equal(signalConflictWaiterInState(state, 'task-e'), true);
  assert.equal(await waited, 'signalled');
});

// Guard the synchronous-registration contract the park sites depend on: the
// waiter entry must exist the instant awaitResolverWaiter returns, BEFORE any
// await, so parkOnConflictResolver can release the merge lock without a racing
// signal slipping through a gap.
test('awaitResolverWaiter registers the waiter synchronously (no await gap)', async () => {
  const state = createRunState();
  const clock = fakeClock();
  const deps: WaiterLivenessDeps = { ...clock.deps, listSessions: async () => [] };

  const waited = awaitResolverWaiter(
    state,
    'run-6',
    'task-f',
    '/wt/task-f',
    FAST_CONFIG,
    deps,
  );
  // No await between the call above and here — the entry must already be present,
  // so signalling immediately releases it.
  assert.equal(
    signalConflictWaiterInState(state, 'task-f'),
    true,
    'waiter is registered synchronously; an instant signal is not lost',
  );
  assert.equal(await waited, 'signalled');
});

// registerConflictWaiter is still exercised directly by the run engine; keep a
// smoke assertion that the raw registry release matches the wrapper's.
test('raw registerConflictWaiter + signal round-trips (unchanged registry contract)', async () => {
  const state = createRunState();
  const p = registerConflictWaiter(state, 'run-7', 'task-g');
  let resolved = false;
  void p.then(() => {
    resolved = true;
  });
  assert.equal(signalConflictWaiterInState(state, 'task-g'), true);
  await p;
  assert.equal(resolved, true);
});
