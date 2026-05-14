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
  await forEachKnownProjectSafely('sweepOrphanedWorktrees', async (repoRoot) => {
    if (!(await gitDirExists(repoRoot))) return; // project moved/deleted

    const wtList = await projectGit(repoRoot, ['worktree', 'list', '--porcelain']);
    if (wtList.code !== 0) {
      console.warn(
        `[startup] sweep: 'git worktree list' in ${repoRoot} exit ${wtList.code}: ${wtList.stderr.trim()}`,
      );
      return;
    }
    const worktrees = parseWorktreesPorcelain(wtList.stdout);

    const activeWorktreePaths = await getActiveWorktreePaths(repoRoot);
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
  });
}

async function getActiveWorktreePaths(repoRoot: string): Promise<Set<string>> {
  let tasks: Task[];
  try {
    tasks = await listTasks(repoRoot);
  } catch {
    tasks = [];
  }

  return new Set(
    tasks
      .filter((t) => ACTIVE_STATUSES.has(t.status) && t.worktreePath)
      .map((t) => path.resolve(t.worktreePath as string)),
  );
}
