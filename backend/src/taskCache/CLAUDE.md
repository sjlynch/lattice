# backend/src/taskCache

In-memory + on-disk store for Lattice's per-project task lists. Implementation
behind `../tasks.ts` and `../taskCache.ts`; keep those stable re-export shims
for existing imports.

## Storage layout

```
~/.lattice/
├── projects.json                         # global index of project roots
├── tasks.json                            # legacy global tasks (pre-2026-05-09)
└── per-project/
    └── <sha1(canonicalPath)[:12]>/
        ├── .canonical-path               # human-readable hint
        ├── tasks.json                    # the live task DB
        └── tasks.backup.json             # snapshot taken before each merge run
```

`tasks.json` was moved out of `<project>/.lattice/tasks.json` (legacy) into
`~/.lattice/per-project/<hash>/tasks.json` after the 2026-05-09 incident —
keeping task data alive when a project-side catastrophe wipes the project
dir. Legacy in-project files auto-migrate on first read; the legacy copy is
left in place so a user can roll back to a pre-2026-05-09 build without
losing tasks.

## Module map

- `index.ts` — module entry point. Constructs the singleton
  `ProjectsIndex`, `TaskMigrations`, and `TaskCacheManager` and re-exports
  the public functions consumed via `tasks.ts` (`listTasks`, `createTask`,
  `updateTask`, `updateTaskCrashSafe`, `deleteTask`, `reorderTasksInLane`,
  `flushPersist`, `backupTasksFile`, `restoreAllProjectsFromBackup`,
  `listReadyToMergeTasks`, `listKnownProjects`, …). Add a new public verb
  here, not on the manager directly.
- `manager.ts` — `TaskCacheManager` extends `ProjectStateManager<Task[]>`.
  Owns CRUD/reorder, `updateTaskCrashSafe` (disk-before-cache), and
  `ensureProjectLoaded`/`loadAllKnown` (which trigger migrations on
  first touch). Exposes `loadedTasks()` for recovery's read-only scans.
  `updateTaskCrashSafe` keeps the per-project lock + subscriber notify here
  and delegates the invariant-heavy disk-write / live-cache re-sync to
  `crashSafeUpdate.ts`.
- `crashSafeUpdate.ts` — `applyCrashSafeTaskUpdate(ops, project, list, idx,
  id, updates)`: the disk-before-cache core (write disk first, cancel pending
  debounce, re-read the LIVE cache and re-apply only this task's delta — never
  the pre-write snapshot). Pure of the manager's cache internals: the caller
  binds `writeStateNow`/`cancelPendingPersist`/`getCached`/`setCached` to the
  live instance so subclass overrides still dispatch. MUST run under the
  manager's per-project write lock.
- `paths.ts` — single source of truth for `~/.lattice/` and per-project
  paths (`projectTasksFile`, `projectTasksBackupFile`, `homeProjectDir`,
  `LEGACY_GLOBAL_TASKS`).
- `projectsIndex.ts` — `ProjectsIndex`: in-memory `Set<projectPath>` backed
  by `~/.lattice/projects.json`. On load it canonicalises + de-dups (collapses
  case-different duplicates on Windows) and prunes junk entries via
  `pruneIndex.ts`, re-persisting so a restart self-cleans.
- `pruneIndex.ts` — the conservative index-pruning predicate
  (`isStructurallyJunkPath` / `projectHasTasksOnDisk` / `shouldPruneProjectEntry`):
  drops temp-dir scratch, shell-mangled, and phantom (gone-from-disk AND
  task-less) entries; a path that still exists on disk OR has task data is
  always kept. Run at boot by `projectsIndex.ts` and to reap an emptied scratch
  project in `manager.ts`'s `deleteTask`.
- `migrations.ts` — `TaskMigrations` class (holds the once-per-process
  legacy-migration flag) plus the two pure migration functions:
  - `migrateLegacy(projectsIndex)`: one-time `~/.lattice/tasks.json` →
    per-project split. Run from every `ensureProjectLoaded` / `loadAllKnown`
    call but guarded by the once-flag.
  - `migrateInProjectTasksToHome(projectKey)`: first-touch
    `<project>/.lattice/tasks.json` → `~/.lattice/per-project/<hash>/`.
    Idempotent. Called on first load of each project AND from
    `restoreTasksFromBackupIfMissing` so boot recovery picks up legacy
    files whose home location never existed.
- `recovery.ts` — file-level backup/restore and read-only iterators that
  callers in `recovery.ts` and `mergeRuns/preflight.ts` use:
  - `backupTasksFile(projectPath)`: write `tasks.json` → `tasks.backup.json`
    (validates JSON first). Run at the start of every merge run.
  - `restoreTasksFromBackupIfMissing(projectPath, migrations)`: on boot,
    if `tasks.json` is gone/corrupt and `tasks.backup.json` is intact,
    restore. Runs the first-touch migration first.
  - `restoreAllProjectsFromBackup(projectsIndex, migrations)`: same, for
    every known project. Called from boot recovery BEFORE any other
    `tasks.ts` read.
  - `listReadyToMergeTasks(provider)`: scan every loaded project for
    `status=ready_to_merge` tasks with a branch. Used to detect tasks
    whose branch was cleaned up but whose status was never persisted.
  - `listKnownProjects(projectsIndex)`: the full project list, for the
    boot-time orphaned-worktree sweep.
- `taskUpdate.ts` — small pure helpers shared by `manager.ts`:
  `stampTimestamps` (status-transition timestamp inference) and
  `applyTaskUpdate` (immutable list-with-one-item-replaced). The cross-project
  by-id scan + cache-miss fallback now live in the shared base class
  (`ProjectStateManager.findInCacheById` / `withItemAcrossProjects`).
- `types.ts` — `Task`, `TaskStatus`, `TaskUpdates`, `TaskSubscriber`.

## Ordering invariant

Load/canonicalize the projects index and run legacy global migration before
the first project cache read; then copy legacy
`<project>/.lattice/tasks.json` to the home location before `loadIfNeeded`.
Boot restore (`restoreAllProjectsFromBackup`) must run before any other task
read so the cache sees restored disk state.

## Crash-safety contract

- `updateTaskCrashSafe` writes disk **before** mutating cache. Used for
  one-way transitions (`ready_to_merge → qa`) where losing the update
  would leave the system inconsistent. Cancels any pending debounce timer
  on success so the cache and disk stay in sync.
- **Per-project write lock (in the `ProjectStateManager` base).** Every
  read-modify-write — `createTask` / `updateTask` / `deleteTask` /
  `reorderTasksInLane` / `updateTaskCrashSafe` — runs through
  `runProjectWrite(project, fn)` (a `serializeWrites.runExclusive` chain keyed
  by store-name + canonical project). Without it, `updateTaskCrashSafe`'s
  disk-write `await` was a window where a sibling mutation (a Run-All
  run-attempt bump on another task, a Stop-hook `/complete` flip, a
  `createTask`) landed in cache and then got reverted when the crash-safe
  update resumed and committed its **pre-await** full-list snapshot — and its
  `cancelPendingPersist` even dropped the sibling's scheduled persist.
  `updateTaskCrashSafe` now additionally **re-reads the live cache after the
  disk write** and re-applies only its one task's delta, never the snapshot.
  By-id mutators use `withLockedItemAcrossProjects` (resolve project → take the
  lock → re-find the item in the live cache → mutate). The read-only by-id
  helpers (`getTask` via `withTaskAcrossProjects` →
  `withItemAcrossProjects`) stay **unlocked**.
- **Atomic writes + corrupt-load guard (base `writeStateNow` / `performLoad`).**
  `writeStateNow` routes through the shared `atomicWriteFile` (temp→rename, with
  the Windows file-lock retry) so a crash/kill mid-write can't truncate the live
  file. `performLoad` distinguishes ENOENT (legit empty → default) from a
  `JSON.parse` failure (a truncated/corrupt DB): on a parse failure it moves the
  bad file aside to a `<file>.corrupt-<ts>` sidecar and loads an empty state, so
  the next persist can't silently overwrite the still-recoverable bytes with
  `[]`. If the bytes can't be preserved at all, the key is write-protected and
  `writeStateNow` refuses to overwrite it.
- Every merge run takes a `backupTasksFile` snapshot up front; boot
  recovery (`restoreAllProjectsFromBackup`) restores from it if the main
  file is missing/corrupt.
- Storage lives under `~/.lattice/`, never inside the project tree — a
  project-side catastrophe (`rm -rf .lattice`, accidental `git clean -fdx`,
  the 2026-05-08 `.git`-deletion incident) cannot reach it.
