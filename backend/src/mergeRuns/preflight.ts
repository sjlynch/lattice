import {
  backupProjectGitBundle,
  ensureLatticeRepoExclude,
  gitDirExists,
  projectGit,
  snapshotForRun,
  untrackOwnedFilesInRepo,
  type SnapshotHandle,
} from '../worktree.js';
import { backupTasksFile, listTasks } from '../tasks.js';
import { clearStaleGitLocks, describeBlockingLocks } from '../worktree/staleGitLocks.js';
import type { MergeRun } from './state.js';

export type RunPreflightResult = {
  runSnapshot: SnapshotHandle;
  baselineHead: string | null;
};

// The paths this run's fast-forwards can rewrite: the union of each
// Ready-to-Merge branch's own changes (`HEAD...branch`). A dirty path outside
// it is never touched by the run, and copying the whole dirty tree (~1 GB of a
// user's uncommitted art on 2026-09-23) on every run is what filled the disk.
// Any failure returns undefined → the full snapshot, as before. Each
// fast-forward also scopes its own snapshot, so this is not the only guard.
async function runStashScope(projectPath: string): Promise<string[] | undefined> {
  try {
    const branches = (await listTasks(projectPath))
      .filter((t) => t.status === 'ready_to_merge' && t.branch)
      .map((t) => t.branch as string);
    const union = new Set<string>();
    for (const branch of branches) {
      const r = await projectGit(projectPath, ['diff', '--name-only', '--no-renames', '-z', `HEAD...${branch}`]);
      if (r.code !== 0) return undefined;
      for (const p of r.stdout.split('\0')) if (p) union.add(p);
    }
    return [...union];
  } catch {
    return undefined;
  }
}

export async function runPreflight(
  projectPath: string,
  run: MergeRun,
): Promise<RunPreflightResult> {
  // Snapshot tasks.json before we start touching the repo. Cheap insurance
  // against the catastrophic-state class of failure where something during
  // the run wipes `.lattice/tasks.json`. Boot recovery restores from this
  // backup if the main file is missing on next start.
  try {
    await backupTasksFile(projectPath);
  } catch (err) {
    console.warn('[merge-run] tasks.json backup failed (continuing):', err);
  }

  // Pre-flight: a `git bundle --all` snapshot of the whole object graph
  // under ~/.lattice/git-backups/<hash>/. Doesn't prevent damage — the
  // layered guards do — but turns "catastrophe → re-clone, lose local
  // commits" into "fetch the bundle, lose nothing". Best-effort; a
  // failed backup must never block the run.
  try {
    const bundlePath = await backupProjectGitBundle(projectPath);
    if (bundlePath) console.log(`[merge-run] pre-run git bundle → ${bundlePath}`);
  } catch (err) {
    console.warn('[merge-run] pre-run git bundle backup failed (continuing):', err);
  }

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
  // An abandoned git lock (a git killed mid-command) would fail the
  // snapshot's resets and every fast-forward; clear it when provably stale.
  const locks = await clearStaleGitLocks(projectPath);
  if (locks.blocking.length > 0) {
    console.warn(`[merge-run] project repo has a git lock in place: ${describeBlockingLocks(locks.blocking)}`);
  }
  let runSnapshot: SnapshotHandle = { dir: '', modifiedTracked: [], untracked: [] };
  try {
    runSnapshot = await snapshotForRun(projectPath, await runStashScope(projectPath));
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

  // Circuit-breaker baseline: main's HEAD before any task. After each
  // task we re-check that `.git` is intact and HEAD only moved forward
  // (a merge run only fast-forwards main). On a violation we stop the
  // whole run rather than let task N+1 compound the damage.
  let baselineHead: string | null = null;
  try {
    if (await gitDirExists(projectPath)) {
      const r = await projectGit(projectPath, ['rev-parse', 'HEAD']);
      if (r.code === 0) baselineHead = r.stdout.trim() || null;
    } else {
      console.error(
        `[merge-run] !!! ${projectPath}/.git is missing before the run even started — aborting.`,
      );
      run.errored.push({ taskId: '(run)', error: '.git missing before run start' });
      run.cancelRequested = true;
    }
  } catch (err) {
    console.warn('[merge-run] could not read baseline HEAD (continuing without it):', err);
  }

  return { runSnapshot, baselineHead };
}
