// Narrowed-capability git wrapper for the *project repo* — the user's actual
// working directory, as opposed to a disposable Lattice worktree. Every
// `.git`-deletion incident was a recursive filesystem delete (never a git
// command), so the defence is twofold: (1) never `fs.rm({recursive:true})`
// anything that could be inside the project (worktrees live outside it — see
// setup.ts), and (2) never let a *destructive* git subcommand touch the project
// repo. This module enforces (2); see the root CLAUDE.md defences list.
//
// Every git invocation against the project repo goes through `projectGit()`:
//   - asserts `<repoRoot>/.git` still exists (fail fast, never let git walk up to
//     a sibling repo's gitdir), and
//   - validates argv against a whitelist. Anything not on it — `clean`, `stash`,
//     `reset --hard`, `update-ref -d`, `branch -D` of a non-`lattice/` branch, a
//     real (non-ff) `merge` in the project tree, `checkout <branch>`, `push`,
//     `gc`, … — throws *before* git runs.
//
// Disposable worktree checkouts deliberately do NOT go through here: their blast
// radius is one task's scratch dir, and `mergeWorktreeInRepo` runs a real
// `git merge` inside them, which this policy (correctly) forbids in the project.

import { exec, type ExecOptions, type ExecResult } from './exec.js';
import { assertGitDirIntact } from './state.js';
import {
  DisallowedProjectGitError,
  SAFE_READ_OR_INDEX_ONLY,
} from './projectGit/policy.js';
import { assertAllowedBranchArgs } from './projectGit/validators/branch.js';
import { assertAllowedCheckoutArgs } from './projectGit/validators/checkout.js';
import { assertAllowedMergeArgs } from './projectGit/validators/merge.js';
import { assertAllowedMergeFileArgs } from './projectGit/validators/mergeFile.js';
import { assertAllowedResetArgs } from './projectGit/validators/reset.js';
import { assertAllowedRmArgs } from './projectGit/validators/rm.js';
import { assertAllowedWorktreeArgs } from './projectGit/validators/worktree.js';

export { DisallowedProjectGitError } from './projectGit/policy.js';

type ProjectGitSubcommandValidator = (rest: string[]) => void;

const MUTATING_SUBCOMMAND_VALIDATORS = new Map<string, ProjectGitSubcommandValidator>([
  ['worktree', assertAllowedWorktreeArgs],
  ['branch', assertAllowedBranchArgs],
  ['merge', assertAllowedMergeArgs],
  ['merge-file', assertAllowedMergeFileArgs],
  ['checkout', assertAllowedCheckoutArgs],
  ['reset', assertAllowedResetArgs],
  ['rm', assertAllowedRmArgs],
]);

function assertAllowedSymbolicRefArgs(rest: string[]): void {
  // `git symbolic-ref HEAD <ref>` writes; the read form is `symbolic-ref
  // [-q] [--short] <name>`. Forbid the 2-positional-arg write form.
  // `-d`/`--delete` deletes the symbolic ref (HEAD) with ONE positional.
  if (rest.some((a) => a === '-d' || a === '--delete')) {
    throw new DisallowedProjectGitError('symbolic-ref delete is not allowed');
  }
  const positionals = rest.filter((a) => !a.startsWith('-'));
  if (positionals.length >= 2) {
    throw new DisallowedProjectGitError('symbolic-ref write form is not allowed');
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
    if (sub === 'symbolic-ref') assertAllowedSymbolicRefArgs(rest);
    return;
  }

  const validator = MUTATING_SUBCOMMAND_VALIDATORS.get(sub);
  if (validator) {
    validator(rest);
    return;
  }

  if (sub === 'gc') {
    // Only the housekeeping form repoMaintenance.ts runs: `gc --auto
    // [--quiet]` (packs loose objects, prunes only what git itself deems
    // expired). No `--prune=now`, `--aggressive`, … .
    if (rest.some((a) => a !== '--auto' && a !== '--quiet') || !rest.includes('--auto')) {
      throw new DisallowedProjectGitError('only "gc --auto [--quiet]" is allowed');
    }
    return;
  }

  if (sub === 'fetch') {
    // Network read into the object store; cannot delete `.git`. Allowed
    // even though Lattice doesn't currently use it — harmless and useful.
    return;
  }

  throw new DisallowedProjectGitError(
    `subcommand "${sub}" is not in the allowed set`,
  );
}

// Env vars a project-git call may set. Deliberately tiny: `GIT_DIR`,
// `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*` … would redirect git (or
// smuggle in `-c` config) past the argv whitelist above. Only
// `GIT_LFS_SKIP_SMUDGE` — a task worktree's `worktree add` checks LFS files out
// as pointer stubs (lfsMode.ts) — is needed.
const ALLOWED_PROJECT_GIT_ENV = new Set(['GIT_LFS_SKIP_SMUDGE']);

// Throws DisallowedProjectGitError for an env var projectGit won't pass.
// Exported for unit testing.
export function assertAllowedProjectGitEnv(env: Record<string, string> | undefined): void {
  for (const key of Object.keys(env ?? {})) {
    if (!ALLOWED_PROJECT_GIT_ENV.has(key)) {
      throw new DisallowedProjectGitError(`env var "${key}" is not allowed for project git`);
    }
  }
}

// Run `git <args…>` in the project repo, after asserting `.git` is intact
// and the argv is on the whitelist. Use this for *every* git call whose cwd
// is the user's project root.
export async function projectGit(
  repoRoot: string,
  args: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  await assertGitDirIntact(repoRoot);
  assertAllowedProjectGitArgs(args);
  assertAllowedProjectGitEnv(opts?.env);
  return exec('git', args, repoRoot, opts);
}
