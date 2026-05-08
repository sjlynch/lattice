// Cross-file health analysis: build the import graph from per-file
// import lists, then compute fan-in / fan-out / participation in
// circular dependencies. Results are merged back into each file's
// HealthMetrics in place; the per-file score is recomputed afterwards
// since cross-file penalties contribute to the composite.

import path from 'node:path';
import type { HealthMetrics } from './types.js';
import { computeScore } from './score.js';
import { bump, type SmellCounter } from './universal.js';
import { SMELL_LABELS } from './types.js';
import type { ParsedAlias } from './tsconfig.js';

export type FileImports = {
  filePath: string;
  imports: string[];
};

// Resolve a module specifier (as written in `import "./foo"`) to an
// absolute file path within the scanned tree. Best-effort:
//
//   1. Strip query/fragment portions
//   2. Skip external packages (no leading `.` or `/`)
//   3. For relative paths, try common extensions and `index.*`
//
// This isn't a full module resolver — we don't read package.json,
// don't follow `paths` in tsconfig, etc. — but it's accurate enough
// for fan-in/fan-out signals on well-organized projects.
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];
const INDEX_FILES = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  '__init__.py',
];

// Python relative imports surface as e.g. `.foo` or `..foo.bar`
// (leading dots indicate parent packages; remaining text is the
// dotted sub-package). Translate them into ordinary fs-relative
// specs so the rest of the resolver treats them like any other
// relative path.
function normalizePythonRelativeImport(spec: string): string {
  // Count the leading dots (each dot = one parent directory; the
  // first dot means "this directory").
  let dots = 0;
  while (dots < spec.length && spec[dots] === '.') dots++;
  if (dots === 0) return spec;
  const rest = spec.slice(dots).replace(/\./g, '/');
  // 1 dot → './rest' (current package); 2 → '../rest'; 3 → '../../rest'.
  const parents = '../'.repeat(Math.max(0, dots - 1));
  const combined = `${parents}${rest}`;
  if (!combined) return '.';
  return combined.startsWith('.') ? combined : `./${combined}`;
}

// Try a target absolute path with all the extensions / index-file
// fallbacks we'd accept for a real import. Returns the first match
// in `presentFiles`, or null if nothing landed.
function tryAllExtensions(
  target: string,
  presentFiles: Set<string>,
): string | null {
  if (presentFiles.has(target)) return target;
  for (const ext of RESOLVE_EXTS) {
    if (presentFiles.has(target + ext)) return target + ext;
  }
  for (const indexFile of INDEX_FILES) {
    const candidate = path.join(target, indexFile);
    if (presentFiles.has(candidate)) return candidate;
  }
  return null;
}

// Try the import against a tsconfig path-alias map. Aliases are
// pre-sorted longest-prefix-first in tsconfig.ts so the first match
// is the most specific.
function resolveByAlias(
  spec: string,
  aliases: readonly ParsedAlias[],
  presentFiles: Set<string>,
): string | null {
  for (const alias of aliases) {
    let tail: string | null = null;
    if (alias.isWildcard) {
      if (spec.startsWith(alias.prefix)) {
        tail = spec.slice(alias.prefix.length);
      }
    } else if (spec === alias.prefix) {
      tail = '';
    }
    if (tail === null) continue;
    for (const sub of alias.substitutions) {
      const target = tail ? path.join(sub, tail) : sub;
      const hit = tryAllExtensions(target, presentFiles);
      if (hit) return hit;
    }
  }
  return null;
}

function resolveImport(
  fromFile: string,
  spec: string,
  presentFiles: Set<string>,
  aliases?: readonly ParsedAlias[],
): string | null {
  if (!spec) return null;
  // Python relative imports come through with a leading-dot dotted
  // form; translate before treating them like fs paths.
  const normalized = fromFile.endsWith('.py') || fromFile.endsWith('.pyi')
    ? normalizePythonRelativeImport(spec)
    : spec;

  // Path-alias check has to come BEFORE the "external package" bail
  // because aliased specs (like `@/components/Foo`) look identical to
  // scoped npm packages — only the alias map can tell them apart.
  if (aliases && aliases.length > 0) {
    const aliased = resolveByAlias(normalized, aliases, presentFiles);
    if (aliased) return aliased;
  }

  // External package — `react`, `lodash/fp`, etc.
  if (
    !normalized.startsWith('.') &&
    !normalized.startsWith('/') &&
    !normalized.startsWith('\\')
  ) {
    return null;
  }

  const fromDir = path.dirname(fromFile);
  const target = path.resolve(fromDir, normalized);
  return tryAllExtensions(target, presentFiles);
}

// Tarjan's strongly-connected components. Returns an array of SCCs;
// any SCC with more than one node — or a single node that imports
// itself — is a dependency cycle.
function tarjan(
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

export type CrossFileResult = {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  inCycle: Set<string>;
  // For introspection / debugging.
  totalEdges: number;
};

export function computeCrossFile(
  fileImports: FileImports[],
  presentFiles: Set<string>,
  aliases?: readonly ParsedAlias[],
): CrossFileResult {
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
      if (!resolved || resolved === fi.filePath) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      edges.get(fi.filePath)!.add(resolved);
      fanOut.set(fi.filePath, (fanOut.get(fi.filePath) ?? 0) + 1);
      fanIn.set(resolved, (fanIn.get(resolved) ?? 0) + 1);
      totalEdges++;
    }
  }

  // Cycle detection via Tarjan's SCC.
  const sccs = tarjan(Array.from(presentFiles), edges);
  const inCycle = new Set<string>();
  for (const scc of sccs) {
    if (scc.length > 1) {
      for (const n of scc) inCycle.add(n);
    } else if (scc.length === 1) {
      // Self-loops also count.
      const n = scc[0];
      if (edges.get(n)?.has(n)) inCycle.add(n);
    }
  }

  return { fanIn, fanOut, inCycle, totalEdges };
}

// Merge cross-file results into per-file HealthMetrics in place.
// Adds the relevant smells, recomputes the composite score.
export function applyCrossFile(
  metrics: Map<string, HealthMetrics>,
  cross: CrossFileResult,
): void {
  for (const [filePath, m] of metrics) {
    m.fanIn = cross.fanIn.get(filePath) ?? 0;
    m.fanOut = cross.fanOut.get(filePath) ?? 0;
    m.inCycle = cross.inCycle.has(filePath);

    // Patch the smells list to reflect cross-file findings.
    const smellMap: SmellCounter = new Map();
    for (const s of m.smells) {
      smellMap.set(s.id, s.count);
    }
    if (m.inCycle) bump(smellMap, 'circular_dependency');
    if (m.fanOut > 25) bump(smellMap, 'high_fan_out');
    if (m.fanIn > 30) bump(smellMap, 'high_fan_in');

    // Rebuild smells array in the same shape `analyze.ts` produced.
    const out: { id: import('./types.js').HealthSmellId; count: number; label: string }[] = [];
    for (const [id, count] of smellMap) {
      if (count > 0) out.push({ id, count, label: SMELL_LABELS[id] });
    }
    out.sort((a, b) => b.count - a.count);
    m.smells = out;
    let total = 0;
    for (const s of out) total += s.count;
    m.smellCount = total;

    // Recompute the score with the cross-file fields in play.
    m.score = computeScore(m);
  }
}
