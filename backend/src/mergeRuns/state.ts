import path from 'node:path';
import { canonicalProjectPath, homeProjectDir } from '../projectPath.js';
import { ProjectStateManager } from '../projectStateManager.js';
import { ConflictWaiterRegistry } from './conflictWaiters.js';
import { normalizeLoadedRuns } from './normalization.js';
import { snapshotRun } from './snapshot.js';
import type { MergeRun, MergeRunEvent } from './types.js';

export type {
  ConflictWaiterEntry,
  MergeRun,
  MergeRunErrorEntry,
  MergeRunEvent,
  MergeRunStatus,
} from './types.js';

const MERGE_RUNS_FILENAME = 'merge-runs.json';

function projectMergeRunsFile(projectPath: string): string {
  return path.join(homeProjectDir(projectPath), MERGE_RUNS_FILENAME);
}

type MergeRunSubscriber = (ev: MergeRunEvent) => void;

export class MergeRunStateManager extends ProjectStateManager<
  MergeRun[],
  MergeRunSubscriber
> {
  public readonly runs = new Map<string, MergeRun>();
  private readonly conflictWaiters = new ConflictWaiterRegistry();

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
    this.conflictWaiters.unblockRun(id);
    return true;
  }

  public registerConflictWaiter(runId: string, taskId: string): Promise<void> {
    return this.conflictWaiters.register(runId, taskId);
  }

  public signalConflictWaiter(taskId: string): boolean {
    return this.conflictWaiters.signal(taskId);
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
  return state.registerConflictWaiter(runId, taskId);
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
  return state.signalConflictWaiter(taskId);
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
