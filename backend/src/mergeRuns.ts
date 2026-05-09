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
  snapshotForRun,
  restoreSnapshot,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
  isMidMerge,
  RUN_STASH_LABEL,
  type SnapshotHandle,
} from './worktree.js';
import { listConflictedFiles } from './worktree/state.js';
import { getTask, listTasks, updateTask, backupTasksFile } from './tasks.js';
import { tryAcquire, release } from './mergeLocks.js';
import { proxyCreateSession } from './terminalProxy.js';
import { canonicalProjectPath } from './projectPath.js';

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
      serverId?: string;
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
  const key = canonicalProjectPath(projectPath);
  for (const r of runs.values()) {
    if (r.projectPath === key && r.status === 'running') {
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
  projectPath = canonicalProjectPath(projectPath);
  for (const r of runs.values()) {
    if (r.projectPath === projectPath && r.status === 'running') {
      throw new Error('A merge run is already in progress for this project.');
    }
  }
  const tasks = await listTasks(projectPath);
  // Include conflict-flagged tasks too — the per-task loop knows how to
  // re-attempt them (resolver Claude may have already finished and
  // committed; Lattice just needs to re-sync and finalize). The old
  // `&& !t.conflict` filter stranded conflict tasks across server
  // restarts: a "merge all" click would skip them entirely.
  const targets = tasks
    .filter((t) => t.status === 'ready_to_merge')
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

  // Snapshot tasks.json before we start touching the repo. Cheap insurance
  // against the catastrophic-state class of failure where something during
  // the run wipes `.lattice/tasks.json`. Boot recovery restores from this
  // backup if the main file is missing on next start.
  try {
    await backupTasksFile(projectPath);
  } catch (err) {
    console.warn('[merge-run] tasks.json backup failed (continuing):', err);
  }

  // Run the worker async. Fire-and-forget; consumers track via WS / GET.
  (async () => {
    console.log(`[merge-run] ${run.id} started — ${targets.length} task(s) to merge`);

    // Pre-flight: heal the project's tracking of Lattice-owned files
    // BEFORE stashing. If `.claude/settings.local.json` is tracked in main,
    // every per-task merge will conflict on it; untrack it now (idempotent
    // no-op if already clean) so the run starts from a known-good state.
    //
    // We deliberately do NOT call ensureLatticeGitignore here. Modifying
    // the tracked .gitignore mid-run dirties the working tree, and prior
    // catastrophic-state incidents (2026-05-08, 2026-05-09) had a
    // fingerprint consistent with a stash that included a modified-or-
    // untracked .gitignore being lost — taking `.lattice/` un-ignored
    // status (and downstream `.lattice/tasks.json`, `.git/`, etc.) with
    // it. The .gitignore is already added once per project at
    // setupTaskWorktree time, so re-applying it here is also redundant.
    // ensureLatticeRepoExclude writes to .git/info/exclude (gitdir-only,
    // never stashed) and is what actually keeps `.lattice/` ignored
    // during a run.
    try {
      await ensureLatticeRepoExclude(projectPath);
      await untrackOwnedFilesInRepo(projectPath);
    } catch (err) {
      console.warn('[merge-run] pre-flight untrack failed (continuing):', err);
    }

    // Pre-flight: snapshot the working tree once so every per-task
    // fastForwardMain call sees a clean tree. The snapshot is a copy on
    // disk under ~/.lattice/snapshots/<projectHash>/, NOT a `git stash`,
    // so a server crash can't silently delete the captured paths (the
    // failure mode behind the 2026-05-08/09 .git deletion incidents).
    // recoverPendingSnapshots in startup recovery picks up any orphan
    // snapshot dirs from a crashed run and restores them automatically.
    let runSnapshot: SnapshotHandle = { dir: '', modifiedTracked: [], untracked: [] };
    try {
      runSnapshot = await snapshotForRun(projectPath);
      if (runSnapshot.dir) {
        console.log(
          `[merge-run] snapshotted working-tree changes ` +
            `(${runSnapshot.modifiedTracked.length} modified, ` +
            `${runSnapshot.untracked.length} untracked) → ${runSnapshot.dir}`,
        );
      }
    } catch (err) {
      console.warn('[merge-run] pre-flight snapshot failed (continuing):', err);
    }
    for (const seed of targets) {
      if (run.cancelRequested) break;

      run.current = seed.id;
      notify({ type: 'progress', run: snapshot(run) });

      // Re-read the task so we see any state changes since the run started
      // (manual /merge, user dragging the card to a different lane, etc.).
      const task = await getTask(seed.id);
      if (!task) {
        console.warn(`[merge-run] task ${seed.id} disappeared — skipping`);
        run.errored.push({ taskId: seed.id, error: 'task disappeared' });
        run.processed += 1;
        continue;
      }
      console.log(`[merge-run] processing "${task.title.slice(0, 50)}" (${task.id})`);
      if (task.status !== 'ready_to_merge') {
        console.log(`[merge-run] task ${task.id} is ${task.status} — skipping`);
        run.processed += 1;
        continue;
      }
      if (!task.branch || !task.worktreePath) {
        console.warn(`[merge-run] task ${task.id} has no branch/worktree — skipping`);
        run.errored.push({
          taskId: task.id,
          error: 'task has no worktree branch on record',
        });
        run.processed += 1;
        continue;
      }

      // Already-flagged conflict: two cases.
      //   - Worktree is mid-merge (resolver Claude died, server restarted,
      //     or user closed the tab before resolution). Re-spawn the
      //     resolver session and re-emit the conflict event.
      //   - Worktree is NOT mid-merge (resolver finished and committed,
      //     but finalize was interrupted — e.g. server restart, FF race).
      //     Fall through and let mergeWorktreeInRepo detect the merge is
      //     already done; the path returns `clean` and we finalize.
      // Old behavior was a flat skip, which left conflict tasks stranded
      // forever once the run loop exited.
      if (task.conflict) {
        if (await isMidMerge(task.worktreePath)) {
          console.log(`[merge-run] task ${task.id} mid-merge — re-spawning resolver`);
          try {
            const conflictedFiles = await listConflictedFiles(task.worktreePath);
            const { relativePath } = await writeMergeInstructions(
              task,
              task.branch,
              conflictedFiles,
              backendOrigin,
              task.worktreePath,
            );
            const command = buildConflictResolveCommand(relativePath);
            const sess = await proxyCreateSession({
              cwd: task.worktreePath,
              initialCommand: command,
              projectPath: task.projectPath,
            });
            run.conflicted.push(task.id);
            notify({
              type: 'conflict',
              runId: run.id,
              projectPath,
              taskId: task.id,
              command,
              cwd: task.worktreePath,
              conflictedFiles,
              serverId: 'id' in sess ? sess.id : undefined,
            });
          } catch (err) {
            console.error(`[merge-run] re-spawn for ${task.id} failed:`, err);
            run.errored.push({
              taskId: task.id,
              error: `re-spawn resolver failed: ${(err as Error).message}`,
            });
          }
          run.processed += 1;
          continue;
        }
        console.log(
          `[merge-run] task ${task.id} flagged conflict but worktree is clean — re-syncing`,
        );
      }

      if (!tryAcquire(task.id)) {
        console.warn(`[merge-run] task ${task.id} lock held — skipping`);
        run.errored.push({
          taskId: task.id,
          error: 'merge lock held by another caller; skipped',
        });
        run.processed += 1;
        continue;
      }

      try {
        console.log(`[merge-run] merging worktree for ${task.id} (branch=${task.branch})`);
        const result = await mergeWorktreeInRepo(
          task.projectPath,
          task.branch,
          task.worktreePath,
          task.id,
          backendOrigin,
          task.title,
        );
        console.log(`[merge-run] mergeWorktreeInRepo → ${result.status}${result.status === 'conflict' ? ` (${result.conflictedFiles?.join(', ')})` : result.status === 'error' ? `: ${result.message}` : ''}`);
        if (result.status === 'clean') {
          console.log(`[merge-run] finalizing task ${task.id}...`);
          const fin = await finalizeMergedTask(task, backendOrigin);
          console.log(`[merge-run] finalize → ${fin.ok ? 'ok' : ('stashConflict' in fin ? `stash-conflict (${fin.stashConflict.join(', ')})` : `error: ${'error' in fin ? fin.error : '?'}`)}`);
          if (fin.ok) {
            run.merged.push(task.id);
          } else if ('stashConflict' in fin) {
            run.conflicted.push(task.id);
            const sess = await proxyCreateSession({
              cwd: fin.cwd,
              initialCommand: fin.resolveCommand,
              projectPath: task.projectPath,
            });
            notify({
              type: 'conflict',
              runId: run.id,
              projectPath,
              taskId: task.id,
              command: fin.resolveCommand,
              cwd: fin.cwd,
              conflictedFiles: fin.stashConflict,
              serverId: 'id' in sess ? sess.id : undefined,
            });
            // Stop the run — subsequent tasks can't FF until the stash conflict
            // is resolved. /stash-resolved will auto-restart the run.
            run.cancelRequested = true;
          } else {
            run.errored.push({
              taskId: task.id,
              error: 'error' in fin ? fin.error : 'finalize failed',
            });
          }
        } else if (result.status === 'conflict') {
          console.log(`[merge-run] writing merge instructions for ${task.id}`);
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
          const command = buildConflictResolveCommand(relativePath);
          const sess = await proxyCreateSession({
            cwd: task.worktreePath,
            initialCommand: command,
            projectPath: task.projectPath,
          });
          notify({
            type: 'conflict',
            runId: run.id,
            projectPath,
            taskId: task.id,
            command,
            cwd: task.worktreePath,
            conflictedFiles: result.conflictedFiles,
            serverId: 'id' in sess ? sess.id : undefined,
          });
        } else {
          run.errored.push({ taskId: task.id, error: result.message });
        }
      } catch (err) {
        console.error(`[merge-run] uncaught error for task ${task.id}:`, err);
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
      console.log(`[merge-run] progress: ${run.processed}/${run.total} (merged=${run.merged.length} conflicts=${run.conflicted.length} errors=${run.errored.length})`);
    }

    // Post-run snapshot restore. Only when the loop ran to completion
    // (not on cancel) — a cancelled run leaves the snapshot in place so
    // the user's mods aren't blasted with whatever partial state the FFs
    // left. The snapshot dir survives across server restarts and
    // recoverPendingSnapshots will restore it on next boot.
    //
    // Unlike the prior stash-based path, restore here can never produce a
    // "conflict" outcome — copy-based restore is last-writer-wins on
    // overlap. Conservative: the user's snapshotted files always win
    // over whatever the FF brought in. Worst case is a dirty working
    // tree the user can review with `git status` / `git diff`.
    if (runSnapshot.dir && !run.cancelRequested) {
      console.log(`[merge-run] restoring run snapshot → ${runSnapshot.dir}`);
      try {
        await restoreSnapshot(runSnapshot, projectPath);
        console.log(`[merge-run] snapshot restored`);
      } catch (err) {
        console.warn('[merge-run] post-run snapshot restore failed (continuing):', err);
      }
    }

    // If tasks became ready_to_merge while this run was processing its
    // snapshot, they were never in `targets` and are still waiting. Auto-
    // restart so they get picked up without requiring a manual merge-all click.
    if (!run.cancelRequested) {
      try {
        const allTasks = await listTasks(projectPath);
        const seenIds = new Set(targets.map((t) => t.id));
        const newReady = allTasks.filter(
          (t) => t.status === 'ready_to_merge' && !t.conflict && !seenIds.has(t.id),
        );
        if (newReady.length > 0) {
          console.log(
            `[merge-run] ${newReady.length} task(s) became ready_to_merge during this run — auto-restarting`,
          );
          startMergeRun(projectPath, backendOrigin).catch(() => {});
        }
      } catch {
        // best-effort; failure just means the user sees the remaining tasks
        // at ready_to_merge and can trigger merge-all manually
      }
    }

    finishRun(run);
  })().catch((err) => {
    console.error('[mergeRuns] run worker crashed', err);
    run.status = 'errored';
    run.finishedAt = Date.now();
    notify({ type: 'completed', run: snapshot(run) });
  });

  return snapshot(run);
}

function finishRun(run: MergeRun): void {
  run.status = run.cancelRequested ? 'cancelled' : 'completed';
  run.finishedAt = Date.now();
  run.current = undefined;
  console.log(`[merge-run] ${run.id} ${run.status} — merged=${run.merged.length} conflicts=${run.conflicted.length} errors=${run.errored.length}`);
  if (run.errored.length > 0) {
    for (const e of run.errored) console.error(`[merge-run] error on ${e.taskId}: ${e.error}`);
  }
  notify({
    type: run.cancelRequested ? 'cancelled' : 'completed',
    run: snapshot(run),
  });
}

// Called by /api/merge-runs/:id/stash-resolved after Claude resolves the
// post-run stash-pop conflict. Marks the run completed and notifies clients.
export function completeRunAfterStashResolution(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status !== 'running') return false;
  console.log(`[merge-run] ${id} completing after stash resolution`);
  finishRun(run);
  return true;
}
