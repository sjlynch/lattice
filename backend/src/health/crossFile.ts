// Re-export shim: cross-file health analysis now lives under
// `./crossFile/`. Existing callers import `./crossFile.js`.
export {
  applyCrossFile,
  buildImportGraph,
  computeCrossFile,
  cyclicNodes,
  INDEX_FILES,
  normalizePythonRelativeImport,
  RESOLVE_EXTS,
  resolveByAlias,
  resolveImport,
  tarjan,
  tryAllExtensions,
  type CrossFileResult,
  type FileImports,
  type ImportGraph,
} from './crossFile/index.js';
