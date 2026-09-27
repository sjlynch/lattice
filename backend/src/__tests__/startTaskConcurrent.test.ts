// At most one start per task at a time, whatever the entry point. The workflow
// Start step starts a task directly (outside the spawn queue); while that start
// waited on the checkout gate the task was still `open`, so a /run (Run All, ▶,
// MCP run_task) passed isFreshlyRunnable and queued a second startTaskById. The
// second setup's reconcile killed the first agent's pty and recreated the
// checkout, then backed out — stranding the task In Progress with no agent.
// startTaskById now serializes starts per task: the later one waits for the
// first, then withdraws if the task was claimed, or retries if it failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { enqueueSpawn } from '../spawnQueue.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { runSpawnThunk, taskRunDedupeKey } from '../routes/tasks/queuedSpawn.js';
import {
  isTaskStartInFlight,
  startTaskById,
  type StartTaskDeps,
} from '../routes/tasks/startTask.js';
import { isTaskStartWithdrawn } from '../routes/tasks/queuedSpawnAdmission.js';
import { createTask, getTask, updateTask, type Task } from '../tasks.js';

const ORIGIN = 'http://127.0.0.1:1';

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

const project = path.join(os.tmpdir(), `lattice-start-concurrent-${process.pid}`);

async function openTask(): Promise<Task> {
  return createTask(project, `concurrent start ${Date.now()}-${Math.random()}`);
}

// Fake checkout + pty. `setups` counts setupTaskWorktree calls; the first
// setup waits on `firstSetup` (the checkout gate) and, with `failFirst`,
// then throws.
function fakeDeps(firstSetup: Promise<void>, opts: { failFirst?: boolean } = {}) {
  const calls = { setups: 0, spawned: [] as string[], killed: [] as string[], cleaned: [] as string[] };
  const deps: Partial<StartTaskDeps> = {
    setupTaskWorktree: (async (_repo: string, task: Task) => {
      calls.setups += 1;
      if (calls.setups === 1) {
        await firstSetup;
        if (opts.failFirst) throw new Error('checkout failed');
      }
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
        const serverId = `srv-${calls.spawned.length + 1}`;
        calls.spawned.push(serverId);
        return { command: 'claude', serverId };
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

// What `enqueueTaskRun` enqueues, with the fake deps injected.
async function enqueueRun(taskId: string, deps: Partial<StartTaskDeps>): Promise<Promise<void>> {
  await updateTask(taskId, { runQueued: true, runQueuedAt: Date.now() });
  const { done } = enqueueSpawn<void>({
    kind: 'task-run',
    priority: 'batch',
    dedupeKey: taskRunDedupeKey(taskId),
    thunk: (signal) =>
      runSpawnThunk(taskId, 'run', () =>
        startTaskById(taskId, ORIGIN, { deps, throwOnCapacity: true, signal }),
      ),
  });
  return done;
}

test('a /run queued while a direct start is on the checkout gate withdraws instead of killing the first agent', async () => {
  healthyQueue();
  const task = await openTask();
  const checkout = gate();
  const { deps, calls } = fakeDeps(checkout.wait);

  // The workflow Start step's direct start, parked on the checkout gate.
  const direct = startTaskById(task.id, ORIGIN, { deps, throwOnCapacity: true });
  assert.equal(isTaskStartInFlight(task.id), true);

  // Run All / ▶ meanwhile: the task is still `open`, so the route admits it.
  assert.equal((await getTask(task.id))?.status, 'open');
  const queued = await enqueueRun(task.id, deps);
  const queuedRejected = assert.rejects(queued, (err) => isTaskStartWithdrawn(err));
  // The thunk counts its attempt (a store write) before calling startTaskById;
  // let it get there, so it really is a second start racing the first.
  while ((await getTask(task.id))?.runFailureCount !== 1) await pause();
  await pause();

  checkout.open();
  const started = await direct;
  await queuedRejected;

  assert.equal(calls.setups, 1, 'exactly one checkout was set up');
  assert.deepEqual(calls.spawned, ['srv-1'], 'exactly one agent was spawned');
  assert.deepEqual(calls.killed, [], 'the surviving agent was never killed');
  assert.deepEqual(calls.cleaned, [], 'the live checkout was never removed');
  assert.equal(started.serverId, 'srv-1');

  const after = await getTask(task.id);
  assert.equal(after?.status, 'in_progress');
  assert.equal(after?.worktreePath, started.worktreePath);
  assert.equal(after?.runQueued, undefined, 'no stale Queued pill is left behind');
  assert.equal(after?.runFailureCount, undefined, 'the surplus run burns no retry budget');
  assert.equal(isTaskStartInFlight(task.id), false);
});

test('a start waiting behind a failed start of the same task retries it', async () => {
  const task = await openTask();
  const checkout = gate();
  const { deps, calls } = fakeDeps(checkout.wait, { failFirst: true });

  const first = startTaskById(task.id, ORIGIN, { deps, throwOnCapacity: true });
  const firstRejected = assert.rejects(first, /checkout failed/);
  const second = startTaskById(task.id, ORIGIN, { deps, throwOnCapacity: true });

  checkout.open();
  await firstRejected;
  const started = await second;

  assert.equal(calls.setups, 2, 'the waiting start ran its own checkout');
  assert.deepEqual(calls.spawned, ['srv-1']);
  assert.deepEqual(calls.killed, []);
  assert.equal(started.task.status, 'in_progress');
  assert.equal(isTaskStartInFlight(task.id), false);
});
