# backend/src/worktree/projectGuards

Project-repo hygiene helpers behind the `projectGuards.ts` facade. Task worktree
setup (`../setupProject.ts`) runs only `ensureLatticeRepoExclude` →
`untrackOwnedFilesInRepo`; the tracked `.gitignore` is never edited there (only
`git init` writes one) — see `../CLAUDE.md` → "Lattice-owned files".

- `gitignore.ts` — `ensureLatticeGitignore` appends the missing Lattice entries
  to the project's tracked `.gitignore`. It only appends to an **existing**
  file: on ENOENT it returns without creating one. Its sole caller is
  `projectInit/init.ts` (before a new project's first commit);
  `mergeRuns/preflight.ts` and `routes/tasks/manualMergeService.ts`
  deliberately skip it, since editing a tracked file mid-run dirties main.
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
- `verify.ts` — `verifyEssentialExclusions` probes (`git check-ignore`) that
  `.lattice/` and `node_modules/` are excluded. It is the stash/snapshot
  pre-check, called from `../stash.ts` `assertSafeForStash` after an
  `ensureLatticeRepoExclude` self-heal — not from worktree setup.
- These modules protect the user's repo; keep safety comments near code and do
  not add raw `fs.rm({recursive})` or unrestricted git calls here.
