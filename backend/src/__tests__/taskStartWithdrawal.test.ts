import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  cancelSpawn,
  enqueueSpawn,
  getSpawnQueueSnapshot,
  notifyDiskSpaceFreed,
  SpawnCapacityError,
  SpawnDiskSpaceError,
} from '../spawnQueue.js';
import { queueState } from '../spawnQueue/state.js';
import { drainQueue } from '../spawnQueue/drain.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { dequeueTaskRun, taskRunDedupeKey } from '../routes/tasks/queuedSpawn.js';
import { startTaskById, type StartTaskDeps } from '../routes/tasks/startTask.js';
import { isTaskStartWithdrawn } from '../routes/tasks/queuedSpawnAdmission.js';
import { reserveColorSlot } from '../routes/tasks/colorSlot.js';
import { createTask, deleteTask, getTask, updateTask, type Task, type TaskUpdates } from '../tasks.js';

// Regression coverage for "a cancel / lane change made while a task's admitted
// run is in flight is ignored": the spawn queue used to only cancel PENDING
// requests (an in-flight one re-queued itself after a disk / CAP deferral and
// later spawned the agent the user cancelled), and startTaskById flipped the
// task to in_progress without re-reading it (silently undoing a drag to
// Backlog). Plus the stale-colorIndex half: a re-run kept its stored palette
// slot even when an active sibling had taken it meanwhile.

const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function healthyQueue(): void {
  queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
  queueState.accounting.reconcile(0, Date.now() + 1);
  // Batch admissions must not be held by this machine's CPU/RAM load.
  queueState.governor.setEnabled(false);
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

const project = path.join(os.tmpdir(), `lattice-start-withdrawal-${process.pid}`);

async function openTask(overrides: TaskUpdates = {}): Promise<Task> {
  const task = await createTask(project, `withdrawal ${Date.now()}-${Math.random()}`);
  if (Object.keys(overrides).length === 0) return task;
  return (await updateTask(task.id, overrides))!;
}

// Fakes for the heavy I/O. `onSetup` / `onSpawn` run inside the checkout and
// the pty creation, so a test can change the task while the start is there.
function fakeDeps(opts: {
  onSetup?: () => Promise<void>;
  onSpawn?: () => Promise<void>;
  capHit?: boolean;
} = {}) {
  const calls = { spawned: 0, killed: [] as string[], cleaned: [] as string[] };
  const deps: Partial<StartTaskDeps> = {
    setupTaskWorktree: (async (_repo: string, task: Task) => {
      await opts.onSetup?.();
      return {
        worktreePath: path.join(os.tmpdir(), 'wt', task.id),
        branch: `lattice/${task.id}`,
        taskFile: path.join(os.tmpdir(), 'wt', task.id, 'LATTICE_TASK.md'),
      };
    }) as unknown as StartTaskDeps['setupTaskWorktree'],
    selectHarnessCommand: (() => ({
      harness: 'claude',
      commandBuilder: () => 'claude',
      createSession: async () => {
        await opts.onSpawn?.();
        if (opts.capHit) return { command: 'claude', capHit: true };
        calls.spawned += 1;
        return { command: 'claude', serverId: 'srv-1' };
      },
    })) as unknown as StartTaskDeps['selectHarnessCommand'],
    discard: {
      killSession: async (id) => { calls.killed.push(id); return true; },
      cleanupWorktree: (async (_p: string, worktreePath: string) => {
        calls.cleaned.push(worktreePath);
        return true;
      }) as never,
    },
  };
  return { deps, calls };
}

// --- spawn queue ------------------------------------------------------------

test('cancelling an admitted task run: a later disk deferral does not re-queue it, and it never runs again', async () => {
  healthyQueue();
  const taskId = `t_cancel_inflight_${Date.now()}`;
  const blocked = gate();
  let calls = 0;
  const { done } = enqueueSpawn<void>({
    kind: 'task-run',
    priority: 'batch',
    dedupeKey: taskRunDedupeKey(taskId),
    thunk: async () => {
      calls += 1;
      await blocked.wait;
      throw new SpawnDiskSpaceError('not enough disk space', 60_000);
    },
  });
  const settled = assert.rejects(done, /disk space/);
  assert.equal(calls, 1, 'admitted straight away');

  // The route's cancel: the request is in flight, so it is aborted, not dropped.
  assert.deepEqual(await dequeueTaskRun(taskId), { inFlight: true });
  blocked.open();
  await settled;

  assert.equal(getSpawnQueueSnapshot().items.length, 0, 'nothing left queued');
  notifyDiskSpaceFreed();
  drainQueue();
  await pause(20);
  assert.equal(calls, 1, 'the cancelled run is never retried');
});

test('a re-run enqueued while a cancelled run is still in flight waits for it, then runs', async () => {
  healthyQueue();
  const key = `task-run:t_rerun_${Date.now()}`;
  const blocked = gate();
  const order: string[] = [];
  const first = enqueueSpawn<void>({
    kind: 'task-run',
    priority: 'batch',
    dedupeKey: key,
    thunk: async (signal) => {
      order.push('first:start');
      await blocked.wait;
      order.push(`first:end aborted=${signal.aborted}`);
      throw new Error('withdrawn');
    },
  });
  const firstSettled = assert.rejects(first.done, /withdrawn/);
  assert.equal(cancelSpawn(key), 'in-flight');

  const second = enqueueSpawn<void>({
    kind: 'task-run',
    priority: 'batch',
    dedupeKey: key,
    thunk: async () => { order.push('second'); },
  });
  await pause(10);
  assert.deepEqual(order, ['first:start'], 'the re-run is not deduped onto the cancelled run, nor run beside it');
  assert.equal(getSpawnQueueSnapshot().inFlight, 1);

  blocked.open();
  await firstSettled;
  await second.done;
  assert.deepEqual(order, ['first:start', 'first:end aborted=true', 'second']);
  assert.equal(getSpawnQueueSnapshot().items.length, 0);
});

// --- startTaskById ----------------------------------------------------------

test('a task dragged to Backlog during its checkout stays in Backlog and no agent is spawned', async () => {
  const task = await openTask({ runQueued: true, runQueuedAt: 1 });
  const blocked = gate();
  const reached = gate();
  const { deps, calls } = fakeDeps({ onSetup: async () => { reached.open(); await blocked.wait; } });

  const start = startTaskById(task.id, 'http://127.0.0.1:1', { deps, throwOnCapacity: true });
  const rejected = assert.rejects(start, (err) => isTaskStartWithdrawn(err));
  await reached.wait;
  await updateTask(task.id, { status: 'backlog' }); // the PATCH
  blocked.open();
  await rejected;

  const after = await getTask(task.id);
  assert.equal(after?.status, 'backlog');
  assert.equal(after?.worktreePath, undefined);
  assert.equal(after?.runQueued, undefined, 'the queued pill is dropped with the run');
  assert.equal(calls.spawned, 0);
  assert.equal(calls.cleaned.length, 1, 'the checkout is reclaimed');
});

test('a task dragged to Backlog while its pty spawns stays in Backlog and the pty is killed', async () => {
  const task = await openTask();
  const blocked = gate();
  const reached = gate();
  const { deps, calls } = fakeDeps({ onSpawn: async () => { reached.open(); await blocked.wait; } });

  const start = startTaskById(task.id, 'http://127.0.0.1:1', { deps, throwOnCapacity: true });
  const rejected = assert.rejects(start, (err) => isTaskStartWithdrawn(err));
  await reached.wait;
  await updateTask(task.id, { status: 'backlog' });
  blocked.open();
  await rejected;

  const after = await getTask(task.id);
  assert.equal(after?.status, 'backlog', 'the lane change is not overwritten by the in_progress flip');
  assert.equal(after?.worktreePath, undefined);
  assert.deepEqual(calls.killed, ['srv-1']);
  assert.equal(calls.cleaned.length, 1);
});

test('a start whose signal is aborted mid-start backs out without touching the task', async () => {
  const task = await openTask();
  const controller = new AbortController();
  const blocked = gate();
  const reached = gate();
  const { deps, calls } = fakeDeps({ onSpawn: async () => { reached.open(); await blocked.wait; } });

  const start = startTaskById(task.id, 'http://127.0.0.1:1', {
    deps,
    throwOnCapacity: true,
    signal: controller.signal,
  });
  const rejected = assert.rejects(start, (err) => isTaskStartWithdrawn(err));
  await reached.wait;
  controller.abort();
  blocked.open();
  await rejected;

  const after = await getTask(task.id);
  assert.equal(after?.status, 'open');
  assert.equal(after?.worktreePath, undefined);
  assert.deepEqual(calls.killed, ['srv-1']);
  assert.equal(calls.cleaned.length, 1);
});

test('a task deleted during a CAP-rejected pass has its checkout reclaimed instead of re-queued', async () => {
  const task = await openTask();
  const blocked = gate();
  const reached = gate();
  const { deps, calls } = fakeDeps({
    capHit: true,
    onSpawn: async () => { reached.open(); await blocked.wait; },
  });

  const start = startTaskById(task.id, 'http://127.0.0.1:1', { deps, throwOnCapacity: true });
  const rejected = assert.rejects(start, /was deleted while its run was being started/);
  await reached.wait;
  await deleteTask(task.id);
  blocked.open();
  await rejected;
  assert.equal(calls.cleaned.length, 1);
});

test('a CAP-parked checkout is reclaimed when the queued run is cancelled before its retry', async () => {
  const task = await openTask();
  const controller = new AbortController();
  const { deps, calls } = fakeDeps({ capHit: true });

  await assert.rejects(
    startTaskById(task.id, 'http://127.0.0.1:1', { deps, throwOnCapacity: true, signal: controller.signal }),
    (err) => err instanceof SpawnCapacityError,
  );
  assert.equal(calls.cleaned.length, 0, 'kept for the retry');
  controller.abort();
  await pause(20);
  assert.equal(calls.cleaned.length, 1, 'reclaimed once the run was cancelled');
});

// --- color slot -------------------------------------------------------------

test('reserveColorSlot keeps a stored slot only while no active sibling or reservation holds it', () => {
  const proj = `/color-${Date.now()}`;
  const base = { projectPath: proj, title: 'T', createdAt: 0 };
  const self: Task = { ...base, id: 'a', status: 'open', colorIndex: 0 };
  const holder: Task = { ...base, id: 'b', status: 'in_progress', colorIndex: 0 };

  const taken = reserveColorSlot(proj, [self, holder], 'a', self.colorIndex);
  assert.notEqual(taken.slot, 0, 'an in_progress sibling owns slot 0 now');
  taken.release();

  const free = reserveColorSlot(proj, [self, { ...holder, status: 'done' }], 'a', 3);
  assert.equal(free.slot, 3, 'nobody holds it: the re-run keeps its color');

  const other = reserveColorSlot(proj, [self], 'c', 3);
  assert.notEqual(other.slot, 3, 'a sibling start\'s reservation counts as held');
  other.release();
  free.release();
});

test('a re-run whose stored colorIndex an in_progress sibling now owns gets a different slot', async () => {
  const sibling = await openTask({ status: 'in_progress', worktreePath: path.join(os.tmpdir(), 'wt-sib'), colorIndex: 0 });
  const rerun = await openTask({ colorIndex: 0 });
  const { deps } = fakeDeps();
  const started = await startTaskById(rerun.id, 'http://127.0.0.1:1', { deps, throwOnCapacity: true });
  assert.equal(started.task.status, 'in_progress');
  assert.notEqual(started.task.colorIndex, 0);

  // Once the sibling leaves the active lanes, a re-run keeps its own slot.
  await updateTask(sibling.id, { status: 'done' });
  const keeper = await openTask({ colorIndex: 7 });
  const kept = await startTaskById(keeper.id, 'http://127.0.0.1:1', { deps, throwOnCapacity: true });
  assert.equal(kept.task.colorIndex, 7);
});
