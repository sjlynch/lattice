import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode, ScanResult, HealthMetrics } from '../api/types/index.ts';
import {
  linkEndpointId,
  normalizeLinks,
  patchUpdatedFiles,
  removeFile,
} from '../hooks/scanResultPatch.ts';

function metrics(score: number, loc: number): HealthMetrics {
  return {
    score,
    language: 'typescript',
    loc,
    commentRatio: 0,
    cyclomaticMax: 1,
    cyclomaticTotal: 1,
    cognitiveMax: 1,
    cognitiveTotal: 1,
    maxNestingDepth: 1,
    halstead: { vocabulary: 1, length: 1, volume: 1, difficulty: 1, effort: 1 },
    maintainabilityIndex: 100,
    functionCount: 1,
    namedFunctionCount: 1,
    avgFunctionLength: loc,
    maxFunctionLength: loc,
    maxParamCount: 0,
    classCount: 0,
    callGraphDensity: 0,
    godFunctionRatio: 0,
    smells: [],
    smellCount: 0,
  };
}

function fileNode(path: string, healthDetails = metrics(0.5, 10)): GraphNode {
  return {
    id: path,
    name: path.split('/').pop() ?? path,
    path,
    kind: 'file',
    health: healthDetails.score,
    healthDetails,
    loc: healthDetails.loc,
  };
}

function scan(): ScanResult {
  return {
    root: '/repo',
    nodes: [
      { id: '/repo', name: 'repo', path: '/repo', kind: 'dir' },
      fileNode('/repo/a.ts'),
      fileNode('/repo/b.ts'),
    ],
    links: [
      { source: '/repo', target: '/repo/a.ts' },
      { source: '/repo/a.ts', target: '/repo/b.ts' },
    ],
  };
}

test('linkEndpointId reads strings, object ids, and object paths', () => {
  assert.equal(linkEndpointId('/repo/a.ts'), '/repo/a.ts');
  assert.equal(linkEndpointId({ id: '/repo/b.ts' }), '/repo/b.ts');
  assert.equal(linkEndpointId({ path: '/repo/c.ts' }), '/repo/c.ts');
  assert.equal(linkEndpointId({ id: 42, path: false }), null);
  assert.equal(linkEndpointId(null), null);
});

test('normalizeLinks reduces hydrated runtime endpoints to string id pairs', () => {
  const normalized = normalizeLinks([
    { source: { id: '/repo/a.ts' }, target: { path: '/repo/b.ts' } },
    { source: '/repo/b.ts', target: '/repo/c.ts' },
    { source: '/repo/c.ts', target: {} },
  ] as never);

  assert.deepEqual(normalized, [
    { source: '/repo/a.ts', target: '/repo/b.ts' },
    { source: '/repo/b.ts', target: '/repo/c.ts' },
  ]);
});

test('patchUpdatedFiles returns the original ScanResult for empty and no-op updates', () => {
  const prev = scan();
  assert.deepEqual(patchUpdatedFiles(prev, []), { result: prev, missing: false });

  const current = prev.nodes.find((n) => n.path === '/repo/a.ts')!.healthDetails!;
  assert.deepEqual(
    patchUpdatedFiles(prev, [{ filePath: '/repo/a.ts', metrics: current }]),
    { result: prev, missing: false },
  );
});

test('patchUpdatedFiles applies latest metrics while preserving metric-only link identity', () => {
  const prev = scan();
  const first = metrics(0.1, 11);
  const latest = metrics(0.9, 42);

  const { result, missing } = patchUpdatedFiles(prev, [
    { filePath: '/repo/a.ts', metrics: first },
    { filePath: '/repo/a.ts', metrics: latest },
  ]);

  assert.equal(missing, false);
  assert.notEqual(result, prev);
  assert.equal(result.links, prev.links);
  const patched = result.nodes.find((n) => n.path === '/repo/a.ts')!;
  assert.equal(patched.health, latest.score);
  assert.equal(patched.healthDetails, latest);
  assert.equal(patched.loc, latest.loc);
  assert.equal(result.nodes.find((n) => n.path === '/repo/b.ts'), prev.nodes[2]);
});

test('patchUpdatedFiles reports missing updated files absent from the current scan', () => {
  const prev = scan();
  const { result, missing } = patchUpdatedFiles(prev, [
    { filePath: '/repo/new.ts', metrics: metrics(0.7, 7) },
  ]);

  assert.equal(result, prev);
  assert.equal(missing, true);
});

test('removeFile prunes deleted files, normalizes hydrated links, and drops touching links', () => {
  const prev = scan();
  const hydrated: ScanResult = {
    ...prev,
    links: [
      { source: { id: '/repo' }, target: { id: '/repo/a.ts' } },
      { source: { id: '/repo/a.ts' }, target: { id: '/repo/b.ts' } },
      { source: { path: '/repo' }, target: { path: '/repo/b.ts' } },
    ] as never,
  };

  const next = removeFile(hydrated, '/repo/a.ts');

  assert.notEqual(next, hydrated);
  assert.deepEqual(
    next.nodes.map((n) => n.path),
    ['/repo', '/repo/b.ts'],
  );
  assert.deepEqual(next.links, [{ source: '/repo', target: '/repo/b.ts' }]);
});

test('removeFile returns the original ScanResult when the file is already absent', () => {
  const prev = scan();
  assert.equal(removeFile(prev, '/repo/missing.ts'), prev);
});
