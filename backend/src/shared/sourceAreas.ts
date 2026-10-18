export type AreaFile = { path: string; weight: number };
export type SourceArea = { paths: string[]; files: number; weight: number; label: string };
export type SourceAreasResult = { areas: SourceArea[]; totalFiles: number };
export type SourceTree = { path: string; name: string; files: number; weight: number; children: SourceTree[] };
export type CustomAreasResult = { areas: SourceArea[]; missing: string[]; overlaps: { path: string; areas: string[] }[]; rest: number };

const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp|scala|vue|svelte|dart|ex|exs|erl|lua|hs|zig|ml|m|mm|jl|r|pl|sh)$/i;
const EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.git',
  '__snapshots__', '__tests__', 'tests', 'test', 'spec', 'e2e', 'fixtures',
  // Not what a review of the product should spend an area on.
  'examples', 'example', 'benchmarks', 'benchmark', 'bench', 'docs',
]);
// runtime-tests/, integration_tests/, unit-test/ …
const TEST_DIR_SUFFIX = /[-_](tests?|specs?)$/;

export function isAreaSourceFile(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/');
  const basename = segments[segments.length - 1];
  return SOURCE_EXTENSION.test(basename)
    && !segments.slice(0, -1).some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()) || TEST_DIR_SUFFIX.test(segment.toLowerCase()))
    && !/\.(test|spec)\.[a-z0-9]+$/i.test(basename)
    && !/^test_.*\.py$/i.test(basename)
    && !/_test\.(go|py)$/i.test(basename)
    && !/\.d\.ts$/i.test(basename);
}


const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const parent = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
const under = (file: string, dir: string) => dir === '.' || file.startsWith(`${dir}/`);
const weightOf = (files: readonly AreaFile[]) => files.reduce((sum, f) => sum + f.weight, 0);
function sourceFiles(input: readonly (string | AreaFile)[]): AreaFile[] {
  const files = new Map<string, number>();
  for (const item of input) {
    const path = (typeof item === 'string' ? item : item.path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    const raw = typeof item === 'string' ? 1 : item.weight;
    const weight = Number.isFinite(raw) ? Math.max(1, Math.min(2000, Math.trunc(raw))) : 1;
    if (isAreaSourceFile(path)) files.set(path, Math.max(files.get(path) ?? 0, weight));
  }
  return [...files].sort(([a], [b]) => cmp(a, b)).map(([path, weight]) => ({ path, weight }));
}
export function areaPathMatches(scope: string, file: string): boolean {
  if (scope.endsWith('/*')) return parent(file) === scope.slice(0, -2);
  return scope === file || under(file, scope);
}

// Also used by the folder picker when naming a selection. With `weights`
// (parallel to `paths`), names lead with the heaviest pieces: the first path
// of a path-ordered group is often a small one.
export function sourceAreaLabel(paths: readonly string[], individualFiles = false, weights?: readonly number[]): string {
  if (!paths.length) return '';
  const one = (p: string) => p.endsWith('/*') ? `${p.slice(0, -2)} (top-level files)` : p;
  const byWeight = weights ? paths.map((p, i) => [p, weights[i] ?? 0] as const).sort((a, b) => b[1] - a[1]).map(([p]) => p) : [...paths];
  let label: string;
  if (paths.length === 1) label = one(paths[0]);
  else if (individualFiles && paths.every((p) => parent(p) === parent(paths[0]))) {
    label = `${parent(paths[0])}: ${paths[0].split('/').pop()} … ${paths[paths.length - 1].split('/').pop()} (${paths.length} files)`;
  } else if (!individualFiles && paths.every((p) => !p.endsWith('/*'))) {
    let common = parent(paths[0]);
    while (common !== '.' && !paths.every((p) => under(p, common))) common = parent(common);
    const names = byWeight.slice(0, 3).map((p) => common === '.' ? p : p.slice(common.length + 1));
    label = `${common === '.' ? '' : `${common}: `}${names.join(', ')}${paths.length > 3 ? ` +${paths.length - 3}` : ''}`;
  } else label = `${byWeight.slice(0, 2).map(one).join(', ')}${paths.length > 2 ? ` +${paths.length - 2}` : ''}`;
  return label.length <= 80 ? label : `${label.slice(0, 79)}…`;
}

type Piece = { path: string; members: AreaFile[]; kind: 'directory' | 'direct' | 'file' };
const size = (p: Piece) => weightOf(p.members);
function children(piece: Piece): Piece[] {
  if (piece.kind === 'file') return [];
  const direct = piece.members.filter((f) => parent(f.path) === piece.path);
  if (piece.kind === 'direct' || direct.length === piece.members.length) {
    return piece.members.map((f) => ({ path: f.path, members: [f], kind: 'file' }));
  }
  const folders = new Map<string, AreaFile[]>();
  for (const file of piece.members) {
    if (parent(file.path) === piece.path) continue;
    const tail = piece.path === '.' ? file.path : file.path.slice(piece.path.length + 1);
    const dir = piece.path === '.' ? tail.split('/')[0] : `${piece.path}/${tail.split('/')[0]}`;
    const members = folders.get(dir) ?? []; members.push(file); folders.set(dir, members);
  }
  const out: Piece[] = [...folders].map(([path, members]) => ({ path, members, kind: 'directory' }));
  if (direct.length) out.push({ path: piece.path, members: direct, kind: 'direct' });
  return out.sort((a, b) => a.kind === 'direct' ? -1 : b.kind === 'direct' ? 1 : cmp(a.path, b.path));
}
function partitionPackage(files: AreaFile[], root: string, count: number, roots: string[]): SourceArea[] {
  const total = weightOf(files);
  const nodes: Piece[] = [{ path: root, members: files, kind: 'directory' }];
  for (;;) {
    const candidate = nodes.filter((p) => p.kind !== 'file' && (
      (size(p) > total / count && p.members.length > 1) ||
      (p.kind === 'directory' && roots.some((r) => r !== root && under(r, p.path)))
    )).sort((a, b) => size(b) - size(a) || cmp(a.path, b.path))[0];
    if (!candidate) break;
    nodes.splice(nodes.indexOf(candidate), 1, ...children(candidate));
  }
  nodes.sort((a, b) => {
    if (a.kind === 'direct' && under(b.path, a.path)) return -1;
    if (b.kind === 'direct' && under(a.path, b.path)) return 1;
    return cmp(a.path, b.path);
  });
  const groups = Math.min(count, nodes.length);
  const fill = (cap: number): Piece[][] => {
    const out: Piece[][] = [[]]; let used = 0;
    for (const p of nodes) {
      if (out[out.length - 1].length && used + size(p) > cap) { out.push([]); used = 0; }
      out[out.length - 1].push(p); used += size(p);
    }
    return out;
  };
  let low = Math.max(...nodes.map(size)), high = total;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (fill(mid).length <= groups) high = mid; else low = mid + 1; }
  const parts = fill(low);
  const partWeight = (part: Piece[]) => part.reduce((s, p) => s + size(p), 0);
  while (parts.length < groups) {
    const i = parts.reduce((best, p, j) => p.length > 1 && (best < 0 || partWeight(p) > partWeight(parts[best])) ? j : best, -1);
    if (i < 0) break;
    const part = parts[i]; let cut = 1, gap = Infinity;
    for (let k = 1; k < part.length; k++) {
      const next = Math.abs(partWeight(part.slice(0, k)) - partWeight(part.slice(k)));
      if (next < gap) { gap = next; cut = k; }
    }
    parts.splice(i, 1, part.slice(0, cut), part.slice(cut));
  }
  return parts.map((part) => {
    const paths = part.map((p) => p.kind === 'direct' ? `${p.path}/*` : p.path);
    const allFiles = part.every((p) => p.kind === 'file');
    const label = sourceAreaLabel(paths, allFiles, part.map(size));
    return { paths, files: part.reduce((s, p) => s + p.members.length, 0), weight: partWeight(part), label };
  });
}

export function partitionSourceAreas(input: readonly (string | AreaFile)[], count: number, opts?: { packageRoots?: readonly string[] }): SourceArea[] {
  count = Math.max(2, Math.min(16, Math.trunc(count) || 2));
  const files = sourceFiles(input), total = weightOf(files);
  if (files.length < 10) return [{ paths: ['.'], files: files.length, weight: total, label: 'whole repository' }];
  let roots = [...new Set(['.', ...(opts?.packageRoots ?? []).map((p) => p.replace(/\\/g, '/').replace(/\/$/, ''))])].sort(cmp);
  const assign = () => {
    const packages = new Map<string, AreaFile[]>();
    for (const file of files) {
      const root = roots.filter((r) => under(file.path, r)).sort((a, b) => (b === '.' ? 0 : b.length) - (a === '.' ? 0 : a.length) || cmp(a, b))[0];
      const members = packages.get(root) ?? []; members.push(file); packages.set(root, members);
    }
    return packages;
  };
  let packages = assign();
  for (;;) {
    const tiny = roots.filter((r) => r !== '.' && weightOf(packages.get(r) ?? []) < total / (2 * count))
      .sort((a, b) => b.length - a.length || cmp(a, b))[0];
    if (!tiny) break;
    roots = roots.filter((r) => r !== tiny); packages = assign();
  }
  while (packages.size > count) {
    const lightest = [...packages.keys()].filter((r) => r !== '.')
      .sort((a, b) => weightOf(packages.get(a)!) - weightOf(packages.get(b)!) || cmp(a, b))[0];
    roots = roots.filter((r) => r !== lightest); packages = assign();
  }
  // A thin root package (configs, a scripts folder) does not earn a reviewer
  // of its own: at 4 areas it took one of them for 20 files. Fold its pieces
  // into the lightest area of the real packages instead.
  const rootFiles = packages.get('.') ?? [];
  if (packages.size > 1 && rootFiles.length && weightOf(rootFiles) < total / (2 * count)) {
    packages.delete('.');
    const areas = partitionWithin(packages, count);
    const rest = partitionPackage(rootFiles, '.', 1, ['.', ...packages.keys()])[0];
    const i = areas.reduce((best, a, k) => (a.weight < areas[best].weight ? k : best), 0);
    const host = areas[i];
    const more = /^(.*) \+(\d+)$/.exec(host.label);
    areas[i] = {
      paths: [...host.paths, ...rest.paths], files: host.files + rest.files, weight: host.weight + rest.weight,
      label: (more ? `${more[1]} +${+more[2] + rest.paths.length}` : `${host.label} +${rest.paths.length}`).slice(0, 80),
    };
    return areas;
  }
  return partitionWithin(packages, count);
}

function partitionWithin(packages: Map<string, AreaFile[]>, count: number): SourceArea[] {
  const entries = [...packages].sort(([a], [b]) => cmp(a, b));
  // Constrained largest remainder: reserve packages whose proportional quota
  // is below one, then apportion the remaining seats proportionally.
  const seats = new Map<string, number>(); let remaining = count;
  let pending = entries;
  while (pending.length) {
    const sum = pending.reduce((s, [, f]) => s + weightOf(f), 0);
    const small = pending.filter(([, f]) => remaining * weightOf(f) / sum < 1);
    if (!small.length) {
      const quotas = pending.map(([r, f]) => ({ r, q: remaining * weightOf(f) / sum }));
      for (const { r, q } of quotas) seats.set(r, Math.floor(q));
      let extra = remaining - quotas.reduce((s, { q }) => s + Math.floor(q), 0);
      for (const { r } of quotas.sort((a, b) => (b.q % 1) - (a.q % 1) || cmp(a.r, b.r))) if (extra-- > 0) seats.set(r, seats.get(r)! + 1);
      break;
    }
    for (const [r] of small) { seats.set(r, 1); remaining--; }
    pending = pending.filter(([r]) => !seats.has(r));
  }
  return entries.flatMap(([root, members]) => partitionPackage(members, root, seats.get(root)!, [...packages.keys()]));
}

// A minimal cover relative to the complete production-source universe.
function minimalCover(all: AreaFile[], selected: Set<string>, dir = '.'): string[] {
  const members = all.filter((f) => under(f.path, dir));
  const chosen = members.filter((f) => selected.has(f.path));
  if (!chosen.length) return [];
  if (chosen.length === members.length) return [dir];
  const direct = members.filter((f) => parent(f.path) === dir);
  const picked = direct.filter((f) => selected.has(f.path));
  const out = picked.length && picked.length === direct.length ? [`${dir}/*`] : picked.map((f) => f.path);
  const dirs = new Set(members.filter((f) => parent(f.path) !== dir).map((f) => {
    const tail = dir === '.' ? f.path : f.path.slice(dir.length + 1);
    return dir === '.' ? tail.split('/')[0] : `${dir}/${tail.split('/')[0]}`;
  }));
  return [...out, ...[...dirs].sort(cmp).flatMap((d) => minimalCover(members, selected, d))];
}
export function resolveCustomAreas(input: readonly (string | AreaFile)[], wanted: readonly { label: string; paths: string[] }[], includeRest: boolean): CustomAreasResult {
  const files = sourceFiles(input), missing = new Set<string>();
  const claims = files.map((f) => ({ file: f, indices: wanted.flatMap((a, i) => a.paths.some((p) => areaPathMatches(p, f.path)) ? [i] : []) }));
  for (const area of wanted) for (const p of area.paths) if (!files.some((f) => areaPathMatches(p, f.path))) missing.add(p);
  const areas = wanted.flatMap((a, i) => {
    const owned = claims.filter((c) => c.indices[0] === i).map((c) => c.file);
    if (!owned.length) return [];
    // Preserve authored paths when disjoint; an overlapping later area must
    // have its scope narrowed so its planner cannot review first-owned files.
    const overlap = claims.some((c) => c.indices.includes(i) && c.indices[0] !== i);
    return [{ label: a.label.trim().slice(0, 80), paths: overlap ? minimalCover(files, new Set(owned.map((f) => f.path))) : a.paths.filter((p) => !missing.has(p)), files: owned.length, weight: weightOf(owned) }];
  });
  const restFiles = claims.filter((c) => !c.indices.length).map((c) => c.file);
  if (includeRest && restFiles.length) areas.push({ label: 'Everything else', paths: minimalCover(files, new Set(restFiles.map((f) => f.path))), files: restFiles.length, weight: weightOf(restFiles) });
  return { areas, missing: [...missing], overlaps: claims.filter((c) => c.indices.length > 1).map((c) => ({ path: c.file.path, areas: c.indices.map((i) => wanted[i].label) })), rest: restFiles.length };
}
export function buildSourceTree(input: readonly (string | AreaFile)[]): SourceTree {
  const root: SourceTree = { path: '.', name: '.', files: 0, weight: 0, children: [] };
  for (const file of sourceFiles(input)) {
    let node = root;
    for (const segment of file.path.split('/').slice(0, -1)) {
      let child = node.children.find((c) => c.name === segment);
      if (!child) { child = { path: node.path === '.' ? segment : `${node.path}/${segment}`, name: segment, files: 0, weight: 0, children: [] }; node.children.push(child); }
      node = child;
    }
    node.files++; node.weight += file.weight;
  }
  return root;
}

export function renderAreaScope(area: SourceArea): string {
  const list = area.paths.map((path) => path.endsWith('/*')
    ? `the files directly in \`${path.slice(0, -2)}\``
    : `\`${path}\``).join(', ');
  return `Scope for this step: review only ${list} (and what it calls, as needed). Other steps review the rest of the repository in parallel; file tasks only about code inside this scope.`;
}
