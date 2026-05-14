import { exec } from '../exec.js';
import { resolveOwnedFileConflicts } from '../conflictResolve.js';
import { untrackOwnedFilesPostMerge } from '../mergeOwnedFiles.js';
import { installStopHook } from '../setup.js';
import type { MergeOutcome } from '../merge.js';

export async function handleMergeConflict(
  worktreePath: string,
  mergeMessage: string,
  conflictedFiles: string[] | undefined,
  taskId: string,
  backendOrigin: string,
): Promise<MergeOutcome> {
  // Auto-resolve any Lattice-owned files in the conflict set. If they
  // were the only conflicts, complete the merge ourselves and report
  // `clean` so the caller can finalize without spawning a resolver
  // Claude (which would have been bootstrapped against a malformed
  // .claude/settings.local.json full of conflict markers).
  const { resolved, remaining } = await resolveOwnedFileConflicts(
    worktreePath,
    'merge',
    conflictedFiles,
  );
  if (resolved.length > 0) {
    console.log(
      `[merge] auto-resolved ${resolved.length} owned file(s) in ${worktreePath}: ${resolved.join(', ')}`,
    );
  }
  if (remaining.length === 0) {
    const commit = await exec(
      'git',
      [
        'commit',
        '--no-edit',
        '-m',
        `${mergeMessage}\n\n[lattice-auto] auto-resolved owned files: ${resolved.join(', ')}`,
      ],
      worktreePath,
    );
    if (commit.code !== 0) {
      return {
        status: 'error',
        message: `Auto-resolve commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`.slice(0, 500),
      };
    }
    // Same post-clean cleanup as the all-clean path: drop any tracked
    // managed files (LATTICE_TASK.md etc.) the merge brought in.
    await untrackOwnedFilesPostMerge(worktreePath);
    await installStopHook(worktreePath, taskId, backendOrigin);
    return { status: 'clean' };
  }

  // Real conflicts remain — a resolver Claude is about to be spawned.
  // Re-install the Stop hook so its callback URL is correct for THIS
  // task before the resolver bootstraps.
  await installStopHook(worktreePath, taskId, backendOrigin);
  return {
    status: 'conflict',
    conflictKind: 'merge',
    conflictedFiles: remaining,
  };
}
