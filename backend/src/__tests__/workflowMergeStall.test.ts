// A workflow Merge step whose round has a task that never finishes (its agent
// died; its start was never admitted) used to error the whole run after the
// 30-min no-progress window — merging NOTHING, even with the rest of the round
// ready. With `mergeContinueOnStall` (default on) the wait gives up on the
// stalled task instead: it resolves with the board, the ready tasks merge,
// the stalled one stays In Progress, the run gets a note naming it, and the
// step completes. Off → the old rejection. The stalled task stops blocking
// every later wait in the same step.

import assert from 'node:assert/strict';
import test from 'node:test';

import { runMergeStep, stalledNote, type MergeStepDeps } from '../workflowRuns/controlSteps/merge.js';
import { waitForMergeWork, type MergeWorkWaitDeps } from '../workflowRuns/controlSteps/shared.js';
import type { MergeWorkStall } from '../workflowRuns/controlSteps/mergeWorkWait.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import type { MergeRun } from '../mergeRuns/state.js';
import type { Task } from '../tasks.js';
import type { Workflow } from '../workflows.js';

const PROJECT = '/project';
const task = (id: string, status: Task['status'], title = id): Task => ({ id, title, projectPath: PROJECT, createdAt: 1, status } as Task);

function harness(tasks: Task[]) {
  const run: WorkflowRun = {
    id: 'wfrun_stall', workflowId: 'wf', workflowName: 'wf', projectPath: PROJECT,
    status: 'running', startedAt: 1, totalSteps: 1, currentStepIndex: 0, roundTaskIds: tasks.map((t) => t.id),
  };
  const waitDeps: MergeWorkWaitDeps = {
    listTasks: async () => tasks.map((t) => ({ ...t })),
    subscribeTasks: () => () => undefined,
    subscribeRun: () => () => undefined,
    hasQueuedRun: () => false,
  };
  return { run, waitDeps };
}

test('waitForMergeWork: rejects on a stall by default; with resolveOnStall resolves and ignores the stalled task', async () => {
  const tasks = [task('t1', 'in_progress'), task('t2', 'ready_to_merge')];
  const { run, waitDeps } = harness(tasks);
  await assert.rejects(waitForMergeWork(PROJECT, run, () => {}, 150, waitDeps), /made no progress/);

  const stall: MergeWorkStall = { ignore: new Set(), resolveOnStall: true };
  const got = await waitForMergeWork(PROJECT, run, () => {}, 150, waitDeps, stall);
  assert.deepEqual(got.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual([...stall.ignore], ['t1']);
  // Once ignored, the stalled task no longer blocks: the next wait resolves at once.
  const t0 = Date.now();
  await waitForMergeWork(PROJECT, run, () => {}, 5000, waitDeps, stall);
  assert.ok(Date.now() - t0 < 1000);
});

test('runMergeStep: merges the ready tasks, leaves the stalled one, notes it, completes', async () => {
  const tasks = [task('t1', 'in_progress', 'Dead agent task'), task('t2', 'ready_to_merge'), task('t3', 'ready_to_merge')];
  const { run, waitDeps } = harness(tasks);
  const rounds: string[][] = [];
  const inner = new Map<string, MergeRun>();
  const deps: MergeStepDeps = {
    listTasks: waitDeps.listTasks,
    waitForMergeWork: (p, r, progress, _ms, _deps, stall) => waitForMergeWork(p, r, progress, 150, waitDeps, stall),
    subscribeWorkflowRuns: () => () => undefined,
    startMergeRun: async () => {
      const ready = tasks.filter((t) => t.status === 'ready_to_merge');
      rounds.push(ready.map((t) => t.id));
      for (const t of ready) t.status = 'qa';
      const mr: MergeRun = { id: `mr_${rounds.length}`, projectPath: PROJECT, status: 'completed', startedAt: 1, total: ready.length, processed: ready.length, merged: ready.map((t) => t.id), conflicted: [], errored: [], cancelRequested: false };
      inner.set(mr.id, mr);
      return mr;
    },
    getMergeRun: (id) => inner.get(id) ?? null,
    cancelMergeRun: () => false,
    subscribeMergeRuns: () => () => undefined,
    waitForPostMergeHookIdle: async () => {},
    continueOnStall: async () => true,
  };
  await runMergeStep({ projectPath: PROJECT, steps: [{ kind: 'merge' }] } as Workflow, run, 0, 'http://x', deps);
  assert.deepEqual(rounds, [['t2', 't3']]);
  assert.equal(tasks[0].status, 'in_progress', 'the stalled task is left where it was');
  assert.equal(run.notes?.length, 1);
  assert.match(run.notes![0], /1 task\(s\) made no progress for 30 min and were left unmerged: “Dead agent task”/);

  // Off: the old behavior — the run errors and nothing merges.
  const again = [task('a', 'in_progress'), task('b', 'ready_to_merge')];
  const h2 = harness(again);
  await assert.rejects(
    runMergeStep({ projectPath: PROJECT, steps: [{ kind: 'merge' }] } as Workflow, h2.run, 0, 'http://x', {
      ...deps,
      listTasks: h2.waitDeps.listTasks,
      waitForMergeWork: (p, r, progress, _ms, _deps, stall) => waitForMergeWork(p, r, progress, 150, h2.waitDeps, stall),
      continueOnStall: async () => false,
    }),
    /made no progress/,
  );
  assert.equal(again[1].status, 'ready_to_merge');
});

test('stalledNote names at most five tasks', () => {
  const ids = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const note = stalledNote(ids, [...ids].map((id) => ({ id, title: `Task ${id}` })));
  assert.match(note, /^Merge: 7 task\(s\)/);
  assert.match(note, /“Task e”, \+2 more\./);
});
