// The one-off liveness watch (recovery/oneOffRunResume/watch.ts) that settles
// a re-adopted push / QA / post-merge run whose terminal is gone, after the
// loss grace. The watch must restart its loss grace after a live observation,
// respect callbacks arriving during a probe (a normal completion is never
// overwritten or cleaned up twice), and serialize probing and settlement
// (overlapping ticks skip, then recover).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOST_SETTLE_GRACE_MS,
  resetOneOffRunWatch,
  runOneOffRunWatchTick,
  watchedOneOffRunIds,
} from '../recovery/oneOffRunResume.js';
import type { Watched } from '../recovery/oneOffRunResume/contracts.js';
import { watchOneOffRun } from '../recovery/oneOffRunResume/watch.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function watchedRun(id: string, overrides: Partial<Watched> = {}): Watched {
  return {
    kind: 'push',
    noun: 'push run',
    run: { id, projectPath: '/project', cwd: `/scratch/${id}` },
    isRunning: () => true,
    settleLost: async () => undefined,
    reason: 'terminal did not survive a backend restart',
    ...overrides,
  };
}

test('one-off watch: a live observation resets the full grace for a later loss', async (t) => {
  resetOneOffRunWatch();
  t.after(resetOneOffRunWatch);
  const settleLost = mock.fn(async (_reason: string) => undefined);
  const entry = watchedRun('grace-reset', { settleLost });
  const liveSessions = [{ id: 'srv-live', cwd: entry.run.cwd }];
  let now = 1_000;
  let sessions = liveSessions;
  const deps = { now: () => now, listSessions: async () => sessions };
  watchOneOffRun(entry);

  await runOneOffRunWatchTick(deps);
  assert.deepEqual(watchedOneOffRunIds(), ['push:grace-reset']);
  assert.equal(entry.goneSince, undefined);
  assert.equal(settleLost.mock.callCount(), 0);

  const firstLoss = now + 1_000;
  now = firstLoss;
  sessions = [];
  await runOneOffRunWatchTick(deps);
  assert.equal(entry.goneSince, firstLoss);
  assert.equal(settleLost.mock.callCount(), 0);

  now = firstLoss + LOST_SETTLE_GRACE_MS - 2;
  sessions = liveSessions;
  await runOneOffRunWatchTick(deps);
  assert.equal(entry.goneSince, undefined, 'seeing the live pty clears the first loss');
  assert.equal(settleLost.mock.callCount(), 0);

  const secondLoss = now + 1;
  now = secondLoss;
  sessions = [];
  await runOneOffRunWatchTick(deps);
  assert.equal(entry.goneSince, secondLoss);
  assert.equal(settleLost.mock.callCount(), 0);

  now = firstLoss + LOST_SETTLE_GRACE_MS;
  await runOneOffRunWatchTick(deps);
  assert.equal(settleLost.mock.callCount(), 0, 'the original deadline cannot settle the later loss');
  assert.deepEqual(watchedOneOffRunIds(), ['push:grace-reset']);

  now = secondLoss + LOST_SETTLE_GRACE_MS - 1;
  await runOneOffRunWatchTick(deps);
  assert.equal(settleLost.mock.callCount(), 0, 'the second loss gets the entire grace window');
  assert.deepEqual(watchedOneOffRunIds(), ['push:grace-reset']);

  now += 1;
  await runOneOffRunWatchTick(deps);
  assert.equal(settleLost.mock.callCount(), 1);
  assert.deepEqual(settleLost.mock.calls[0].arguments, ['terminal exited without calling back']);
  assert.deepEqual(watchedOneOffRunIds(), []);

  for (const later of [now + 1, now + LOST_SETTLE_GRACE_MS]) {
    now = later;
    await runOneOffRunWatchTick(deps);
  }
  assert.equal(settleLost.mock.callCount(), 1, 'a settled entry is never settled twice');
});

test('one-off watch: normal completion during a pending probe prevents lost settlement', async (t) => {
  resetOneOffRunWatch();
  t.after(resetOneOffRunWatch);
  const probe = deferred<[]>();
  const listSessions = mock.fn(() => probe.promise);
  const settleLost = mock.fn(async (_reason: string) => undefined);
  let running = true;
  watchOneOffRun(watchedRun('callback-race', {
    isRunning: () => running,
    settleLost,
    goneSince: 1_000,
  }));
  const deps = { listSessions, now: () => 1_000 + LOST_SETTLE_GRACE_MS + 1 };
  const tick = runOneOffRunWatchTick(deps);
  try {
    assert.equal(listSessions.mock.callCount(), 1, 'the probe is in flight');
    assert.deepEqual(watchedOneOffRunIds(), ['push:callback-race']);
    assert.equal(settleLost.mock.callCount(), 0);

    // Its normal completion callback wins while the terminal probe is pending.
    running = false;
    probe.resolve([]);
    await tick;
    assert.deepEqual(watchedOneOffRunIds(), []);
    assert.equal(settleLost.mock.callCount(), 0);

    await runOneOffRunWatchTick(deps);
    assert.equal(listSessions.mock.callCount(), 1, 'the completed entry was removed from the watch');
    assert.equal(settleLost.mock.callCount(), 0, 'normal completion must not be overwritten or cleaned up twice');
  } finally {
    probe.resolve([]);
    await tick;
  }
});

test('one-off watch: overlapping ticks skip pending probes and settlements, then recover', async (t) => {
  resetOneOffRunWatch();
  t.after(resetOneOffRunWatch);
  const probe = deferred<{ id: string; cwd: string }[]>();
  const settlement = deferred<void>();
  const settlementStarted = deferred<void>();
  const listSessions = mock.fn(() => probe.promise);
  const settleLost = mock.fn(async (_reason: string) => {
    settlementStarted.resolve();
    await settlement.promise;
  });
  const siblingIsRunning = mock.fn(() => true);
  const siblingSettleLost = mock.fn(async (_reason: string) => undefined);
  const sibling = watchedRun('live-sibling', {
    isRunning: siblingIsRunning,
    settleLost: siblingSettleLost,
  });
  const liveSessions = [{ id: 'srv-sibling', cwd: sibling.run.cwd }];
  watchOneOffRun(watchedRun('overlap', { settleLost, goneSince: 1_000 }));
  // Settlement removes its entry before awaiting. Keep a sibling watched so
  // an empty registry cannot hide a broken overlap guard during that await.
  watchOneOffRun(sibling);
  const deps = { listSessions, now: () => 1_000 + LOST_SETTLE_GRACE_MS + 1 };
  const ticks: Promise<void>[] = [];
  const startTick = () => {
    const tick = runOneOffRunWatchTick(deps);
    ticks.push(tick);
    return tick;
  };
  const firstTick = startTick();
  try {
    assert.equal(listSessions.mock.callCount(), 1);
    const duringProbe = startTick();
    assert.equal(listSessions.mock.callCount(), 1, 'an overlapping tick must not start another probe');
    await duringProbe;
    assert.equal(settleLost.mock.callCount(), 0);
    assert.equal(siblingIsRunning.mock.callCount(), 0);

    probe.resolve(liveSessions);
    // A premature return also releases this wait, so it fails an assertion
    // instead of leaving the test hung waiting for settlement to start.
    await Promise.race([settlementStarted.promise, firstTick]);
    assert.equal(settleLost.mock.callCount(), 1);
    assert.deepEqual(watchedOneOffRunIds(), ['push:live-sibling']);

    const duringSettlement = startTick();
    assert.equal(listSessions.mock.callCount(), 1, 'settlement still holds the overlap guard');
    await duringSettlement;
    assert.equal(settleLost.mock.callCount(), 1, 'the pending settlement must not be duplicated');
    assert.equal(siblingIsRunning.mock.callCount(), 0, 'no sibling work starts while settlement is pending');

    settlement.resolve();
    await firstTick;
    assert.equal(siblingIsRunning.mock.callCount(), 1);

    const laterSettleLost = mock.fn(async (_reason: string) => undefined);
    watchOneOffRun(watchedRun('after-overlap', { settleLost: laterSettleLost, goneSince: 1_000 }));
    await startTick();
    assert.equal(listSessions.mock.callCount(), 2, 'finishing settlement releases the guard for later ticks');
    assert.equal(laterSettleLost.mock.callCount(), 1, 'a new overdue entry can settle');
    assert.equal(settleLost.mock.callCount(), 1);
    assert.equal(siblingIsRunning.mock.callCount(), 2);
    assert.equal(siblingSettleLost.mock.callCount(), 0);
    assert.deepEqual(watchedOneOffRunIds(), ['push:live-sibling']);
  } finally {
    probe.resolve(liveSessions);
    settlementStarted.resolve();
    settlement.resolve();
    await Promise.all(ticks);
  }
});
