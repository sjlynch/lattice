// Regression: cancelling a run while it waits for a checkout slot used to
// leave `runWaitingForDisk` on the cancelled task. The disk guard runs inside
// `withCheckoutSlot`, after a FIFO wait that can last minutes, so a cancel
// during that wait wasn't seen before the guard threw `SpawnDiskSpaceError`;
// `runSpawnThunk` then treated it as a deferral and stamped the disk wait onto
// the cancelled task. `enqueueTaskRun` never cleared it and `noteWaitingForDisk`
// never rewrites a set one, so a later ▶ showed a stale "waiting for disk" pill
// while the run was really waiting for an agent slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cancelSpawn, SpawnDiskSpaceError } from '../spawnQueue.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { dequeueTaskRun, enqueueTaskRun, taskRunDedupeKey } from '../routes/tasks/queuedSpawn.js';
import { runSpawnThunk } from '../routes/tasks/queuedSpawnFailure.js';
import { startTaskById, type StartTaskDeps } from '../routes/tasks/startTask.js';
import { isTaskStartWithdrawn } from '../routes/tasks/queuedSpawnAdmission.js';
import { createTask, getTask, updateTask, type Task } from '../tasks.js';

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

const project = path.join(os.tmpdir(), `lattice-cancelled-disk-wait-${process.pid}`);

test('a run cancelled while waiting for a checkout slot leaves no disk wait behind, and a re-enqueue starts clean', async () => {
  const created = await createTask(project, `cancelled disk wait ${Date.now()}`);
  const task = (await updateTask(created.id, { runQueued: true, runQueuedAt: 1 }))!;
  const controller = new AbortController();
  const reached = gate();
  const slot = gate();
  let spawned = 0;
  const deps: Partial<StartTaskDeps> = {
    // The checkout-slot wait, then the disk guard's verdict.
    setupTaskWorktree: (async () => {
      reached.open();
      await slot.wait;
      throw new SpawnDiskSpaceError('need 6.5 GB free, have 2.1 GB', 60_000);
    }) as unknown as StartTaskDeps['setupTaskWorktree'],
    selectHarnessCommand: ((t: Task) => ({
      harness: 'claude',
      commandBuilder: () => 'claude',
      createSession: async () => {
        spawned += 1;
        return { command: 'claude', serverId: `srv-${t.id}` };
      },
    })) as unknown as StartTaskDeps['selectHarnessCommand'],
  };

  const run = runSpawnThunk(task.id, 'run', () =>
    startTaskById(task.id, 'http://127.0.0.1:1', {
      deps,
      throwOnCapacity: true,
      signal: controller.signal,
    }),
  );
  const rejected = assert.rejects(run, (err) => isTaskStartWithdrawn(err));
  await reached.wait;
  // The cancel-queued-run route: clear the queue state, abort the in-flight run.
  await dequeueTaskRun(task.id);
  controller.abort();
  slot.open();
  await rejected;

  const after = await getTask(task.id);
  assert.equal(after?.status, 'open');
  assert.equal(after?.runWaitingForDisk, undefined, 'no disk wait on a cancelled run');
  assert.equal(after?.runQueued, undefined, 'no queued pill on a cancelled run');
  assert.equal(spawned, 0);

  // A later ▶ — even over a stale disk wait — starts from clean queue state.
  // Admissions are frozen so the real thunk never runs, and the pending
  // request is dropped straight away (before a queue poll could admit it).
  await updateTask(task.id, { runWaitingForDisk: 'need 6.5 GB free, have 2.1 GB' });
  queueState.accounting.noteOverAdmit();
  let enqueued: Awaited<ReturnType<typeof enqueueTaskRun>> | undefined;
  try {
    enqueued = await enqueueTaskRun(task.id, 'http://127.0.0.1:1', 'claude');
  } finally {
    cancelSpawn(taskRunDedupeKey(task.id));
    queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
    queueState.accounting.reconcile(0, Date.now() + 1);
  }
  assert.deepEqual(enqueued, { queued: true });
  const requeued = await getTask(task.id);
  assert.equal(requeued?.runQueued, true);
  assert.equal(requeued?.runWaitingForDisk, undefined, 'a fresh enqueue clears the disk wait');
});
