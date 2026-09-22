// Re-export shim: import resolution now lives under `./resolveImport/` as a set
// of focused pure modules (case-folded filesystem index, extension/index
// candidates + NodeNext .js→.ts remap, Python relative-import translation,
// tsconfig alias resolution). Existing callers import `./resolveImport.js`; the
// public surface is unchanged. See ./resolveImport/index.ts for the module map.
export {
  INDEX_FILES,
  RESOLVE_EXTS,
  normalizePythonRelativeImport,
  resolvePythonAbsoluteImport,
  resolveByAlias,
  resolveImport,
  tryAllExtensions,
} from './resolveImport/index.js';
