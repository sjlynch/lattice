// Stash helpers used during merge/finalize:
//   - per-task fastForwardMain auto-stashes any dirty working tree, fast-forwards
//     main, then pops the stash back. Eliminates conflict markers from main's
//     working files when the user has uncommitted edits.
//   - per-run stash (RUN_STASH_LABEL) snapshots the working tree once at run
//     start so each per-task FF sees a clean tree and never needs its own stash.

import { exec } from './exec.js';
import { resolveOwnedFileConflicts } from './conflictResolve.js';

// Stash label used for the run-level pre-flight stash. Fixed so that a
// stash created by one run can be found and popped by a subsequent run
// (e.g. after an auto-restart following a worktree conflict).
export const RUN_STASH_LABEL = 'lattice-run-stash';

export function autoStashMessage(branchName: string): string {
  return `lattice-auto-${branchName}`;
}

// Stash the working tree once before a merge run so per-task
// fastForwardMain calls never need to stash (they see a clean tree).
// Returns true if a stash was created.
export async function stashForRun(repoRoot: string): Promise<boolean> {
  const status = await exec('git', ['status', '--porcelain'], repoRoot);
  if (status.code !== 0 || !status.stdout.trim()) return false;
  const stash = await exec(
    'git',
    ['stash', 'push', '--include-untracked', '-m', RUN_STASH_LABEL],
    repoRoot,
  );
  return stash.code === 0;
}

// Pop a stash by its message label. The stash list is searched for an entry
// whose subject matches and that entry is popped explicitly (not blindly
// `stash@{0}`) so a concurrent stash by the user doesn't get clobbered.
export async function popStashByMessage(
  repoRoot: string,
  message: string,
): Promise<
  | { kind: 'clean' }
  | { kind: 'conflict'; conflictedFiles: string[] }
  | { kind: 'error'; message: string }
> {
  const list = await exec('git', ['stash', 'list'], repoRoot);
  if (list.code !== 0) {
    return {
      kind: 'error',
      message: list.stderr.trim() || 'git stash list failed',
    };
  }
  let ref: string | undefined;
  for (const line of list.stdout.split(/\r?\n/)) {
    if (!line.includes(message)) continue;
    const m = line.match(/^stash@\{\d+\}/);
    if (m) {
      ref = m[0];
      break;
    }
  }
  if (!ref) {
    // Stash already gone (someone popped it manually) — treat as clean.
    return { kind: 'clean' };
  }
  const pop = await exec('git', ['stash', 'pop', ref], repoRoot);
  if (pop.code === 0) {
    return { kind: 'clean' };
  }
  // Pop conflict: git leaves the stash in the list and writes conflict markers.
  // Auto-resolve any Lattice-owned files (the worktree's version always
  // wins). If only owned files conflicted, drop the stash and report
  // clean — no resolver Claude needed.
  const { resolved, remaining } = await resolveOwnedFileConflicts(repoRoot, 'stash');
  if (resolved.length > 0) {
    console.log(
      `[stash] auto-resolved ${resolved.length} owned file(s) in stash-pop: ${resolved.join(', ')}`,
    );
  }
  if (remaining.length === 0) {
    // Stash-pop leaves the stash in the list when it conflicts; drop it
    // explicitly now that all conflicts are cleared.
    const drop = await exec('git', ['stash', 'drop', ref], repoRoot);
    if (drop.code !== 0) {
      console.warn(
        `[stash] auto-resolve drop failed (${ref}): ${drop.stderr.trim() || drop.stdout.trim()}`,
      );
    }
    return { kind: 'clean' };
  }
  return { kind: 'conflict', conflictedFiles: remaining };
}
