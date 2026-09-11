# backend/src/worktree/snapshot

Safety-critical copy-based working-tree snapshots. Keep the capture order in
`capture.ts` intact:

1. Parse `git status --porcelain=v1 -z --untracked-files=all`. The `-z`
   (machine-parse) form is required: it emits NUL-terminated records with
   verbatim, unquoted pathnames and splits a rename/copy into a
   destination field + a source field (no ` -> ` arrow). The default
   newline form mangles renames (`R  old -> new`) and quotes special-char
   names, which made those paths fail to copy and silently drop from the
   snapshot. `parseStatus` snapshots the rename destination and discards
   the source field.
2. Drop any path that fails the repo-containment guard; dropped paths must not
   be copied, reset, or deleted.
3. Create the snapshot dir and copy dirty paths, recording successes and
   failures separately.
4. Write the manifest only after copies, and list only successfully copied
   paths.
5. Reset tracked files and delete untracked files **only** from the successful
   copy lists. A failed copy stays dirty in the user's working tree so follow-up
   git operations fail safely instead of losing data.

Do not replace this with `git stash --include-untracked`.

Additional recovery invariants (2026-09 stability review):

- Snapshot directories use `mkdtemp`, so same-label captures in one millisecond
  cannot share payloads or overwrite each other's manifest.
- `_lattice-snapshot.json` at the snapshot root is metadata. A repository path
  with that name (case-insensitive) is left dirty rather than captured/reset;
  older manifests listing the metadata path are refused on restore.
- Untracked cleanup is nonrecursive and rechecks parent symlinks. A file that
  became a directory after capture contains uncaptured work and must survive.
- The manifest reader validates recovery fields and arrays before returning a
  supported record. A version number alone does not make a record safe to use.
- Stale conflict copies use exclusive creation with numbered suffixes; existing
  recovery work is never overwritten. Identical copies are reused across boots.
