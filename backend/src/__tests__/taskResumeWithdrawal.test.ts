// Resume owns only its new allocation, never the existing checkout. Exercise
// the actual producer at deferred preparation/allocation boundaries and drive
// the real enqueue wrapper so dropping its AbortSignal cannot regress silently.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTask, deleteTask, getTask, updateTask, type Task } from '../tasks.js';
import { resumeTaskById, type ResumeTaskDeps } from '../routes/tasks/resumeTask.js';
import { selectHarnessCommand } from '../routes/tasks/harnessFactory.js';
import { TaskStartWithdrawnError, isTaskStartWithdrawn } from '../routes/tasks/queuedSpawnAdmission.js';
import { enqueueTaskResume, cancelQueuedTaskSpawns, runSpawnThunk } from '../routes/tasks/queuedSpawn.js';
import {
  subscribeTaskSpawned, subscribeTaskSpawnFailed,
  type TaskSpawnedEvent, type TaskSpawnFailedEvent,
} from '../taskSpawnEvents.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import type { CreateSessionResult } from '../terminalServerClient/createSession.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

async function fixture(t: TestContext, project: string) {
  const worktreePath = path.join(project, 'existing-checkout');
  await writeLayout(worktreePath, { 'valuable.txt': 'uncommitted edits' });
  const created = await createTask(project, 'resume withdrawal');
  const task = (await updateTask(created.id, {
    status: 'in_progress', worktreePath, branch: 'lattice/existing',
    harness: 'pi', piModel: 'provider/model', agentSession: { harness: 'pi', id: 'old' },
  }))!;
  t.after(async () => { await deleteTask(task.id); });
  const spawns: TaskSpawnedEvent[] = [];
  const failures: TaskSpawnFailedEvent[] = [];
  t.after(subscribeTaskSpawned((event) => spawns.push(event)));
  t.after(subscribeTaskSpawnFailed((event) => failures.push(event)));
  const calls = { allocations: 0, kills: [] as string[] };
  const deps: ResumeTaskDeps = {
    worktreeExists: async () => true,
    buildTaskResumeCommand: async () => null,
    selectHarnessCommand: (owner, options) => selectHarnessCommand(owner, options, {
      proxyCreateSession: async () => {
        calls.allocations++;
        return { id: 'late-pty', terminalId: 'late-tab', agentSession: { harness: 'claude', id: 'new', source: 'minted' } };
      },
    }),
    killSession: async (id) => { calls.kills.push(id); return true; },
  };
  const spawn = (signal?: AbortSignal) => runSpawnThunk(task.id, 'resume', () =>
    resumeTaskById(task.id, 'claude', { deps, signal, throwOnCapacity: true }));
  const assertWorkPreserved = async () => {
    assert.equal(await fs.readFile(path.join(worktreePath, 'valuable.txt'), 'utf8'), 'uncommitted edits');
    assert.deepEqual(spawns, []);
    assert.deepEqual(failures, [], 'intentional withdrawal does not toast a spawn failure');
  };
  return { task, worktreePath, calls, deps, spawn, assertWorkPreserved };
}

function assertMetadataUnchanged(current: Task | null, original: Task) {
  assert.ok(current);
  assert.equal(current.harness, original.harness);
  assert.equal(current.piModel, original.piModel);
  assert.deepEqual(current.agentSession, original.agentSession);
}

for (const change of ['cancel', 'delete', 'lane', 'worktree', 'branch'] as const) {
  test(`resume withdrawn by ${change} during conversation lookup never allocates`, async (t) => {
    await withTempDir('lattice-resume-prepare-', async (project) => {
      const f = await fixture(t, project);
      const reached = gate();
      const blocked = gate();
      const controller = new AbortController();
      f.deps.buildTaskResumeCommand = async () => { reached.open(); await blocked.wait; return null; };
      const rejected = assert.rejects(f.spawn(controller.signal), isTaskStartWithdrawn);
      await reached.wait;
      if (change === 'cancel') controller.abort();
      if (change === 'delete') await deleteTask(f.task.id);
      if (change === 'lane') await updateTask(f.task.id, { status: 'ready_to_merge' });
      if (change === 'worktree') await updateTask(f.task.id, { worktreePath: path.join(project, 'replacement') });
      if (change === 'branch') await updateTask(f.task.id, { branch: 'lattice/replacement' });
      blocked.open();
      await rejected;
      assert.equal(f.calls.allocations, 0);
      assert.deepEqual(f.calls.kills, []);
      const after = await getTask(f.task.id);
      if (change === 'delete') assert.equal(after, null);
      else assertMetadataUnchanged(after, f.task);
      await f.assertWorkPreserved();
    });
  });
}

test('resume cancellation during the worktree probe wins over a missing-directory error', async (t) => {
  await withTempDir('lattice-resume-probe-', async (project) => {
    const f = await fixture(t, project);
    const controller = new AbortController();
    f.deps.worktreeExists = async () => { controller.abort(); return false; };
    await assert.rejects(f.spawn(controller.signal), isTaskStartWithdrawn);
    assert.equal(f.calls.allocations, 0);
    await f.assertWorkPreserved();
  });
});

for (const change of ['cancel', 'delete', 'lane', 'worktree'] as const) {
  test(`resume withdrawn by ${change} during allocation reclaims only its late PTY`, async (t) => {
    await withTempDir('lattice-resume-allocate-', async (project) => {
      const f = await fixture(t, project);
      const reached = gate();
      const blocked = gate();
      const controller = new AbortController();
      const select = f.deps.selectHarnessCommand;
      f.deps.selectHarnessCommand = (owner, options) => {
        const harness = select(owner, options);
        const create = harness.createSession;
        return { ...harness, createSession: async (args) => { reached.open(); await blocked.wait; return create(args); } };
      };
      const rejected = assert.rejects(f.spawn(controller.signal), isTaskStartWithdrawn);
      await reached.wait;
      if (change === 'cancel') controller.abort();
      if (change === 'delete') await deleteTask(f.task.id);
      if (change === 'lane') await updateTask(f.task.id, { status: 'ready_to_merge' });
      if (change === 'worktree') await updateTask(f.task.id, { worktreePath: path.join(project, 'replacement') });
      blocked.open();
      await rejected;
      assert.equal(f.calls.allocations, 1);
      assert.deepEqual(f.calls.kills, ['late-pty'], 'reclaim exactly the allocation this resume owns');
      const after = await getTask(f.task.id);
      if (change === 'delete') assert.equal(after, null);
      else assertMetadataUnchanged(after, f.task);
      await f.assertWorkPreserved();
    });
  });
}

test('a withdrawn CAP resume does not return a capacity deferral', async (t) => {
  await withTempDir('lattice-resume-cap-cancel-', async (project) => {
    const f = await fixture(t, project);
    const controller = new AbortController();
    f.deps.selectHarnessCommand = (owner, options) => selectHarnessCommand(owner, options, {
      proxyCreateSession: async () => { controller.abort(); return { error: 'cap', code: 'CAP' }; },
    });
    await assert.rejects(f.spawn(controller.signal), isTaskStartWithdrawn);
    assert.deepEqual(f.calls.kills, []);
    assertMetadataUnchanged(await getTask(f.task.id), f.task);
    await f.assertWorkPreserved();
  });
});

test('body-less Pi resume keeps its harness/model and returns the current task snapshot', async (t) => {
  await withTempDir('lattice-resume-default-', async (project) => {
    const f = await fixture(t, project);
    f.deps.selectHarnessCommand = (owner, options) => {
      assert.equal(options.requestedHarness, 'pi');
      assert.equal(options.piModel, 'provider/model');
      return selectHarnessCommand(owner, options, {
        proxyCreateSession: async () => {
          await updateTask(owner.id, { title: 'renamed during allocation' });
          return { id: 'pi-pty', agentSession: { harness: 'pi', id: 'continued', source: 'minted' } };
        },
      });
    };
    const resumed = await resumeTaskById(f.task.id, undefined, { deps: f.deps });
    assert.equal(resumed.task.title, 'renamed during allocation');
    assert.equal(resumed.task.harness, 'pi');
    assert.equal(resumed.task.piModel, 'provider/model');
    assert.deepEqual(resumed.task.agentSession, { harness: 'pi', id: 'continued' });
    assert.equal(resumed.serverId, 'pi-pty');
    assert.deepEqual(f.calls.kills, []);
  });
});

test('unchanged conversation still checks withdrawal after allocation', async (t) => {
  await withTempDir('lattice-resume-unchanged-', async (project) => {
    const f = await fixture(t, project);
    const controller = new AbortController();
    f.deps.selectHarnessCommand = (owner, options) => selectHarnessCommand(owner, options, {
      proxyCreateSession: async () => {
        controller.abort();
        return { id: 'pi-pty', agentSession: { harness: 'pi', id: 'old', source: 'minted' } };
      },
    });
    await assert.rejects(runSpawnThunk(f.task.id, 'resume', () =>
      resumeTaskById(f.task.id, undefined, { deps: f.deps, signal: controller.signal })), isTaskStartWithdrawn);
    assert.deepEqual(f.calls.kills, ['pi-pty']);
    assertMetadataUnchanged(await getTask(f.task.id), f.task);
    await f.assertWorkPreserved();
  });
});

test('enqueue forwards cancellation and default cleanup settles the late registry tab', async (t) => {
  await withTempDir('lattice-resume-queue-', async (project) => {
    const f = await fixture(t, project);
    const reached = gate();
    const blocked = gate();
    const settled = gate();
    const observed: { signal?: AbortSignal; error?: unknown } = {};
    // Keep an older tab to prove cleanup is by new PTY, never by cwd/task.
    const old = await terminalRegistry.create({
      projectPath: project, cwd: f.worktreePath, owner: 'task', taskId: f.task.id,
      label: 'old', launch: { harness: 'pi' }, serverId: 'old-pty',
    });
    let lateTabId = '';
    f.deps.selectHarnessCommand = (owner, options) => selectHarnessCommand(owner, options, {
      proxyCreateSession: async (): Promise<CreateSessionResult> => {
        reached.open();
        await blocked.wait;
        const record = await terminalRegistry.create({
          projectPath: project, cwd: f.worktreePath, owner: 'task', taskId: owner.id,
          label: 'late', launch: { harness: 'claude' }, serverId: 'late-pty',
        });
        lateTabId = record.id;
        return { id: 'late-pty', terminalId: record.id, agentSession: { harness: 'claude', id: 'new', source: 'minted' } };
      },
    });
    // Use the real terminalProxy kill wrapper/registry, replacing only HTTP.
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      assert.equal(init?.method, 'DELETE');
      assert.ok(String(url).endsWith('/sessions/late-pty'));
      f.calls.kills.push('late-pty');
      return new Response('{}', { status: 200 });
    });
    const { killSession: _fakeKill, ...resumeDeps } = f.deps;
    queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
    queueState.accounting.reconcile(0, Date.now() + 1);
    queueState.governor.setEnabled(false);
    try {
      await enqueueTaskResume(f.task.id, 'claude', undefined, {
        resumeTaskById: async (id, harness, options, piModel) => {
          observed.signal = options?.signal;
          try {
            return await resumeTaskById(id, harness, { ...options, deps: resumeDeps }, piModel);
          } catch (error) {
            observed.error = error;
            throw error;
          } finally {
            settled.open();
          }
        },
      });
      await reached.wait;
      cancelQueuedTaskSpawns(f.task.id); // the delete route's cancellation
      await deleteTask(f.task.id);
      assert.equal(observed.signal?.aborted, true);
      blocked.open();
      await settled.wait;
      // The producer's rejection still passes through runSpawnThunk/queue.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(observed.error instanceof TaskStartWithdrawnError);
      assert.deepEqual(f.calls.kills, ['late-pty']);
      assert.equal(await terminalRegistry.get(lateTabId, project), null, 'late tab cannot be restored');
      assert.ok(await terminalRegistry.get(old.id, project), 'older task tab is untouched');
      assert.equal(await getTask(f.task.id), null);
      await f.assertWorkPreserved();
    } finally {
      blocked.open();
      cancelQueuedTaskSpawns(f.task.id);
      await terminalRegistry.endWhere((record) => record.projectPath === project, { reason: 'closed' });
    }
  });
});
