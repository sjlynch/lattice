# backend/src/health

Tree-sitter-driven per-file metrics pipeline. Each file is parsed to an AST
(with universal regex helpers for languages lacking a grammar), run through
Halstead token counts and a Maintainability Index, and folded into a composite
0-100 health score plus a set of code "smells".

## Files

- `parser.ts` — grammar load/cache; `grammarKeyForExt` maps extensions to grammars
- `nodeKinds.ts` — per-language node-kind sets (function/branch/loop/etc.)
- `walker.ts` — re-export shim for `walker/`, whose context + visitor helpers perform the single AST pass producing a `FileAnalysis`
- `halstead.ts` — operator/operand tokenization + Maintainability Index
- `universal.ts` — re-export shim for focused universal text helpers in `universal/` (`commentSyntax`, `lineCounts`, `strip`, `smells`)
- `analyze.ts` — top-level `analyzeFile` entry point
- `crossFile.ts` — fanIn/fanOut/inCycle patch-in pass over the file set
- `scoreModel.ts` — score component ids, weights, thresholds, and metric extractors
- `score.ts` — final score calculation over the score model
- `watcher.ts` — chokidar watcher rebroadcasting changed-file metrics
- `cache.ts` — LRU file-content cache; `tsconfig.ts` — tsconfig alias resolution
- `types.ts` — `HealthMetrics` / `HealthSmellId` definitions

Adding a smell: update `types.ts` (id + label), emit it from `walker/` or
`universal/smells.ts`, and add a `scoreModel.ts` component if it gates the
score. Adding a language: add to `grammarKeyForExt` in `parser.ts` + a
`NodeKinds` factory in `nodeKinds.ts`.
