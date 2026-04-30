// Backend-driven "merge all ready" runs.
//
// The frontend used to drive a sequential loop over /api/tasks/:id/merge
// in JS — closing the browser tab killed the loop, the first conflict
// halted everything, and there was no way to surface progress. This
// module owns the loop server-side: a run iterates through every task
// the user wants to merge, calls the same merge logic /api/tasks/:id/merge
// uses, and emits events on a WS so the UI can render progress live.
//
// One active run per project; concurrent run-starts on the same project
// are rejected. Inside a run, each task acquires the per-task lock from
// mergeLocks.ts, so a manual /merge call landing during a run can't race.

import {
  mergeWorktreeInRepo,
  writeMergeInstructions,
  buildConflictResolveCommand,
  finalizeMergedTask,
} from './worktree.js';
import { getTask, listTasks, updateTask } from './tasks.js';
import { tryAcquire, release } from './mergeLocks.js';

export type MergeRunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'errored';

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
    }
  | { type: 'completed'; run: MergeRun }
  | { type: 'cancelled'; run: MergeRun };

const runs = new Map<string, MergeRun>();
const listeners = new Set<(ev: MergeRunEvent) => void>();

function snapshot(run: MergeRun): MergeRun {
  return {
    ...run,
    merged: [...run.merged],
    conflicted: [...run.conflicted],
    errored: run.errored.map((e) => ({ ...e })),
  };
}

function notify(ev: MergeRunEvent): void {
  for (const fn of listeners) fn(ev);
}

export function subscribe(fn: (ev: MergeRunEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getRun(id: string): MergeRun | null {
  const r = runs.get(id);
  return r ? snapshot(r) : null;
}

export function getActiveRunForProject(projectPath: string): MergeRun | null {
  for (const r of runs.values()) {
    if (r.projectPath === projectPath && r.status === 'running') {
      return snapshot(r);
    }
  }
  return null;
}

export function cancelRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status !== 'running') return false;
  run.cancelRequested = true;
  return true;
}

export async function startMergeRun(
  projectPath: string,
  backendOrigin: string,
): Promise<MergeRun> {
  for (const r of runs.values()) {
    if (r.projectPath === projectPath && r.status === 'running') {
      throw new Error('A merge run is already in progress for this project.');
    }
  }
  const tasks = await listTasks(projectPath);
  const targets = tasks
    .filter((t) => t.status === 'ready_to_merge' && !t.conflict)
    .sort((a, b) => a.createdAt - b.createdAt);

  const run: MergeRun = {
    id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    projectPath,
    status: 'running',
    startedAt: Date.now(),
    total: targets.length,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: [],
    cancelRequested: false,
  };
  runs.set(run.id, run);
  notify({ type: 'started', run: snapshot(run) });

  // Run the worker async. Fire-and-forget; consumers track via WS / GET.
  (async () => {
    for (const seed of targets) {
      if (run.cancelRequested) break;

      run.current = seed.id;
      notify({ type: 'progress', run: snapshot(run) });

      // Re-read the task so we see any state changes since the run started
      // (manual /merge, user dragging the card to a different lane, etc.).
      const task = await getTask(seed.id);
      if (!task) {
        run.errored.push({ taskId: seed.id, error: 'task disappeared' });
        run.processed += 1;
        continue;
      }
      if (task.status !== 'ready_to_merge') {
        // Someone moved it; skip silently.
        run.processed += 1;
        continue;
      }
      if (task.conflict) {
        // Already in conflict-resolution; skip and let resolver handle it.
        run.conflicted.push(task.id);
        run.processed += 1;
        continue;
      }
      if (!task.branch || !task.worktreePath) {
        run.errored.push({
          taskId: task.id,
          error: 'task has no worktree branch on record',
        });
        run.processed += 1;
        continue;
      }

      if (!tryAcquire(task.id)) {
        // Manual /merge or another run is touching this task; skip.
        run.errored.push({
          taskId: task.id,
          error: 'merge lock held by another caller; skipped',
        });
        run.processed += 1;
        continue;
      }

      try {
        const result = await mergeWorktreeInRepo(
          task.projectPath,
          task.branch,
          task.worktreePath,
        );
        if (result.status === 'clean') {
          const fin = await finalizeMergedTask(task);
          if (fin.ok) {
            run.merged.push(task.id);
          } else if ('stashConflict' in fin && fin.stashConflict) {
            run.errored.push({
              taskId: task.id,
              error: `stash-pop conflict on ${fin.stashConflict.length} file(s)`,
            });
          } else {
            run.errored.push({
              taskId: task.id,
              error: 'error' in fin ? fin.error : 'finalize failed',
            });
          }
        } else if (result.status === 'conflict') {
          const { relativePath } = await writeMergeInstructions(
            task,
            task.branch,
            result.conflictedFiles,
            backendOrigin,
            task.worktreePath,
          );
          await updateTask(task.id, {
            conflict: true,
            conflictStartedAt: Date.now(),
          });
          run.conflicted.push(task.id);
          notify({
            type: 'conflict',
            runId: run.id,
            projectPath,
            taskId: task.id,
            command: buildConflictResolveCommand(relativePath),
            cwd: task.worktreePath,
            conflictedFiles: result.conflictedFiles,
          });
        } else {
          run.errored.push({ taskId: task.id, error: result.message });
        }
      } catch (err) {
        run.errored.push({
          taskId: task.id,
          error: (err as Error).message ?? 'unknown error',
        });
      } finally {
        release(task.id);
      }

      run.processed += 1;
      run.current = undefined;
      notify({ type: 'progress', run: snapshot(run) });
    }

    run.status = run.cancelRequested ? 'cancelled' : 'completed';
    run.finishedAt = Date.now();
    run.current = undefined;
    notify({
      type: run.cancelRequested ? 'cancelled' : 'completed',
      run: snapshot(run),
    });
  })().catch((err) => {
    console.error('[mergeRuns] run worker crashed', err);
    run.status = 'errored';
    run.finishedAt = Date.now();
    notify({ type: 'completed', run: snapshot(run) });
  });

  return snapshot(run);
}
