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
- `resolveImport.ts` — extension/index/alias/Python-relative import resolution.
- `roots.ts` — entry-point detection + `RESOLVABLE_IMPORT_EXTS`.
- `apply.ts` — patch fanIn/fanOut/inCycle smells + the `deadCode` status back
  into `HealthMetrics` and recompute the score.

**Dead-code guard invariant** (`deadCode.ts`): if ≥20 resolvable non-root files
are in play and more than 70% of them come back `dead`, that's the fingerprint
of a resolver blind spot (e.g. a dropped NodeNext `.js`→`.ts` edge), not a
genuinely dead codebase — so every `dead` is downgraded to `uncertain`. This
makes mislabeling fail safe: a resolution gap can never confidently paint a
whole project red.
