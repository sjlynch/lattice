import {
  DisallowedProjectGitError,
  hasFlag,
  lastNonFlag,
  LATTICE_BRANCH_RE,
} from '../policy.js';

export function assertAllowedBranchArgs(rest: string[]): void {
  // Deletion: only `lattice/*` branches.
  if (hasFlag(rest, '-D', '-d', '--delete', '--delete=force')) {
    const target = lastNonFlag(rest);
    if (!target || !LATTICE_BRANCH_RE.test(target)) {
      throw new DisallowedProjectGitError(
        `branch delete target "${target ?? '(none)'}" is not a lattice/* branch`,
      );
    }
    return;
  }
  // Rename / copy could clobber an existing branch (incl. main) — never
  // something Lattice does.
  if (hasFlag(rest, '-m', '-M', '--move', '-c', '-C', '--copy')) {
    throw new DisallowedProjectGitError('branch move/copy is not allowed');
  }
  // Otherwise it's a list (`branch`, `branch --list`, `branch -a`, …) or
  // a create (`branch <name> [<start>]`). Both are harmless w.r.t. `.git`.
}
