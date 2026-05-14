# backend/src/health

Tree-sitter-driven per-file metrics pipeline. Each file is parsed to an AST
(with universal regex helpers for languages lacking a grammar), run through
Halstead token counts and a Maintainability Index, and folded into a composite
0-100 health score plus a set of code "smells".

## Files

- `parser.ts` — grammar load/cache; `grammarKeyForExt` maps extensions to grammars
- `nodeKinds.ts` — re-export shim for `./nodeKinds/`, which holds per-language
  node-kind sets (function/branch/loop/etc.) — `base.ts` plus one file per
  language (`typescript.ts`, `python.ts`, `go.ts`, …)
- `walker.ts` — re-export shim for `./walker/`, which holds the single AST
  pass (`index.ts`) plus its sub-passes (`complexity.ts`, `depth.ts`,
  `functionRecord.ts`, `smells.ts`) producing a `FileAnalysis`
- `halstead.ts` — operator/operand tokenization + Maintainability Index
- `universal.ts` — regex helpers for fallback languages + line-kind counter
- `analyze.ts` — top-level `analyzeFile` entry point + `computeFromTree`
  orchestrator. Delegates to `./analyze/`:
  - `analyze/language.ts` — `languageForExt` (extension → `HealthLanguage`)
  - `analyze/fallback.ts` — `analyzeFallback` + `DEFAULT_METRICS` (used for
    unsupported languages, oversize files, parser/parse failures)
  - `analyze/functionMetrics.ts` — `aggregateFunctionMetrics` (per-function
    rollups: complexity max/total, function length, param counts, docstring/
    boolean-param/mixed-sync-async tallies) and `computeCallGraph` (internal
    call density + god-function heuristic)
  - `analyze/smells.ts` — `assembleSmells` (folds AST smell tokens, magic
    strings, universal regex smells, and threshold-derived smells into the
    final `HealthSmell[]`)
- `crossFile.ts` — fanIn/fanOut/inCycle patch-in pass over the file set
- `score.ts` — metric weighting + final score
- `watcher.ts` — chokidar watcher rebroadcasting changed-file metrics
- `cache.ts` — LRU file-content cache; `tsconfig.ts` — tsconfig alias resolution
- `types.ts` — `HealthMetrics` / `HealthSmellId` definitions

Adding a smell: update `types.ts` (id + label), emit it from `walker.ts`/
`universal.ts`, and wire its weight in `score.ts` if it gates the score.
Adding a language: add to `grammarKeyForExt` in `parser.ts` + a `NodeKinds`
factory in `nodeKinds.ts`.
