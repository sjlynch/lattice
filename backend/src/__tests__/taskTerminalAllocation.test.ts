// Returned executor errors must travel through the REAL harness factory and
// task producer. A throwing spawn stub alone missed the factory swallowing
// these errors and publishing/counting starts that had no PTY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTask, deleteTask, getTask, updateTask } from '../tasks.js';
import { selectHarnessCommand } from '../routes/tasks/harnessFactory.js';
import { startTaskById, type StartTaskDeps } from '../routes/tasks/startTask.js';
import { resumeTaskById, type ResumeTaskDeps } from '../routes/tasks/resumeTask.js';
import { runSpawnThunk } from '../routes/tasks/queuedSpawn.js';
import { SpawnCapacityError, isSpawnDeferral } from '../spawnQueue.js';
import type { CreateSessionResult } from '../terminalServerClient/createSession.js';
import {
  subscribeTaskSpawned, subscribeTaskSpawnFailed,
  type TaskSpawnedEvent, type TaskSpawnFailedEvent,
} from '../taskSpawnEvents.js';
import { runStartStep } from '../workflowRuns/controlSteps/start.js';
import { subscribe, type WorkflowRun, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { Workflow } from '../workflows.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

const ORIGIN = 'http://127.0.0.1:1';
const UNCERTAIN = 'terminal-server did not respond within 30000ms. Session creation outcome is unknown; it was not replayed to avoid starting a duplicate agent.';

async function fixture(project: string, kind: 'run' | 'resume', allocation: CreateSessionResult) {
  const worktreePath = path.join(project, 'checkout');
  await writeLayout(worktreePath, { 'valuable.txt': 'keep my edits' });
  const created = await createTask(project, 'allocation regression');
  const task = (await updateTask(created.id, kind === 'run' ? {
    runQueued: true, runQueuedAt: 1,
  } : {
    status: 'in_progress', worktreePath, branch: 'lattice/existing',
    harness: 'pi', piModel: 'provider/model', agentSession: { harness: 'pi', id: 'old' },
  }))!;
  const calls = { allocated: 0, discarded: 0 };
  const select: typeof selectHarnessCommand = (owner, options) => selectHarnessCommand(owner, options, {
    proxyCreateSession: async () => { calls.allocated++; return allocation; },
  });
  const startDeps: StartTaskDeps = {
    setupTaskWorktree: async () => ({ worktreePath, branch: 'lattice/new', taskFile: path.join(worktreePath, 'LATTICE_TASK.md') }),
    selectHarnessCommand: select,
    discard: {
      killSession: async () => { calls.discarded++; },
      cleanupWorktree: async () => { calls.discarded++; return true; },
    },
  };
  const resumeDeps: ResumeTaskDeps = {
    worktreeExists: async () => true,
    buildTaskResumeCommand: async () => null,
    selectHarnessCommand: select,
    killSession: async () => { calls.discarded++; return true; },
  };
  const spawn = (throwOnCapacity?: boolean) => kind === 'run'
    ? startTaskById(task.id, ORIGIN, { deps: startDeps, throwOnCapacity })
    : resumeTaskById(task.id, 'claude', { deps: resumeDeps, throwOnCapacity });
  return { task, calls, startDeps, spawn, worktreePath };
}

for (const kind of ['run', 'resume'] as const) {
  for (const reason of ['executor rejected session creation', UNCERTAIN]) {
    test(`${kind}: returned ${reason === UNCERTAIN ? 'uncertain' : 'definite'} error fails once and preserves work`, async (t) => {
      await withTempDir('lattice-allocation-', async (project) => {
        const f = await fixture(project, kind, { error: reason });
        t.after(async () => { await deleteTask(f.task.id); });
        const failures: TaskSpawnFailedEvent[] = [];
        const spawns: TaskSpawnedEvent[] = [];
        t.after(subscribeTaskSpawnFailed((event) => failures.push(event)));
        t.after(subscribeTaskSpawned((event) => spawns.push(event)));

        await assert.rejects(runSpawnThunk(f.task.id, kind, () => f.spawn(true)), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, reason, 'the original uncertainty/diagnostic survives verbatim');
          assert.equal(isSpawnDeferral(error), false, 'never automatically retry an unknown outcome');
          return true;
        });

        const after = await getTask(f.task.id);
        assert.equal(after?.status, f.task.status);
        assert.deepEqual(after?.agentSession, f.task.agentSession);
        assert.equal(after?.harness, f.task.harness);
        assert.equal(after?.piModel, f.task.piModel);
        assert.equal(after?.startedAt, f.task.startedAt);
        assert.equal(after?.runQueued, undefined);
        assert.equal(after?.runFailureCount, undefined);
        assert.deepEqual(spawns, []);
        assert.equal(failures.length, 1);
        assert.equal(failures[0].reason, reason);
        assert.equal(failures[0].kind, kind);
        assert.deepEqual(f.calls, { allocated: 1, discarded: 0 });
        assert.equal(await fs.readFile(path.join(f.worktreePath, 'valuable.txt'), 'utf8'), 'keep my edits');
      });
    });
  }

  test(`${kind}: a returned CAP defers even without the legacy option`, async (t) => {
    await withTempDir('lattice-allocation-cap-', async (project) => {
      const f = await fixture(project, kind, { error: 'hard cap', code: 'CAP' });
      t.after(async () => { await deleteTask(f.task.id); });
      const failures: TaskSpawnFailedEvent[] = [];
      const spawns: TaskSpawnedEvent[] = [];
      t.after(subscribeTaskSpawnFailed((event) => failures.push(event)));
      t.after(subscribeTaskSpawned((event) => spawns.push(event)));
      await assert.rejects(runSpawnThunk(f.task.id, kind, () => f.spawn()), SpawnCapacityError);
      const after = await getTask(f.task.id);
      assert.equal(after?.status, f.task.status);
      assert.deepEqual(after?.agentSession, f.task.agentSession);
      assert.equal(after?.runQueued, f.task.runQueued);
      assert.equal(after?.runFailureCount, undefined, 'CAP does not consume an attempt');
      assert.deepEqual(spawns, []);
      assert.deepEqual(failures, []);
      assert.deepEqual(f.calls, { allocated: 1, discarded: 0 });
    });
  });

  test(`${kind}: successful allocation publishes one terminal and stores its conversation`, async (t) => {
    await withTempDir('lattice-allocation-ok-', async (project) => {
      const f = await fixture(project, kind, {
        id: 'new-pty', terminalId: 'new-tab',
        agentSession: { harness: 'claude', id: 'new-conversation', source: 'minted' },
      });
      t.after(async () => { await deleteTask(f.task.id); });
      const spawns: TaskSpawnedEvent[] = [];
      t.after(subscribeTaskSpawned((event) => spawns.push(event)));
      await runSpawnThunk(f.task.id, kind, () => f.spawn());
      const after = await getTask(f.task.id);
      assert.equal(after?.status, 'in_progress');
      assert.equal(after?.harness, 'claude');
      assert.equal(after?.piModel, undefined);
      assert.deepEqual(after?.agentSession, { harness: 'claude', id: 'new-conversation' });
      assert.equal(after?.runQueued, undefined);
      assert.equal(after?.runFailureCount, undefined);
      assert.equal(spawns.length, 1);
      assert.equal(spawns[0].serverId, 'new-pty');
      assert.equal(spawns[0].terminalId, 'new-tab');
      assert.deepEqual(f.calls, { allocated: 1, discarded: 0 });
    });
  });
}

test('workflow Start counts an actual returned factory error as failed and never requeues it', async (t) => {
  await withTempDir('lattice-allocation-workflow-', async (project) => {
    const f = await fixture(project, 'run', { error: UNCERTAIN });
    t.after(async () => { await deleteTask(f.task.id); });
    const task = (await updateTask(f.task.id, { runQueued: undefined, runQueuedAt: undefined }))!;
    const events: WorkflowRunEvent[] = [];
    t.after(subscribe((event) => events.push(event)));
    const run: WorkflowRun = {
      id: 'allocation-run', workflowId: 'workflow', workflowName: 'Workflow', projectPath: project,
      status: 'running', startedAt: 1, totalSteps: 1, currentStepIndex: 0, harnessOverride: 'claude',
    };
    await assert.rejects(runStartStep({ projectPath: project } as Workflow, run, 0, ORIGIN, {
      listTasks: async () => [task],
      startTask: (id, origin, options) => startTaskById(id, origin, { ...options, deps: f.startDeps }),
      enqueueRun: async () => { assert.fail('terminal failure must not be requeued'); },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(UNCERTAIN));
      return true;
    });
    assert.equal(events.some((event) => event.type === 'workflow-task-spawned'), false);
    assert.ok(events.some((event) => event.type === 'step-control-progress' && event.message === '0/1 started, 1 failed'));
    assert.equal((await getTask(task.id))?.status, 'open');
    assert.deepEqual(f.calls, { allocated: 1, discarded: 0 });
  });
});
