import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSpawnThunk,
  reportSpawnFailure,
  type SpawnFailureDeps,
} from '../routes/tasks/queuedSpawn.js';
import {
  subscribeTaskSpawnFailed,
  subscribeTaskSpawned,
  type TaskSpawnFailedEvent,
  type TaskSpawnedEvent,
} from '../taskSpawnEvents.js';
import { SpawnCapacityError, SpawnDiskSpaceError } from '../spawnQueue.js';
import { TaskStartWithdrawnError } from '../routes/tasks/queuedSpawnAdmission.js';
import type { Task } from '../tasks.js';

// Regression coverage for the silently-swallowed spawn-failure bug AND the
// crash-safe retry-ceiling rework: /run and /resume return {accepted:true}
// immediately and the real spawn runs later in the queue. A non-CAP failure
// (worktree setup throws, terminal-server wedged, worktree vanished) must reach
// the UI; and the attempt counter must be bumped BEFORE the spawn (crash-safe,
// via updateTaskCrashSafe) so a run that crashes the whole process mid-spawn —
// never reaching the catch below — still counts toward the ceiling. A CAP
// re-queue is not a real attempt and undoes its bump.
//
// `runSpawnThunk` is the shared body of both queued thunks; forcing its `spawn`
// callback to throw is the "worktree setup throws" scenario without standing up
// the real git/worktree/terminal-server stack.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectPath: 'C:\\development\\proj',
    title: 'My task',
    status: 'open',
    createdAt: 0,
    runQueued: true,
    runQueuedAt: 1,
    ...overrides,
  };
}

// A stateful fake store: getTask reflects accumulated updates so the at-admission
// bump and the CAP undo read a realistic prior counter. Records updateTask and
// updateTaskCrashSafe calls separately so a test can assert the bump went
// through the crash-safe (disk-first) path.
function makeStore(initial: Task | null): {
  deps: SpawnFailureDeps;
  updates: Array<Partial<Task>>;
  crashSafeUpdates: Array<Partial<Task>>;
  current: () => Task | null;
} {
  let task = initial;
  const updates: Array<Partial<Task>> = [];
  const crashSafeUpdates: Array<Partial<Task>> = [];
  const deps: SpawnFailureDeps = {
    getTask: async () => task,
    updateTask: async (_id, u) => {
      updates.push(u as Partial<Task>);
      task = task ? { ...task, ...(u as Partial<Task>) } : null;
      return task;
    },
    updateTaskCrashSafe: async (_id, u) => {
      crashSafeUpdates.push(u as Partial<Task>);
      task = task ? { ...task, ...(u as Partial<Task>) } : null;
      return task;
    },
  };
  return { deps, updates, crashSafeUpdates, current: () => task };
}

function captureFailed(): {
  events: TaskSpawnFailedEvent[];
  stop: () => void;
} {
  const events: TaskSpawnFailedEvent[] = [];
  const stop = subscribeTaskSpawnFailed((e) => events.push(e));
  return { events, stop };
}

test('runSpawnThunk(run): bumps the attempt counter crash-safely BEFORE the spawn', async () => {
  const store = makeStore(makeTask());
  const { stop } = captureFailed();
  let counterAtSpawn: number | undefined;
  try {
    await runSpawnThunk(
      't1',
      'run',
      async () => {
        // The spawn observes the bump already persisted — a process crash here
        // would leave the increment on disk for boot recovery to see.
        counterAtSpawn = store.current()?.runFailureCount;
        return {
          task: makeTask(),
          worktreePath: 'C:\\wt',
          command: 'claude',
          serverId: 's',
        };
      },
      store.deps,
    );
  } finally {
    stop();
  }
  assert.equal(store.crashSafeUpdates.length, 1);
  assert.equal(store.crashSafeUpdates[0].runFailureCount, 1);
  assert.equal(counterAtSpawn, 1);
});

test('runSpawnThunk(run): a non-CAP failure clears all run-queue state and emits task-spawn-failed', async () => {
  const store = makeStore(
    makeTask({ runQueuedHarness: 'pi', runQueuedPiModel: 'q/q' }),
  );
  const { events, stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw new Error('worktree setup failed');
        },
        store.deps,
      ),
      /worktree setup failed/,
    );
  } finally {
    stop();
  }

  // Attempt counted at admission (crash-safe).
  assert.equal(store.crashSafeUpdates.length, 1);
  assert.equal(store.crashSafeUpdates[0].runFailureCount, 1);

  // The catch clears the whole queued policy so the card drops the pill and a
  // re-run starts clean.
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0].runQueued, undefined);
  assert.equal(store.updates[0].runQueuedAt, undefined);
  assert.equal(store.updates[0].runQueuedHarness, undefined);
  assert.equal(store.updates[0].runQueuedPiModel, undefined);
  assert.equal(store.updates[0].runFailureCount, undefined);

  // The UI signal.
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, 't1');
  assert.equal(events[0].kind, 'run');
  assert.equal(events[0].projectPath, 'C:\\development\\proj');
  assert.equal(events[0].title, 'My task');
  assert.match(events[0].reason, /worktree setup failed/);
});

test('runSpawnThunk(run): the at-admission bump increments an existing counter (crash-loop accrual)', async () => {
  const store = makeStore(makeTask({ runFailureCount: 2 }));
  const { stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw new Error('still broken');
        },
        store.deps,
      ),
    );
  } finally {
    stop();
  }
  // 2 → 3 at admission; this is the increment boot recovery accrues each boot.
  assert.equal(store.crashSafeUpdates[0].runFailureCount, 3);
});

test('runSpawnThunk(resume): a non-CAP failure emits task-spawn-failed but counts nothing and touches no runQueued state', async () => {
  const store = makeStore(
    makeTask({ status: 'in_progress', runQueued: undefined }),
  );
  const { events, stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'resume',
        async () => {
          throw new Error('worktree vanished');
        },
        store.deps,
      ),
      /worktree vanished/,
    );
  } finally {
    stop();
  }

  // Resume is transient — not boot-recovered, so it is never counted and has no
  // persisted flag to reset.
  assert.equal(store.crashSafeUpdates.length, 0);
  assert.equal(store.updates.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'resume');
  assert.match(events[0].reason, /worktree vanished/);
});

test('runSpawnThunk(run): a CAP failure undoes the attempt bump and leaves runQueued set (no event)', async () => {
  const store = makeStore(makeTask());
  const { events, stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw new SpawnCapacityError('no slot');
        },
        store.deps,
      ),
      (err: unknown) => err instanceof SpawnCapacityError,
    );
  } finally {
    stop();
  }
  // Bumped at admission (→1) then undone on CAP (→ undefined): a task waiting
  // for capacity must not burn its retry budget.
  assert.equal(store.crashSafeUpdates.length, 1);
  assert.equal(store.crashSafeUpdates[0].runFailureCount, 1);
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0].runFailureCount, undefined);
  // CAP is not a failure: the queue re-queues, so runQueued stays set and the
  // user sees nothing.
  assert.equal(store.current()?.runQueued, true);
  assert.equal(events.length, 0);
});

test('runSpawnThunk(run): a CAP failure undoes to N-1 when a prior count existed', async () => {
  const store = makeStore(makeTask({ runFailureCount: 2 }));
  const { stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw new SpawnCapacityError('no slot');
        },
        store.deps,
      ),
      (err: unknown) => err instanceof SpawnCapacityError,
    );
  } finally {
    stop();
  }
  // 2 → 3 (admission) → 2 (CAP undo).
  assert.equal(store.crashSafeUpdates[0].runFailureCount, 3);
  assert.equal(store.updates[0].runFailureCount, 2);
});

test('runSpawnThunk(run): a successful spawn delivers the pty via task-spawned and emits no failure', async () => {
  const store = makeStore(makeTask());
  const spawned: TaskSpawnedEvent[] = [];
  const failed: TaskSpawnFailedEvent[] = [];
  const stopSpawned = subscribeTaskSpawned((e) => spawned.push(e));
  const stopFailed = subscribeTaskSpawnFailed((e) => failed.push(e));
  try {
    await runSpawnThunk(
      't1',
      'run',
      async () => ({
        task: makeTask(),
        worktreePath: 'C:\\wt',
        command: 'claude',
        serverId: 'srv-1',
      }),
      store.deps,
    );
  } finally {
    stopSpawned();
    stopFailed();
  }
  assert.equal(failed.length, 0);
  // The admission bump still fires; the real startTaskById clears it on success
  // (the stub here does not, so the bump is the only update).
  assert.equal(store.crashSafeUpdates.length, 1);
  assert.equal(store.updates.length, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].serverId, 'srv-1');
  assert.equal(spawned[0].taskId, 't1');
});

test('runSpawnThunk: a fulfilled producer without a PTY is a failure, never silent success', async () => {
  const store = makeStore(makeTask());
  const { events, stop } = captureFailed();
  const spawned: TaskSpawnedEvent[] = [];
  const stopSpawned = subscribeTaskSpawned((event) => spawned.push(event));
  try {
    await assert.rejects(runSpawnThunk('t1', 'run', async () => ({
      task: makeTask(), worktreePath: '/wt', command: 'claude',
    }), store.deps), /terminal allocation returned no session id/);
  } finally {
    stop();
    stopSpawned();
  }
  assert.equal(events.length, 1);
  assert.deepEqual(spawned, []);
  assert.equal(store.current()?.runQueued, undefined);
});

test('reportSpawnFailure: tolerates a missing task (emits with empty routing fields, no throw)', async () => {
  const store = makeStore(null);
  const { events, stop } = captureFailed();
  try {
    await reportSpawnFailure('gone', 'run', new Error('boom'), store.deps);
  } finally {
    stop();
  }
  // No task ⇒ updateTask still attempted (best-effort), event still emitted. It
  // no longer bumps the counter (that happens at admission), so the clear writes
  // an all-undefined queue state.
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, 'gone');
  assert.equal(events[0].projectPath, '');
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0].runFailureCount, undefined);
  assert.equal(store.updates[0].runQueued, undefined);
});

// A start the user withdrew mid-flight (run cancelled / task re-laned) is not a
// failure. If this branch stopped matching, the cancel would fall through to
// reportSpawnFailure — clearing the queue state of a re-run the user already
// queued (badge vanishes, boot recovery drops it) and toasting a false failure.
for (const [label, err] of [
  ['cancelled', new TaskStartWithdrawnError('t1', 'cancelled')],
  ['re-laned', new TaskStartWithdrawnError('t1', 'relaned', 'backlog')],
] as const) {
  test(`runSpawnThunk(run): a withdrawn start (${label}) is rethrown with no state change and no task-spawn-failed`, async () => {
    // The task as a re-run left it: queued again with its own policy.
    const store = makeStore(
      makeTask({ runQueuedHarness: 'pi', runQueuedPiModel: 'q/q' }),
    );
    const { events, stop } = captureFailed();
    try {
      await assert.rejects(
        runSpawnThunk(
          't1',
          'run',
          async () => {
            throw err;
          },
          store.deps,
        ),
        (thrown: unknown) => thrown === err,
      );
    } finally {
      stop();
    }
    // Only the at-admission bump wrote anything — no clear, no undo.
    assert.equal(store.crashSafeUpdates.length, 1);
    assert.equal(store.updates.length, 0);
    const after = store.current();
    assert.equal(after?.runQueued, true);
    assert.equal(after?.runQueuedAt, 1);
    assert.equal(after?.runQueuedHarness, 'pi');
    assert.equal(after?.runQueuedPiModel, 'q/q');
    assert.equal(after?.runFailureCount, 1);
    assert.equal(events.length, 0);
  });
}

test('runSpawnThunk(run): a duck-typed withdrawn error (isTaskStartWithdrawn flag) is also silent', async () => {
  const store = makeStore(makeTask());
  const { events, stop } = captureFailed();
  const err = Object.assign(new Error('withdrawn elsewhere'), {
    isTaskStartWithdrawn: true,
  });
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw err;
        },
        store.deps,
      ),
      (thrown: unknown) => thrown === err,
    );
  } finally {
    stop();
  }
  assert.equal(store.updates.length, 0);
  assert.equal(store.current()?.runQueued, true);
  assert.equal(events.length, 0);
});

test('runSpawnThunk(resume): a withdrawn start is rethrown silently with no writes', async () => {
  const store = makeStore(
    makeTask({ status: 'in_progress', runQueued: undefined }),
  );
  const { events, stop } = captureFailed();
  const err = new TaskStartWithdrawnError('t1', 'cancelled');
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'resume',
        async () => {
          throw err;
        },
        store.deps,
      ),
      (thrown: unknown) => thrown === err,
    );
  } finally {
    stop();
  }
  assert.equal(store.crashSafeUpdates.length, 0);
  assert.equal(store.updates.length, 0);
  assert.equal(events.length, 0);
});

// A disk-space deferral is re-queued like CAP (attempt bump undone), and the
// card is told why the run is waiting — once per waiting episode, since a
// deferred run retries every 30 s and rewriting would churn the store + WS.
test('runSpawnThunk(run): a disk-space deferral undoes the attempt bump and records runWaitingForDisk', async () => {
  const store = makeStore(makeTask());
  const { events, stop } = captureFailed();
  const err = new SpawnDiskSpaceError('need 6.5 GB free, have 2.1 GB', 30_000);
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw err;
        },
        store.deps,
      ),
      (thrown: unknown) => thrown === err,
    );
  } finally {
    stop();
  }
  // 0 → 1 (admission) → undefined (deferral undo).
  assert.equal(store.crashSafeUpdates.length, 1);
  assert.equal(store.crashSafeUpdates[0].runFailureCount, 1);
  assert.equal(store.updates.length, 2);
  assert.deepEqual(store.updates[0], { runFailureCount: undefined });
  assert.deepEqual(store.updates[1], {
    runWaitingForDisk: 'need 6.5 GB free, have 2.1 GB',
  });
  const after = store.current();
  assert.equal(after?.runFailureCount, undefined);
  assert.equal(after?.runWaitingForDisk, 'need 6.5 GB free, have 2.1 GB');
  // Still queued; not a failure.
  assert.equal(after?.runQueued, true);
  assert.equal(events.length, 0);
});

test('runSpawnThunk(run): a disk-space deferral while already waiting does not rewrite runWaitingForDisk', async () => {
  const store = makeStore(
    makeTask({ runWaitingForDisk: 'need 6.5 GB free, have 2.1 GB' }),
  );
  const { events, stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          // Live byte counts moved — the stored message must still not churn.
          throw new SpawnDiskSpaceError('need 6.5 GB free, have 2.0 GB', 30_000);
        },
        store.deps,
      ),
      (thrown: unknown) => thrown instanceof SpawnDiskSpaceError,
    );
  } finally {
    stop();
  }
  // Only the attempt undo; no second disk-wait write.
  assert.equal(store.updates.length, 1);
  assert.deepEqual(store.updates[0], { runFailureCount: undefined });
  assert.equal(
    store.current()?.runWaitingForDisk,
    'need 6.5 GB free, have 2.1 GB',
  );
  assert.equal(events.length, 0);
});

test('runSpawnThunk(resume): a disk-space deferral writes nothing (no runWaitingForDisk, no counter)', async () => {
  const store = makeStore(
    makeTask({ status: 'in_progress', runQueued: undefined }),
  );
  const { events, stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'resume',
        async () => {
          throw new SpawnDiskSpaceError('disk full', 30_000);
        },
        store.deps,
      ),
      (thrown: unknown) => thrown instanceof SpawnDiskSpaceError,
    );
  } finally {
    stop();
  }
  assert.equal(store.crashSafeUpdates.length, 0);
  assert.equal(store.updates.length, 0);
  assert.equal(store.current()?.runWaitingForDisk, undefined);
  assert.equal(events.length, 0);
});
