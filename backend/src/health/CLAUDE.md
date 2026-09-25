# backend/src/health

Tree-sitter-driven per-file metrics pipeline. Each file is parsed to an AST
(with universal regex helpers for languages lacking a grammar), run through
Halstead token counts and a Maintainability Index, and folded into a composite
0-100 health score plus a set of code "smells".

## Files

- `parser.ts` — grammar load/cache; `grammarKeyForExt` maps extensions to grammars
- `nodeKinds/` — per-language node-kind sets (function/branch/loop/etc.):
  `index.ts` (`nodeKindsFor`) + `base.ts` plus one file per language
  (`typescript.ts`, `python.ts`, `go.ts`, `csharp.ts`, `java.ts`, `ruby.ts`,
  `rust.ts`). Import from `./nodeKinds/index.js`.
- `decodeSource.ts` — `decodeSourceText(buf)`: BOM-aware byte → text decode
  (UTF-16LE/BE BOM → UTF-16, else UTF-8) run before analysis, so a UTF-16
  `.ps1`/`.cs` isn't analysed as NUL-interleaved garbage. Used by
  `watcher/fileAnalysis.ts` and `../scanner/readForAnalysis.ts`.
- `walker.ts` + `walker/` — shim plus the single AST pass producing a
  `FileAnalysis`; see `walker/CLAUDE.md`. `walker/index.ts` orchestrates the
  walk via a `context.ts` `WalkerContext` plus visitor helpers in
  `visitors.ts` (`handleComment`, `handleFunctionEntry`/`Exit`,
  `handleFileStructure`, `handleImportsAndStrings`, `handleAstSmells`,
  `handleExportTracking`, `updateComplexity`, `handleAwaitExpression`,
  `handleCallExpression`), which in turn delegate to the sub-passes
  `complexity.ts`, `depth.ts`, `functionRecord.ts`, `functionNames.ts`,
  `parameters.ts`, `docstrings.ts`, and `smells.ts`
- `halstead.ts` — operator/operand tokenization + Maintainability Index
- `universal.ts` + `universal/` — shim plus focused universal text helpers:
  `commentSyntax.ts` (per-language line/block comment markers),
  `lineCounts.ts` (line-kind counter), `strip.ts`
  (`stripStringsAndComments` lexer) + `stripRegex.ts` (its JS/TS
  regex-vs-division disambiguation), and `smells.ts` (regex/heuristic
  fallback-language smells)
- `analyze.ts` + `analyze/` — top-level `analyzeFile` entry point +
  `computeFromTree` orchestrator. Delegates to:
  - `analyze/language.ts` — `languageForExt` (extension → `HealthLanguage`)
  - `analyze/fallback.ts` — `analyzeFallback` + `DEFAULT_METRICS` (used for
    unsupported languages, oversize files, parser/parse failures)
  - `analyze/functionMetrics.ts` — `aggregateFunctionMetrics` (per-function
    rollups: complexity max/total, function length, param counts, docstring/
    boolean-param/mixed-sync-async tallies) and `computeCallGraph` (internal
    call density + god-function heuristic)
  - `analyze/smells.ts` — `assembleSmells` (table-folds AST smell tokens,
    magic strings, universal regex smells, and threshold-derived smells into the
    final `HealthSmell[]`)
- `crossFile.ts` + `crossFile/` — shim plus focused cross-file modules:
  `resolveImport.ts` (extension/index/alias/Python-relative resolution),
  `graph.ts` (thin orchestrator — edge construction, Tarjan SCCs,
  reachability, and dead-code classification, delegating to sibling
  `importGraph`/`cycles`/`reachability`/`deadCode` modules; see
  `crossFile/CLAUDE.md`), `roots.ts` (entry-point detection +
  `RESOLVABLE_IMPORT_EXTS`), and `apply.ts` (patch fanIn/fanOut/inCycle
  smells + the `deadCode` status back into `HealthMetrics`).
  The dead-code pass is reachability-from-roots, not raw `fanIn===0`, so dead
  islands/cycles and entry points classify correctly; it is deliberately kept
  out of `computeScore` (orphan status is a signal, not a penalty). Roots come
  from the scan (`scanner/scan.ts`) and the watcher (`crossFileAnalyzer.ts`);
  the `D` overlay consumes the result.
  - **Resolver accuracy (TS-first).** The dominant false-dead cause is dropped
    edges. `resolveImport.ts` therefore: maps NodeNext `.js`/`.mjs`/`.cjs`/`.jsx`
    specifiers to their TS twins (`./types.js` → `types.ts`) — without this a
    `"module":"NodeNext"` backend loses ~every internal edge; resolves
    `baseUrl`-relative bare imports via a `tsconfig.ts` catch-all alias (bare
    specifiers only — relative imports always resolve against the importer);
    and the walker captures `export … from` re-exports + string-literal dynamic
    `import()`/`require()` (`walker/importEdges.ts`, delegated from
    `walker/visitors.ts`) so barrels and lazy routes aren't orphaned. Python:
    every name of `import a, b as c` plus the `pkg.name` submodule candidate
    of each `from pkg import name` is captured, and a bare dotted spec is
    resolved against the importer's ancestor dirs (`resolveImport/pythonImports.ts`)
    instead of being dropped as an external package.
  - **Entry-point roots** (`roots.ts`): conventional filenames (`index`/`main`/
    `*.config.*`/tests/`.d.ts`), standalone process/CLI entries (`*-server`,
    `*.worker`, files under a `scripts/`|`tools/` dir — spawned by path, never
    imported), user `deadCodeEntryGlobs`, and package.json entry targets across
    all in-tree `package.json`s (`main`/`module`/`source`/`bin`/`exports` + file
    refs inside `scripts`).
  - **Dead-eligible languages** (`RESOLVABLE_IMPORT_EXTS` in `roots.ts`): only
    genuine importable source modules (`.ts/.tsx/.js/.jsx/.py/.pyi`) are
    confidently flagged `dead` when unreachable. `.mjs`/`.cjs` are excluded —
    in TS-first projects they're overwhelmingly tooling/runtime assets loaded
    by path (e.g. a `.cjs` template `fs.readFile`-d, invisible to import
    analysis), so an unreachable one is `uncertain`, never red. (The general
    fix — capturing string-literal fs/path references as weak reachability
    edges — is the future enhancement for non-TS asset accuracy.)
  - **Confidence guard** (`graph.ts`): if >70% of resolvable non-root files come
    back dead (the fingerprint of a resolver gap, not a real dead codebase),
    every `dead` is downgraded to `uncertain` and `scan.ts` logs a warning — a
    resolver blind spot can never paint a whole project red.
  - **Cache coupling:** import extraction feeds the `(mtime,size)`-keyed health
    cache, which does NOT invalidate on analyzer-logic changes. Any change to
    edge capture / resolution MUST bump `CACHE_VERSION` in `cachePaths.ts` or
    existing projects keep serving stale `imports` (this was why the first cut
    showed most files dead).
- `crossFileAnalyzer.ts` — watcher-facing diff/broadcast wrapper around the
  cross-file pass. Coalesces a burst of file events into one trailing-edge
  pass (150 ms — each pass is a synchronous full-project O(V+E) walk on the
  main thread, so the window is what stops an agent writing files continuously
  from stalling HTTP/WS/pty relaying every few dozen ms). Memoizes the
  present-file `Set` alongside the root set (both invalidated by
  `invalidateRoots`, called on every add/remove/re-seed): reusing ONE Set
  identity across content-only passes is what lets the case-fold import index
  in `crossFile/resolveImport/caseFold.ts` (a WeakMap keyed by that Set) hit
  instead of being rebuilt per keystroke on Windows/macOS.
- `scoreMetadata.ts` — serializable source of truth for score component ids,
  ordering, weights, thresholds, and direction. The frontend health legend imports
  this file directly; do not duplicate score metadata in UI code.
- `scoreModel.ts` — backend-only adapter that adds metric extractor functions to
  `scoreMetadata.ts` components for scoring
- `score.ts` + `constants.ts` — final score calculation over the score model; shared thresholds
- `scoreMath.ts` — the shared `clamp01`/`norm` primitives both `score.ts` and
  `scoreModel.ts` use; single source so the two scorers can't silently diverge
- `watcher.ts` + `watcher/` — `watcher.ts` is a thin facade owning the
  singleton `watchers` map (`ensureWatcher` promise memoization) plus the
  shutdown-flush lifecycle hooks (`flushWatcherCaches`, the once-only
  process-exit handlers) and the public surface (`subscribeHealth`,
  `beginWatcherScan`, `watcherScanRevision`, test helpers, `HealthUpdate` type). `watcher/` holds the
  extracted helpers: `setup.ts` (`createWatcher` — per-root construction plus
  the tree-watcher creation (`../../watchTree.ts`: recursive `fs.watch` on
  win32, chokidar elsewhere) + event-wiring; takes the facade's shutdown-flush
  registrar as a callback), `cacheHydration.ts` (cache → in-memory graph
  mirror), `fileAnalysis.ts` (read/LOC count/cache-or-analyze — the read +
  analyzer hand-off of one file runs under a machine-wide 8-slot gate,
  `../../concurrencyLimit.ts`, because the watcher's handlers are
  fire-and-forget and a 5,000-file checkout otherwise started 5,000
  overlapping `fs.readFile`s with every body buffered ahead of the single
  serial analyzer; the (mtime,size) cache check stays outside the gate),
  `handlers.ts` (add/change/remove event handlers), `subscribers.ts`
  (broadcast-safe subscriber fan-out), `isolatedAnalyze.ts`, and `types.ts`.
  Directory add/remove events invalidate the scan revision synchronously but
  broadcast ONE coalesced `rescan` per 100 ms burst (`setup.ts`
  `createDirectoryRescanCoalescer`) — a checkout creating forty directories
  used to push forty frames, each of which made every client re-issue
  `/api/scan`.
  `revision.ts` stamps events before config/read/analysis awaits. Only the
  newest event for a path may publish maps or cache entries, so an older
  analysis cannot resurrect an unlinked file or overwrite a newer edit.
  Config reloads separately fence ignore/alias assignment across async reads.
  `scanPublication.ts` captures the watcher identity/revision before a scan's
  first await, copies the live cache (including pending debounced saves — a
  targeted copy of the one mutated object, `metrics` + its `smells`, and the
  `imports` array, not a `structuredClone` per entry, which cost tens of ms of
  uninterruptible main-thread time at the front of every scan), and
  seeds maps/cache only if no event, newer scan, or watcher creation intervened.
  A committed scan also hands the watcher its freshly-resolved dead-code
  root inputs (package.json entry targets + entry globs) via
  `CrossFileAnalyzer.setRootInputs` — the watcher resolves those once at
  creation against the on-disk cache, which is EMPTY for a fresh project, so
  without the hand-over its first recompute after any keystroke flipped every
  package.json entry target (and the subtree only it reaches) to `dead`.
  Scans never share mutable metrics with the watcher during analysis. Cache I/O
  is ordered across cache instances, including reads during a pending flush.
  `isolatedAnalyze.ts` runs each changed file's analysis in a **warm persistent
  worker thread** (`IsolatedAnalyzer` singleton, serial single-in-flight queue,
  per-file stall watchdog) so a pathological changed file can only pin the worker
  thread, never freeze the backend event loop — the watcher analogue of the
  scan's `scanner/healthWorkerRunner.ts`. It reuses ONE warm worker (tree-sitter
  WASM init amortized: ~117 ms first file, ~1 ms after) to avoid a per-event
  spawn storm on a checkout/format-all. `analyzeContentIsolated` throws
  `WorkerUnavailableError` when the worker can't be used (e.g. `src` under tsx);
  `fileAnalysis.ts` then falls back to in-thread `analyzeFile` (a `null` result,
  by contrast, is a watchdog/analysis skip and is NOT retried in-thread). That
  fallback is the one path with the isolation switched off — it runs the same
  tree-sitter WASM analyzer on the backend's MAIN thread, where a hang freezes
  the event loop and a fault in the WASM runtime kills the process outright
  (with no chance to log it — see `crashLog.ts`). So giving up is deliberately
  **temporary**: three worker deaths write it off for `UNAVAILABLE_COOLDOWN_MS`
  (60s), not for the life of the process as it once did. An *init* failure
  (no compiled `analyze.js`) stays permanent, since retrying can never help. The
  worker is `unref()`'d and disposed on graceful shutdown (`watcher.ts`
  `flushThenExit`).
- `analysisWorker.ts` — the eval-worker primitives shared by
  `watcher/isolatedAnalyze.ts` and `../scanner/healthWorkerRunner.ts`
  (`DEFAULT_ANALYSIS_STALL_MS`, `spawnEvalWorker`, `terminateQuietly`,
  `createStallTimer`, `unref` chosen per call site); protocol and respawn policy
  stay in each caller.
- `cache.ts` + `cachePaths.ts` + `cacheFile.ts` — persistent per-file health
  cache at `<project>/.lattice/health-cache.json`, keyed by absolute path with
  `(mtime,size)` staleness. `cache.ts` is the `HealthCache` class: in-memory
  state + its load/get/set/delete/prune/save/flush transitions, debounced
  coalesced writes, save-chain serialization, dirty-bit rearm-on-failure.
  `cachePaths.ts` owns the location + `CACHE_VERSION` (bump it on any import-
  extraction/resolver change — see the crossFile cache-coupling note above —
  and on any change to cached metric output, e.g. v5: Rust lifetimes in the
  universal strip pass).
  `cacheFile.ts` owns the crash-safe I/O: raw read plus the same-dir temp
  write → atomic rename (transient-Windows-rename retry + temp cleanup).
  `tsconfig.ts` — tsconfig alias resolution
- `walkTree.ts` — `walkSourceTree`, the one bounded, skip-dir-aware directory
  walker shared by tsconfig discovery + `crossFile/packageRoots.ts`
- `configReloader.ts` — `ConfigReloader`: loads the project `.gitignore` matcher
  + tsconfig aliases and refreshes them when the ROOT `.gitignore`/`tsconfig*`
  changes (full rescan). A NESTED `tsconfig*` edit reloads only the merged
  alias map (`reloadAliasesForNestedTsconfig`) and re-runs cross-file, with no
  rescan broadcast; a nested `.gitignore` is ignored
- `index.ts` / `utils.ts` — public re-export barrel; `smellsToArray` helper
- `types.ts` — `HealthMetrics` / `HealthSmellId` definitions

Adding a smell: update `types.ts` (id + label), emit it from `walker/` or
`universal/smells.ts`, and add a `scoreModel.ts` component if it gates the
score. Adding a language: add to `grammarKeyForExt` in `parser.ts` + a
`NodeKinds` factory in `nodeKinds/`.
