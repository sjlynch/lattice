// In-memory workflow-run registry + WS event fan-out.
//
// Holds the runs map, the listener set, and the snapshot/notify primitives
// the spawner and facade share. Splitting this from the orchestration logic
// keeps the WS event surface in one place — every payload that flows over
// `/ws/workflow-runs` is constructed from a `WorkflowRunEvent` here.

import { canonicalProjectPath } from '../projectPath.js';
import type { Workflow, WorkflowStepHarness, WorkflowStepKind } from '../workflows.js';
import { scheduleWorkflowRunPersist, writeWorkflowRunsNow } from './persistence.js';
import { cloneWorkflowDefinition } from './definition.js';

export type WorkflowRunStatus = 'running' | 'completed' | 'errored' | 'cancelled';

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
  harnessOverride?: WorkflowStepHarness;
  // Pi model override for the run, applied to every step when harnessOverride
  // is `pi`. Sibling to harnessOverride (two-field model, see piModels.ts).
  piModelOverride?: string;
  error?: string;
  definition?: Workflow;
  definitionError?: string;
  stepPhase?: 'pending' | 'spawning' | 'running' | 'completing';
  stepSessionId?: string;
};

export type WorkflowRunEvent =
  | { type: 'started'; run: WorkflowRun }
  | { type: 'progress'; run: WorkflowRun }
  | { type: 'completed'; run: WorkflowRun }
  | { type: 'errored'; run: WorkflowRun }
  | { type: 'cancelled'; run: WorkflowRun }
  | {
      type: 'step-spawned';
      runId: string;
      projectPath: string;
      stepIndex: number;
      command: string;
      cwd: string;
      serverId?: string;
    }
  // Emitted by the Start control step for each Open task it kicks off.
  // The frontend turns each one into a task-tagged terminal tab in the
  // sidebar so the user can watch (and intervene with) the spawned agent.
  // Distinct from `step-spawned` (which is one-per-step) because Start
  // fans out N task agents in a single step and each needs its own tab.
  | {
      type: 'workflow-task-spawned';
      runId: string;
      projectPath: string;
      stepIndex: number;
      taskId: string;
      title: string;
      command: string;
      cwd: string;
      serverId?: string;
    }
  // Emitted by control-flow steps (Start/Merge/Push) so the frontend can
  // render kind-specific progress in the run strip without spawning a
  // terminal. `current`/`total` semantics differ per kind:
  //   - start: tasks started / total open tasks
  //   - merge: tasks moved to QA / total ready+conflict tasks at step entry
  //   - push: 0..1 / 1 (binary; uses `message` to surface state)
  | {
      type: 'step-control-progress';
      runId: string;
      projectPath: string;
      stepIndex: number;
      kind: WorkflowStepKind;
      current: number;
      total: number;
      message?: string;
    };

export const runs = new Map<string, WorkflowRun>();
const listeners = new Set<(ev: WorkflowRunEvent) => void>();

export function snapshot(run: WorkflowRun): WorkflowRun {
  return { ...run, ...(run.definition ? { definition: cloneWorkflowDefinition(run.definition) } : {}) };
}

// A transition checkpoint is required before external work starts. Unlike the
// UI's best-effort debounce, failure must prevent an unrecorded side effect.
export async function checkpointWorkflowRun(run: WorkflowRun): Promise<void> {
  const records = getActiveRunsForProject(run.projectPath);
  if (run.status === 'running' && !records.some((r) => r.id === run.id)) records.push(snapshot(run));
  await writeWorkflowRunsNow(run.projectPath, records, true);
}

// Mirror this project's still-running runs to disk (debounced, best-effort).
// Called from `notify` for every run-carrying event and explicitly from
// `completeWorkflowStep` the moment it claims the next step index, so the
// on-disk record can never lag the in-memory one by more than one advance.
// See persistence.ts for why a run must survive the backend process.
export function persistRunsForProject(projectPath: string): void {
  scheduleWorkflowRunPersist(projectPath, () => getActiveRunsForProject(projectPath));
}

export function notify(ev: WorkflowRunEvent): void {
  if ('run' in ev) persistRunsForProject(ev.run.projectPath);
  // Per-listener isolation. notify() is called inline from `dispatchStep`
  // (and other advance points) — if a single subscriber throws, the
  // exception used to bubble up to `completeWorkflowStep`'s try/catch and
  // error the workflow run mid-advance (symptom: workflow aborts the
  // instant we'd transition from an agent step into a control step,
  // because that path runs `notify({type:'progress'})` synchronously
  // before scheduling the control-step worker). A WS race, a closed
  // socket whose `ws.send` throws between the `readyState` check and
  // the send, or any future-added subscriber that throws under load
  // could silently break the entire workflow engine. Per-listener
  // try/catch breaks that cascade.
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch (err) {
      console.error('[workflow-run] subscriber threw (isolated):', err);
    }
  }
}

export function subscribe(fn: (ev: WorkflowRunEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getRun(id: string): WorkflowRun | null {
  const r = runs.get(id);
  return r ? snapshot(r) : null;
}

export function getActiveRunsForProject(projectPath: string): WorkflowRun[] {
  const key = canonicalProjectPath(projectPath);
  const out: WorkflowRun[] = [];
  for (const r of runs.values()) {
    if (r.projectPath === key && r.status === 'running') {
      out.push(snapshot(r));
    }
  }
  return out;
}

// Ids of every run currently `running`, optionally scoped to one project.
// The workflow-step scratch prune passes this in so it never deletes a live
// run's scratch dir (its Stop-hook completion config / task-creation helper)
// just because a burst of newer runs pushed it past the retention window —
// concurrent runs are allowed, and a run parked on a long agent step keeps a
// stale run-dir mtime. Run ids are globally unique, so the project filter is a
// precision nicety rather than a correctness requirement.
export function getRunningRunIds(projectPath?: string): Set<string> {
  const key = projectPath ? canonicalProjectPath(projectPath) : null;
  const out = new Set<string>();
  for (const r of runs.values()) {
    if (r.status !== 'running') continue;
    if (key && r.projectPath !== key) continue;
    out.add(r.id);
  }
  return out;
}
