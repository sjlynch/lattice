# backend/src/worktree/projectGit

Policy modules for `projectGit(repoRoot, args)`, the only allowed git wrapper
for the user's main project repo.

- The boundary is intentional: project-repo git is capability-whitelisted;
  disposable task worktrees may still use raw `exec('git', ...)` where real
  merges/conflicts are needed.
- `policy.ts` holds shared allow/read-only constants + argv helpers (the
  `SAFE_READ_OR_INDEX_ONLY` set, `LATTICE_BRANCH_RE`, `DisallowedProjectGitError`);
  validators own one subcommand family each; dispatch lives in `../projectGit.ts`.
- Keep destructive commands denied unless there is a narrow, tested need:
  no `clean`, `stash`, `reset --hard`, `update-ref -d`, branch checkout, push,
  non-ff merge, or deleting non-`lattice/*` branches.
- Path-form `checkout`/`reset` must stay path-only (`-- <paths>`), never branch
  movement.
- `merge-file` only in its print form (`-p`/`--stdout`, no `--object-id`):
  snapshot restore's three-way merge (`../snapshot/threeWay.ts`) reads the
  result from stdout; without `-p` git rewrites its first file argument.
- Tests for guard drift live in `backend/src/__tests__/projectGit.test.ts`.
