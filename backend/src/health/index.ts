// Public entry point for the health module. Tree-sitter (WASM)
// powered AST analysis for TS/JS/Python; text-only fallback for
// everything else. Cross-file metrics (fan-in/fan-out/cycles) layer
// on after the per-file pass via `applyCrossFile`.

export { analyzeFile, type AnalyzeResult } from './analyze.js';
export type {
  HealthMetrics,
  HealthSmell,
  HealthSmellId,
  HealthLanguage,
  HalsteadMetrics,
  DeadCodeStatus,
} from './types.js';
export { SMELL_LABELS } from './types.js';
export { HealthCache } from './cache.js';
export {
  computeCrossFile,
  applyCrossFile,
  compileEntryGlobs,
  detectRoots,
  readPackageJsonRoots,
  type ComputeCrossFileOptions,
  type FileImports,
  type CrossFileResult,
} from './crossFile.js';
export { preloadGrammar, grammarKeyForExt } from './parser.js';
