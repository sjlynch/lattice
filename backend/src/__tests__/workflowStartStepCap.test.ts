import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStartStep, type StartStepDeps } from '../workflowRuns/controlSteps/start.js';
import { SpawnCapacityError, SpawnDiskSpaceError } from '../spawnQueue.js';
import { subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { Task } from '../tasks.js';
import type { Workflow } from '../workflows.js';
import type { StartTaskByIdResult } from '../routes/tasks/startTask.js';

// Regression for Fix 1: "the Start control step swallows the terminal-server
// hard cap." runStartStep used to call startTaskById WITHOUT throwOnCapacity, so
// when the pre-spawn hit the terminal-server hard cap the rejection was
// swallowed: the task was still flipped open → in_progress with NO pty/agent and
// counted as `started`. A Start step over more Open tasks than the cap then left
// the excess tasks stuck in_progress forever (and manufactured the stuck lane
// that hangs the Merge step). The fix passes throwOnCapacity:true and, on the
// resulting SpawnCapacityError, leaves the task Open, re-queues it on the spawn
// queue, and does NOT count it as started.

const PROJECT = '/project';

function makeTask(over: Partial<Task>): Task {
  return {
    id: 'task',
    projectPath: PROJECT,
    title: 'task',
    status: 'open',
    createdAt: 1,
    ...over,
  } as Task;
}

function makeWorkflow(): Workflow {
  return { projectPath: PROJECT } as Workflow;
}

// harnessOverride pins the picker synchronously (no UserSettings I/O), so the
// test doesn't touch the real settings store.
function makeRun(): WorkflowRun {
  return {
    id: 'wfrun_cap',
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: PROJECT,
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
    harnessOverride: 'claude',
  };
}

function spawnResult(task: Task): StartTaskByIdResult {
  return {
    task: { ...task, status: 'in_progress' },
    worktreePath: `/wt/${task.id}`,
    branch: `lattice/${task.id}`,
    taskFile: `/wt/${task.id}/LATTICE_TASK.md`,
    command: 'claude',
    serverId: `srv-${task.id}`,
  };
}

test('Start step does not force-flip or count a hard-capped task; it re-queues it', async () => {
  const tasks = [
    makeTask({ id: '1', createdAt: 1 }),
    makeTask({ id: '2', createdAt: 2 }),
    makeTask({ id: '3', createdAt: 3 }),
  ];

  const startCalls: string[] = [];
  const throwOnCapacitySeen: boolean[] = [];
  const enqueued: string[] = [];

  const deps: StartStepDeps = {
    listTasks: async () => tasks,
    startTask: async (taskId, _origin, options) => {
      startCalls.push(taskId);
      throwOnCapacitySeen.push(options?.throwOnCapacity === true);
      // The 2nd of 3 tasks hits the terminal-server hard cap.
      if (taskId === '2') {
        throw new SpawnCapacityError('no terminal slot (terminal-server hard cap)');
      }
      const t = tasks.find((x) => x.id === taskId)!;
      return spawnResult(t);
    },
    enqueueRun: async (taskId) => {
      enqueued.push(taskId);
      return { queued: true };
    },
  };

  // Capture the workflow-task-spawned events the step emits (one per STARTED task).
  const spawnedTaskIds: string[] = [];
  const unsub = subscribe((ev: WorkflowRunEvent) => {
    if (ev.type === 'workflow-task-spawned') spawnedTaskIds.push(ev.taskId);
  });

  try {
    // Must NOT throw — 2 tasks started and 1 was cap-deferred (queued), so the
    // step made progress and advances.
    await runStartStep(makeWorkflow(), makeRun(), 0, 'http://localhost', deps);
  } finally {
    unsub();
  }

  // Every task was attempted, always with throwOnCapacity:true (the fix).
  assert.deepEqual(startCalls, ['1', '2', '3']);
  assert.ok(
    throwOnCapacitySeen.every((v) => v === true),
    'every start-step spawn must pass throwOnCapacity:true',
  );

  // The capped task 2 is NOT counted as started — only 1 and 3 got a
  // workflow-task-spawned event (i.e. a live pty/agent + terminal tab).
  assert.deepEqual(
    spawnedTaskIds,
    ['1', '3'],
    'the hard-capped task must not be surfaced as a spawned (started) task',
  );

  // Instead the capped task is left Open and re-queued on the spawn queue so it
  // starts when a slot frees — never left in_progress with no agent.
  assert.deepEqual(enqueued, ['2'], 'the capped task must be re-queued, not dropped');
});

test('Start step still throws when every task genuinely fails (no cap deferrals)', async () => {
  const tasks = [makeTask({ id: 'a', createdAt: 1 }), makeTask({ id: 'b', createdAt: 2 })];
  const deps: StartStepDeps = {
    listTasks: async () => tasks,
    startTask: async () => {
      throw new Error('worktree creation failed');
    },
    enqueueRun: async () => ({ queued: true }),
  };

  // started === 0 && deferred === 0 && failed > 0 → surfaces the real failure.
  await assert.rejects(
    () => runStartStep(makeWorkflow(), makeRun(), 0, 'http://localhost', deps),
    /all 2 task\(s\) failed[\s\S]*worktree creation failed/,
  );
});

test('Start step does not throw when the only non-starts were cap deferrals', async () => {
  const tasks = [makeTask({ id: 'x', createdAt: 1 })];
  let enqueuedCount = 0;
  const deps: StartStepDeps = {
    listTasks: async () => tasks,
    startTask: async () => {
      throw new SpawnCapacityError('cap');
    },
    enqueueRun: async () => {
      enqueuedCount += 1;
      return { queued: true };
    },
  };

  // started === 0 but deferred > 0 (all queued) → NOT a total failure; resolves.
  await runStartStep(makeWorkflow(), makeRun(), 0, 'http://localhost', deps);
  assert.equal(enqueuedCount, 1, 'the sole capped task was re-queued');
});

// The Start step starts tasks directly (not through the spawn queue), so it
// bypassed maxConcurrentAgents and the CPU/RAM governor entirely — a 50-task
// Start step launched 50 agents at once and pinned the CPU (2026-09-22). When
// the queue would hold a batch spawn, the step now hands the task to the queue.
test('Start step queues (never starts) a task while the queue would hold a batch spawn', async () => {
  const tasks = [makeTask({ id: '1', createdAt: 1 }), makeTask({ id: '2', createdAt: 2 })];
  const startCalls: string[] = [];
  const enqueued: string[] = [];
  let holds = [null, 'CPU at 99%'] as Array<string | null>;
  const deps: StartStepDeps = {
    listTasks: async () => tasks,
    startTask: async (taskId) => {
      startCalls.push(taskId);
      return spawnResult(tasks.find((t) => t.id === taskId)!);
    },
    enqueueRun: async (taskId) => {
      enqueued.push(taskId);
      return { queued: true };
    },
    admissionHold: async () => holds.shift() ?? null,
  };
  await runStartStep(makeWorkflow(), makeRun(), 0, 'http://x', deps);
  assert.deepEqual(startCalls, ['1'], 'the first task starts directly');
  assert.deepEqual(enqueued, ['2'], 'the held task goes to the queue instead');
  holds = [];
});

// A queued run keeps its task `open` until the pty spawns (on a big repo the
// admitted thunk can wait minutes on the checkout gate), so the Start step saw
// it as a plain Open task and started it a second time: that setup's reconcile
// killed the first run's pty and force-removed its worktree, or left two live
// agents on one task. A task the queue is already starting must be left to it.
test('Start step never starts a task whose run is already queued or in flight', async () => {
  const tasks = [
    makeTask({ id: 'flagged', createdAt: 1, runQueued: true }),
    makeTask({ id: 'inflight', createdAt: 2 }),
    makeTask({ id: 'free', createdAt: 3 }),
  ];
  // 'inflight' has a live task-run request whose thunk is still blocked (e.g.
  // on the checkout gate) — no runQueued on this listing snapshot.
  const liveRequests = new Set(['inflight']);
  const startCalls: string[] = [];
  const enqueued: string[] = [];
  const deps: StartStepDeps = {
    listTasks: async () => tasks,
    startTask: async (taskId) => {
      startCalls.push(taskId);
      return spawnResult(tasks.find((t) => t.id === taskId)!);
    },
    enqueueRun: async (taskId) => {
      enqueued.push(taskId);
      return { queued: true };
    },
    admissionHold: async () => null,
    hasQueuedRun: (taskId) => liveRequests.has(taskId),
  };
  await runStartStep(makeWorkflow(), makeRun(), 0, 'http://x', deps);
  assert.deepEqual(startCalls, ['free'], 'only the task with no queued run starts directly');
  assert.deepEqual(enqueued, [], 'already-queued tasks are not re-queued either');
});

test('Start step does not throw when every open task is already queued', async () => {
  const tasks = [makeTask({ id: 'q', createdAt: 1, runQueued: true })];
  const deps: StartStepDeps = {
    listTasks: async () => tasks,
    startTask: async () => {
      throw new Error('must not be called');
    },
    enqueueRun: async () => ({ queued: true }),
    admissionHold: async () => null,
  };
  // Counted as deferred (queued forward progress), not failed.
  await runStartStep(makeWorkflow(), makeRun(), 0, 'http://x', deps);
});

// Admission failures are NOT deferrals. Both queue call sites used to swallow
// the enqueue error, defeating the all-failed guard and advancing with no run.
for (const scenario of ['hold', 'capacity', 'disk'] as const) {
  test(`Start step reports a rejected ${scenario} enqueue as failed, preserving its error`, async () => {
    const task = makeTask({ id: 'rejected' });
    const progress: string[] = [];
    const spawned: string[] = [];
    const unsub = subscribe((ev) => {
      if (ev.type === 'step-control-progress') progress.push(ev.message ?? '');
      if (ev.type === 'workflow-task-spawned') spawned.push(ev.taskId);
    });
    try {
      await assert.rejects(runStartStep(makeWorkflow(), makeRun(), 0, 'http://unused', {
        listTasks: async () => [task],
        admissionHold: async () => scenario === 'hold' ? 'agent cap' : null,
        startTask: async () => {
          assert.notEqual(scenario, 'hold', 'held tasks must never start directly');
          if (scenario === 'disk') throw new SpawnDiskSpaceError('disk reserve', 1000);
          throw new SpawnCapacityError('hard cap');
        },
        enqueueRun: async () => { throw new Error('task store update rejected'); },
      }), /all 1 task\(s\) failed[\s\S]*First failure: task store update rejected/);
      assert.equal(progress.at(-1), '0/1 started, 1 failed');
      assert.deepEqual(spawned, []);
      assert.equal(task.status, 'open');
      assert.notEqual(task.runQueued, true);
    } finally {
      unsub();
    }
  });
}

test('Start step attempts every task when all enqueues fail and reports the first enqueue error', async () => {
  const tasks = ['a', 'b', 'c'].map((id, i) => makeTask({ id, createdAt: i }));
  const attempts: string[] = [];
  await assert.rejects(runStartStep(makeWorkflow(), makeRun(), 0, 'http://unused', {
    listTasks: async () => tasks,
    admissionHold: async () => 'CPU hold',
    startTask: async () => { throw new Error('must not start'); },
    enqueueRun: async (id) => { attempts.push(id); throw new Error(`enqueue ${id} failed`); },
  }), /all 3 task\(s\) failed[\s\S]*First failure: enqueue a failed/);
  assert.deepEqual(attempts, ['a', 'b', 'c']);
});

test('Start step continues past both enqueue failures to later queued and started tasks', async () => {
  const tasks = ['held', 'capped', 'queued', 'started'].map((id, i) => makeTask({ id, createdAt: i }));
  const holds = ['agent cap', null, 'CPU hold', null];
  const attempts: string[] = [];
  const starts: string[] = [];
  const progress: string[] = [];
  const unsub = subscribe((ev) => {
    if (ev.type === 'step-control-progress') progress.push(ev.message ?? '');
  });
  try {
    await runStartStep(makeWorkflow(), makeRun(), 0, 'http://unused', {
      listTasks: async () => tasks,
      admissionHold: async () => holds.shift() ?? null,
      startTask: async (id) => {
        starts.push(id);
        if (id === 'capped') throw new SpawnCapacityError('cap');
        return spawnResult(tasks.find((t) => t.id === id)!);
      },
      enqueueRun: async (id) => {
        attempts.push(id);
        if (id !== 'queued') throw new Error(`enqueue ${id} failed`);
        return { queued: true };
      },
    });
    assert.deepEqual(starts, ['capped', 'started']);
    assert.deepEqual(attempts, ['held', 'capped', 'queued']);
    assert.equal(progress.at(-1), '1/4 started, 2 failed, 1 queued');
  } finally {
    unsub();
  }
});

test('Start step advances a mixed failed/queued batch even when nothing starts directly', async () => {
  const tasks = [makeTask({ id: 'failed', createdAt: 1 }), makeTask({ id: 'queued', createdAt: 2 })];
  const attempted: string[] = [];
  await runStartStep(makeWorkflow(), makeRun(), 0, 'http://unused', {
    listTasks: async () => tasks,
    admissionHold: async () => 'agent cap',
    startTask: async () => { throw new Error('must not start'); },
    enqueueRun: async (id) => {
      attempted.push(id);
      if (id === 'failed') throw new Error('admission failed');
      return { queued: true };
    },
  });
  assert.deepEqual(attempted, ['failed', 'queued']);
});

for (const queued of [true, false]) {
  test(`Start step accepts disk deferral after successful admission (queued=${queued})`, async () => {
    await runStartStep(makeWorkflow(), makeRun(), 0, 'http://unused', {
      listTasks: async () => [makeTask({})],
      startTask: async () => { throw new SpawnDiskSpaceError('disk reserve', 1000); },
      // queued=false means the admitted thunk is already in flight, not rejected.
      enqueueRun: async () => ({ queued }),
    });
  });
}

test('Start step leaves known queued runs alone even while admission is held', async () => {
  await runStartStep(makeWorkflow(), makeRun(), 0, 'http://unused', {
    listTasks: async () => [makeTask({ runQueued: true }), makeTask({ id: 'inflight' })],
    admissionHold: async () => 'CPU hold',
    hasQueuedRun: (id) => id === 'inflight',
    startTask: async () => { throw new Error('must not start'); },
    enqueueRun: async () => { throw new Error('must not re-enqueue'); },
  });
});
