// In-memory workflow-run registry + WS event fan-out.
//
// Holds the runs map, the listener set, and the snapshot/notify primitives
// the spawner and facade share. Splitting this from the orchestration logic
// keeps the WS event surface in one place — every payload that flows over
// `/ws/workflow-runs` is constructed from a `WorkflowRunEvent` here.

import { canonicalProjectPath } from '../projectPath.js';
import type { WorkflowStepHarness } from '../workflows.js';

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
