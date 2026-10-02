import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStartStep, type StartStepDeps } from '../workflowRuns/controlSteps/start.js';
import { cancelWorkflowRun, startWorkflowRun } from '../workflowRuns.js';
import { addRoundTasks, isRoundTask, runs, subscribe, type WorkflowRun } from '../workflowRuns/state.js';
import { deserializeWorkflowRuns, flushWorkflowRunPersist, writeWorkflowRunsNow } from '../workflowRuns/persistence.js';
import { createTask, updateTask, type Task } from '../tasks.js';
import { createWorkflow, type Workflow } from '../workflows.js';
import type { StartTaskByIdResult } from '../routes/tasks/startTask.js';

// Regression for: "the workflow Merge step merged the first task to reach
// Ready to Merge while the rest of the round was still queued or running."
// The Merge step now waits for the run's round (WorkflowRun.roundTaskIds): the
// tasks Open or In Progress when the run started plus every task its Start
// step launched or queued. These tests cover how the round is recorded and persisted; the
// Merge-side waiting is covered by workflowMergeQueuedRuns.test.ts.

const PROJECT = '/project';

function makeTask(id: string, status: Task['status'] = 'open', createdAt = 1): Task {
  return { id, title: id, projectPath: PROJECT, status, createdAt } as Task;
}

function makeRun(round?: string[]): WorkflowRun {
  return {
    id: 'wfrun_round', workflowId: 'wf', workflowName: 'wf', projectPath: PROJECT,
    status: 'running', startedAt: 1, totalSteps: 1, currentStepIndex: 0,
    // Pins the harness picker without reading UserSettings.
    harnessOverride: 'claude',
    ...(round ? { roundTaskIds: round } : {}),
  };
}

function startDeps(tasks: Task[], log: string[], run: WorkflowRun): StartStepDeps {
  return {
    listTasks: async () => tasks,
    startTask: async (taskId) => {
      log.push(`start:${taskId}`);
      const task = tasks.find((t) => t.id === taskId)!;
      return {
        task: { ...task, status: 'in_progress' }, worktreePath: `/wt/${taskId}`, branch: `lattice/${taskId}`,
        taskFile: `/wt/${taskId}/LATTICE_TASK.md`, command: 'claude', serverId: `srv-${taskId}`,
      } satisfies StartTaskByIdResult;
    },
    enqueueRun: async (taskId) => {
      log.push(`enqueue:${taskId}`);
      return { queued: true };
    },
    hasQueuedRun: (taskId) => taskId === 'queued',
    checkpoint: async (checkpointed) => {
      assert.equal(checkpointed, run);
      log.push(`checkpoint:${[...(checkpointed.roundTaskIds ?? [])].sort().join(',')}`);
    },
  };
}

test('the Start step adds every task it launches or leaves queued to the round, durably before any launch', async () => {
  const tasks = [
    makeTask('planned', 'open', 2),
    makeTask('queued', 'open', 3),
    makeTask('manual', 'in_progress', 4),
  ];
  const run = makeRun(['pre-existing']);
  const log: string[] = [];
  await runStartStep({ projectPath: PROJECT } as Workflow, run, 0, 'http://unused', startDeps(tasks, log, run));
  assert.deepEqual(log, ['checkpoint:planned,pre-existing,queued', 'start:planned'],
    'the round is checkpointed before the first launch; an already-queued run is left to the queue');
  assert.deepEqual([...run.roundTaskIds!].sort(), ['planned', 'pre-existing', 'queued']);
  assert.equal(isRoundTask(run, 'manual'), false, 'a task the step did not start stays outside the round');
});

test('a re-dispatched Start step does not checkpoint an unchanged round; a legacy run keeps counting every task', async () => {
  const tasks = [makeTask('a')];
  const run = makeRun(['a']);
  const log: string[] = [];
  await runStartStep({ projectPath: PROJECT } as Workflow, run, 0, 'http://unused', startDeps(tasks, log, run));
  assert.deepEqual(log, ['start:a']);

  const legacy = makeRun();
  const legacyLog: string[] = [];
  await runStartStep({ projectPath: PROJECT } as Workflow, legacy, 0, 'http://unused', startDeps(tasks, legacyLog, legacy));
  assert.deepEqual(legacyLog, ['start:a']);
  assert.equal(legacy.roundTaskIds, undefined);
  assert.equal(isRoundTask(legacy, 'anything'), true);
  assert.equal(addRoundTasks(legacy, ['x']), false);
});

test('startWorkflowRun puts every task Open or In Progress at start into the round', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wf-round-'));
  let runId = '';
  let started: WorkflowRun | null = null;
  let wfProject = '';
  const unsubscribe = subscribe((ev) => {
    if (ev.type !== 'started' || ev.run.projectPath !== wfProject) return;
    runId = ev.run.id;
    started = ev.run;
    // Stop before step 1 spawns anything; the round is already recorded.
    cancelWorkflowRun(ev.run.id);
  });
  try {
    const open = await createTask(project, 'open task');
    const queued = await createTask(project, 'queued task');
    await updateTask(queued.id, { runQueued: true });
    const running = await createTask(project, 'running task');
    await updateTask(running.id, { status: 'in_progress' });
    const backlog = await createTask(project, 'backlog task');
    await updateTask(backlog.id, { status: 'backlog' });
    const wf = await createWorkflow(project, 'round', [
      { id: 's1', title: 'Step 1', prompt: 'plan', harness: 'claude' },
    ]);
    wfProject = wf.projectPath;
    await startWorkflowRun(wf.id, 'http://127.0.0.1:1');
    assert.ok(started, 'the run started');
    assert.deepEqual([...(started as WorkflowRun).roundTaskIds!].sort(), [open.id, queued.id, running.id].sort(),
      'Backlog stays out; work already In Progress is waited for like the round');
    assert.equal(runs.get(runId)?.status, 'cancelled');
  } finally {
    unsubscribe();
    if (runId) runs.delete(runId);
    if (wfProject) {
      await flushWorkflowRunPersist(wfProject);
      await writeWorkflowRunsNow(wfProject, []);
    }
    await new Promise((r) => setTimeout(r, 200)); // let the workflow store flush
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('the round survives the persisted mirror; an unreadable one falls back to counting every task', () => {
  const base = {
    id: 'wfrun_persisted', workflowId: 'wf', projectPath: path.resolve('/persisted-project'),
    status: 'running', totalSteps: 1, currentStepIndex: 0,
  };
  const [kept] = deserializeWorkflowRuns(JSON.parse(JSON.stringify([{ ...base, roundTaskIds: ['a', 'a', 7, '', 'b'] }])));
  assert.deepEqual(kept.roundTaskIds, ['a', 'b']);
  const [legacy] = deserializeWorkflowRuns([{ ...base, roundTaskIds: 'a,b' }]);
  assert.equal(legacy.roundTaskIds, undefined);
  assert.equal(isRoundTask(legacy, 'c'), true);
});
