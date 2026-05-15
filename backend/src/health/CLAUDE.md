# backend/src/health

Tree-sitter-driven per-file metrics pipeline. Each file is parsed to an AST
(with universal regex helpers for languages lacking a grammar), run through
Halstead token counts and a Maintainability Index, and folded into a composite
0-100 health score plus a set of code "smells".

## Files

- `parser.ts` — grammar load/cache; `grammarKeyForExt` maps extensions to grammars
- `nodeKinds.ts` + `nodeKinds/` — shim plus per-language node-kind sets
  (function/branch/loop/etc.) — `base.ts` plus one file per language
  (`typescript.ts`, `python.ts`, `go.ts`, …)
- `walker.ts` + `walker/` — shim plus the single AST pass producing a
  `FileAnalysis`; see `walker/CLAUDE.md`. `walker/index.ts` orchestrates the
  walk via a `context.ts` `WalkerContext` plus visitor helpers in
  `visitors.ts` (`handleComment`, `handleFunctionEntry`/`Exit`,
  `handleFileStructure`, `handleImportsAndStrings`, `handleAstSmells`,
  `handleExportTracking`, `updateComplexity`, `handleAwaitExpression`,
  `handleCallExpression`), which in turn delegate to the sub-passes
  `complexity.ts`, `depth.ts`, `functionRecord.ts`, and `smells.ts`
- `halstead.ts` — operator/operand tokenization + Maintainability Index
- `universal.ts` + `universal/` — shim plus focused universal text helpers:
  `commentSyntax.ts` (per-language line/block comment markers),
  `lineCounts.ts` (line-kind counter), `strip.ts`
  (`stripStringsAndComments` lexer), and `smells.ts` (regex/heuristic
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
  - `analyze/smells.ts` — `assembleSmells` (folds AST smell tokens, magic
    strings, universal regex smells, and threshold-derived smells into the
    final `HealthSmell[]`)
- `crossFile.ts` / `crossFileAnalyzer.ts` — fanIn/fanOut/inCycle patch-in pass over the file set
- `scoreMetadata.ts` — serializable source of truth for score component ids,
  ordering, weights, thresholds, and direction. The frontend health legend imports
  this file directly; do not duplicate score metadata in UI code.
- `scoreModel.ts` — backend-only adapter that adds metric extractor functions to
  `scoreMetadata.ts` components for scoring
- `score.ts` + `constants.ts` — final score calculation over the score model; shared thresholds
- `watcher.ts` — chokidar watcher rebroadcasting changed-file metrics
- `cache.ts` — LRU file-content cache; `tsconfig.ts` — tsconfig alias resolution
- `types.ts` — `HealthMetrics` / `HealthSmellId` definitions

Adding a smell: update `types.ts` (id + label), emit it from `walker/` or
`universal/smells.ts`, and add a `scoreModel.ts` component if it gates the
score. Adding a language: add to `grammarKeyForExt` in `parser.ts` + a
`NodeKinds` factory in `nodeKinds/`.
