// Whole-repository planners missed coverage. Areas must cover production source
// exactly once, keep directory context, and partition reproducibly and evenly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAreaSourceFile, partitionSourceAreas, renderAreaScope, type SourceArea } from '../shared/sourceAreas.js';

const filesIn = (dir: string, count: number) => Array.from({ length: count }, (_, i) => `${dir}/file${i}.ts`);
function covers(scope: string, file: string): boolean {
  if (scope === '.' || scope === file) return true;
  if (scope.endsWith('/*')) {
    const dir = scope.slice(0, -2);
    return (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '') === (dir === '.' ? '' : dir);
  }
  return file.startsWith(`${scope}/`);
}
function assertCoverage(files: string[], areas: SourceArea[]) {
  const source = [...new Set(files.map((file) => file.replace(/\\/g, '/')).filter(isAreaSourceFile))];
  for (const file of source) {
    assert.equal(areas.flatMap((area) => area.paths).filter((scope) => covers(scope, file)).length, 1, file);
  }
  for (const area of areas) {
    assert.equal(area.files, source.filter((file) => area.paths.some((scope) => covers(scope, file))).length);
  }
  assert.equal(areas.reduce((sum, area) => sum + area.files, 0), source.length);
}

test('source extensions are case insensitive; test, generated and vendor files are excluded', () => {
  for (const ext of 'ts tsx js jsx mjs cjs py go rs java kt swift rb php cs c cc cpp h hpp scala vue svelte dart ex exs erl lua hs zig ml m mm jl r pl sh'.split(' ')) {
    assert.ok(isAreaSourceFile(`src/main.${ext}`), ext);
    assert.ok(isAreaSourceFile(`src\\MAIN.${ext.toUpperCase()}`), ext);
  }
  for (const segment of 'node_modules dist build out coverage vendor .git __snapshots__ __tests__ tests test spec e2e fixtures examples example benchmarks benchmark bench docs runtime-tests integration_tests unit-test'.split(' ')) {
    assert.equal(isAreaSourceFile(`src/${segment}/nested/main.ts`), false, segment);
    assert.equal(isAreaSourceFile(`src\\${segment}\\main.ts`), false, segment);
  }
  for (const path of ['a.test.ts', 'a.SPEC.JSX', 'test_api.PY', 'api_test.go', 'api_test.py', 'a.d.ts', 'A.D.TS', 'a.json', 'a.css', 'a.ts.map', 'README', 'a.pyi']) {
    assert.equal(isAreaSourceFile(path), false, path);
  }
  for (const path of ['src/testing/main.ts', 'contest.ts', 'test_utils.ts', 'latest.py']) assert.ok(isAreaSourceFile(path), path);
});

test('fewer than ten unique source files use the whole repository, including an empty repo', () => {
  for (const [files, total] of [[[], 0], [filesIn('src', 9), 9], [['src/main.ts', 'src\\main.ts', ...filesIn('tests', 20)], 1]] as [string[], number][]) {
    const areas = partitionSourceAreas(files, 8);
    assert.deepEqual(areas, [{ paths: ['.'], files: total, label: 'whole repository' }]);
    assertCoverage(files, areas);
  }
  assert.equal(partitionSourceAreas([...filesIn('a', 5), ...filesIn('b', 5)], 2).length, 2);
});

test('count clamps to 2..16 and a few files can yield fewer areas', () => {
  const files = Array.from({ length: 20 }, (_, i) => filesIn(`dir${i}`, 10)).flat();
  assert.deepEqual(partitionSourceAreas(files, -10), partitionSourceAreas(files, 2));
  assert.deepEqual(partitionSourceAreas(files, 100), partitionSourceAreas(files, 16));
  assert.equal(partitionSourceAreas(files, 100).length, 16);
  assert.equal(partitionSourceAreas(filesIn('one', 12), 16).length, 12);
  assertCoverage(files, partitionSourceAreas(files, 8));
});

test('direct-file scopes sort before their child directories, including at the root', () => {
  const files = ['root.ts', ...filesIn('!top', 3), ...filesIn('a', 2), ...filesIn('a/!b', 4), ...filesIn('a/c', 4)];
  const areas = partitionSourceAreas(files, 2);
  assert.deepEqual(areas.flatMap((area) => area.paths), ['./*', '!top', 'a/*', 'a/!b', 'a/c']);
  assertCoverage(files, areas);
  assert.deepEqual(partitionSourceAreas([...files, ...files.map((file) => file.replace(/\//g, '\\'))].reverse(), 2), areas);
});

test('uneven real-world tree balances eight scopes, splitting forceGraph when needed', () => {
  for (const smallSize of [5, 25]) {
    const files = [
      ...filesIn('backend/src/routes', 90), ...filesIn('backend/src/worktree', 80),
      ...Array.from({ length: 5 }, (_, i) => filesIn(`frontend/src/components/forceGraph/part${i}`, 34)).flat(),
      ...Array.from({ length: 20 }, (_, i) => filesIn(`backend/src/other/dir${i}`, smallSize === 5 ? 5 : smallSize + i % 4)).flat(),
    ];
    const areas = partitionSourceAreas(files, 8);
    assert.equal(areas.length, 8);
    assert.ok(Math.max(...areas.map((area) => area.files)) <= 2 * files.length / 8);
    if (smallSize === 5) assert.ok(areas.some((area) => area.paths.some((path) => path.includes('forceGraph/part'))));
    assertCoverage(files, areas);
    assert.deepEqual(partitionSourceAreas(files.slice().reverse(), 8), areas);
    assert.deepEqual(partitionSourceAreas([...files, 'tests/ignored.ts', 'README.md', ...files.slice(0, 10)], 8), areas);
  }
});

test('contiguous grouping minimizes the maximum sum and emits exactly the requested groups', () => {
  const weights = [7, 2, 5, 10, 8, 3];
  const files = weights.flatMap((weight, i) => filesIn(`dir${i}`, weight));
  const areas = partitionSourceAreas(files, 3);
  let best = Infinity;
  for (let i = 1; i < weights.length - 1; i++) {
    for (let j = i + 1; j < weights.length; j++) {
      best = Math.min(best, Math.max(...[weights.slice(0, i), weights.slice(i, j), weights.slice(j)].map((group) => group.reduce((a, b) => a + b, 0))));
    }
  }
  assert.equal(areas.length, 3);
  assert.equal(Math.max(...areas.map((area) => area.files)), best);
  assertCoverage(files, areas);
  for (const area of areas) assert.equal(area.label, area.paths.length === 1 ? area.paths[0] : `${area.paths[0]} … ${area.paths.at(-1)}`);
});

test('a deep monorepo balances even when early splits already reach the area count', () => {
  // Two packages, each one big tree: splitting must continue past `count`
  // nodes until no piece exceeds an area's share, or one area gets half the repo.
  const files = [
    ...filesIn('backend/src', 90),
    ...['routes', 'worktree', 'health', 'workflowRuns', 'terminal', 'mcp', 'recovery', 'ws'].flatMap((d, i) => filesIn(`backend/src/${d}`, 20 + i * 10)),
    ...filesIn('frontend/src/components/forceGraph', 170),
    ...['taskboard', 'workflows', 'settings', 'sidebar'].flatMap((d) => filesIn(`frontend/src/components/${d}`, 60)),
    ...filesIn('frontend/src/api', 40),
  ];
  for (const count of [8, 10]) {
    const areas = partitionSourceAreas(files, count);
    assertCoverage(files, areas);
    assert.equal(areas.length, count);
    const avg = areas.reduce((a, x) => a + x.files, 0) / areas.length;
    assert.ok(Math.max(...areas.map((a) => a.files)) <= 2 * avg, `count ${count}: ${areas.map((a) => a.files).join(' ')}`);
  }
});

test('a flat directory splits into balanced lists of its files', () => {
  // rich keeps ~100 modules directly in rich/, Go packages are often flat: a
  // folder that could not split stayed one area whatever count was asked for.
  const files = [...filesIn('pkg', 100), 'pkg/tests/test_a.py', 'setup.py'];
  for (const count of [4, 10]) {
    const areas = partitionSourceAreas(files, count);
    assert.equal(areas.length, count);
    assertCoverage(files, areas);
    assert.ok(Math.max(...areas.map((area) => area.files)) <= Math.ceil(101 / count) + 1, areas.map((a) => a.files).join(' '));
    assert.ok(areas.every((area) => area.paths.every((p) => p === './*' || /^pkg\/file\d+\.ts$/.test(p))));
  }
  assert.deepEqual(partitionSourceAreas(filesIn('pkg', 100), 10), partitionSourceAreas(filesIn('pkg', 100).reverse(), 10));
});

test('scope preface has exact wording for directories and direct files', () => {
  assert.equal(renderAreaScope({ paths: ['backend/src', 'frontend/*', './*'], files: 10, label: 'unused' }),
    'Scope for this step: review only `backend/src`, the files directly in `frontend`, the files directly in `.` (and what it calls, as needed). Other steps review the rest of the repository in parallel; file tasks only about code inside this scope.');
  assert.equal(renderAreaScope({ paths: ['.'], files: 1, label: 'whole repository' }),
    'Scope for this step: review only `.` (and what it calls, as needed). Other steps review the rest of the repository in parallel; file tasks only about code inside this scope.');
});
