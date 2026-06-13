import type { ParsedAlias } from '../tsconfig.js';
import type { DeadCodeStatus } from '../types.js';
import { resolveImport } from './resolveImport.js';
import { RESOLVABLE_IMPORT_EXTS } from './roots.js';

export type FileImports = {
  filePath: string;
  imports: string[];
};

export type CrossFileResult = {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  inCycle: Set<string>;
  // Reachability from the root set, when one is supplied. `reachable` is the
  // transitive closure of imports from the roots; `deadCode` is the per-file
  // classification derived from it. Both empty when no roots are passed.
  reachable: Set<string>;
  deadCode: Map<string, DeadCodeStatus>;
  // For introspection / debugging.
  totalEdges: number;
};

export type ComputeCrossFileOptions = {
  // Entry-point files. When provided, reachability + dead-code classification
  // run; when omitted they're skipped and the maps come back empty.
  roots?: Set<string>;
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
  options: ComputeCrossFileOptions = {},
): CrossFileResult {
  const graph = buildImportGraph(fileImports, presentFiles, aliases);
  const sccs = tarjan(Array.from(presentFiles), graph.edges);
  const inCycle = cyclicNodes(sccs, graph.edges);

  let reachable = new Set<string>();
  let deadCode = new Map<string, DeadCodeStatus>();
  if (options.roots) {
    reachable = computeReachability(graph.edges, options.roots);
    deadCode = classifyDeadCode(presentFiles, options.roots, reachable);
  }

  return {
    fanIn: graph.fanIn,
    fanOut: graph.fanOut,
    inCycle,
    reachable,
    deadCode,
    totalEdges: graph.totalEdges,
  };
}

// Forward reachability: every file transitively imported by a root. `edges`
// maps a file to the set of files it imports, so a DFS from the roots over
// `edges` is exactly "what does the live program pull in".
export function computeReachability(
  edges: Map<string, Set<string>>,
  roots: Iterable<string>,
): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [];
  for (const r of roots) {
    if (!reachable.has(r)) {
      reachable.add(r);
      stack.push(r);
    }
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const outs = edges.get(cur);
    if (!outs) continue;
    for (const next of outs) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }
  return reachable;
}

function classifyDeadCode(
  presentFiles: Set<string>,
  roots: Set<string>,
  reachable: Set<string>,
): Map<string, DeadCodeStatus> {
  const out = new Map<string, DeadCodeStatus>();
  for (const f of presentFiles) {
    if (roots.has(f)) {
      out.set(f, 'entry');
    } else if (reachable.has(f)) {
      out.set(f, 'live');
    } else {
      const ext = extLower(f);
      out.set(f, RESOLVABLE_IMPORT_EXTS.has(ext) ? 'dead' : 'uncertain');
    }
  }
  return out;
}

function extLower(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (dot <= slash) return '';
  return filePath.slice(dot).toLowerCase();
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
