import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedProjectGitArgs,
  DisallowedProjectGitError,
} from '../worktree/projectGit.js';
import { isUnderManagedWorktreesDir } from '../worktree/cleanupSafety.js';

function allowed(args: string[]): void {
  assert.doesNotThrow(() => assertAllowedProjectGitArgs(args), `expected allowed: git ${args.join(' ')}`);
}
function denied(args: string[]): void {
  assert.throws(
    () => assertAllowedProjectGitArgs(args),
    DisallowedProjectGitError,
    `expected denied: git ${args.join(' ')}`,
  );
}

test('projectGit policy allows the operations Lattice actually uses', () => {
  allowed(['rev-parse', '--show-toplevel']);
  allowed(['rev-parse', 'HEAD']);
  allowed(['rev-parse', '--git-common-dir']);
  allowed(['status', '--porcelain']);
  allowed(['status', '--porcelain=v1', '--untracked-files=all']);
  allowed(['ls-files', '--error-unmatch', 'LATTICE_TASK.md']);
  allowed(['check-ignore', '--quiet', '.lattice/probe']);
  allowed(['merge-base', '--is-ancestor', 'aaa', 'bbb']);
  allowed(['symbolic-ref', '--short', 'HEAD']);
  allowed(['worktree', 'list', '--porcelain']);
  allowed(['worktree', 'prune']);
  allowed(['worktree', 'add', '/home/u/.lattice/worktrees/h/foo-abc', '-b', 'lattice/foo-abc']);
  allowed(['worktree', 'remove', '--force', '/home/u/.lattice/worktrees/h/foo-abc']);
  allowed(['merge', '--ff-only', 'lattice/foo-abc']);
  allowed(['checkout', 'HEAD', '--', 'src/api.ts', 'src/x.ts']);
  allowed(['checkout', '--ours', '--', '.claude/settings.local.json']);
  allowed(['rm', '--cached', '--quiet', 'LATTICE_TASK.md']);
  allowed(['commit', '-m', 'Untrack Lattice-managed files [lattice-auto]']);
  allowed(['reset', 'HEAD', '--', 'LATTICE_TASK.md']);
  allowed(['branch', '-D', 'lattice/foo-abc123']);
  allowed(['branch', '--list', 'lattice/foo']);
  allowed(['bundle', 'create', '/home/u/.lattice/git-backups/h/2026.bundle', '--all']);
});

test('projectGit policy covers each mutating subcommand validator', () => {
  allowed(['worktree', 'repair']);
  denied(['worktree', 'remove', '--force']);

  allowed(['branch', '-d', 'lattice/old']);
  denied(['branch', '--copy', 'main', 'main-copy']);
  // Grouped/forced forms are fine as long as every operand is lattice/*.
  allowed(['branch', '-fd', 'lattice/foo-abc']);
  allowed(['branch', '-D', 'lattice/a', 'lattice/b']);
  allowed(['branch', '-f', 'lattice/foo-abc', 'lattice/start']);

  allowed(['merge', '--abort']);
  allowed(['merge', '--continue']);
  denied(['merge', '--no-ff', 'lattice/foo']);

  allowed(['checkout', '--theirs', '--', 'src/api.ts']);
  denied(['checkout', 'HEAD', '--']);
  denied(['checkout', 'HEAD', '--', '/']);

  allowed(['reset', '--', 'src/api.ts']);
  denied(['reset', 'HEAD', '--']);
  denied(['reset', 'HEAD~1', '--', 'src/api.ts']);

  allowed(['rm', '--cached', 'src/api.ts']);
  denied(['rm', '--quiet', 'src/api.ts']);

  // Print-only three-way merge for snapshot restore (snapshot/threeWay.ts).
  allowed(['merge-file', '-p', '-L', 'a', '-L', 'b', '-L', 'c', '/snap/x.ts', '/tmp/base', '/repo/x.ts']);
  denied(['merge-file', '/repo/x.ts', '/tmp/base', '/snap/x.ts']);
  denied(['merge-file', '-p', '--object-id', 'aaa', 'bbb', 'ccc']);
});

test('projectGit policy refuses everything that could damage the repo', () => {
  // The classics behind past incidents.
  denied(['clean', '-fdx']);
  denied(['clean', '-fd']);
  denied(['stash', 'push', '--include-untracked']);
  denied(['stash', 'pop']);
  denied(['reset', '--hard', 'origin/main']);
  denied(['reset', '--hard']);
  denied(['reset', '--soft', 'HEAD~1']);
  denied(['reset', 'HEAD~1']); // moves HEAD — no `--`
  denied(['update-ref', '-d', 'refs/heads/main']);
  denied(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // Bypasses of the whitelist's own gates (third sweep).
  denied(['symbolic-ref', '-d', 'HEAD']);
  denied(['symbolic-ref', '--delete', 'HEAD']);
  denied(['merge', '--ff-only', '--no-ff', 'lattice/foo']);
  denied(['merge', '--ff-only', '--squash', 'lattice/foo']);
  denied(['worktree', 'add', '-f', '-B', 'main', '/tmp/x', 'abc123']);
  denied(['worktree', 'add', '/tmp/x', '-b', 'feature']);
  denied(['worktree', 'add', '-Bmain', '/tmp/x']);
  allowed(['worktree', 'add', '/home/u/.lattice/worktrees/h/foo', 'lattice/foo']);
  denied(['checkout', 'HEAD', '--', ':/']);
  denied(['checkout', 'HEAD', '--', ':(top)']);
  denied(['checkout', 'HEAD', '--', './']);
  denied(['checkout', 'HEAD', '--', ':(literal).']);
  allowed(['checkout', 'HEAD', '--', ':(literal)src/a b.ts']);
  // Branch deletion limited to lattice/*.
  denied(['branch', '-D', 'main']);
  denied(['branch', '-d', 'develop']);
  denied(['branch', '-D']); // no target
  denied(['branch', '-m', 'main', 'old-main']);
  // EVERY operand must be lattice/* — not just the last. `-D main lattice/x`
  // deletes both, so it must be refused on `main`.
  denied(['branch', '-D', 'main', 'lattice/x']);
  denied(['branch', '-d', 'lattice/x', 'develop']);
  // Combined/grouped short flags still express delete intent: `-fd main` is a
  // force-delete of main, not an inert list/create.
  denied(['branch', '-fd', 'main']);
  denied(['branch', '-Df', 'main']);
  denied(['branch', '--delete', 'main']);
  // Force on the create form resets an existing ref (`-f main origin/main`
  // moves main) — refused unless every operand is lattice/*.
  denied(['branch', '-f', 'main', 'origin/main']);
  denied(['branch', '--force', 'main', 'origin/main']);
  // A real (non-ff) merge in the project tree would write conflict markers
  // into vite-watched files.
  denied(['merge', 'lattice/foo']);
  denied(['merge', '-X', 'theirs', 'lattice/foo']);
  // Branch switching / mass discard.
  denied(['checkout', 'some-branch']);
  denied(['checkout', '-f']);
  denied(['checkout', '--', '.']);
  denied(['checkout', 'HEAD', '--', '.']);
  denied(['checkout', 'HEAD']); // no `--`
  // rm without --cached deletes from disk.
  denied(['rm', '-rf', 'src']);
  denied(['rm', 'src/api.ts']);
  // `git init` stays off the whitelist even though Lattice now runs one:
  // `projectInit/` calls it through plain `exec`, because projectGit asserts
  // `<repo>/.git` exists — the very thing init creates. Whitelisting it here
  // would only make that assertion look satisfiable and hand a capability to
  // every other project-repo caller.
  denied(['init']);
  denied(['init', '-b', 'main']);
  // Subcommands not on the list at all.
  denied(['push', 'origin', 'main', '--force']);
  denied(['gc', '--prune=now']);
  denied(['filter-branch', '--all']);
  denied(['worktree', 'add-bogus']);
  // Leading global options would let argv escape the declared cwd.
  denied(['-C', '/some/other/repo', 'status']);
  denied(['-c', 'core.hooksPath=/tmp', 'status']);
  // Empty argv.
  denied([]);
});

test('isUnderManagedWorktreesDir accepts the home + legacy locations only', () => {
  const repo = '/home/u/dev/lattice';
  // We can't predict the projectHash here, so test the legacy in-project
  // location (deterministic) and a few obvious negatives. The home-location
  // positive is covered indirectly by the worktree-creation path.
  assert.equal(isUnderManagedWorktreesDir('/home/u/dev/lattice/.lattice/worktrees/foo-abc', repo), true);
  assert.equal(isUnderManagedWorktreesDir('/home/u/dev/lattice/.lattice/worktrees', repo), false); // the dir itself, not under it
  assert.equal(isUnderManagedWorktreesDir('/home/u/dev/lattice', repo), false); // the repo root
  assert.equal(isUnderManagedWorktreesDir('/home/u/dev/lattice/.git', repo), false);
  assert.equal(isUnderManagedWorktreesDir('/home/u/dev/lattice/.lattice/worktrees-extra/x', repo), false); // prefix-sibling
  assert.equal(isUnderManagedWorktreesDir('/some/where/else', repo), false);
});
