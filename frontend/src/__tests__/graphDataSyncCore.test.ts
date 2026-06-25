import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode, ScanResult } from '../api/types/scan.ts';
import type { GitHistoryResult } from '../api/types/gitHistory.ts';
import { REL_FORWARD_KEY, GHOST_PREFIX } from '../components/forceGraph/timelineDiff.ts';
import {
  buildForceGraphData,
  cloneLink,
  copySimulationState,
  indexNodesById,
  isMetricOnlyUpdate,
  patchSimNodeMetrics,
  prepareGhostMerge,
  shapeFingerprint,
  linkEndpointId,
  type SimNode,
} from '../components/forceGraph/hooks/graphDataSyncCore.ts';

function fileNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return { id, name: id, path: id, kind: 'file', ...overrides };
}

function noHistory(): GitHistoryResult {
  return { isRepo: false, commits: [], uncommitted: { changes: [] } };
}

test('linkEndpointId reads strings, object ids, and falls back to path', () => {
  assert.equal(linkEndpointId('a.ts'), 'a.ts');
  assert.equal(linkEndpointId({ id: 'b.ts' }), 'b.ts');
  assert.equal(linkEndpointId({ path: 'c.ts' }), 'c.ts');
  assert.equal(linkEndpointId({ nothing: true }), null);
  assert.equal(linkEndpointId(null), null);
  assert.equal(linkEndpointId(42), null);
});

test('cloneLink reduces runtime endpoints (objects or strings) to an id pair', () => {
  assert.deepEqual(
    cloneLink({ source: { id: 'a' }, target: { id: 'b' } } as never),
    { source: 'a', target: 'b' },
  );
  assert.deepEqual(cloneLink({ source: 'a', target: 'b' }), { source: 'a', target: 'b' });
  // A dangling endpoint drops the whole link.
  assert.equal(cloneLink({ source: 'a', target: {} } as never), null);
});

test('indexNodesById keys by id and skips entries without a string id', () => {
  const a = fileNode('a');
  const index = indexNodesById([a, { name: 'no-id' }, fileNode('b')]);
  assert.equal(index.size, 2);
  assert.equal(index.get('a'), a);
  assert.ok(index.has('b'));
});

test('copySimulationState copies numeric sim keys and ignores non-numbers', () => {
  const target: SimNode = fileNode('a');
  copySimulationState(target, {
    ...fileNode('a'),
    x: 1,
    y: 2,
    z: 3,
    vx: 0.5,
    fx: undefined,
  } as SimNode);
  assert.equal(target.x, 1);
  assert.equal(target.y, 2);
  assert.equal(target.z, 3);
  assert.equal(target.vx, 0.5);
  assert.equal(target.fx, undefined);
});

test('buildForceGraphData carries prior sim state, stashes relForward, reduces links', () => {
  const prev = new Map<string, SimNode>([
    ['/repo/src/a.ts', { ...fileNode('/repo/src/a.ts'), x: 10, y: 20, z: 30 } as SimNode],
  ]);
  const nodes: GraphNode[] = [
    fileNode('/repo/src/a.ts', { path: '/repo/src/a.ts' }),
    fileNode('/repo/src/b.ts', { path: '/repo/src/b.ts' }),
  ];
  const links = [{ source: '/repo/src/a.ts', target: '/repo/src/b.ts' }];

  const built = buildForceGraphData(prev, nodes, links, '/repo');

  // Prior position carried forward onto the fresh clone.
  const a = built.nodes.find((n) => n.id === '/repo/src/a.ts')!;
  assert.deepEqual([a.x, a.y, a.z], [10, 20, 30]);
  // New node with a placed source neighbour is seeded at the source position.
  const b = built.nodes.find((n) => n.id === '/repo/src/b.ts')!;
  assert.deepEqual([b.x, b.y, b.z], [10, 20, 30]);
  assert.deepEqual([b.vx, b.vy, b.vz], [0, 0, 0]);
  // Forward-relative path precomputed on file clones.
  assert.equal((a as Record<string, unknown>)[REL_FORWARD_KEY], 'src/a.ts');
  // Links reduced to id pairs (clones, not the input objects).
  assert.deepEqual(built.links, links);
  assert.notEqual(built.links[0], links[0]);
});

test('shapeFingerprint is order-insensitive and stable', () => {
  const a = shapeFingerprint(
    [fileNode('x'), fileNode('y')],
    [{ source: 'x', target: 'y' }],
  );
  const b = shapeFingerprint(
    [fileNode('y'), fileNode('x')],
    [{ source: 'x', target: 'y' }],
  );
  assert.equal(a, b);
  // A genuine structural change shifts the fingerprint.
  const c = shapeFingerprint([fileNode('x')], []);
  assert.notEqual(a, c);
});

test('patchSimNodeMetrics mutates metric fields in place and reports change', () => {
  const sim = { ...fileNode('a'), health: 1, loc: 100 } as SimNode;
  const index = new Map<string, SimNode>([['a', sim]]);

  assert.equal(
    patchSimNodeMetrics(index, [fileNode('a', { health: 1, loc: 100 })]),
    false,
  );
  assert.equal(
    patchSimNodeMetrics(index, [fileNode('a', { health: 0.5, loc: 100 })]),
    true,
  );
  assert.equal(sim.health, 0.5);
  // Fresh nodes not in the index are ignored.
  assert.equal(patchSimNodeMetrics(index, [fileNode('missing', { health: 0 })]), false);
});

test('isMetricOnlyUpdate gates the cheap fast path on identity/length/history', () => {
  const links = [{ source: 'a', target: 'b' }];
  const hist = noHistory();
  const prev: ScanResult = { root: '/repo', nodes: [fileNode('a'), fileNode('b')], links };
  const next: ScanResult = { root: '/repo', nodes: [fileNode('a'), fileNode('b')], links };

  assert.equal(isMetricOnlyUpdate(prev, next, hist, hist, true), true);
  // No prior push → must do a full swap.
  assert.equal(isMetricOnlyUpdate(prev, next, hist, hist, false), false);
  // Different links array identity → structural change possible.
  assert.equal(
    isMetricOnlyUpdate(prev, { ...next, links: [...links] }, hist, hist, true),
    false,
  );
  // Node count changed.
  assert.equal(
    isMetricOnlyUpdate(prev, { ...next, nodes: [fileNode('a')] }, hist, hist, true),
    false,
  );
  // History ref changed (ghost set may differ).
  assert.equal(isMetricOnlyUpdate(prev, next, hist, noHistory(), true), false);
  // No prior data.
  assert.equal(isMetricOnlyUpdate(null, next, hist, hist, true), false);
});

test('prepareGhostMerge is a no-op merge without repo history', () => {
  const data: ScanResult = {
    root: '/repo',
    nodes: [fileNode('/repo/a.ts', { path: '/repo/a.ts' })],
    links: [],
  };
  const { ghostIds, mergedNodes, mergedLinks } = prepareGhostMerge(data, noHistory());
  assert.equal(ghostIds.size, 0);
  assert.deepEqual(mergedNodes, data.nodes);
  assert.deepEqual(mergedLinks, data.links);
});

test('prepareGhostMerge adds ghosts for history paths missing from the scan', () => {
  const data: ScanResult = {
    root: '/repo',
    nodes: [{ id: '/repo', name: 'repo', path: '/repo', kind: 'dir' }],
    links: [],
  };
  const history: GitHistoryResult = {
    isRepo: true,
    commits: [
      {
        sha: 'deadbeef',
        shortSha: 'dead',
        subject: 'removed a file',
        authorName: 'me',
        date: 0,
        changes: [{ path: 'gone.ts', status: 'D' }],
      },
    ],
    uncommitted: { changes: [] },
  };
  const { ghostIds, mergedNodes, mergedLinks } = prepareGhostMerge(data, history);
  const ghostId = `${GHOST_PREFIX}gone.ts`;
  assert.ok(ghostIds.has(ghostId));
  assert.equal(mergedNodes.length, 2);
  assert.ok(mergedNodes.some((n) => n.id === ghostId));
  // Ghost is linked under the nearest existing dir (the root here).
  assert.deepEqual(mergedLinks, [{ source: '/repo', target: ghostId }]);
});
