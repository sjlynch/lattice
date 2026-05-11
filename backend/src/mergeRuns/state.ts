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

export type ConflictWaiterEntry = { runId: string; resolve: () => void };

export type RunState = {
  runs: Map<string, MergeRun>;
  listeners: Set<(ev: MergeRunEvent) => void>;
  // Keyed by taskId. A run worker registers here (keyed by the specific
  // conflict task's ID) when it spawns a resolver and wants to block until
  // that resolver's Stop hook fires (/complete). Keying by taskId (not runId)
  // prevents a mid-merge resolver finishing for task A from accidentally
  // unblocking a waiter registered for a different task B.
  conflictWaiters: Map<string, ConflictWaiterEntry>;
};

export function createRunState(): RunState {
  return {
    runs: new Map<string, MergeRun>(),
    listeners: new Set<(ev: MergeRunEvent) => void>(),
    conflictWaiters: new Map(),
  };
}

// Block the run worker until the conflict resolver for `taskId` signals
// completion (via signalConflictWaiterInState / cancelRunInState).
// After this resolves, check run.cancelRequested to decide whether to halt.
export function registerConflictWaiter(
  state: RunState,
  runId: string,
  taskId: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    state.conflictWaiters.set(taskId, { runId, resolve });
  });
}

// Called by /complete (or /merged) after finalizeMergedTask succeeds, or
// after a re-sync conflict re-queues the task (either way the run should
// unblock and move to the next task). Returns true if a waiter was found
// and signalled (the run is alive in this process); false means the run
// was killed by a restart and callers should startMergeRun instead.
export function signalConflictWaiterInState(
  state: RunState,
  taskId: string,
): boolean {
  const entry = state.conflictWaiters.get(taskId);
  if (!entry) return false;
  state.conflictWaiters.delete(taskId);
  entry.resolve();
  return true;
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
  // Unblock any resolver waiter registered by this run so the run loop
  // can exit cleanly rather than hanging indefinitely. Waiters are keyed
  // by taskId; we find ours by matching the runId stored in the entry.
  for (const [taskId, entry] of state.conflictWaiters) {
    if (entry.runId === id) {
      state.conflictWaiters.delete(taskId);
      entry.resolve();
      break; // at most one waiter per run (sequential resolution)
    }
  }
  return true;
}
