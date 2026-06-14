import type { ParsedAlias } from '../tsconfig.js';
import { resolveImport } from './resolveImport.js';

export type FileImports = {
  filePath: string;
  imports: string[];
};

export type ImportGraph = {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  edges: Map<string, Set<string>>;
  totalEdges: number;
};

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

// Lowercased file extension (including the leading dot), or '' when the
// basename has none. Used by the dead-code pass to gate which files are
// confidently classifiable as dead.
export function extLower(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (dot <= slash) return '';
  return filePath.slice(dot).toLowerCase();
}
