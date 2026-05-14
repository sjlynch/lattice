# backend/src/scanner

Pipeline that turns a project root into the `{nodes, links}` graph used by
the 3D force-directed view and the health overlays. Split out of the old
`backend/src/scanner.ts` (the original file is now a thin re-export facade
so `../scanner.js` import paths keep working).

## Phases

A scan runs through these phases, in order — each produces the input for
the next:

1. **`ignore.ts`** — `loadGitignore(root)` builds an `ignore` matcher
   seeded with `IGNORE_DIR_NAMES` and the project's `.gitignore`.
2. **`collectSourceTree.ts`** — `collectSourceTree(root, ig)` walks the
   tree gitignore-aware and returns `{files, directories}` (every
   directory crossed, plus every file whose extension is in
   `SOURCE_EXTS`). `collectSourceFiles` is the files-only shortcut.
3. **`fileMetrics.ts`** — `computeFileMetrics(files, {cache})` stats +
   reads each file once via `readForAnalysis` (skips contents past
   `LOC_MAX_BYTES`), then runs `analyzeFile` for per-file health unless
   the `HealthCache` already has a matching `(mtime, size)` entry.
   Returns the `FileMetric[]` consumed by the next two phases.
4. **`coupling.ts`** — `computeCoupling(metrics, aliases)` feeds the
   per-file `imports` lists into `computeCrossFile` to produce the
   cross-file `CouplingMap` (fan-in/fan-out etc.).
5. **`graphAggregate.ts`** — `aggregate(metrics, coupling, {root,
   directories})` applies cross-file numbers back onto each file's
   `HealthMetrics` and emits the final `{root, nodes, links}` graph.
   `commonRoot` is the fallback when no explicit root is passed;
   `ensureDirectoryNode` lazily seeds intermediate directory nodes for
   any file whose parent wasn't in the walked directory list.
6. **`scan.ts`** — `scan(root)` is the top-level orchestrator: wires the
   phases above, then `cache.prune(seenFiles)`, fire-and-forget
   `cache.save()`, and `seedWatcherState(...)` so the health watcher's
   in-memory mirror reflects the freshly-scanned state (otherwise it
   keeps broadcasting cross-file numbers from before the rescan).

## Conventions

- Output shape is stable — `scan()` must keep returning the same
  `{root, nodes, links}` graph the frontend already consumes.
- Cache writes (`HealthCache.save`) are best-effort and non-blocking;
  never `await` them in the scan response path.
- Phase boundaries are the seams: a new metric → extend
  `fileMetrics.ts`; a new cross-file signal → extend `coupling.ts`; a
  new graph shape → extend `graphAggregate.ts`. Don't reach across.
