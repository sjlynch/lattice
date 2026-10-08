export { applyCrossFile } from './crossFile/apply.js';
export {
  buildImportGraph,
  computeCrossFile,
  computeReachability,
  cyclicNodes,
  tarjan,
  type ComputeCrossFileOptions,
  type CrossFileResult,
  type DeadCodeStats,
  type FileImports,
  type ImportGraph,
} from './crossFile/graph.js';
export {
  INDEX_FILES,
  RESOLVE_EXTS,
  normalizePythonRelativeImport,
  resolveByAlias,
  resolveImport,
  tryAllExtensions,
} from './crossFile/resolveImport.js';
export {
  RESOLVABLE_IMPORT_EXTS,
  compileEntryGlobs,
  detectRoots,
  isConventionalRoot,
  matchesEntryGlob,
} from './crossFile/roots.js';
export { readPackageJsonRoots } from './crossFile/packageRoots.js';
