import { dashDashIndex, DisallowedProjectGitError, hasFlag } from '../policy.js';

export function assertAllowedResetArgs(rest: string[]): void {
  // Only `reset [HEAD] -- <paths…>` (unstage). Forbid all positional-mode
  // resets (`reset <commit>` moves HEAD) and every mode flag, including
  // `--soft` which still moves HEAD.
  if (hasFlag(rest, '--hard', '--soft', '--mixed', '--merge', '--keep', '-N', '--patch', '-p')) {
    throw new DisallowedProjectGitError('reset with a mode flag is not allowed');
  }
  const dd = dashDashIndex(rest);
  if (dd < 0) {
    throw new DisallowedProjectGitError('reset without `--` (would move HEAD) is not allowed');
  }
  if (rest.slice(dd + 1).length === 0) {
    throw new DisallowedProjectGitError('reset with `--` but no paths is not allowed');
  }
  // Anything before `--` must be `HEAD` (or nothing). A SHA there would
  // be a soft reset to that commit.
  const beforeDD = rest.slice(0, dd).filter((a) => !a.startsWith('-'));
  if (beforeDD.length > 1 || (beforeDD.length === 1 && beforeDD[0] !== 'HEAD')) {
    throw new DisallowedProjectGitError(`reset target "${beforeDD.join(' ')}" must be HEAD or omitted`);
  }
}
