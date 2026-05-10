// Re-export shim: the AST walker now lives under `./walker/`. Existing
// callers import `./walker.js`.
export { analyzeTree, type FnRecord, type FileAnalysis } from './walker/index.js';
