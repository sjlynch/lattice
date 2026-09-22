import { DisallowedProjectGitError, LATTICE_BRANCH_RE, lastNonFlag } from '../policy.js';

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
  // `worktree add -b/-B <name>` creates — and with `-B` force-RESETS — a
  // branch, so `-B main <path> <sha>` would move main. Only lattice/* names.
  if (op === 'add') {
    for (let i = 1; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '-b' || a === '-B') {
        const name = rest[i + 1];
        if (!name || !LATTICE_BRANCH_RE.test(name)) {
          throw new DisallowedProjectGitError(`worktree add ${a} "${name ?? ''}" (only lattice/* branches)`);
        }
      } else if (/^-[bB]./.test(a) || a.startsWith('--orphan')) {
        throw new DisallowedProjectGitError(`worktree add ${a} is not allowed`);
      }
    }
  }
}
