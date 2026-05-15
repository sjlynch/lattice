import { projectGit } from '../projectGit.js';
import { assertGitDirIntact } from '../state.js';
import { LATTICE_OWNED_FILE_PATHS } from '../managedFiles.js';

// `git rm --cached` any Lattice-owned file that's still tracked in `repoRoot`,
// then commit the cleanup so it propagates when branches merge. Files stay
// on disk (rm --cached only touches the index). Idempotent: skips files
// that aren't tracked, and skips the commit if the index is unchanged.
//
// Called at:
//   - setupTaskWorktree (per-worktree create) — heals projects on first use
//   - startMergeRun (pre-flight)              — heals before main absorbs branches
//   - /api/tasks/:id/merge (manual merge)     — heals before a one-off merge
//
// Aborts (no-op) if the working tree has uncommitted changes — a commit
// here would entangle Lattice's cleanup with whatever the user is editing.
// The auto-resolve path at merge time still handles the conflict case.
export async function untrackOwnedFilesInRepo(repoRoot: string): Promise<void> {
  // Bail before any git work if .git is missing. Other callers in the
  // merge pipeline already guard at their level, but this function is
  // also called directly from /merge and the run pre-flight, so we guard
  // here too.
  await assertGitDirIntact(repoRoot);
  const tracked: string[] = [];
  for (const f of LATTICE_OWNED_FILE_PATHS) {
    const ls = await projectGit(repoRoot, ['ls-files', '--error-unmatch', f]);
    if (ls.code === 0 && ls.stdout.trim()) tracked.push(f);
  }
  if (tracked.length === 0) return;

  const status = await projectGit(repoRoot, ['status', '--porcelain']);
  if (status.code !== 0) {
    console.warn(`[worktree] untrack: git status failed in ${repoRoot}`);
    return;
  }
  // Tolerate the working tree containing only Lattice-owned files (e.g. a
  // freshly-installed Stop hook). Anything else means real user state we
  // shouldn't bundle into a Lattice-auto commit.
  const dirtyOther = status.stdout
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .filter((p) => !(LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(p));
  if (dirtyOther.length > 0) {
    console.log(
      `[worktree] skipping untrack of [${tracked.join(', ')}] in ${repoRoot} ` +
        `— working tree has unrelated changes (${dirtyOther.slice(0, 3).join(', ')}${dirtyOther.length > 3 ? ', …' : ''})`,
    );
    return;
  }

  const rm = await projectGit(repoRoot, ['rm', '--cached', '--quiet', ...tracked]);
  if (rm.code !== 0) {
    console.warn(
      `[worktree] git rm --cached failed in ${repoRoot}: ${rm.stderr.trim()}`,
    );
    return;
  }
  const commit = await projectGit(repoRoot, [
    'commit',
    '-m',
    `Untrack Lattice-managed files [lattice-auto]\n\n${tracked.map((f) => `- ${f}`).join('\n')}`,
  ]);
  if (commit.code !== 0) {
    // No commit usually means the index ended up unchanged (race with
    // another process). Reset the index to keep state coherent.
    console.warn(
      `[worktree] commit after rm --cached failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    );
    await projectGit(repoRoot, ['reset', 'HEAD', '--', ...tracked]);
    return;
  }
  console.log(
    `[worktree] untracked Lattice-owned file(s) from ${repoRoot}: ${tracked.join(', ')}`,
  );
}
