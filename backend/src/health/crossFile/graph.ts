import type { ParsedAlias } from '../tsconfig.js';
import type { DeadCodeStatus } from '../types.js';
import { buildImportGraph, type FileImports, type ImportGraph } from './importGraph.js';
import { cyclicNodes, tarjan } from './cycles.js';
import { computeReachability } from './reachability.js';
import { classifyDeadCode, type DeadCodeStats } from './deadCode.js';

// Thin orchestrator for the cross-file pass: wires the import-graph builder,
// Tarjan cycle detection, reachability DFS, and dead-code classifier together
// behind computeCrossFile(). Each algorithm lives in a sibling module; this
// file re-exports their public surface so the historical `./graph.js` import
// path keeps resolving every symbol it used to.
export { buildImportGraph, computeReachability, cyclicNodes, tarjan };
export type { DeadCodeStats, FileImports, ImportGraph };

export type CrossFileResult = {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  inCycle: Set<string>;
  // Reachability from the root set, when one is supplied. `reachable` is the
  // transitive closure of imports from the roots; `deadCode` is the per-file
  // classification derived from it. Both empty when no roots are passed.
  reachable: Set<string>;
  deadCode: Map<string, DeadCodeStatus>;
  // Population/guard stats for the dead-code pass; undefined when no roots.
  deadCodeStats?: DeadCodeStats;
  // For introspection / debugging.
  totalEdges: number;
};

export type ComputeCrossFileOptions = {
  // Entry-point files. When provided, reachability + dead-code classification
  // run; when omitted they're skipped and the maps come back empty.
  roots?: Set<string>;
};

export function computeCrossFile(
  fileImports: FileImports[],
  presentFiles: Set<string>,
  aliases?: readonly ParsedAlias[],
  options: ComputeCrossFileOptions = {},
): CrossFileResult {
  const graph = buildImportGraph(fileImports, presentFiles, aliases);
  const sccs = tarjan(Array.from(presentFiles), graph.edges);
  const inCycle = cyclicNodes(sccs, graph.edges);

  let reachable = new Set<string>();
  let deadCode = new Map<string, DeadCodeStatus>();
  let deadCodeStats: DeadCodeStats | undefined;
  if (options.roots) {
    reachable = computeReachability(graph.edges, options.roots);
    ({ deadCode, deadCodeStats } = classifyDeadCode(
      presentFiles,
      options.roots,
      reachable,
    ));
  }

  return {
    fanIn: graph.fanIn,
    fanOut: graph.fanOut,
    inCycle,
    reachable,
    deadCode,
    deadCodeStats,
    totalEdges: graph.totalEdges,
  };
}
