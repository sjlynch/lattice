import path from 'node:path';
import { canonicalProjectPath, homeProjectDir } from '../projectPath.js';
import { ProjectStateManager } from '../projectStateManager.js';
import { ConflictWaiterRegistry } from './conflictWaiters.js';
import { normalizeLoadedRuns } from './normalization.js';
import { snapshotRun } from './snapshot.js';
import type { MergeRun, MergeRunEvent } from './types.js';
import { cancelMergeRunSpawns } from './cancellation.js';

export type {
  ConflictWaiterEntry,
  MergeRun,
  MergeRunErrorEntry,
  MergeRunEvent,
  MergeRunStatus,
} from './types.js';

const MERGE_RUNS_FILENAME = 'merge-runs.json';

// `merge-runs.json` is rewritten on EVERY progress event, with every run the
// project ever recorded; unbounded, a long-lived project made each event a
// multi-megabyte write. Persist only the newest settled runs (plus every
// running one — a live run must never fall off the persisted record).
export const MAX_PERSISTED_RUNS_PER_PROJECT = 50;

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
  // Run ids with a worker actually executing in THIS process. A `running`
  // record without an entry here is a zombie (see reapOrphanedRuns) — nothing
  // will ever advance or finish it, so it must never gate a new run.
  private readonly liveRunIds = new Set<string>();

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

  // Adopt persisted runs this process doesn't already know about.
  //
  // NEVER overwrite an id already in `this.runs`: the cached array holds
  // SNAPSHOTS (syncProjectFromRunMap clones on the way out), so re-seeding an
  // existing id swapped the LIVE run object the worker mutates for a frozen
  // clone. Every later mutation (processed++, merged.push, finishRun's status
  // flip) then landed on an object nobody could see, while the map — and the
  // 409 gate and `cancel` that read it — kept the clone's `status: 'running'`
  // forever. That is exactly how a project got wedged at "a merge run is
  // already in progress" with a dead cancel button: a second startMergeRun
  // (a resolver /complete restart, a workflow Merge step, a UI click) called
  // loadProject while a run was in flight and clobbered it mid-run.
  private syncRunMapFromProject(projectPath: string): void {
    const key = canonicalProjectPath(projectPath);
    const projectRuns = this.getCached(key) ?? [];
    for (const run of projectRuns) {
      if (this.runs.has(run.id)) continue;
      this.runs.set(run.id, run);
    }
  }

  private syncProjectFromRunMap(projectPath: string): void {
    const key = canonicalProjectPath(projectPath);
    const all = Array.from(this.runs.values()).filter((run) => run.projectPath === key);
    const running = all.filter((run) => run.status === 'running');
    const settled = all
      .filter((run) => run.status !== 'running')
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_PERSISTED_RUNS_PER_PROJECT);
    const projectRuns = [...running, ...settled]
      .sort((a, b) => a.startedAt - b.startedAt)
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

  // Worker liveness. startMergeRun marks a run live the moment it registers it
  // and settled when its worker's finalize resolves (crash included).
  public markRunLive(id: string): void {
    this.liveRunIds.add(id);
  }

  public markRunSettled(id: string): void {
    this.liveRunIds.delete(id);
  }

  public isRunLive(id: string): boolean {
    return this.liveRunIds.has(id);
  }

  // Backstop for the whole class of "stuck at running" bugs: flip any run this
  // process still records as `running` but has no worker for. Without this, one
  // zombie record blocks every future merge run for the project until a
  // restart. Emits so the UI drops the phantom active run.
  public reapOrphanedRuns(projectPath: string): MergeRun[] {
    const key = canonicalProjectPath(projectPath);
    const reaped: MergeRun[] = [];
    for (const run of this.runs.values()) {
      if (run.projectPath !== key) continue;
      if (run.status !== 'running' || this.liveRunIds.has(run.id)) continue;
      run.status = 'errored';
      run.finishedAt = Date.now();
      run.current = undefined;
      run.errored.push({
        taskId: '(run)',
        error: 'merge run record was orphaned (no worker running) — reaped',
      });
      reaped.push(run);
    }
    for (const run of reaped) {
      console.warn(`[merge-run] reaped orphaned run record ${run.id}`);
      this.emit({ type: 'completed', run: snapshotRun(run) });
    }
    return reaped;
  }

  public getActiveRunForProject(projectPath: string): MergeRun | null {
    const key = canonicalProjectPath(projectPath);
    this.reapOrphanedRuns(key);
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
    cancelMergeRunSpawns(run);
    this.conflictWaiters.unblockRun(id);
    // No worker to observe `cancelRequested` — settle the record here so the
    // button is never a silent no-op (and the run stops gating new ones).
    if (!this.liveRunIds.has(id)) {
      run.status = 'cancelled';
      run.finishedAt = Date.now();
      run.current = undefined;
      this.emit({ type: 'cancelled', run: snapshotRun(run) });
      return true;
    }
    this.syncProjectFromRunMap(run.projectPath);
    return true;
  }

  public registerConflictWaiter(runId: string, taskId: string): Promise<void> {
    return this.conflictWaiters.register(runId, taskId);
  }

  public signalConflictWaiter(taskId: string): boolean {
    return this.conflictWaiters.signal(taskId);
  }

  // Every `running` run this process is executing, with the conflict-resolver
  // tasks it is currently parked on (empty = not parked on a resolver).
  public liveRunsWithResolverWaits(): Array<{ run: MergeRun; resolverTaskIds: string[] }> {
    const out: Array<{ run: MergeRun; resolverTaskIds: string[] }> = [];
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || !this.liveRunIds.has(run.id)) continue;
      out.push({ run: snapshotRun(run), resolverTaskIds: this.conflictWaiters.taskIdsForRun(run.id) });
    }
    return out;
  }

  public abandonConflictWaiter(taskId: string, runId: string): boolean {
    return this.conflictWaiters.abandon(taskId, runId);
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

// Release a parked waiter WITHOUT recording a real completion — the liveness
// backstop (mergeRuns/waiterLiveness.ts) uses this when it wakes a run worker
// parked on a resolver whose pty died / whose wait timed out with no callback.
// Guarded on runId (see ConflictWaiterRegistry.abandon).
export function abandonConflictWaiter(
  state: RunState,
  taskId: string,
  runId: string,
): boolean {
  return state.abandonConflictWaiter(taskId, runId);
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

export function markRunLiveInState(state: RunState, id: string): void {
  state.markRunLive(id);
}

export function markRunSettledInState(state: RunState, id: string): void {
  state.markRunSettled(id);
}

export function reapOrphanedRunsInState(
  state: RunState,
  projectPath: string,
): MergeRun[] {
  return state.reapOrphanedRuns(projectPath);
}
