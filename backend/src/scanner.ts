// Re-export facade. The scanner pipeline now lives in scanner/. Keeping this
// file means routes/tests/watchers can continue importing from '../scanner.js'
// regardless of which phase they need.
export {
  collectSourceTree,
  collectSourceFiles,
  type DirectoryEntry,
  type CollectedSourceTree,
} from './scanner/collectSourceTree.js';
export {
  readForAnalysis,
  computeFileMetrics,
  type FileMetric,
} from './scanner/fileMetrics.js';
export { computeCoupling, type CouplingMap } from './scanner/coupling.js';
export {
  aggregate,
  commonRoot,
  ensureDirectoryNode,
  type GraphNode,
  type GraphLink,
  type ScanResult,
  type TreeAnalysis,
} from './scanner/graphAggregate.js';
export { loadGitignore } from './scanner/ignore.js';
export { scan } from './scanner/scan.js';
