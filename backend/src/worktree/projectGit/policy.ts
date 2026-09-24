// Shared policy data and small argv helpers for project-repo git calls.
// Subcommand-specific validators live in ./validators/ so each mutating
// capability can be audited independently.

// Branches Lattice is allowed to delete in the project repo. Anything not
// matching this is refused — deleting `main`/`master`/a user branch is
// never something Lattice should do.
export const LATTICE_BRANCH_RE = /^lattice\//;

// Subcommands that cannot mutate repo structure at all (reads, or
// index-only writes that the working tree / `.git` survive regardless).
export const SAFE_READ_OR_INDEX_ONLY = new Set([
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
  'symbolic-ref', // read form only (see projectGit.ts)
  'add', // index only — never touches .git structure or deletes files
  'commit', // creates a commit; cannot delete .git
  'bundle', // read-only w.r.t. the repo (used by the backup)
  'count-objects', // read-only (repoMaintenance.ts sizes a repack)
  'version',
  'help',
]);

export function hasFlag(args: readonly string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

// Index of the `--` separator, or -1.
export function dashDashIndex(args: readonly string[]): number {
  return args.indexOf('--');
}

// Last argument that doesn't look like a flag (used to find the "target"
// of e.g. `worktree remove [--force] <target>` or `branch -D <name>`).
export function lastNonFlag(args: readonly string[]): string | undefined {
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
