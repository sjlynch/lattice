export { applyCrossFile } from './apply.js';
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
} from './graph.js';
export {
  INDEX_FILES,
  RESOLVE_EXTS,
  normalizePythonRelativeImport,
  resolveByAlias,
  resolveImport,
  tryAllExtensions,
} from './resolveImport.js';
export {
  RESOLVABLE_IMPORT_EXTS,
  detectRoots,
  isConventionalRoot,
  matchesEntryGlob,
  readPackageJsonRoots,
} from './roots.js';
