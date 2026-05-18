// In-memory workflow-run registry + WS event fan-out.
//
// Holds the runs map, the listener set, and the snapshot/notify primitives
// the spawner and facade share. Splitting this from the orchestration logic
// keeps the WS event surface in one place — every payload that flows over
// `/ws/workflow-runs` is constructed from a `WorkflowRunEvent` here.

import { canonicalProjectPath } from '../projectPath.js';
import type { WorkflowStepHarness, WorkflowStepKind } from '../workflows.js';

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
  error?: string;
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
  return { ...run };
}

export function notify(ev: WorkflowRunEvent): void {
  for (const fn of listeners) fn(ev);
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
