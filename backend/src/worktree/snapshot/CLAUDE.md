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

Ownership and edit preservation (2026-09 follow-up):

- Capture manifests carry the owning project lock generation. Boot recovery
  acquires its own project lock and re-reads the manifest before restoring;
  it never borrows a live merge's local ownership. Live-owned snapshots defer.
- Cleanup requires the snapshot directory and compares captured/current content
  hashes or symlink targets before resetting/deleting. Missing version evidence
  refuses cleanup. Literal Git pathspecs prevent wildcard names resetting other
  files. Hashing streams file contents to keep large artifacts off the JS heap.
- Default restoration preserves newer dirty edits and overlays only tracked
  destinations verified clean against HEAD. Assume-unchanged/skip-worktree paths
  are treated as uncertain. Boot restoration stays stricter: all differing
  destinations keep their current content and receive captured conflict copies.
- Restoration returns a structured restored/partial result with restored paths,
  conflicts, failures and snapshot retention. Partial teardown becomes a run
  error; a post-FF partial is surfaced to the finalize caller without retrying
  an already-successful HEAD move. Recursive cleanup refuses reparse points,
  filesystem roots, and any snapshot/project containment overlap.
- External editors do not participate in Lattice's lock. Version checks detect
  changes before cleanup, but a write racing the final comparison and Git/file
  replacement is not an OS-level compare-and-swap; that residual window remains.
