import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  reserveWorktreeDiskSpace,
  resetDiskSpaceStateForTests,
  type DiskSpaceDeps,
} from '../worktree/diskSpace.js';
import {
  SpawnDiskSpaceError,
  enqueueSpawn,
  getSpawnQueueSnapshot,
  isSpawnDeferral,
  notifyDiskSpaceFreed,
} from '../spawnQueue.js';
import { queueState } from '../spawnQueue/state.js';
import {
  mergeToFreeDiskSpace,
  resetDiskPressureMergeStateForTests,
  type DiskPressureMergeDeps,
} from '../diskPressureMerge.js';
import { pruneBundles, type BundleFile } from '../worktree/gitBackup.js';

// Regression coverage for the 2026-09-22 disk-full incident: queued workflows
// on a large repo (6.5 GB per worktree, 4.3 GB of it Git LFS) created
// checkouts until the disk ran out. The guard defers — never fails — a run
// whose checkout would cross the free-space reserve.

const GB = 1024 ** 3;

function diskDeps(free: number, estimate: number, minFree = 10 * GB): DiskSpaceDeps {
  return {
    estimateCheckoutBytes: async () => estimate,
    freeBytesAt: async () => free,
    minFreeBytes: async () => minFree,
  };
}

test('admits a checkout that fits above the reserve', async () => {
  resetDiskSpaceStateForTests();
  const r = await reserveWorktreeDiskSpace('C:\\repo', 'C:\\wt', diskDeps(20 * GB, 6 * GB));
  r.release();
});

test('defers (SpawnDiskSpaceError) a checkout that would cross the reserve', async () => {
  resetDiskSpaceStateForTests();
  await assert.rejects(
    reserveWorktreeDiskSpace('C:\\repo', 'C:\\wt', diskDeps(15 * GB, 6 * GB)),
    (err: unknown) => {
      assert.ok(err instanceof SpawnDiskSpaceError);
      assert.ok(isSpawnDeferral(err), 'a disk deferral is a deferral, not a failure');
      assert.match((err as Error).message, /stays queued/);
      return true;
    },
  );
});

test('concurrent setups reserve against each other until released', async () => {
  resetDiskSpaceStateForTests();
  const deps = diskDeps(25 * GB, 6 * GB);
  const first = await reserveWorktreeDiskSpace('C:\\repo', 'C:\\wt', deps);
  const second = await reserveWorktreeDiskSpace('C:\\repo', 'C:\\wt', deps);
  // 25 − 12 reserved − 6 = 7 < 10 reserve.
  await assert.rejects(reserveWorktreeDiskSpace('C:\\repo', 'C:\\wt', deps), SpawnDiskSpaceError);
  first.release();
  first.release(); // idempotent
  const third = await reserveWorktreeDiskSpace('C:\\repo', 'C:\\wt', deps);
  second.release();
  third.release();
});

test('an unmeasurable disk never blocks work', async () => {
  resetDiskSpaceStateForTests();
  const r = await reserveWorktreeDiskSpace('C:\\repo', 'C:\\wt', {
    estimateCheckoutBytes: async () => null,
    freeBytesAt: async () => 1,
    minFreeBytes: async () => 10 * GB,
  });
  r.release();
});

test('spawn queue: a disk deferral re-queues with a backoff and notifyDiskSpaceFreed retries it', async () => {
  queueState.accounting.reconcile(0, Date.now());
  let calls = 0;
  const { done } = enqueueSpawn({
    kind: 'task-run',
    priority: 'batch',
    dedupeKey: 'disk-test:1',
    thunk: async () => {
      calls += 1;
      if (calls === 1) throw new SpawnDiskSpaceError('no room', 60_000);
      return 'spawned';
    },
  });
  // Let the first (failing) attempt settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  const item = getSpawnQueueSnapshot().items.find((i) => i.dedupeKey === 'disk-test:1');
  assert.ok(item, 'the request is still queued, not dropped');
  assert.equal(item.state, 'pending');
  assert.equal(item.waitingForDisk?.reason, 'no room');
  // The 60 s backoff would hold it; a freed worktree cuts it short.
  notifyDiskSpaceFreed();
  assert.equal(await done, 'spawned');
  assert.equal(calls, 2);
});

function mergeDeps(over: Partial<DiskPressureMergeDeps> = {}): DiskPressureMergeDeps & { started: string[] } {
  const started: string[] = [];
  let t = 1_000_000;
  return {
    autoMergeEnabled: async () => true,
    hasActiveMergeRun: () => false,
    hasActiveWorkflowRun: () => false,
    hasActivePostMergeHook: () => false,
    readyToMergeIds: async () => ['t1', 't2', 't3'],
    mergeShortfall: async () => null,
    startMergeRun: async (p) => {
      started.push(p);
    },
    now: () => (t += 1),
    started,
    ...over,
  };
}

test('disk pressure starts a merge run when Ready-to-Merge work is parked', async () => {
  resetDiskPressureMergeStateForTests();
  const deps = mergeDeps();
  assert.equal(await mergeToFreeDiskSpace('C:\\proj', 'http://x', deps), 'started');
  assert.equal(deps.started.length, 1);
  // Throttled: a burst of deferred runs asks once.
  assert.equal(await mergeToFreeDiskSpace('C:\\proj', 'http://x', deps), 'throttled');
  assert.equal(deps.started.length, 1);
});

test('disk pressure never merges over an active workflow, merge run, or hook, or when disabled', async () => {
  const cases: Array<[Partial<DiskPressureMergeDeps>, string]> = [
    [{ hasActiveWorkflowRun: () => true }, 'workflow-active'],
    [{ hasActiveMergeRun: () => true }, 'merge-run-active'],
    [{ hasActivePostMergeHook: () => true }, 'hook-active'],
    [{ readyToMergeIds: async () => [] }, 'nothing-to-merge'],
    [{ mergeShortfall: async () => 'only 12 MB free' }, 'disk-full'],
    [{ autoMergeEnabled: async () => false }, 'disabled'],
  ];
  for (const [over, expected] of cases) {
    resetDiskPressureMergeStateForTests();
    const deps = mergeDeps(over);
    assert.equal(await mergeToFreeDiskSpace('C:\\proj', 'http://x', deps), expected);
    assert.equal(deps.started.length, 0, expected);
  }
});

// A run that moves nothing out of ready_to_merge (disk-halted on its first
// task, or every task errored) must not be restarted every throttle window
// forever — the low-disk monitor asks once a minute.
test('disk pressure does not restart a merge run that made no progress', async () => {
  resetDiskPressureMergeStateForTests();
  const MIN = 60_000;
  let t = 1_000_000;
  let ready = ['t1', 't2', 't3'];
  let shortfall: string | null = null;
  const deps = mergeDeps({
    now: () => t,
    readyToMergeIds: async () => ready,
    mergeShortfall: async () => shortfall,
  });
  const ask = () => mergeToFreeDiskSpace('C:\\proj', 'http://x', deps);

  assert.equal(await ask(), 'started');
  // The run finished with every task still ready (same ids, any order).
  ready = ['t3', 't1', 't2'];
  // Four asks, 3 min apart: each past the 2-min throttle, all inside the
  // first 15-min no-progress backoff (a fifth would land exactly on it).
  for (let i = 0; i < 4; i++) {
    t += 3 * MIN; // past the throttle every time
    assert.equal(await ask(), 'no-progress');
  }
  assert.equal(deps.started.length, 1);

  // The set changing (a task merged, or a new one became ready) retries.
  ready = ['t1', 't2', 't3', 't4'];
  t += 3 * MIN;
  assert.equal(await ask(), 'started');
  assert.equal(deps.started.length, 2);
  t += 3 * MIN;
  assert.equal(await ask(), 'no-progress');

  // Under the merge floor nothing starts at all; once space comes back above
  // it, the disk-halted tasks get another try.
  shortfall = 'only 12 MB free';
  t += 3 * MIN;
  assert.equal(await ask(), 'disk-full');
  shortfall = null;
  t += 3 * MIN;
  assert.equal(await ask(), 'started');
  assert.equal(deps.started.length, 3);

  // Otherwise an unchanged set is retried only on a doubling backoff.
  t += 14 * MIN;
  assert.equal(await ask(), 'no-progress');
  t += 2 * MIN; // 16 min after the last start: past the first 15-min backoff
  assert.equal(await ask(), 'started');
  t += 20 * MIN; // second backoff is 30 min
  assert.equal(await ask(), 'no-progress');
  t += 11 * MIN;
  assert.equal(await ask(), 'started');
  assert.equal(deps.started.length, 5);
});

test('bundle pruning honours count and byte budgets but always keeps the newest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-bundles-'));
  try {
    const bundles: BundleFile[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const name = `2026-09-1${i}T00-00-00-000Z.bundle`;
      await fs.writeFile(path.join(dir, name), 'x');
      bundles.push({ name, bytes: 3.5 * GB, mtimeMs: i });
    }
    // 8 GB budget with 3.5 GB bundles → the newest two survive.
    await pruneBundles(dir, bundles, 5, 8 * GB);
    assert.deepEqual((await fs.readdir(dir)).sort(), bundles.slice(3).map((b) => b.name));
    // A budget smaller than one bundle still keeps the newest.
    await pruneBundles(dir, bundles.slice(3), 4, 1 * GB);
    assert.deepEqual(await fs.readdir(dir), [bundles[4].name]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
