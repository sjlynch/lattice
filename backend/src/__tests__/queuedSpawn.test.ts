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
import { SpawnCapacityError } from '../spawnQueue.js';
import type { Task } from '../tasks.js';

// Regression coverage for the silently-swallowed spawn-failure bug:
// /run and /resume return {accepted:true} immediately and the real spawn runs
// later in the queue. A non-CAP failure (worktree setup throws, terminal-server
// wedged, worktree vanished) used to only console.error — nothing reached the
// UI, the resume thunk had no try/catch at all, and a deterministically-failing
// run kept `runQueued` set so boot recovery re-enqueued it forever.
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

// Capture deps: a fixed task + a recording updateTask. The real
// task-spawn-failed event bus is used so the wiring is exercised end to end.
function makeDeps(task: Task | null): {
  deps: SpawnFailureDeps;
  updates: Array<Partial<Task>>;
} {
  const updates: Array<Partial<Task>> = [];
  const deps: SpawnFailureDeps = {
    getTask: async () => task,
    updateTask: async (_id, u) => {
      updates.push(u as Partial<Task>);
      return task ? { ...task, ...(u as Partial<Task>) } : null;
    },
  };
  return { deps, updates };
}

function captureFailed(): {
  events: TaskSpawnFailedEvent[];
  stop: () => void;
} {
  const events: TaskSpawnFailedEvent[] = [];
  const stop = subscribeTaskSpawnFailed((e) => events.push(e));
  return { events, stop };
}

test('runSpawnThunk(run): a non-CAP failure clears runQueued, bumps the failure counter, and emits task-spawn-failed', async () => {
  const { deps, updates } = makeDeps(makeTask());
  const { events, stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw new Error('worktree setup failed');
        },
        deps,
      ),
      /worktree setup failed/,
    );
  } finally {
    stop();
  }

  // runQueued reset + failure counter bumped (was undefined ⇒ 1).
  assert.equal(updates.length, 1);
  assert.equal(updates[0].runQueued, undefined);
  assert.equal(updates[0].runQueuedAt, undefined);
  assert.equal(updates[0].runFailureCount, 1);

  // The UI signal.
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, 't1');
  assert.equal(events[0].kind, 'run');
  assert.equal(events[0].projectPath, 'C:\\development\\proj');
  assert.equal(events[0].title, 'My task');
  assert.match(events[0].reason, /worktree setup failed/);
});

test('runSpawnThunk(run): a non-CAP failure increments an existing failure counter', async () => {
  const { deps, updates } = makeDeps(makeTask({ runFailureCount: 2 }));
  const { stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw new Error('still broken');
        },
        deps,
      ),
    );
  } finally {
    stop();
  }
  assert.equal(updates[0].runFailureCount, 3);
});

test('runSpawnThunk(resume): a non-CAP failure emits task-spawn-failed but touches no runQueued state', async () => {
  const { deps, updates } = makeDeps(
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
        deps,
      ),
      /worktree vanished/,
    );
  } finally {
    stop();
  }

  // Resume is transient — no persisted flag to reset, so no write.
  assert.equal(updates.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'resume');
  assert.match(events[0].reason, /worktree vanished/);
});

test('runSpawnThunk: a CAP failure is re-thrown untouched — no state change, no failure event', async () => {
  const { deps, updates } = makeDeps(makeTask());
  const { events, stop } = captureFailed();
  try {
    await assert.rejects(
      runSpawnThunk(
        't1',
        'run',
        async () => {
          throw new SpawnCapacityError('no slot');
        },
        deps,
      ),
      (err: unknown) => err instanceof SpawnCapacityError,
    );
  } finally {
    stop();
  }
  // CAP is not a failure: the queue re-queues, so runQueued stays set and the
  // user sees nothing.
  assert.equal(updates.length, 0);
  assert.equal(events.length, 0);
});

test('runSpawnThunk: a successful spawn delivers the pty via task-spawned and emits no failure', async () => {
  const { deps, updates } = makeDeps(makeTask());
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
      deps,
    );
  } finally {
    stopSpawned();
    stopFailed();
  }
  assert.equal(failed.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].serverId, 'srv-1');
  assert.equal(spawned[0].taskId, 't1');
});

test('reportSpawnFailure: tolerates a missing task (emits with empty routing fields, no throw)', async () => {
  const { deps, updates } = makeDeps(null);
  const { events, stop } = captureFailed();
  try {
    await reportSpawnFailure('gone', 'run', new Error('boom'), deps);
  } finally {
    stop();
  }
  // No task ⇒ updateTask still attempted (best-effort), event still emitted.
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, 'gone');
  assert.equal(events[0].projectPath, '');
  assert.equal(updates[0].runFailureCount, 1);
});
