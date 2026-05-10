import { canonicalProjectPath } from '../projectPath.js';

export type MergeRunStatus = 'running' | 'completed' | 'cancelled' | 'errored';

export type MergeRunErrorEntry = { taskId: string; error: string };

export type MergeRun = {
  id: string;
  projectPath: string;
  status: MergeRunStatus;
  startedAt: number;
  finishedAt?: number;
  total: number;
  processed: number;
  current?: string;
  merged: string[];
  conflicted: string[];
  errored: MergeRunErrorEntry[];
  cancelRequested: boolean;
};

export type MergeRunEvent =
  | { type: 'started'; run: MergeRun }
  | { type: 'progress'; run: MergeRun }
  | {
      type: 'conflict';
      runId: string;
      projectPath: string;
      taskId: string;
      command: string;
      cwd: string;
      conflictedFiles: string[];
      serverId?: string;
    }
  | { type: 'completed'; run: MergeRun }
  | { type: 'cancelled'; run: MergeRun };

export type RunState = {
  runs: Map<string, MergeRun>;
  listeners: Set<(ev: MergeRunEvent) => void>;
};

export function createRunState(): RunState {
  return {
    runs: new Map<string, MergeRun>(),
    listeners: new Set<(ev: MergeRunEvent) => void>(),
  };
}

export function snapshot(run: MergeRun): MergeRun {
  return {
    ...run,
    merged: [...run.merged],
    conflicted: [...run.conflicted],
    errored: run.errored.map((e) => ({ ...e })),
  };
}

export function notify(state: RunState, ev: MergeRunEvent): void {
  for (const fn of state.listeners) fn(ev);
}

export function subscribeToRunState(
  state: RunState,
  fn: (ev: MergeRunEvent) => void,
): () => void {
  state.listeners.add(fn);
  return () => {
    state.listeners.delete(fn);
  };
}

export function getRunFromState(state: RunState, id: string): MergeRun | null {
  const r = state.runs.get(id);
  return r ? snapshot(r) : null;
}

export function getActiveRunForProjectFromState(
  state: RunState,
  projectPath: string,
): MergeRun | null {
  const key = canonicalProjectPath(projectPath);
  for (const r of state.runs.values()) {
    if (r.projectPath === key && r.status === 'running') {
      return snapshot(r);
    }
  }
  return null;
}

export function cancelRunInState(state: RunState, id: string): boolean {
  const run = state.runs.get(id);
  if (!run || run.status !== 'running') return false;
  run.cancelRequested = true;
  return true;
}
