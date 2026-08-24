# backend/src/projectInit

Turns a folder that isn't a git repo into one Lattice can use: probe → preview
→ `git init` + starter `.gitignore` + first commit. Served by
`routes/projectInit.ts` (`POST /api/project-init/preview`, `POST /api/project-init`)
and surfaced additively on `GET /api/git-check`.

Without it, opening a non-repo folder dead-ends: `routes/tasks/projectValidation.ts`
400s every task create, because a task can only ever run in a worktree.

## Files

- `types.ts` — the wire contract shared with the frontend (`ProjectGitState`,
  `ProjectGitProbe`, `ProjectInitPreview`, `ProjectInitResult`) plus
  `ProjectInitError`, the typed failure whose `code` the route maps to
  409 / 422 / 500 / 503.
- `probe.ts` — `probeProjectGit(project)`. `fs.stat(<project>/.git)` fast path
  (dir OR file), then the walk-up `rev-parse` (see invariant 1), then the bare
  check, then the path guards.
- `guards.ts` — `refuseInitReason(canonicalPath)`: home dir, filesystem/drive
  roots, anything under `~/.lattice`, Windows system trees, non-directories,
  and unwritable dirs. Returns the human-readable reason the dialog shows.
- `gitignoreTemplate.ts` — `buildStarterGitignore(repoRoot)`, composed from
  `health/constants.ts`'s `IGNORE_DIR_NAMES`, `worktree/managedFiles.ts`'s
  `LATTICE_GITIGNORE_ENTRIES`, and `worktree/envDetect.ts`'s detected
  ecosystems — plus secrets and OS/editor noise.
- `preview.ts` — `previewProjectInit(project, gitignore?)`: bounded, symlink-
  refusing walk counting what the first commit would capture. The pattern
  matcher is a deliberate subset of gitignore syntax; git is authoritative at
  commit time (see the file header).
- `init.ts` — `initProjectGit(project, {gitignore?})`, serialized per project
  through `runExclusive`. **`.gitignore` precedence:** an explicit `gitignore`
  wins over a file already on disk (it only ever comes from the dialog, where
  the user saw that exact text *and* the file count it produces — keeping the
  old file would make the count they approved describe a different commit);
  with no explicit text a `.gitignore` the project brought is left untouched.
  Either way `ensureLatticeGitignore` runs before `add -A`, so a user who edits
  the Lattice entries out can't commit `.lattice/` scratch. Also exports
  `isMissingIdentityFailure(stderr)` —
  the string match that stands in for the identity probe we're not allowed to
  run (invariant 2), pinned against git's real message text in
  `__tests__/projectInit.test.ts`.

## Invariants

1. **Walk-up detection, always.** `'nested'` (a repo exists ABOVE this folder)
   must be decided by `git rev-parse --show-toplevel`, never by
   `fs.stat(<project>/.git)`. A subdirectory of a monorepo looks repo-less to
   `stat`, and initializing there creates a nested repo the parent sees as a
   bare gitlink — the worst outcome this feature can produce.
2. **Never touch a git identity.** No probing, no setting, no env overrides —
   `__tests__/gitIdentityUntouched.test.ts` scans every shipped source file for
   the literals involved. A missing identity is detected from git's stderr
   (`/Author identity unknown|Please tell me who you are|unable to auto-detect/i`)
   and surfaced as `422 git-identity-missing` with git's RAW stderr as `detail`;
   the user-facing fix instructions live in the frontend, which that test does
   not scan.

Other standing rules this module inherits: `init` stays OFF the `projectGit`
whitelist (the pre-`.git` `init`/`rev-parse` calls use plain `exec`, everything
after goes through `projectGit`), and nothing here deletes anything —
`fs.rm` never appears, recursively or otherwise.
