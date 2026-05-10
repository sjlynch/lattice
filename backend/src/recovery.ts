// Crash-recovery sweep run on every backend boot.
//
// Detects ready_to_merge tasks whose branch no longer exists. This happens
// when finalizeMergedTask completed FF + cleanup but the server crashed
// before writing the qa status. The branch being gone is the reliable
// indicator: cleanup ran, so the task is already in main.

import path from 'node:path';
import {
  listReadyToMergeTasks,
  updateTaskCrashSafe,
  restoreAllProjectsFromBackup,
  listKnownProjects,
  listTasks,
  type Task,
} from './tasks.js';
import {
  checkBranchExists,
  recoverPendingSnapshots,
  gitDirExists,
  projectGit,
  parseWorktreesPorcelain,
  isUnderManagedWorktreesDir,
  cleanupWorktreeForTask,
} from './worktree.js';

// Tasks whose worktree we must not touch — they have a live (or
// resumable) Claude session pointed at it.
const ACTIVE_STATUSES = new Set(['in_progress', 'ready_to_merge']);

// For every known project, reconcile `git worktree list` against the live
// task set: any worktree git still tracks that (a) lives under a
// Lattice-managed worktrees directory, (b) is not the main worktree, and
// (c) is not referenced by an in_progress / ready_to_merge task is an
// orphan — left behind by a finalize whose background cleanup failed, a
// crashed run, or a pre-2026-05-10 in-project worktree. We tear it down
// via `cleanupWorktreeForTask` (which delegates the recursive delete to
// `git worktree remove --force` — no raw fs.rm) and prune stale
// registrations. This is what makes "leave the dir, retry at boot"
// (cleanup.ts) actually converge.
export async function sweepOrphanedWorktrees(): Promise<void> {
  let projects: string[];
  try {
    projects = await listKnownProjects();
  } catch (err) {
    console.error('[startup] sweepOrphanedWorktrees: could not list projects:', err);
    return;
  }
  for (const repoRoot of projects) {
    try {
      if (!(await gitDirExists(repoRoot))) continue; // project moved/deleted

      const wtList = await projectGit(repoRoot, ['worktree', 'list', '--porcelain']);
      if (wtList.code !== 0) {
        console.warn(
          `[startup] sweep: 'git worktree list' in ${repoRoot} exit ${wtList.code}: ${wtList.stderr.trim()}`,
        );
        continue;
      }
      const worktrees = parseWorktreesPorcelain(wtList.stdout);

      let tasks: Task[];
      try {
        tasks = await listTasks(repoRoot);
      } catch {
        tasks = [];
      }
      const activeWorktreePaths = new Set(
        tasks
          .filter((t) => ACTIVE_STATUSES.has(t.status) && t.worktreePath)
          .map((t) => path.resolve(t.worktreePath as string)),
      );

      const repoResolved = path.resolve(repoRoot);
      let removed = 0;
      for (const wt of worktrees) {
        const resolved = path.resolve(wt.path);
        if (resolved === repoResolved) continue; // the main worktree
        if (!isUnderManagedWorktreesDir(resolved, repoRoot)) continue; // not ours
        if (activeWorktreePaths.has(resolved)) continue; // a live task owns it

        const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : '';
        console.warn(
          `[startup] sweep: removing orphaned worktree ${resolved} ` +
            `(branch=${branch || 'detached'}) — no active task references it`,
        );
        try {
          // cleanupWorktreeForTask skips the branch delete for non-`lattice/`
          // names, so passing '' (detached) or a stray branch is safe.
          await cleanupWorktreeForTask(repoRoot, resolved, branch);
          removed += 1;
        } catch (err) {
          console.error(`[startup] sweep: cleanup of ${resolved} failed:`, err);
        }
      }
      // Prune registrations whose dirs no longer exist (including any we
      // just removed, and any deleted out-of-band).
      await projectGit(repoRoot, ['worktree', 'prune']).catch(() => undefined);
      if (removed > 0) {
        console.log(`[startup] sweep: reclaimed ${removed} orphaned worktree(s) in ${repoRoot}`);
      }
    } catch (err) {
      console.error(`[startup] sweepOrphanedWorktrees: ${repoRoot} failed:`, err);
    }
  }
}

export async function recoverOrphanedTasks(): Promise<void> {
  // Phase 1: repair `.lattice/tasks.json` from `.lattice/tasks.backup.json`
  // for any project where the main file went missing or unparseable. Must
  // run BEFORE any tasks.ts read so the cache is populated from the
  // restored file. Logs loudly per project that gets restored.
  try {
    await restoreAllProjectsFromBackup();
  } catch (err) {
    console.error('[startup] restoreAllProjectsFromBackup failed:', err);
  }

  // Phase 1b: scan ~/.lattice/snapshots/ for any orphan snapshots from a
  // crashed run and restore them into their original repos. Replaces the
  // prior `git stash` based recovery (which depended on the stash entry
  // surviving across restarts — failure-prone, see snapshot.ts header).
  try {
    await recoverPendingSnapshots();
  } catch (err) {
    console.error('[startup] recoverPendingSnapshots failed:', err);
  }

  // Phase 1c: reclaim orphaned worktrees (failed background cleanups,
  // crashed runs, legacy in-project worktrees). cleanup.ts deliberately
  // leaves a worktree dir in place when `git worktree remove` fails
  // mid-run; this is the retry that makes it converge.
  try {
    await sweepOrphanedWorktrees();
  } catch (err) {
    console.error('[startup] sweepOrphanedWorktrees failed:', err);
  }

  try {
    const stuckTasks = await listReadyToMergeTasks();
    for (const task of stuckTasks) {
      if (!task.branch) continue;
      const exists = await checkBranchExists(task.projectPath, task.branch);
      if (!exists) {
        console.log(
          `[startup] task ${task.id} ("${task.title.slice(0, 40)}") branch deleted but status is ready_to_merge — recovering to qa`,
        );
        await updateTaskCrashSafe(task.id, {
          status: 'qa',
          mergedAt: task.mergedAt ?? Date.now(),
          worktreePath: undefined,
          branch: undefined,
          conflict: undefined,
          conflictStartedAt: undefined,
        });
      }
    }
  } catch (err) {
    console.error('[startup] recoverOrphanedTasks failed:', err);
  }
}
