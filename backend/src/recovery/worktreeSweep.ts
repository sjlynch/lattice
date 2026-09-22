import path from 'node:path';
import { listTasks, type Task } from '../tasks.js';
import {
  cleanupWorktreeForTask,
  gitDirExists,
  isUnderManagedWorktreesDir,
  parseWorktreesPorcelain,
  projectGit,
} from '../worktree.js';
import { archiveUncommittedWorktreeChanges } from '../worktree/discardArchive.js';
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
// `git worktree remove --force` — no raw fs.rm) and remove only their exact
// registrations. This is what makes "leave the dir, retry at boot"
// (cleanup.ts) actually converge.
export type WorktreeSweepDeps = {
  forEachKnownProjectSafely: typeof forEachKnownProjectSafely;
  listTasks: typeof listTasks;
  gitDirExists: typeof gitDirExists;
  projectGit: typeof projectGit;
  cleanupWorktreeForTask: typeof cleanupWorktreeForTask;
  collectLiveSessionCwds: typeof collectLiveSessionCwds;
  // Optional so hand-built test deps keep compiling; defaults to the real one.
  archiveUncommitted?: typeof archiveUncommittedWorktreeChanges;
};

const defaultDeps: WorktreeSweepDeps = {
  forEachKnownProjectSafely, listTasks, gitDirExists, projectGit,
  cleanupWorktreeForTask, collectLiveSessionCwds,
  archiveUncommitted: archiveUncommittedWorktreeChanges,
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
    const wtList = await deps.projectGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
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
      if (wt.locked) continue; // explicit Git lock preserves even an absent checkout
      if (activeWorktreePaths.has(normalizeCwd(resolved))) continue; // a live task owns it
      if (hasLiveSessionAtOrUnder(liveCwds, resolved)) continue;

      const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : '';
      // An orphan with real unmerged commits on its branch (a task moved back
      // to Open from in_progress / ready_to_merge, a deleted task record) must
      // not be reclaimed: cleanup deletes the branch, and that is the only
      // copy of the work. Only a count of 0 (or a non-lattice branch, which
      // cleanup never deletes) is safe to sweep.
      if (branch.startsWith('lattice/')) {
        const unmerged = await deps.projectGit(repoRoot, ['rev-list', '--count', `HEAD..${wt.branch}`]);
        const count = unmerged.code === 0 ? parseInt(unmerged.stdout.trim(), 10) : NaN;
        if (!Number.isFinite(count) || count > 0) {
          console.error(
            `[startup] sweep: NOT reclaiming ${resolved} — branch ${branch} ` +
              (Number.isFinite(count)
                ? `has ${count} unmerged commit(s)`
                : `unmerged-commit count failed (exit ${unmerged.code}): ${unmerged.stderr.trim()}`) +
              '; merge or delete the branch by hand if the work is no longer wanted',
          );
          continue;
        }
      }
      // `worktree remove --force` would also silently discard uncommitted
      // edits. Archive them to ~/.lattice/snapshots/ (a keep-for-the-user
      // copy that boot recovery never auto-restores); if that fails, the
      // orphan is left in place for the next boot or a human.
      const archive = deps.archiveUncommitted ?? archiveUncommittedWorktreeChanges;
      const archived = await archive(repoRoot, resolved, branch);
      if (archived.status === 'failed') {
        console.error(
          `[startup] sweep: NOT reclaiming ${resolved} — could not archive its uncommitted changes ` +
            `(${archived.error}); leaving the checkout in place`,
        );
        continue;
      }
      if (archived.status === 'archived') {
        console.warn(`[startup] sweep: archived ${archived.files} uncommitted change(s) from ${resolved} to ${archived.dir}`);
      }
      console.warn(
        `[startup] sweep: removing orphaned worktree ${resolved} ` +
          `(branch=${branch || 'detached'}) — no active task references it`,
      );
      try {
        // cleanupWorktreeForTask skips the branch delete for non-`lattice/`
        // names, so passing '' (detached) or a stray branch is safe.
        // Already archived above — don't take a second, identical archive.
        if (await deps.cleanupWorktreeForTask(repoRoot, resolved, branch, undefined, { skipArchive: true })) {
          removed += 1;
        }
      } catch (err) {
        console.error(`[startup] sweep: cleanup of ${resolved} failed:`, err);
      }
    }

    // Exact cleanup handles missing orphan directories too. Do not globally
    // prune: active or user-managed checkouts may just be temporarily offline.
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
