# backend/src/worktree/snapshot

Safety-critical copy-based working-tree snapshots. Never replace with
`git stash --include-untracked`.

- `capture.ts` — `snapshotWorkingTree` (under `withProjectMutation`),
  `createSnapshotDirectory`, `writeCapturedSnapshotManifest`,
  `buildSnapshotCleanupPlan`; scope filter, free-space refusal, partial-dir
  removal, `readHeadCommit` (→ `baseCommit`). Re-exports most helpers of the
  next two.
- `pathClassification.ts` — `parseStatusRecords` / `parseStatus` (`-z` parser,
  four buckets); `filterSafeDirtyPaths` / `classifySafeDirtyPaths`
  (repo-containment guard).
- `copyAndCleanup.ts` — `copyDirtyPathsToSnapshot`, `resetTrackedSnapshotPaths`,
  `unstageAddedSnapshotPaths`, `restoreDeletedSnapshotPaths`,
  `cleanupCapturedUntrackedPaths`; `chunkPathsForArgv` / `GIT_ARGV_CHAR_BUDGET`.
- `versions.ts` — `pathVersion`: streamed sha256 / `link:` target / `null` if
  absent.
- `manifest.ts` — `SNAPSHOTS_BASE`, `SNAPSHOT_MANIFEST_FILENAME`
  (`_lattice-snapshot.json`), `SnapshotHandle` / `SnapshotManifest` /
  `RetiredSnapshotPath`, `readSnapshotManifest` via `isSupportedSnapshotManifest`.
- `restore.ts` — public `restoreSnapshot` (mutation ownership, ordered
  whole-snapshot restore, guarded dir removal) and `describePartialRestore`.
- `restoreTypes.ts` — options/result types, `SNAPSHOT_CONFLICT_SUFFIX`, the single
  `StaleSnapshotConflict` / `SnapshotPathKept` constructors used to classify.
- `restorePath.ts` — `restoreSnapshotPath` / `reapplySnapshotDeletion`: guarded
  per-path copy/delete, destination version checks, exclusive/reusable conflict
  copies.
- `threeWay.ts` — `reconcileWithCommittedChange`, `deletedSinceCapture`,
  `MAX_THREE_WAY_MERGE_BYTES` (8 MB).
- `restoreRetirement.ts` — `retireSettledEntries`: narrow a partial restore's
  manifest to retryable entries; archive when none remain.
- `recovery.ts` — boot `recoverPendingSnapshots`: `listPendingSnapshotDirs`
  (lazy `<hash>/<snap>` walk) → `validateSnapshotForRecovery` (skip
  missing/unsupported/archived manifests, dir hash must match `repoRoot`, repo
  must exist) → `recoverOneSnapshot` (`noteInterruptedRunBeforeSteal`, own run
  lock, manifest re-read, `guardStaleOverwrite` restore; errors defer).

Capture order (keep intact):

1. Parse `git status --porcelain=v1 -z --untracked-files=all`. `-z` is required:
   NUL-terminated verbatim paths, a rename/copy split into destination + source
   fields. The newline form mangles renames (`R  old -> new`) and quotes
   special-char names, which silently dropped them from the snapshot. FOUR
   buckets, each cleaned differently: `untracked` (copy + delete), `modified`
   (copy + `checkout HEAD --`), `added` (`A`/`R`/`C`, in the index not HEAD:
   copy + `reset HEAD --` + delete — `checkout HEAD` can't reset a path HEAD
   lacks, and git refuses a WHOLE batched checkout on one bad pathspec) and
   `deleted` (` D`/`D `/rename source — nothing to copy: `checkout HEAD --`
   resurrects it for a clean FF, the manifest lists it, restore re-deletes it
   only if still a clean tracked HEAD copy). `MD` stays `modified` (index-only
   content must not be reset). Every batched `checkout`/`reset` retries per path
   on a non-zero exit.
2. Drop paths failing the repo-containment guard; never copy/reset/delete them.
3. Create the snapshot dir and copy, recording successes and failures separately.
4. Write the manifest only after copies, listing only successful copies.
5. Reset/delete **only** successfully copied paths. A failed copy stays dirty so
   later git operations fail safely instead of losing data.

Scale limits (2026-09-23 — ~1 GB of uncommitted art filled the disk):

- **Scope.** `onlyPaths` captures only dirty paths colliding with it (equal, or
  one an ancestor dir of the other). `fastForwardMain` passes `git diff
  --name-only --no-renames HEAD <branch>` (`merge --ff-only` rewrites nothing
  else and refuses without writing if an unlisted dirty path would be
  clobbered); the merge-run stash passes the union of each Ready-to-Merge
  branch's `HEAD...branch`. No overlap ⇒ no snapshot; a failed diff ⇒ full
  snapshot.
- **Free space.** Bytes to copy are summed before creating the dir; the capture
  is refused (tree untouched) if they would cross `globalSettings.minFreeDiskGb`.
- **Command-line length.** Path-list git calls are chunked at 8,000 chars: 1,610
  paths hit Windows' 32,767-char limit as `spawn ENAMETOOLONG` — an exception the
  per-path retry never saw — failing every capture after its copy.
- **Partial copies.** A capture that throws before its manifest is written
  removes its dir (nothing was reset yet; recovery ignores manifest-less dirs).

Recovery invariants (2026-09 stability review):

- Snapshot dirs use `mkdtemp`: same-label captures in one millisecond never
  share payloads or manifests.
- A repository path named `_lattice-snapshot.json` (case-insensitive) is left
  dirty, not captured/reset; older manifests listing it are refused on restore.
- Untracked cleanup is nonrecursive and rechecks parent symlinks. A file that
  became a directory after capture holds uncaptured work and must survive.
- The manifest reader validates recovery fields and arrays; a version number
  alone does not make a record safe.
- Stale conflict copies use exclusive creation with numbered suffixes; existing
  recovery work is never overwritten. Identical copies are reused across boots.

Ownership and edit preservation (2026-09 follow-up):

- Manifests carry the owning project lock generation. Boot recovery acquires its
  own project lock and re-reads the manifest before restoring; it never borrows
  a live merge's local ownership. Live-owned snapshots defer.
- Cleanup requires the snapshot dir and compares captured/current `pathVersion`
  before resetting/deleting; missing version evidence refuses cleanup. Literal
  Git pathspecs stop wildcard names resetting other files. Hashing streams, to
  keep large artifacts off the JS heap.
- Default restoration preserves newer dirty edits and overlays only tracked
  destinations verified clean against HEAD; assume-unchanged/skip-worktree
  paths count as uncertain. Boot restoration is stricter: every differing
  destination keeps its content and gets a captured conflict copy.
- Restoration returns a structured restored/partial result (restored paths,
  conflicts, failures, retention). Partial teardown becomes a run error; a
  post-FF partial is surfaced to the finalize caller without retrying the
  already-successful HEAD move. Recursive cleanup refuses reparse points,
  filesystem roots, and any snapshot/project containment overlap.
- External editors don't take Lattice's lock. Version checks catch changes
  before cleanup, but a write racing the final comparison and the Git/file
  replacement is not an OS-level compare-and-swap; that window remains.

Restoring over a change that landed after capture (2026-09-25):

- A capture records its HEAD (`baseCommit`, handle + manifest). An in-session
  restore of a tracked destination clean against the NEW HEAD compares
  `baseCommit:<path>` with `HEAD:<path>`: same object → the copy overlays it;
  different (the FF rewrote it) → `git merge-file -p` of base / captured /
  current. Before, the pre-merge copy silently reverted the task's change while
  reporting `restored` (and the QA-lane Push's `git add -A` committed the
  revert). A clean merge writes the combined file; overlapping hunks,
  binary/non-UTF-8 or > 8 MB keep HEAD's version and save the capture as
  `<file>.lattice-conflict` → `'partial'`, surfaced by FF finalize and merge-run
  teardown. Conflict markers never reach the main checkout. A modified file the
  merge DELETED is a conflict copy too, not resurrected. Boot recovery
  (`guardStaleOverwrite: true`) never merges. `projectGit` whitelists
  `merge-file` only as `-p`, fed temp copies of the checked bytes.
- A partial restore moves restored, conflict-copied, deliberately-kept (a
  captured deletion of a since-edited file) and unsafe entries to `retired`;
  only retry-fixable failures stay listed. Nothing left → `archived: true`: the
  payload stays for the user and recovery skips it. Before, every boot
  re-applied the whole manifest, resurrecting deleted files and re-creating
  reviewed conflict copies indefinitely.
- Boot recovery's run lock steals an interrupted Merge All's dead `merge-run`
  lock (or a workflow Merge/Push step's), so it first records
  `interrupted-run.json` (`../../projectRunLock/interruptedRun.ts`):
  `resumeInterruptedMergeRuns` still resumes and the owed post-merge hook check
  still defers; the resume clears it once it has acted.

Discarded-worktree archives (`../discardArchive.ts`) share this directory tree
and the copy routine but are NOT pending snapshots: their manifest is
`_lattice-discarded-worktree.json` and the payload sits under `files/`.
`recovery.ts` only acts on `_lattice-snapshot.json`, so they are never
auto-restored. Do not give them a `_lattice-snapshot.json`.
