# backend/src/taskCache

Implementation behind `../tasks.ts` and `../taskCache.ts`; keep those stable
re-export shims for existing imports.

- `index.ts` — singleton `TaskCacheManager` plus the exported task API used by
  routes, recovery, and merge code.
- `manager.ts` — cache/list/create/update/delete/reorder, debounced persist,
  `updateTaskCrashSafe`, task backups/restores, and cross-project scans.
- `paths.ts` — home-dir task DB helpers plus legacy filename constants for
  `~/.lattice/per-project/<hash>/tasks.json`.
- `projectsIndex.ts` — load/persist/canonicalize `~/.lattice/projects.json`.
- `types.ts` — `Task`, `TaskStatus`, `TaskUpdates`, `TaskSubscriber`.
- Legacy migrations live in `../taskMigrations.ts`; manager supplies the path
  context and owns when they run.

Ordering invariant: load/canonicalize the projects index and run legacy global
migration before the first project cache read; then copy legacy
`<project>/.lattice/tasks.json` to the home location before `loadIfNeeded`.
Boot restore must run before any other task read so the cache sees restored
disk state.
