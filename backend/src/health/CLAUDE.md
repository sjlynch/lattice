# backend/src/health

Tree-sitter-driven per-file metrics pipeline. Each file is parsed to an AST
(with universal regex helpers for languages lacking a grammar), run through
Halstead token counts and a Maintainability Index, and folded into a composite
0-100 health score plus a set of code "smells".

## Files

- `analyze.ts` — top-level `analyzeFile`: parse-or-fallback, aggregate walker/Halstead metrics, assemble smells, compute score.
- `walker.ts` + `walker/` — shim plus split AST walker (`analyzeTree`, function records, complexity/depth/smell helpers); see `walker/CLAUDE.md`.
- `parser.ts` — grammar load/cache; `grammarKeyForExt` maps extensions to grammars.
- `nodeKinds.ts` + `nodeKinds/` — shim plus per-language node-kind sets (function/branch/loop/etc.).
- `halstead.ts` — operator/operand tokenization + Maintainability Index.
- `universal.ts` — regex helpers for fallback languages + line-kind counter.
- `crossFile.ts` / `crossFileAnalyzer.ts` — fanIn/fanOut/inCycle patch-in pass over the file set.
- `score.ts` + `constants.ts` — metric weighting, thresholds, and final score.
- `watcher.ts` — chokidar watcher rebroadcasting changed-file metrics; `cache.ts` — file-content cache; `tsconfig.ts` — tsconfig alias resolution.
- `types.ts` — `HealthMetrics` / `HealthSmellId` definitions.

Adding a smell: update `types.ts` (id + label), emit it from `walker/` or
`universal.ts`, and wire its weight/threshold in `score.ts`/`constants.ts` if
it gates the score. Adding a language: add to `grammarKeyForExt` in
`parser.ts` + a `NodeKinds` factory in `nodeKinds/`.
