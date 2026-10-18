// Runtime area resolution must be deterministic, weighted and package-local.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partitionSourceAreas, resolveCustomAreas, sourceAreaLabel, areaPathMatches, buildSourceTree, type AreaFile } from '../shared/sourceAreas.js';
const flat = (dir: string, n: number, weight = 1): AreaFile[] => Array.from({ length: n }, (_, i) => ({ path: `${dir}/f${i}.ts`, weight }));
function coverage(files: AreaFile[], areas: ReturnType<typeof partitionSourceAreas>) {
  for (const f of files) assert.equal(areas.filter((a) => a.paths.some((p) => areaPathMatches(p, f.path))).length, 1, f.path);
  for (const a of areas) {
    const members = files.filter((f) => a.paths.some((p) => areaPathMatches(p, f.path)));
    assert.equal(a.files, members.length); assert.equal(a.weight, members.reduce((s, f) => s + f.weight, 0));
  }
}
test('line weights balance rather than file counts; input order and duplicates do not matter', () => {
  const files = [...flat('a', 10, 100), ...flat('b', 100, 1)];
  const areas = partitionSourceAreas(files, 4);
  assert.ok(Math.max(...areas.map((a) => a.weight)) <= 300);
  assert.equal(areas.reduce((s, a) => s + a.weight, 0), 1100);
  coverage(files, areas);
  assert.deepEqual(partitionSourceAreas([...files].reverse(), 4), areas);
  assert.deepEqual(partitionSourceAreas([...files, ...files.map((f) => ({ ...f, path: f.path.replaceAll('/', '\\') }))], 4), areas);
  assert.equal(partitionSourceAreas([{ path: 'a.ts', weight: 9999 }, { path: 'b.ts', weight: 0 }], 2)[0].weight, 2001);
});
test('packages never share an area, including a root package with nested packages', () => {
  const files = [...flat('backend/src', 40), ...flat('frontend/src', 40), ...flat('scripts', 20)];
  const roots = ['frontend', '.', 'backend'];
  const areas = partitionSourceAreas(files, 8, { packageRoots: roots });
  assert.equal(areas.length, 8); coverage(files, areas);
  for (const a of areas) {
    const packages = new Set(files.filter((f) => a.paths.some((p) => areaPathMatches(p, f.path))).map((f) => f.path.split('/')[0]));
    assert.equal(packages.size, 1);
  }
  assert.deepEqual(partitionSourceAreas(files.reverse(), 8, { packageRoots: roots.reverse() }), areas);
});
test('a thin root package rides along with the lightest area instead of taking one', () => {
  // Lattice at 4 areas gave one whole reviewer to 20 config/script files.
  const files = [...flat('backend/src', 100), ...flat('frontend/src', 80), ...flat('scripts', 5), { path: 'vite.config.ts', weight: 1 }];
  const areas = partitionSourceAreas(files, 4, { packageRoots: ['.', 'backend', 'frontend'] });
  assert.equal(areas.length, 4); coverage(files, areas);
  const host = areas.filter((a) => a.paths.includes('scripts'));
  assert.equal(host.length, 1);
  assert.ok(host[0].paths.some((p) => p.startsWith('frontend')), host[0].paths.join(' '));
  assert.ok(areas.every((a) => a.files > 6));
});
test('tiny packages fold repeatedly into their parent; excess packages fold lightest first', () => {
  const files = [...flat('parent', 40), ...flat('parent/tiny', 1), ...flat('other', 40)];
  const opts = { packageRoots: ['parent', 'parent/tiny', 'other'] };
  const areas = partitionSourceAreas(files, 2, opts);
  assert.equal(areas.length, 2); coverage(files, areas);
  assert.ok(areas.some((a) => a.paths.includes('parent')));
  const many = [...flat('a', 10, 3), ...flat('b', 10, 2), ...flat('c', 10, 1)];
  const folded = partitionSourceAreas(many, 2, { packageRoots: ['a', 'b', 'c'] });
  assert.equal(folded.length, 2); coverage(many, folded);
  assert.ok(folded.some((a) => a.paths.includes('a')));
});
test('readable label forms are bounded and use a deepest common parent', () => {
  assert.equal(sourceAreaLabel(['src/foo']), 'src/foo');
  assert.equal(sourceAreaLabel(['src/*']), 'src (top-level files)');
  assert.equal(sourceAreaLabel(['src/a', 'src/b', 'src/c', 'src/d']), 'src: a, b, c +1');
  assert.equal(sourceAreaLabel(['src/x/a', 'src/y/b']), 'src: x/a, y/b');
  assert.equal(sourceAreaLabel(['src/a.ts', 'src/z.ts'], true), 'src: a.ts \u2026 z.ts (2 files)');
  assert.ok(partitionSourceAreas([...flat('src', 10), ...flat('src/child', 10)], 2).some((a) => a.label.includes('top-level files')));
  assert.equal(sourceAreaLabel(['src/*', 'other']), 'src (top-level files), other');
  assert.equal(sourceAreaLabel(['a', 'b/*', 'c'], false, [1, 30, 5]), 'b (top-level files), c +1');
  assert.equal(sourceAreaLabel(['src/a', 'src/b', 'src/c', 'src/d'], false, [1, 2, 9, 3]), 'src: c, d, b +1');
  assert.equal(sourceAreaLabel(['lib/a', 'src/b']), 'lib/a, src/b');
  assert.ok(sourceAreaLabel(['x'.repeat(100)]).length <= 80);
});
test('custom missing, first-wins overlap, empty drop, and exact minimal rest cover', () => {
  const files = [...flat('src/a', 2), ...flat('src/b', 2), ...flat('src/c', 2), ...flat('lib', 2), ...flat('src', 2)];
  const result = resolveCustomAreas(files, [
    { label: 'First', paths: ['src/a', 'absent'] }, { label: 'Later', paths: ['src/a', 'src/b/f0.ts'] },
    { label: 'Empty', paths: ['src/a'] },
  ], true);
  assert.deepEqual(result.missing, ['absent']);
  assert.equal(result.overlaps.length, 2);
  assert.deepEqual(result.overlaps[0].areas, ['First', 'Later', 'Empty']);
  assert.deepEqual(result.areas.map((a) => a.label), ['First', 'Later', 'Everything else']);
  assert.deepEqual(result.areas[1].paths, ['src/b/f0.ts']);
  assert.deepEqual(result.areas[2].paths, ['lib', 'src/*', 'src/b/f1.ts', 'src/c']);
  assert.equal(result.rest, 7); coverage(files, result.areas);
  assert.equal(resolveCustomAreas(files, [], false).rest, files.length);
  assert.deepEqual(resolveCustomAreas(files, [], true).areas[0].paths, ['.']);
  assert.equal(resolveCustomAreas(files, [], false).areas.length, 0);
});
test('source tree contains directories once with direct counts and weights', () => {
  assert.deepEqual(buildSourceTree([...flat('src', 2, 10), ...flat('src/a', 1, 20), 'root.ts']), {
    path: '.', name: '.', files: 1, weight: 1, children: [{ path: 'src', name: 'src', files: 2, weight: 20,
      children: [{ path: 'src/a', name: 'a', files: 1, weight: 20, children: [] }] }],
  });
});

test('single-character package roots are deeper than the always-present dot package', () => {
  const files = [...flat('a', 20), ...flat('b', 20)];
  const areas = partitionSourceAreas(files, 3, { packageRoots: ['a', 'b'] });
  assert.equal(areas.length, 3); coverage(files, areas);
  assert.ok(areas.every((a) => new Set(files.filter((f) => a.paths.some((p) => areaPathMatches(p, f.path))).map((f) => f.path[0])).size === 1));
});

test('dot-prefixed relative source inputs normalize without creating a self-repeating root piece', () => {
  const files = [...flat('a', 20), ...flat('b', 20)];
  assert.deepEqual(partitionSourceAreas(files.map((f) => ({ ...f, path: `./${f.path}` })), 4), partitionSourceAreas(files, 4));
});
