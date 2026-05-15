import type { ParsedAlias } from '../tsconfig.js';
import { resolveImport } from './resolveImport.js';

export type FileImports = {
  filePath: string;
  imports: string[];
};

export type CrossFileResult = {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  inCycle: Set<string>;
  // For introspection / debugging.
  totalEdges: number;
};

export type ImportGraph = {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  edges: Map<string, Set<string>>;
  totalEdges: number;
};

export function computeCrossFile(
  fileImports: FileImports[],
  presentFiles: Set<string>,
  aliases?: readonly ParsedAlias[],
): CrossFileResult {
  const graph = buildImportGraph(fileImports, presentFiles, aliases);
  const sccs = tarjan(Array.from(presentFiles), graph.edges);
  const inCycle = cyclicNodes(sccs, graph.edges);

  return {
    fanIn: graph.fanIn,
    fanOut: graph.fanOut,
    inCycle,
    totalEdges: graph.totalEdges,
  };
}

export function buildImportGraph(
  fileImports: FileImports[],
  presentFiles: Set<string>,
  aliases?: readonly ParsedAlias[],
): ImportGraph {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const edges = new Map<string, Set<string>>();

  for (const f of presentFiles) {
    fanIn.set(f, 0);
    fanOut.set(f, 0);
    edges.set(f, new Set());
  }

  let totalEdges = 0;
  for (const fi of fileImports) {
    if (!presentFiles.has(fi.filePath)) continue;

    const seen = new Set<string>();
    for (const spec of fi.imports) {
      const resolved = resolveImport(fi.filePath, spec, presentFiles, aliases);
      if (!resolved) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);

      edges.get(fi.filePath)!.add(resolved);

      // Preserve existing fan-in/fan-out semantics: importing yourself does not
      // inflate either fan counter, but the edge stays in the graph so Tarjan can
      // mark it as a self-loop cycle.
      if (resolved === fi.filePath) continue;

      fanOut.set(fi.filePath, (fanOut.get(fi.filePath) ?? 0) + 1);
      fanIn.set(resolved, (fanIn.get(resolved) ?? 0) + 1);
      totalEdges++;
    }
  }

  return { fanIn, fanOut, edges, totalEdges };
}

// Tarjan's strongly-connected components. Returns an array of SCCs; any SCC
// with more than one node — or a single node that imports itself — is a
// dependency cycle.
export function tarjan(
  nodes: string[],
  edges: Map<string, Set<string>>,
): string[][] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const successors = edges.get(v);
    if (successors) {
      for (const w of successors) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const n of nodes) {
    if (!indices.has(n)) strongConnect(n);
  }

  return sccs;
}

export function cyclicNodes(
  sccs: string[][],
  edges: Map<string, Set<string>>,
): Set<string> {
  const inCycle = new Set<string>();
  for (const scc of sccs) {
    if (scc.length > 1) {
      for (const n of scc) inCycle.add(n);
    } else if (scc.length === 1) {
      const n = scc[0];
      if (edges.get(n)?.has(n)) inCycle.add(n);
    }
  }
  return inCycle;
}
