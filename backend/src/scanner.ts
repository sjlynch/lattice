// Re-export facade over the scanner pipeline in scanner/. Production code
// imports the phase modules in scanner/ directly; this facade's remaining
// importer is a test (`__tests__/userSettingsFieldShapes.test.ts`).
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
