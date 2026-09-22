import { DisallowedProjectGitError, hasFlag } from '../policy.js';

export function assertAllowedMergeArgs(rest: string[]): void {
  // Only fast-forward, or operating on an in-progress merge state.
  // A later merge-mode flag overrides `--ff-only` (`--ff-only --no-ff` is a
  // real merge; `--squash` writes the merge result into the working tree), so
  // `--ff-only` only counts when nothing contradicts it.
  if (hasFlag(rest, '--abort', '--continue', '--quit')) return;
  if (hasFlag(rest, '--ff-only') && !hasFlag(rest, '--no-ff', '--ff', '--squash', '--no-commit')) return;
  throw new DisallowedProjectGitError(
    'a non-fast-forward `git merge` in the project repo is forbidden ' +
      '(Lattice merges inside the worktree and only fast-forwards main)',
  );
}
