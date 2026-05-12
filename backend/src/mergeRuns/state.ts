import path from 'node:path';
import os from 'node:os';
import { canonicalProjectPath, projectHash } from '../projectPath.js';
import { ProjectStateManager } from '../projectStateManager.js';

const LATTICE_HOME = path.join(os.homedir(), '.lattice');
const PER_PROJECT_BASE = path.join(LATTICE_HOME, 'per-project');
const MERGE_RUNS_FILENAME = 'merge-runs.json';

function projectMergeRunsFile(projectPath: string): string {
  return path.join(PER_PROJECT_BASE, projectHash(projectPath), MERGE_RUNS_FILENAME);
}

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

type MergeRunSubscriber = (ev: MergeRunEvent) => void;

function snapshotRun(run: MergeRun): MergeRun {
  return {
    ...run,
    merged: [...run.merged],
    conflicted: [...run.conflicted],
    errored: run.errored.map((e) => ({ ...e })),
  };
}

function normalizeLoadedRuns(raw: unknown, projectPath: string): MergeRun[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const runs: MergeRun[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<MergeRun>;
    if (typeof candidate.id !== 'string' || !candidate.id) continue;
    if (typeof candidate.startedAt !== 'number') continue;
    const status: MergeRunStatus =
      candidate.status === 'completed' ||
      candidate.status === 'cancelled' ||
      candidate.status === 'errored'
        ? candidate.status
        : 'errored';
    const run: MergeRun = {
      id: candidate.id,
      projectPath: canonicalProjectPath(candidate.projectPath ?? projectPath),
      status,
      startedAt: candidate.startedAt,
      finishedAt:
        typeof candidate.finishedAt === 'number'
          ? candidate.finishedAt
          : status === 'errored'
            ? now
            : undefined,
      total: typeof candidate.total === 'number' ? candidate.total : 0,
      processed: typeof candidate.processed === 'number' ? candidate.processed : 0,
      current: typeof candidate.current === 'string' ? candidate.current : undefined,
      merged: Array.isArray(candidate.merged)
        ? candidate.merged.filter((id): id is string => typeof id === 'string')
        : [],
      conflicted: Array.isArray(candidate.conflicted)
        ? candidate.conflicted.filter((id): id is string => typeof id === 'string')
        : [],
      errored: Array.isArray(candidate.errored)
        ? candidate.errored
            .filter(
              (e): e is MergeRunErrorEntry =>
                !!e &&
                typeof e === 'object' &&
                typeof (e as MergeRunErrorEntry).taskId === 'string' &&
                typeof (e as MergeRunErrorEntry).error === 'string',
            )
            .map((e) => ({ ...e }))
        : [],
      cancelRequested: !!candidate.cancelRequested || status !== candidate.status,
    };
    if (status === 'errored' && candidate.status === 'running') {
      run.current = undefined;
      run.errored.push({
        taskId: '(run)',
        error: 'merge run was interrupted by backend restart',
      });
    }
    runs.push(run);
  }
  return runs;
}

export class MergeRunStateManager extends ProjectStateManager<
  MergeRun[],
  MergeRunSubscriber
> {
  public readonly runs = new Map<string, MergeRun>();
  // Keyed by taskId. A run worker registers here (keyed by the specific
  // conflict task's ID) when it spawns a resolver and wants to block until
  // that resolver's Stop hook fires (/complete). Keying by taskId (not runId)
  // prevents a mid-merge resolver finishing for task A from accidentally
  // unblocking a waiter registered for a different task B.
  public readonly conflictWaiters = new Map<string, ConflictWaiterEntry>();

  constructor() {
    super({
      name: 'merge-runs',
      fileForProject: projectMergeRunsFile,
      defaultState: () => [],
      deserialize: normalizeLoadedRuns,
      snapshot: (runs) => runs.map(snapshotRun),
    });
  }

  public async loadProject(projectPath: string): Promise<string> {
    const key = await this.loadIfNeeded(projectPath);
    this.syncRunMapFromProject(key);
    return key;
  }

  private syncRunMapFromProject(projectPath: string): void {
    const key = canonicalProjectPath(projectPath);
    const projectRuns = this.getCached(key) ?? [];
    for (const run of projectRuns) {
      this.runs.set(run.id, run);
    }
  }

  private syncProjectFromRunMap(projectPath: string): void {
    const key = canonicalProjectPath(projectPath);
    const projectRuns = Array.from(this.runs.values())
      .filter((run) => run.projectPath === key)
      .map(snapshotRun);
    this.setCached(key, projectRuns);
    this.schedulePersist(key);
  }

  public emit(ev: MergeRunEvent): void {
    const projectPaths = new Set<string>();
    if ('run' in ev) projectPaths.add(ev.run.projectPath);
    if ('projectPath' in ev) projectPaths.add(ev.projectPath);
    for (const projectPath of projectPaths) {
      this.syncProjectFromRunMap(projectPath);
    }
    this.emitToSubscribers((fn) => fn(ev));
  }

  public getRun(id: string): MergeRun | null {
    const run = this.runs.get(id);
    return run ? snapshotRun(run) : null;
  }

  public getActiveRunForProject(projectPath: string): MergeRun | null {
    const key = canonicalProjectPath(projectPath);
    for (const run of this.runs.values()) {
      if (run.projectPath === key && run.status === 'running') {
        return snapshotRun(run);
      }
    }
    return null;
  }

  public cancelRun(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running') return false;
    run.cancelRequested = true;
    this.syncProjectFromRunMap(run.projectPath);
    // Unblock any resolver waiter registered by this run so the run loop
    // can exit cleanly rather than hanging indefinitely. Waiters are keyed
    // by taskId; we find ours by matching the runId stored in the entry.
    for (const [taskId, entry] of this.conflictWaiters) {
      if (entry.runId === id) {
        this.conflictWaiters.delete(taskId);
        entry.resolve();
        break; // at most one waiter per run (sequential resolution)
      }
    }
    return true;
  }
}

export type RunState = MergeRunStateManager;

export function createRunState(): RunState {
  return new MergeRunStateManager();
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
  return snapshotRun(run);
}

export function notify(state: RunState, ev: MergeRunEvent): void {
  state.emit(ev);
}

export function subscribeToRunState(
  state: RunState,
  fn: (ev: MergeRunEvent) => void,
): () => void {
  return state.subscribe(fn);
}

export function getRunFromState(state: RunState, id: string): MergeRun | null {
  return state.getRun(id);
}

export function getActiveRunForProjectFromState(
  state: RunState,
  projectPath: string,
): MergeRun | null {
  return state.getActiveRunForProject(projectPath);
}

export function cancelRunInState(state: RunState, id: string): boolean {
  return state.cancelRun(id);
}
