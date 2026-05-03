// Sequential workflow run engine.
//
// Mirrors mergeRuns.ts: an in-memory WorkflowRun tracks progress through a
// chain of steps. Each step becomes a regular Lattice task tagged with
// workflowRunId + workflowStepIndex. When a tagged task transitions to `qa`
// (i.e. its merge into main has been finalized), the advancer creates and
// auto-runs the next step's task in the same workflow run.
//
// 'parallel' steps are accepted in the schema but executed sequentially —
// the fan-out-per-file executor is intentionally deferred.

import {
  createTask,
  getTask,
  updateTask,
  subscribe as subscribeTasks,
  type Task,
} from './tasks.js';
import { getWorkflow, type Workflow } from './workflows.js';
import { setupTaskWorktree, buildClaudeCommand } from './worktree.js';

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'errored';

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  projectPath: string;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  totalSteps: number;
  currentStepIndex: number;
  taskIdsByStep: string[];
  error?: string;
};

export type WorkflowSpawnInfo = {
  taskId: string;
  command: string;
  worktreePath: string;
  stepIndex: number;
};

export type WorkflowRunEvent =
  | { type: 'started'; run: WorkflowRun }
  | { type: 'progress'; run: WorkflowRun }
  | { type: 'completed'; run: WorkflowRun }
  | { type: 'errored'; run: WorkflowRun }
  | {
      type: 'task-spawned';
      runId: string;
      projectPath: string;
      taskId: string;
      command: string;
      worktreePath: string;
      stepIndex: number;
    };

const runs = new Map<string, WorkflowRun>();
const listeners = new Set<(ev: WorkflowRunEvent) => void>();

function snapshot(run: WorkflowRun): WorkflowRun {
  return { ...run, taskIdsByStep: [...run.taskIdsByStep] };
}

function notify(ev: WorkflowRunEvent): void {
  for (const fn of listeners) fn(ev);
}

export function subscribe(fn: (ev: WorkflowRunEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getRun(id: string): WorkflowRun | null {
  const r = runs.get(id);
  return r ? snapshot(r) : null;
}

export function getActiveRunsForProject(projectPath: string): WorkflowRun[] {
  const out: WorkflowRun[] = [];
  for (const r of runs.values()) {
    if (r.projectPath === projectPath && r.status === 'running') {
      out.push(snapshot(r));
    }
  }
  return out;
}

async function spawnStepTask(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<WorkflowSpawnInfo> {
  const step = wf.steps[stepIndex];
  const stepTitle = step.title.trim() || `${wf.name} — step ${stepIndex + 1}`;
  const created = await createTask(wf.projectPath, stepTitle, step.prompt);
  await updateTask(created.id, {
    workflowRunId: run.id,
    workflowStepIndex: stepIndex,
  });
  const fresh = (await getTask(created.id)) ?? created;
  const result = await setupTaskWorktree(wf.projectPath, fresh, backendOrigin);
  await updateTask(created.id, {
    status: 'in_progress',
    worktreePath: result.worktreePath,
    branch: result.branch,
    startedAt: Date.now(),
  });
  const command = buildClaudeCommand(result.taskFile);
  run.taskIdsByStep[stepIndex] = created.id;
  notify({
    type: 'task-spawned',
    runId: run.id,
    projectPath: wf.projectPath,
    taskId: created.id,
    command,
    worktreePath: result.worktreePath,
    stepIndex,
  });
  notify({ type: 'progress', run: snapshot(run) });
  return {
    taskId: created.id,
    command,
    worktreePath: result.worktreePath,
    stepIndex,
  };
}

export async function startWorkflowRun(
  workflowId: string,
  backendOrigin: string,
): Promise<{ run: WorkflowRun; spawn: WorkflowSpawnInfo }> {
  const wf = await getWorkflow(workflowId);
  if (!wf) throw new Error('workflow not found');
  if (wf.steps.length === 0) {
    throw new Error('workflow has no steps');
  }

  const run: WorkflowRun = {
    id: `wfrun_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    workflowId: wf.id,
    workflowName: wf.name,
    projectPath: wf.projectPath,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: wf.steps.length,
    currentStepIndex: 0,
    taskIdsByStep: [],
  };
  runs.set(run.id, run);
  notify({ type: 'started', run: snapshot(run) });
  console.log(
    `[workflow-run] ${run.id} started (workflow=${wf.id} "${wf.name}", ${wf.steps.length} step(s))`,
  );

  try {
    const spawn = await spawnStepTask(wf, run, 0, backendOrigin);
    return { run: snapshot(run), spawn };
  } catch (err) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'spawn failed';
    notify({ type: 'errored', run: snapshot(run) });
    console.error(`[workflow-run] ${run.id} failed to start step 0:`, err);
    throw err;
  }
}

let advancerStarted = false;

// Watches every task update across every project for workflow-tagged tasks
// transitioning to qa. When such a task is the run's current step, advances
// the run by spawning the next step's task. Idempotent: claims the advance
// synchronously by bumping currentStepIndex before any await, so subsequent
// notifications for the same step are ignored.
export function startWorkflowAdvancer(backendOrigin: string): void {
  if (advancerStarted) return;
  advancerStarted = true;
  subscribeTasks((_projectPath, tasks) => {
    for (const t of tasks) {
      tryAdvance(t, backendOrigin);
    }
  });
}

function tryAdvance(t: Task, backendOrigin: string): void {
  if (!t.workflowRunId || t.workflowStepIndex === undefined) return;
  if (t.status !== 'qa') return;
  const run = runs.get(t.workflowRunId);
  if (!run || run.status !== 'running') return;
  const stepIdx = run.currentStepIndex;
  if (t.workflowStepIndex !== stepIdx) return;

  // Synchronously claim ownership of this advance so a re-entrant
  // notification (which can fire while spawnStepTask is awaiting git) is
  // ignored by the same `t.workflowStepIndex !== stepIdx` check above.
  const nextIndex = stepIdx + 1;
  run.currentStepIndex = nextIndex;

  void (async () => {
    try {
      const wf = await getWorkflow(run.workflowId);
      if (!wf) {
        run.status = 'errored';
        run.finishedAt = Date.now();
        run.error = 'workflow definition not found';
        console.warn(
          `[workflow-run] ${run.id} errored: workflow ${run.workflowId} missing`,
        );
        notify({ type: 'errored', run: snapshot(run) });
        return;
      }
      if (nextIndex >= wf.steps.length) {
        run.status = 'completed';
        run.finishedAt = Date.now();
        console.log(
          `[workflow-run] ${run.id} completed all ${wf.steps.length} step(s)`,
        );
        notify({ type: 'completed', run: snapshot(run) });
        return;
      }
      console.log(
        `[workflow-run] ${run.id} advancing step ${stepIdx} → ${nextIndex}`,
      );
      await spawnStepTask(wf, run, nextIndex, backendOrigin);
    } catch (err) {
      run.status = 'errored';
      run.finishedAt = Date.now();
      run.error = (err as Error).message ?? 'advance failed';
      console.error(`[workflow-run] ${run.id} advance failed:`, err);
      notify({ type: 'errored', run: snapshot(run) });
    }
  })();
}
