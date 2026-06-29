# backend/src/worktree/projectGuards

Project-repo hygiene helpers called during task worktree setup through the
`projectGuards.ts` facade.

- `gitignore.ts` ensures Lattice-managed files/scratch are ignored in the
  project working tree.
- `repoExclude.ts` manages `.git/info/exclude` for repo-local excludes that
  should not be committed.
- `untrack.ts` removes Lattice-owned files from the index with `projectGit`
  (`rm --cached` only), never recursive filesystem deletion.
- `verify.ts` probes that essential exclusions are present before snapshot or
  stash-sensitive operations continue.
- These modules protect the user's repo; keep safety comments near code and do
  not add raw `fs.rm({recursive})` or unrestricted git calls here.
