// Regression coverage for the 2026-09 merge/worktree/recovery audit fixes:
//   - checkBranchExists throws instead of reading a git failure as "deleted"
//   - a rejecting control-step completion errors the run, never the process
//   - /merge-aborted takes the per-task merge lock (409 when held)
//   - finalizeResolvedTask re-reads the task after the lock and honours a cancel
//   - the batched owned-file `ls-files` parser
//   - the in-progress sweep's overlap guard + no-commits back-off
//   - case-folded worktree containment on win32
//   - color-slot reservations for concurrent starts
//   - the bounded fan-out helper the recovery loops share

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Response } from 'express';
import { checkBranchExists } from '../worktree/state.js';
import { executeControlStep, runControlStepWorker } from '../workflowRuns/controlStep.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import type { Workflow } from '../workflows.js';
import { handleTaskMergeAborted } from '../routes/tasks/hooks/mergeAborted.js';
import { finalizeResolvedTask } from '../routes/tasks/finalizeResolved.js';
import { tryAcquire, release, isLocked } from '../mergeLocks.js';
import { createTask, deleteTask, flushPersist, updateTask, type Task } from '../tasks.js';
import { homeProjectDir } from '../projectPath.js';
import { trackedOwnedPaths, LATTICE_OWNED_FILE_PATHS } from '../worktree/managedFiles.js';
import { assertAllowedProjectGitArgs } from '../worktree/projectGit.js';
import { runInProgressSweepTick } from '../recovery/inProgressSweep/scheduler.js';
import {
  clearNoCommitsVerdict,
  isNoCommitsBackedOff,
  noteNoCommitsVerdict,
  NO_COMMITS_BACKOFF_MS,
  resetNoCommitsBackoffForTests,
} from '../recovery/inProgressSweep/sweep.js';
import { isPathStrictlyInside } from '../worktree/paths.js';
import { assignColorSlot, reserveColorSlot } from '../routes/tasks/colorSlot.js';
import { forEachWithConcurrency } from '../recovery/concurrency.js';

const execFileAsync = promisify(execFile);
const ORIGIN = 'http://127.0.0.1:5184';

// ---- checkBranchExists ------------------------------------------------------

test('checkBranchExists throws on a git failure instead of reporting "deleted"', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-branch-probe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Not a repo: `git branch --list` exits 128 with empty stdout — the exact
  // shape the old boolean read as "branch gone → recover to qa".
  await assert.rejects(checkBranchExists(dir, 'lattice/x'), /git branch --list lattice\/x failed/);

  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '--allow-empty', '-m', 'base'], { cwd: dir });
  await execFileAsync('git', ['branch', 'lattice/present'], { cwd: dir });
  assert.equal(await checkBranchExists(dir, 'lattice/present'), true);
  assert.equal(await checkBranchExists(dir, 'lattice/absent'), false, 'exit 0 + no match is the one confirmed absence');
});

// ---- control step completion ----------------------------------------------

function makeRun(): WorkflowRun {
  return {
    id: 'run_audit',
    workflowId: 'wf',
    projectPath: path.join(os.tmpdir(), 'lattice-audit-project'),
    status: 'running',
    currentStepIndex: 0,
    totalSteps: 1,
    startedAt: Date.now(),
  } as unknown as WorkflowRun;
}

test('a rejecting completeStep errors the run instead of surfacing an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const wf = { projectPath: os.tmpdir(), steps: [{ kind: 'start' }] } as Workflow;
    const run = makeRun();
    await runControlStepWorker(
      wf, run, 0, ORIGIN,
      async () => { throw new Error('EPERM: checkpoint rename failed'); },
      {
        acquireLock: async () => ({ release: async () => undefined }),
        runStart: async () => undefined,
        runMerge: async () => undefined,
        runPush: async () => undefined,
      },
    );
    assert.equal(run.status, 'errored');
    assert.match(run.error ?? '', /checkpoint rename failed/);

    // The fire-and-forget entry point is guarded too: a worker that rejects
    // outright (here: a step index with no step) is logged, not unhandled.
    const run2 = makeRun();
    executeControlStep({ projectPath: os.tmpdir(), steps: [] } as unknown as Workflow, run2, 0, ORIGIN, async () => undefined);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ---- /merge-aborted lock + finalize re-read --------------------------------

type MockRes = { statusCode: number; body: unknown; status: (c: number) => MockRes; json: (b: unknown) => MockRes };
function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

test('/merge-aborted refuses with 409 while the per-task merge lock is held', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-abort-lock-'));
  const projectPath = path.join(base, 'repo');
  await fs.mkdir(projectPath, { recursive: true });
  const task = await createTask(projectPath, 'abort lock fixture');
  await updateTask(task.id, { status: 'ready_to_merge', conflict: true, branch: `lattice/${task.id}` });
  let recovered = 0;
  const handler = handleTaskMergeAborted(ORIGIN, {
    recover: async () => { recovered += 1; },
    signalConflictWaiter: () => false,
  });
  const lock = tryAcquire(task.id);
  try {
    const held = mockRes();
    await handler({ params: { id: task.id }, query: {} } as never, held as unknown as Response);
    assert.equal(held.statusCode, 409, 'a live merge/finalize on this task refuses the abort');
    assert.equal(recovered, 0, 'git merge --abort never raced the in-flight merge');
    release(lock!);

    const free = mockRes();
    await handler({ params: { id: task.id }, query: {} } as never, free as unknown as Response);
    assert.deepEqual(free.body, { ok: true });
    assert.equal(recovered, 1);
    assert.equal(isLocked(task.id), false, 'the abort released the lock it took');
  } finally {
    if (isLocked(task.id) && lock) release(lock);
    await deleteTask(task.id);
    await flushPersist(projectPath).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('finalizeResolvedTask honours a cancel that landed before it took the lock', async () => {
  const id = `t_audit_reread_${Date.now()}`;
  const task: Task = {
    id,
    projectPath: path.join(os.tmpdir(), 'lattice-audit-reread', 'repo'),
    title: 'fixture',
    status: 'ready_to_merge',
    conflict: true,
    branch: `lattice/${id}`,
    worktreePath: path.join(os.tmpdir(), 'lattice-audit-reread', 'wt'),
    createdAt: 0,
  };
  let resyncCalls = 0;
  const result = await finalizeResolvedTask(task, ORIGIN, 'complete', {
    resync: async () => { resyncCalls += 1; return { kind: 'finalized' } as never; },
    signalOrRestartMergeRun: () => undefined,
    // The store's view once the lock is ours: /merge-aborted cleared the flag.
    readTask: async () => ({ ...task, conflict: undefined }),
  });
  assert.deepEqual(result, { kind: 'already-finalizing' });
  assert.equal(resyncCalls, 0, 'no re-sync / FF into main behind the cancel');
  assert.equal(isLocked(id), false);
});

// ---- batched ls-files -------------------------------------------------------

test('trackedOwnedPaths parses one NUL-delimited ls-files call and keeps canonical order', () => {
  const out = ['.pi/mcp.json', 'LATTICE_TASK.md', 'unrelated.txt', '.claude\\settings.local.json'].join('\0') + '\0';
  assert.deepEqual(trackedOwnedPaths(out), ['LATTICE_TASK.md', '.claude/settings.local.json', '.pi/mcp.json']);
  assert.deepEqual(trackedOwnedPaths(''), []);
  assertAllowedProjectGitArgs(['ls-files', '-z', '--', ...LATTICE_OWNED_FILE_PATHS]);
});

// ---- in-progress sweep ------------------------------------------------------

test('runInProgressSweepTick never overlaps a pass that is still running', async () => {
  let finish!: () => void;
  let calls = 0;
  const sweep = () => { calls += 1; return new Promise<void>((r) => { finish = r; }); };
  const first = runInProgressSweepTick(sweep);
  assert.equal(await runInProgressSweepTick(sweep), false, 'second tick skipped');
  assert.equal(calls, 1);
  finish();
  assert.equal(await first, true);
  assert.equal(await runInProgressSweepTick(async () => { calls += 1; }), true, 'runs again once free');
  assert.equal(calls, 2);
});

test('a no-commits verdict backs off for 10 minutes and warns once', () => {
  resetNoCommitsBackoffForTests();
  const task = { id: 't1', branch: 'lattice/t1' } as Task;
  const now = 1_000_000;
  assert.equal(isNoCommitsBackedOff(task, now), false);
  assert.equal(noteNoCommitsVerdict(task, now), false, 'first verdict: warn');
  assert.equal(isNoCommitsBackedOff(task, now + 60_000), true, 'next pass: no probe');
  assert.equal(isNoCommitsBackedOff(task, now + NO_COMMITS_BACKOFF_MS), false, 're-probe after the window');
  assert.equal(noteNoCommitsVerdict(task, now + NO_COMMITS_BACKOFF_MS), true, 'still stuck: quiet');
  clearNoCommitsVerdict(task);
  assert.equal(noteNoCommitsVerdict(task, now), false, 'a resumed task starts fresh');
  resetNoCommitsBackoffForTests();
});

// ---- case-folded containment ---------------------------------------------

test('isPathStrictlyInside folds case on win32 only', () => {
  const base = path.resolve('/Users/Someone/.lattice/worktrees');
  const target = path.resolve('/users/someone/.lattice/worktrees/proj/wt-1');
  assert.equal(isPathStrictlyInside(base, target), process.platform === 'win32');
  assert.equal(isPathStrictlyInside(base, base), false, 'never the base itself');
  assert.equal(isPathStrictlyInside(base, `${base}-sibling`), false, 'never a prefix sibling');
});

// ---- color slots ------------------------------------------------------------

function slotTask(p: Partial<Task>): Task {
  return { id: p.id ?? 'x', projectPath: '/p', title: 'T', status: p.status ?? 'in_progress', createdAt: 0, ...p };
}

test('reserveColorSlot hands overlapping starts distinct slots and frees them on release', () => {
  const tasks = [slotTask({ id: 'live', colorIndex: 0 })];
  // Both starts read the same task list (both still `open`) before either
  // status flip lands — the "Run All" race.
  const a = reserveColorSlot('/p-audit', tasks, 'a');
  const b = reserveColorSlot('/p-audit', tasks, 'b');
  assert.equal(a.slot, 1);
  assert.equal(b.slot, 2, 'the second start sees the first one\'s reservation');
  assert.equal(reserveColorSlot('/p-audit', tasks, 'a').slot, 1, 're-reserving is idempotent');
  a.release();
  a.release();
  assert.equal(reserveColorSlot('/p-audit', tasks, 'c').slot, 1, 'a released slot is reusable');
  b.release();
  assert.equal(assignColorSlot(tasks, 'z', new Set([1, 2])), 3);
});

// ---- bounded fan-out --------------------------------------------------------

test('forEachWithConcurrency bounds in-flight work and visits every item', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen: number[] = [];
  await forEachWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    seen.push(i);
    inFlight -= 1;
  });
  assert.equal(peak, 4);
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
  await forEachWithConcurrency([], 8, async () => { assert.fail('never called'); });
});
