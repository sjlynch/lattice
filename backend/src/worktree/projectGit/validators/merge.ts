import { DisallowedProjectGitError, hasFlag } from '../policy.js';

export function assertAllowedMergeArgs(rest: string[]): void {
  // Only fast-forward, or operating on an in-progress merge state.
  if (hasFlag(rest, '--ff-only', '--abort', '--continue', '--quit')) return;
  throw new DisallowedProjectGitError(
    'a non-fast-forward `git merge` in the project repo is forbidden ' +
      '(Lattice merges inside the worktree and only fast-forwards main)',
  );
}
