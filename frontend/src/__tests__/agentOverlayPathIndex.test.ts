import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { AgentOverlayCtx } from '../components/forceGraph/agentOverlayContext.ts';
import type { SimNode } from '../components/forceGraph/agentOverlayTypes.ts';
import {
  AgentPathIndex,
  type GraphBounds,
} from '../components/forceGraph/agentOverlayPathIndex.ts';
import { parkedPosition } from '../components/forceGraph/agentOverlayPlacement.ts';
import { installCanvasDocument } from './domDoubles.ts';

const restoreDocument = installCanvasDocument();
after(restoreDocument);
const { AgentOverlay } = await import('../components/forceGraph/agentOverlay.ts');
const { removeAgent } = await import('../components/forceGraph/agentOverlayReconcile.ts');

function makeGraph(nodes: SimNode[]) {
  const scene = new THREE.Scene();
  let data = { nodes, links: [] };
  let reads = 0;
  const graph = {
    scene: () => scene,
    graphData: (next?: { nodes: SimNode[] }) => {
      if (next) data = { nodes: next.nodes, links: [] };
      else reads++;
      return data;
    },
  } as unknown as ForceGraph3DInstance;
  return { graph, scene, dataReads: () => reads };
}

function generationA() {
  return [
    { id: 'shared', path: 'src/shared.ts', x: 0, y: 0, z: 0, healthDetails: { generation: 'A' } },
    { id: 'old', path: 'src/old.ts', x: 10, y: 5, z: 0 },
  ];
}

function generationB() {
  return [
    { id: 'shared', path: 'src/shared.ts', x: 1000, y: 200, z: 600 },
    { id: 'new', path: 'src/new.ts', x: 1800, y: 900, z: 1000 },
  ];
}

function context(overlay: InstanceType<typeof AgentOverlay>): AgentOverlayCtx {
  return (overlay as unknown as { ctx: AgentOverlayCtx }).ctx;
}

// Inspect both retaining edges: an empty lookup map alone does not prove the
// old nodes array was released. No forced GC or subsequent frame is needed.
function indexState(index: AgentPathIndex) {
  return index as unknown as {
    byPath: Map<string, SimNode>;
    indexedNodes: object[] | null;
    cachedBounds: GraphBounds | null;
    boundsValid: boolean;
  };
}

function assertReleased(index: AgentPathIndex) {
  const state = indexState(index);
  assert.equal(state.byPath.size, 0);
  assert.equal(state.indexedNodes, null);
  assert.equal(state.cachedBounds, null);
  assert.equal(index.get('src/shared.ts'), undefined);
  assert.equal(index.bounds(), null);
  assert.equal(index.centroidSpread(), null);
}

test('clearing the path index is idempotent and permits rebuilding the same array', () => {
  const nodes = generationA();
  const { graph } = makeGraph(nodes);
  const index = new AgentPathIndex();
  index.ensure(graph);
  assert.deepEqual(index.bounds(), { minY: 0, maxY: 5 });

  index.clear();
  assert.equal(indexState(index).boundsValid, false);
  assertReleased(index);
  index.clear();
  assert.equal(indexState(index).boundsValid, false);
  assertReleased(index);

  // Array identity is unchanged, but ensure must rebuild after clear. The
  // cached A bounds must not survive either.
  nodes[1].y = 50;
  index.ensure(graph);
  assert.equal(indexState(index).indexedNodes, nodes);
  assert.equal(index.get('src/shared.ts'), nodes[0]);
  assert.deepEqual(index.bounds(), { minY: 0, maxY: 50 });
});

test('final agent reconciliation releases A before a graph swap to B without a render', (t) => {
  const nodesA = generationA();
  const { graph, dataReads } = makeGraph(nodesA);
  const overlay = new AgentOverlay(graph, 4);
  t.after(() => overlay.destroy(graph));
  const { pathIndex, group } = context(overlay);
  assert.equal(overlay.setAgents([{ taskId: 'first', color: '#ffffff' }], graph), true);
  assert.equal(indexState(pathIndex).indexedNodes, nodesA);
  assert.equal(pathIndex.get('src/shared.ts'), nodesA[0]);
  assert.deepEqual(pathIndex.bounds(), { minY: 0, maxY: 5 });
  const beforeRemoval = dataReads();

  assert.equal(overlay.setAgents([], graph), true);
  assert.equal(overlay.isActive(), false);
  assert.equal(group.children.length, 0);
  assertReleased(pathIndex);
  assert.equal(dataReads(), beforeRemoval, 'removal does not need a graph rescan');

  graph.graphData({ nodes: generationB(), links: [] });
  assertReleased(pathIndex);
  assert.equal(dataReads(), beforeRemoval, 'inactive overlay does not index B');
});

test('removing one agent preserves the index until its final sibling is removed', (t) => {
  const nodes = generationA();
  const { graph } = makeGraph(nodes);
  const overlay = new AgentOverlay(graph, 4);
  t.after(() => overlay.destroy(graph));
  const ctx = context(overlay);
  overlay.setAgents([
    { taskId: 'first', color: '#ffffff' },
    { taskId: 'sibling', color: '#ff0000' },
  ], graph);
  const bounds = ctx.pathIndex.bounds();

  assert.equal(overlay.setAgents([{ taskId: 'sibling', color: '#ff0000' }], graph), true);
  assert.equal(overlay.hasAgent('sibling'), true);
  assert.equal(indexState(ctx.pathIndex).indexedNodes, nodes);
  assert.equal(ctx.pathIndex.get('src/shared.ts'), nodes[0]);
  assert.equal(ctx.pathIndex.bounds(), bounds, 'sibling keeps its cached bounds');

  removeAgent(ctx, 'sibling');
  assert.equal(overlay.isActive(), false);
  assertReleased(ctx.pathIndex);
  removeAgent(ctx, 'sibling');
  assertReleased(ctx.pathIndex);
});

test('empty reconciliation clears an unused index and repeated empty updates stay empty', (t) => {
  const { graph, dataReads } = makeGraph(generationA());
  const overlay = new AgentOverlay(graph, 4);
  t.after(() => overlay.destroy(graph));
  const { pathIndex } = context(overlay);
  // Seed an unused index to exercise the already-empty cleanup path rather
  // than relying on removeAgent to clear it.
  pathIndex.ensure(graph);
  assert.ok(pathIndex.bounds());
  const before = dataReads();

  assert.equal(overlay.setAgents([], graph), false);
  assertReleased(pathIndex);
  graph.graphData({ nodes: generationB(), links: [] });
  assert.equal(overlay.setAgents([], graph), false);
  assertReleased(pathIndex);
  assert.equal(dataReads(), before);
});

for (const active of [true, false]) {
  test(`destroy releases the index with ${active ? 'a live agent' : 'no agents'} and is repeatable`, () => {
    const { graph, scene } = makeGraph(generationA());
    const overlay = new AgentOverlay(graph, 4);
    const ctx = context(overlay);
    try {
      if (active) overlay.setAgents([{ taskId: 'first', color: '#ffffff' }], graph);
      else ctx.pathIndex.ensure(graph);
      assert.ok(ctx.pathIndex.bounds());

      overlay.destroy(graph);
      assert.equal(overlay.isActive(), false);
      assert.equal(scene.children.includes(ctx.group), false);
      assertReleased(ctx.pathIndex);
      overlay.destroy(graph);
      assertReleased(ctx.pathIndex);
    } finally {
      overlay.destroy(graph);
    }
  });
}

test('the next agent uses B for lookup, bounds, parked placement and beam targets', (t) => {
  const { graph } = makeGraph(generationA());
  const overlay = new AgentOverlay(graph, 4);
  t.after(() => overlay.destroy(graph));
  const ctx = context(overlay);
  overlay.setAgents([{ taskId: 'first', color: '#ffffff' }], graph);
  assert.deepEqual(ctx.pathIndex.bounds(), { minY: 0, maxY: 5 });
  overlay.setAgents([], graph);
  assertReleased(ctx.pathIndex);

  const nodesB = generationB();
  graph.graphData({ nodes: nodesB, links: [] });
  overlay.setAgents([{ taskId: 'next', color: '#ffffff' }], graph);
  assert.equal(indexState(ctx.pathIndex).indexedNodes, nodesB);
  assert.equal(ctx.pathIndex.get('src/shared.ts'), nodesB[0]);
  assert.equal(ctx.pathIndex.get('src/new.ts'), nodesB[1]);
  assert.equal(ctx.pathIndex.get('src/old.ts'), undefined);
  assert.deepEqual(ctx.pathIndex.bounds(), { minY: 200, maxY: 900 });
  const spread = { cx: 1400, cz: 800, maxR: Math.hypot(400, 200) };
  assert.deepEqual(ctx.pathIndex.centroidSpread(), spread);
  const agent = ctx.agents.get('next')!;
  const expected = parkedPosition(1, { ...spread, y: 970 });
  assert.deepEqual(agent.pos.toArray(), expected.toArray());
  assert.deepEqual(agent.node.position.toArray(), expected.toArray());

  overlay.addActivity('next', 'src/shared.ts', 'start', 1000);
  overlay.tick(1000, graph, false);
  const beam = agent.beams.get('src/shared.ts')!;
  assert.equal(beam.targetNode, nodesB[0]);
  assert.deepEqual([beam.lastToX, beam.lastToY, beam.lastToZ], [1000, 200, 600]);
});
