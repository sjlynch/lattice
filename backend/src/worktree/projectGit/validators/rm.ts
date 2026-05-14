import { DisallowedProjectGitError, hasFlag } from '../policy.js';

export function assertAllowedRmArgs(rest: string[]): void {
  // Only `rm --cached` (index only — never deletes from the working tree).
  if (!hasFlag(rest, '--cached')) {
    throw new DisallowedProjectGitError('`git rm` without --cached (would delete files) is not allowed');
  }
}
