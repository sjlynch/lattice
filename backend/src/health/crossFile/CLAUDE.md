# backend/src/health/crossFile

Cross-file health pass behind the `../crossFile.ts` shim. After the per-file
analysis runs, this layer builds the import graph for a file set, finds
dependency cycles, computes reachability from a root set, classifies dead code,
and patches the results back onto each file's `HealthMetrics`. Pure functions —
the watcher and the full scan both drive `computeCrossFile`.

- `graph.ts` — thin orchestrator: `computeCrossFile()` + the `CrossFileResult`
  type. Wires the modules below together and re-exports their public surface so
  callers can still import everything from `./graph.js`.
- `importGraph.ts` — `buildImportGraph` (+ `ImportGraph`/`FileImports` types,
  `extLower`). Edge construction with duplicate de-duping; preserves the
  self-import fan-in/fan-out semantics (a self-edge stays in the graph for cycle
  detection but never inflates a fan counter).
- `cycles.ts` — `tarjan` (strongly-connected components) + `cyclicNodes`
  (SCCs of size >1, plus single-node self-loops, are cycles).
- `reachability.ts` — `computeReachability`: forward DFS over import edges from
  the roots = "what the live program pulls in".
- `deadCode.ts` — `classifyDeadCode` + the `DeadCodeStats` type + the guard
  constants. Tags each file `entry`/`live`/`dead`/`uncertain`.
- `resolveImport.ts` / `resolveImport/` — extension/index/alias/Python-relative
  import resolution behind the `resolveImport.ts` re-export shim. Focused pure
  modules under `resolveImport/`:
  - `resolveImport/index.ts` — the `resolveImport()` orchestrator (Python-relative
    normalization → tsconfig aliases → external-package bail → relative
    filesystem candidates) plus the re-export barrel for the public surface.
  - `resolveImport/caseFold.ts` — case-insensitive filesystem support
    (`CASE_INSENSITIVE_FS`, the Set-identity-memoized case-folded index, and
    `lookupPresent`, the exact-then-case-folded membership test).
  - `resolveImport/extensionCandidates.ts` — `RESOLVE_EXTS`/`INDEX_FILES`, the
    NodeNext `.js`/`.mjs`/`.cjs`/`.jsx` → TS-twin remap table, and
    `tryAllExtensions` (exact → JS-to-TS remap → extensionless append → directory
    index).
  - `resolveImport/pythonImports.ts` — `normalizePythonRelativeImport` (`.foo` /
    `..pkg.sub` → fs-relative spec).
  - `resolveImport/aliasResolution.ts` — `resolveByAlias` (tsconfig path aliases,
    baseUrl-catch-all-is-bare-only rule) + the shared `isRelativeSpec` predicate.
- `roots.ts` — pure, synchronous, fs-free entry-point heuristics +
  `RESOLVABLE_IMPORT_EXTS`: `isConventionalRoot` (filename/path shapes),
  `globToRegExp`/`compileEntryGlobs`/`matchesEntryGlob` (the user
  `deadCodeEntryGlobs` escape hatch), and `detectRoots` (combine the two with
  caller-supplied extra roots). Cheap enough for the watcher to recompute on
  every change.
- `packageRoots.ts` — async, filesystem-walking package.json resolution used
  only by the full scan: `readPackageJsonRoots` resolves every in-tree
  package.json's `main`/`module`/`source`/`types`/`bin`/`exports` + `scripts`
  file refs to in-tree source files. Finds the package.jsons via the shared
  bounded walker (`../walkTree.js` `walkSourceTree`, canonical
  `IGNORE_DIR_NAMES` skip set). Re-exported from `./index.js` alongside the
  `roots.js` heuristics, so importers are unaffected by the split.
- `apply.ts` — patch fanIn/fanOut/inCycle smells + the `deadCode` status back
  into `HealthMetrics` and recompute the score.

**Dead-code guard invariant** (`deadCode.ts`): if ≥20 resolvable non-root files
are in play and more than 70% of them come back `dead`, that's the fingerprint
of a resolver blind spot (e.g. a dropped NodeNext `.js`→`.ts` edge), not a
genuinely dead codebase — so every `dead` is downgraded to `uncertain`. This
makes mislabeling fail safe: a resolution gap can never confidently paint a
whole project red.
