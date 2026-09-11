import path from 'node:path';
import { listTasks, type Task } from '../tasks.js';
import {
  cleanupWorktreeForTask,
  gitDirExists,
  isUnderManagedWorktreesDir,
  parseWorktreesPorcelain,
  projectGit,
} from '../worktree.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { collectLiveSessionCwds, hasLiveSessionAtOrUnder, normalizeCwd } from './liveSessions.js';

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
export type WorktreeSweepDeps = {
  forEachKnownProjectSafely: typeof forEachKnownProjectSafely;
  listTasks: typeof listTasks;
  gitDirExists: typeof gitDirExists;
  projectGit: typeof projectGit;
  cleanupWorktreeForTask: typeof cleanupWorktreeForTask;
  collectLiveSessionCwds: typeof collectLiveSessionCwds;
};

const defaultDeps: WorktreeSweepDeps = {
  forEachKnownProjectSafely, listTasks, gitDirExists, projectGit,
  cleanupWorktreeForTask, collectLiveSessionCwds,
};

export async function sweepOrphanedWorktrees(deps: WorktreeSweepDeps = defaultDeps): Promise<void> {
  // Detached PTYs survive a backend restart. Without an authoritative session
  // inventory we cannot prove a worktree is abandoned, so defer reclamation.
  const liveCwds = await deps.collectLiveSessionCwds();
  if (liveCwds === null) {
    console.warn('[startup] worktree sweep: terminal-server unreachable — skipping reclamation');
    return;
  }
  await deps.forEachKnownProjectSafely('sweepOrphanedWorktrees', async (repoRoot) => {
    if (!(await deps.gitDirExists(repoRoot))) return; // project moved/deleted

    // A failed task read is NOT an empty task list. Let the per-project guard
    // report it and continue with other projects before any destructive work.
    const tasks = await deps.listTasks(repoRoot);
    // The store also preserves corrupt JSON and returns its empty default.
    // With zero records we cannot tell "all tasks were deleted" from "the
    // ownership database could not be recovered". Leave checkouts available
    // for manual recovery rather than force-removing potentially unique work.
    if (tasks.length === 0) {
      console.warn(`[startup] worktree sweep: no task ownership records for ${repoRoot} — skipping reclamation`);
      return;
    }
    const activeWorktreePaths = getActiveWorktreePaths(tasks);
    const wtList = await deps.projectGit(repoRoot, ['worktree', 'list', '--porcelain']);
    if (wtList.code !== 0) {
      console.warn(
        `[startup] sweep: 'git worktree list' in ${repoRoot} exit ${wtList.code}: ${wtList.stderr.trim()}`,
      );
      return;
    }
    const worktrees = parseWorktreesPorcelain(wtList.stdout);

    const repoResolved = normalizeCwd(repoRoot);
    let removed = 0;

    for (const wt of worktrees) {
      const resolved = path.resolve(wt.path);
      if (normalizeCwd(resolved) === repoResolved) continue; // the main worktree
      if (!isUnderManagedWorktreesDir(resolved, repoRoot)) continue; // not ours
      if (activeWorktreePaths.has(normalizeCwd(resolved))) continue; // a live task owns it
      if (hasLiveSessionAtOrUnder(liveCwds, resolved)) continue;

      const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : '';
      console.warn(
        `[startup] sweep: removing orphaned worktree ${resolved} ` +
          `(branch=${branch || 'detached'}) — no active task references it`,
      );
      try {
        // cleanupWorktreeForTask skips the branch delete for non-`lattice/`
        // names, so passing '' (detached) or a stray branch is safe.
        await deps.cleanupWorktreeForTask(repoRoot, resolved, branch);
        removed += 1;
      } catch (err) {
        console.error(`[startup] sweep: cleanup of ${resolved} failed:`, err);
      }
    }

    // Prune registrations whose dirs no longer exist (including any we
    // just removed, and any deleted out-of-band).
    await deps.projectGit(repoRoot, ['worktree', 'prune']).catch(() => undefined);
    if (removed > 0) {
      console.log(`[startup] sweep: reclaimed ${removed} orphaned worktree(s) in ${repoRoot}`);
    }
  });
}

function getActiveWorktreePaths(tasks: Task[]): Set<string> {
  return new Set(
    tasks
      .filter((t) => (ACTIVE_STATUSES.has(t.status) || t.runQueued) && t.worktreePath)
      .map((t) => normalizeCwd(t.worktreePath as string)),
  );
}
