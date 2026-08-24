# backend/src/worktree/projectGuards

Project-repo hygiene helpers called during task worktree setup through the
`projectGuards.ts` facade.

- `gitignore.ts` ensures Lattice-managed files/scratch are ignored in the
  project working tree.
- `repoExclude.ts` manages `.git/info/exclude` for repo-local excludes that
  should not be committed. **Always resolve the target with `git rev-parse
  --git-common-dir`.** `info/exclude` is one of git's *common* files: it is read
  only from the common gitdir, never from a linked worktree's own
  `.git/worktrees/<name>/`. Writing to the latter is silently inert — that was a
  real bug (`writeWorktreeExclude` in `../stopHook.ts` did it), and its
  consequence was that every Lattice file stayed visible to `git add -A` inside
  task worktrees, so agents committed `.codex/hooks.json` onto main and aborted
  later merges. Because the file is shared, appends must be idempotent
  (`appendMissingExcludeEntries`), never blind.
- `untrack.ts` removes Lattice-owned files from the index with `projectGit`
  (`rm --cached` only), never recursive filesystem deletion.
- `verify.ts` probes that essential exclusions are present before snapshot or
  stash-sensitive operations continue.
- These modules protect the user's repo; keep safety comments near code and do
  not add raw `fs.rm({recursive})` or unrestricted git calls here.
