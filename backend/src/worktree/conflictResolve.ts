// Auto-resolve merge / stash-pop conflicts on Lattice-owned files.
//
// Why this exists: the per-worktree `.claude/settings.local.json` Stop
// hook embeds a task-specific URL. If two branches end up with the file
// tracked, every cross-branch merge conflicts on it — and the conflict
// markers IN the JSON break the resolver Claude's bootstrap (Claude
// reads .claude/settings.local.json at startup; malformed JSON triggers
// a "Settings Error" prompt before the user prompt is processed).
//
// "Resolve to ours" is always correct for Lattice-owned files:
//   - .claude/settings.local.json → the worktree's own task ID is the
//     one whose Stop hook needs to fire on session end.
//   - LATTICE_TASK.md / MERGE_INSTRUCTIONS.md / STASH_CONFLICT_*.md →
//     these are written for THIS task/run; whatever was on the other
//     side is from a different task/run and is no longer relevant.
//
// Lives in its own module to break a cycle (merge.ts ↔ stash.ts both
// need it).

import { exec } from './exec.js';
import { listConflictedFiles } from './state.js';
import {
  isLatticeOwnedConflictPath,
  LATTICE_OWNED_FILE_PATHS,
} from './managedFiles.js';

// `git merge` runs a pre-flight check BEFORE attempting the merge: if a
// file is tracked in HEAD, modified in the working tree, AND the merge
// would touch it, git aborts with:
//
//   error: Your local changes to the following files would be
//   overwritten by merge: <file>
//   Please commit your changes or stash them before you merge.
//   Aborting
//
// This fires before any conflict markers are written, so Layer 2 auto-
// resolve doesn't get a chance. The classic case: a worktree was
// created from a base where `.claude/settings.local.json` was tracked,
// installStopHook wrote a per-task version into it (a "modification"
// against HEAD), and now main has an untrack commit deleting it — the
// merge would have to remove the working-tree file, but the working-
// tree file has uncommitted modifications relative to the index.
//
// Resetting the working-tree copy to HEAD's version eliminates the
// "modified" status. The merge proceeds and any resulting modify/delete
// conflict is then handled by resolveOwnedFileConflicts. The per-task
// content is restored post-merge by re-running installStopHook (the
// caller's responsibility — the file is task-specific).
export async function resetOwnedFileLocalChanges(
  worktreePath: string,
): Promise<string[]> {
  const reset: string[] = [];
  for (const file of LATTICE_OWNED_FILE_PATHS) {
    // Only act when the file is tracked. Untracked owned files are
    // either covered by .git/info/exclude (so git won't touch them) or
    // shelved separately by mergeWorktreeInRepo.
    const ls = await exec(
      'git',
      ['ls-files', '--error-unmatch', file],
      worktreePath,
    );
    if (ls.code !== 0) continue;
    // Skip if the working-tree copy already matches HEAD — `git checkout`
    // would still succeed but the work is wasted.
    const diff = await exec(
      'git',
      ['diff', '--quiet', '--', file],
      worktreePath,
    );
    if (diff.code === 0) continue;
    const co = await exec(
      'git',
      ['checkout', 'HEAD', '--', file],
      worktreePath,
    );
    if (co.code !== 0) {
      console.warn(
        `[pre-merge] reset of ${file} failed: ${co.stderr.trim() || co.stdout.trim()}`,
      );
      continue;
    }
    reset.push(file);
  }
  return reset;
}

export type ResolveMode = 'merge' | 'stash';

export async function resolveOwnedFileConflicts(
  repoOrWorktreePath: string,
  mode: ResolveMode,
): Promise<{ resolved: string[]; remaining: string[] }> {
  const conflicted = await listConflictedFiles(repoOrWorktreePath);
  const resolved: string[] = [];
  const remaining: string[] = [];
  for (const file of conflicted) {
    if (!isLatticeOwnedConflictPath(file)) {
      remaining.push(file);
      continue;
    }
    // `git checkout --ours -- <file>` writes stage-2 (ours) to the index
    // and working tree, clearing the U-U conflict entry.
    const co = await exec(
      'git',
      ['checkout', '--ours', '--', file],
      repoOrWorktreePath,
    );
    if (co.code !== 0) {
      console.warn(
        `[auto-resolve] 'git checkout --ours -- ${file}' failed: ${co.stderr.trim()}`,
      );
      remaining.push(file);
      continue;
    }
    if (mode === 'merge') {
      // Stage as a deletion so the merge commit removes the file from
      // tracking. The working tree keeps the file (the Stop hook /
      // instructions still need to be readable by the resolver Claude).
      const rm = await exec(
        'git',
        ['rm', '--cached', '--quiet', '--', file],
        repoOrWorktreePath,
      );
      if (rm.code !== 0) {
        console.warn(
          `[auto-resolve] 'git rm --cached -- ${file}' failed: ${rm.stderr.trim()}`,
        );
        // Fall back to `git add` so the file is at least marked resolved
        // and the merge commit can proceed.
        await exec('git', ['add', '--', file], repoOrWorktreePath);
      }
    }
    resolved.push(file);
  }
  return { resolved, remaining };
}
