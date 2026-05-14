import { DisallowedProjectGitError, lastNonFlag } from '../policy.js';

const ALLOWED_WORKTREE_OPS = new Set([
  'list',
  'prune',
  'add',
  'remove',
  'repair',
  'lock',
  'unlock',
  'move',
]);

export function assertAllowedWorktreeArgs(rest: string[]): void {
  const op = rest[0];
  if (!op || !ALLOWED_WORKTREE_OPS.has(op)) {
    throw new DisallowedProjectGitError(`worktree subcommand "${op ?? '(none)'}" not allowed`);
  }
  // `worktree remove <target>` — git itself refuses to remove the main
  // worktree, but bail loudly here too rather than rely on that.
  if (op === 'remove') {
    const target = lastNonFlag(rest.slice(1));
    if (!target) throw new DisallowedProjectGitError('worktree remove with no target');
  }
}
