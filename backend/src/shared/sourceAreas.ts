export type SourceArea = { paths: string[]; files: number; label: string };
export type SourceAreasResult = { areas: SourceArea[]; totalFiles: number };

const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp|scala|vue|svelte|dart|ex|exs|erl|lua|hs|zig|ml|m|mm|jl|r|pl|sh)$/i;
const EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.git',
  '__snapshots__', '__tests__', 'tests', 'test', 'spec', 'e2e', 'fixtures',
]);

export function isAreaSourceFile(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/');
  const basename = segments[segments.length - 1];
  return SOURCE_EXTENSION.test(basename)
    && !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))
    && !/\.(test|spec)\.[a-z0-9]+$/i.test(basename)
    && !/^test_.*\.py$/i.test(basename)
    && !/_test\.(go|py)$/i.test(basename)
    && !/\.d\.ts$/i.test(basename);
}

type Directory = {
  path: string;
  files: number;
  direct: number;
  children: Map<string, Directory>;
};
type AreaNode = { path: string; files: number; directory?: Directory };
function comparePaths(a: AreaNode, b: AreaNode): number {
  if (a.path === b.path) return 0;
  // Direct files precede every child, including names like !utils that sort
  // before '*' lexically. The root's ./* likewise precedes root directories.
  const aDir = a.path.endsWith('/*') ? a.path.slice(0, -2) : null;
  const bDir = b.path.endsWith('/*') ? b.path.slice(0, -2) : null;
  if (aDir !== null && (aDir === '.' || b.path.startsWith(`${aDir}/`))) return -1;
  if (bDir !== null && (bDir === '.' || a.path.startsWith(`${bDir}/`))) return 1;
  return a.path < b.path ? -1 : 1;
}

function splitNode(node: AreaNode): AreaNode[] {
  const dir = node.directory;
  // Direct-file nodes and directories with no subdirectories are indivisible.
  if (!dir || dir.children.size === 0) return [];
  const children: AreaNode[] = [...dir.children.values()].map((child) => ({
    path: child.path, files: child.files, directory: child,
  }));
  if (dir.direct) children.push({ path: `${dir.path}/*`, files: dir.direct });
  return children.sort(comparePaths);
}

export function partitionSourceAreas(files: readonly string[], count: number): SourceArea[] {
  count = Math.max(2, Math.min(16, Math.trunc(count) || 2));
  const source = new Set(files.map((file) => file.replace(/\\/g, '/')).filter(isAreaSourceFile));
  const total = source.size;
  if (total < 10) return [{ paths: ['.'], files: total, label: 'whole repository' }];

  const root: Directory = { path: '.', files: 0, direct: 0, children: new Map() };
  for (const file of source) {
    const segments = file.split('/');
    segments.pop();
    let dir = root;
    dir.files++;
    for (const segment of segments) {
      let child = dir.children.get(segment);
      if (!child) {
        child = { path: dir === root ? segment : `${dir.path}/${segment}`, files: 0, direct: 0, children: new Map() };
        dir.children.set(segment, child);
      }
      dir = child;
      dir.files++;
    }
    dir.direct++;
  }

  // Split every node bigger than one area's share until none is left (or what
  // is left can't be split): balance needs pieces no bigger than the target.
  const nodes: AreaNode[] = [{ path: '.', files: total, directory: root }];
  for (;;) {
    // Path order breaks equal-size ties independently of scanner/input order.
    const candidate = nodes.filter((node) => node.files > total / count && node.directory?.children.size)
      .sort((a, b) => b.files - a.files || comparePaths(a, b))[0];
    if (!candidate) break;
    nodes.splice(nodes.indexOf(candidate), 1, ...splitNode(candidate));
  }
  nodes.sort(comparePaths);

  // Contiguous partition of the path-sorted nodes (keeps neighbours together)
  // minimizing the largest area: binary search on capacity, greedy fill.
  const groups = Math.min(count, nodes.length);
  const fill = (capacity: number): AreaNode[][] => {
    const out: AreaNode[][] = [[]];
    let size = 0;
    for (const node of nodes) {
      if (out[out.length - 1].length && size + node.files > capacity) { out.push([]); size = 0; }
      out[out.length - 1].push(node);
      size += node.files;
    }
    return out;
  };
  let low = Math.max(...nodes.map((node) => node.files));
  let high = total;
  while (low < high) {
    const capacity = Math.floor((low + high) / 2);
    if (fill(capacity).length <= groups) high = capacity;
    else low = capacity + 1;
  }
  const parts = fill(low);
  // Greedy fill can use fewer groups than asked; split the largest
  // multi-node group at its most balanced point until the count is met.
  const sizeOf = (part: AreaNode[]) => part.reduce((a, n) => a + n.files, 0);
  while (parts.length < groups) {
    const i = parts.reduce((best, part, j) => (part.length > 1 && (best < 0 || sizeOf(part) > sizeOf(parts[best])) ? j : best), -1);
    if (i < 0) break;
    const part = parts[i];
    let cut = 1;
    let bestGap = Infinity;
    for (let k = 1; k < part.length; k++) {
      const gap = Math.abs(sizeOf(part.slice(0, k)) - sizeOf(part.slice(k)));
      if (gap < bestGap) { bestGap = gap; cut = k; }
    }
    parts.splice(i, 1, part.slice(0, cut), part.slice(cut));
  }
  return parts.map((part) => {
    const paths = part.map((node) => node.path);
    return { paths, files: sizeOf(part), label: paths.length === 1 ? paths[0] : `${paths[0]} … ${paths[paths.length - 1]}` };
  });
}

export function renderAreaScope(area: SourceArea): string {
  const list = area.paths.map((path) => path.endsWith('/*')
    ? `the files directly in \`${path.slice(0, -2)}\``
    : `\`${path}\``).join(', ');
  return `Scope for this step: review only ${list} (and what it calls, as needed). Other steps review the rest of the repository in parallel; file tasks only about code inside this scope.`;
}
