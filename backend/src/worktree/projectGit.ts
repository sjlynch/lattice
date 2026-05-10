// Narrowed-capability git wrapper for the *project repo* — the user's
// actual working directory, as opposed to a disposable Lattice worktree.
//
// Audit of every `.git`-deletion incident on this project points at exactly
// one mechanism: a recursive filesystem delete (directly via `fs.rm`, or
// indirectly via a lost `git stash --include-untracked`) reaching content
// it shouldn't. No *git command* has ever deleted `.git`. The defence we
// want is therefore twofold:
//   1. never run `fs.rm({recursive:true})` on anything that could be
//      inside the project (handled by relocating worktrees out of the
//      project tree — see setup.ts), and
//   2. never let a *destructive* git subcommand touch the project repo.
//
// This module enforces (2). Every git invocation against the project repo
// is supposed to go through `projectGit()`. It:
//   - asserts `<repoRoot>/.git` still exists (fail fast, never let git
//     walk up to a sibling repo's gitdir), and
//   - validates the argv against a whitelist. Anything not on the list —
//     `clean`, `stash`, `reset --hard`, `update-ref -d`, `branch -D` of a
//     non-`lattice/` branch, a real (non-ff) `merge` in the project tree,
//     `checkout <branch>`, `push`, `gc`, … — throws *before* git runs.
//
// Disposable worktree checkouts deliberately do NOT go through here: their
// blast radius is one task's scratch dir, and `mergeWorktreeInRepo` runs a
// real `git merge` inside them, which this policy (correctly) forbids in
// the project repo.

import { exec, type ExecResult } from './exec.js';
import { assertGitDirIntact } from './state.js';

// Branches Lattice is allowed to delete in the project repo. Anything not
// matching this is refused — deleting `main`/`master`/a user branch is
// never something Lattice should do.
const LATTICE_BRANCH_RE = /^lattice\//;

// Subcommands that cannot mutate repo structure at all (reads, or
// index-only writes that the working tree / `.git` survive regardless).
const SAFE_READ_OR_INDEX_ONLY = new Set([
  'rev-parse',
  'status',
  'ls-files',
  'check-ignore',
  'diff',
  'rev-list',
  'merge-base',
  'log',
  'show',
  'cat-file',
  'name-rev',
  'describe',
  'shortlog',
  'for-each-ref',
  'symbolic-ref', // read form only (see below)
  'add', // index only — never touches .git structure or deletes files
  'commit', // creates a commit; cannot delete .git
  'bundle', // read-only w.r.t. the repo (used by the backup)
  'version',
  'help',
]);

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

// Index of the `--` separator, or -1.
function dashDashIndex(args: string[]): number {
  return args.indexOf('--');
}

// Last argument that doesn't look like a flag (used to find the "target"
// of e.g. `worktree remove [--force] <target>` or `branch -D <name>`).
function lastNonFlag(args: string[]): string | undefined {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    if (!args[i].startsWith('-')) return args[i];
  }
  return undefined;
}

export class DisallowedProjectGitError extends Error {
  constructor(message: string) {
    super(`[projectGit] refusing to run in the project repo: ${message}`);
    this.name = 'DisallowedProjectGitError';
  }
}

// Throws DisallowedProjectGitError if `args` is not a permitted project-repo
// git invocation. Exported for unit testing.
export function assertAllowedProjectGitArgs(args: string[]): void {
  if (args.length === 0) throw new DisallowedProjectGitError('empty argv');
  // Strip leading `-c key=val` / `-C path` style global options — none of
  // ours use them, and `-C` in particular would let an argv escape the
  // declared cwd. Just forbid global options entirely.
  if (args[0].startsWith('-')) {
    throw new DisallowedProjectGitError(
      `leading option "${args[0]}" not allowed; pass the subcommand first`,
    );
  }
  const sub = args[0];
  const rest = args.slice(1);

  if (SAFE_READ_OR_INDEX_ONLY.has(sub)) {
    // `git symbolic-ref HEAD <ref>` writes; the read form is `symbolic-ref
    // [-q] [--short] <name>`. Forbid the 2-positional-arg write form.
    if (sub === 'symbolic-ref') {
      const positionals = rest.filter((a) => !a.startsWith('-'));
      if (positionals.length >= 2) {
        throw new DisallowedProjectGitError('symbolic-ref write form is not allowed');
      }
    }
    return;
  }

  switch (sub) {
    case 'worktree': {
      const op = rest[0];
      if (!op || !['list', 'prune', 'add', 'remove', 'repair', 'lock', 'unlock', 'move'].includes(op)) {
        throw new DisallowedProjectGitError(`worktree subcommand "${op ?? '(none)'}" not allowed`);
      }
      // `worktree remove <target>` — git itself refuses to remove the main
      // worktree, but bail loudly here too rather than rely on that.
      if (op === 'remove') {
        const target = lastNonFlag(rest.slice(1));
        if (!target) throw new DisallowedProjectGitError('worktree remove with no target');
      }
      return;
    }
    case 'branch': {
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
      return;
    }
    case 'merge': {
      // Only fast-forward, or operating on an in-progress merge state.
      if (hasFlag(rest, '--ff-only', '--abort', '--continue', '--quit')) return;
      throw new DisallowedProjectGitError(
        'a non-fast-forward `git merge` in the project repo is forbidden ' +
          '(Lattice merges inside the worktree and only fast-forwards main)',
      );
    }
    case 'checkout': {
      // Permit only the path-restoring form: `checkout <ref|--ours|--theirs> -- <paths…>`
      // with at least one explicit path that isn't `.`/`*`. Forbid branch
      // switching (`checkout <branch>`), which rewrites the whole tree, and
      // `checkout -- .` (mass discard).
      const dd = dashDashIndex(rest);
      if (dd < 0) {
        throw new DisallowedProjectGitError('checkout without `--` (branch switch) is not allowed');
      }
      const paths = rest.slice(dd + 1);
      if (paths.length === 0) {
        throw new DisallowedProjectGitError('checkout with `--` but no paths is not allowed');
      }
      if (paths.some((p) => p === '.' || p === '*' || p === '' || p === '/')) {
        throw new DisallowedProjectGitError('checkout with a wildcard/dot path is not allowed');
      }
      return;
    }
    case 'reset': {
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
      return;
    }
    case 'rm': {
      // Only `rm --cached` (index only — never deletes from the working tree).
      if (!hasFlag(rest, '--cached')) {
        throw new DisallowedProjectGitError('`git rm` without --cached (would delete files) is not allowed');
      }
      return;
    }
    case 'fetch':
      // Network read into the object store; cannot delete `.git`. Allowed
      // even though Lattice doesn't currently use it — harmless and useful.
      return;
    default:
      throw new DisallowedProjectGitError(
        `subcommand "${sub}" is not in the allowed set`,
      );
  }
}

// Run `git <args…>` in the project repo, after asserting `.git` is intact
// and the argv is on the whitelist. Use this for *every* git call whose cwd
// is the user's project root.
export async function projectGit(
  repoRoot: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  await assertGitDirIntact(repoRoot);
  assertAllowedProjectGitArgs(args);
  return exec('git', args, repoRoot, opts);
}
