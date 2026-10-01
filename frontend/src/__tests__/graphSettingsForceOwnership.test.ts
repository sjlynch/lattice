import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { DEFAULT_SETTINGS, type GraphSettings } from '../components/forceGraph/graphSettings.ts';
import { attachIdleController, type IdleController } from '../components/forceGraph/idleController.ts';
import { type CollideForceXZ } from '../components/forceGraph/layoutShapeForces.ts';
import { type LocalRepulsionForce } from '../components/forceGraph/localRepulsionForce.ts';
import { type GraphRef } from '../components/forceGraph/hooks/graphSettingsEffectUtils.ts';
import { applyCollisionRadius, useLayoutShapeSettings } from '../components/forceGraph/hooks/useGraphSettingsLayoutShape.ts';
import { usePhysicsAndRepulsionSettings } from '../components/forceGraph/hooks/useGraphSettingsPhysics.ts';
import { installGlobal, installManualTimers } from './domDoubles.ts';

type SimNode = {
  id: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  healthDetails: { generation: string };
};
type Force = {
  (alpha: number): void;
  initialize(nodes: SimNode[], random?: () => number, dimensions?: number): void;
};
type Initialization = {
  nodes: SimNode[];
  random?: () => number;
  dimensions?: number;
};

function nodes(generation: string, separation = 5): SimNode[] {
  return [0, separation].map((x, i) => ({
    id: `${generation}-${i}`, x, z: 0, vx: 0, vz: 0,
    healthDetails: { generation },
  }));
}

// Match d3's ownership contract: removing a force does not initialize it, node
// swaps initialize only installed forces, and setters pass simulation context.
// Initialization records deliberately keep test references for direct assertions.
function fakeGraph(initialNodes: SimNode[]) {
  let currentNodes = initialNodes;
  let nbodyNodes: SimNode[] = [];
  const nbodySettings = { strength: -30, theta: 0.9 };
  const values = { alphaDecay: 0, warmupTicks: 0, dagLevelDistance: 0, velocityDecay: 0, linkDistance: 0 };
  const forces = new Map<string, Force>();
  const records = new Map<Force, Initialization[]>();
  const random = () => 0.25;
  let failNextChange = false;
  let removals = 0;
  let reheats = 0;
  let engineStarts = 0;
  const nbody = Object.assign(((alpha: number) => {
    for (const node of nbodyNodes) node.vx += nbodySettings.strength * alpha;
  }) as Force, {
    initialize: (next: SimNode[]) => { nbodyNodes = next; },
    strength: (value: number) => { nbodySettings.strength = value; },
    theta: (value: number) => { nbodySettings.theta = value; },
  });

  function initialize(force: Force) {
    if (!records.has(force)) {
      const history: Initialization[] = [];
      records.set(force, history);
      const original = force.initialize;
      force.initialize = (next, source, dimensions) => {
        if (next.length === 0 && currentNodes.length > 0) {
          assert.ok(![...forces.values()].includes(force), 'a populated active force must never be emptied');
        }
        history.push({ nodes: next, random: source, dimensions });
        original.call(force, next, source, dimensions);
      };
    }
    force.initialize(currentNodes, random, 3);
    return force;
  }

  const graph = {
    graphData: () => ({ nodes: currentNodes, links: [] }),
    d3Force: (name: string, force?: Force | null) => {
      if (force === undefined) return name === 'link'
        ? { distance: (value: number) => { values.linkDistance = value; } }
        : forces.get(name);
      if (failNextChange) {
        failNextChange = false;
        throw new Error('force change failed');
      }
      if (force === null) {
        forces.delete(name);
        removals++;
      } else {
        forces.set(name, initialize(force));
      }
      return graph;
    },
    d3AlphaDecay: (value: number) => { values.alphaDecay = value; },
    warmupTicks: (value: number) => { values.warmupTicks = value; },
    dagLevelDistance: (value: number) => { values.dagLevelDistance = value; },
    d3VelocityDecay: (value: number) => { values.velocityDecay = value; },
    d3ReheatSimulation: () => { reheats++; },
  } as unknown as ForceGraph3DInstance;
  forces.set('charge', initialize(nbody));
  attachIdleController(graph, { engineStarted: () => { engineStarts++; } } as IdleController);

  return {
    graph, forces, records, random, values, nbody, nbodySettings,
    get nbodyNodes() { return nbodyNodes; },
    get removals() { return removals; },
    get reheats() { return reheats; },
    get engineStarts() { return engineStarts; },
    failNextChange() { failNextChange = true; },
    swapNodes(next: SimNode[]) {
      currentNodes = next;
      for (const force of forces.values()) initialize(force);
    },
    lastInitialization(force: Force) { return records.get(force)!.at(-1)!; },
  };
}

async function mountSettings(t: TestContext, mock: ReturnType<typeof fakeGraph>, initial: GraphSettings) {
  const restoreAct = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const timers = installManualTimers();
  const graphRef: GraphRef = { current: mock.graph };
  function Harness({ settings }: { settings: GraphSettings }) {
    useLayoutShapeSettings(settings, graphRef);
    usePhysicsAndRepulsionSettings(settings, graphRef);
    return null;
  }
  let renderer: ReturnType<typeof TestRenderer.create> | undefined;
  async function unmount() {
    if (!renderer) return;
    const mounted = renderer;
    renderer = undefined;
    await act(async () => mounted.unmount());
  }
  t.after(async () => {
    try { await unmount(); } finally { timers.restore(); restoreAct(); }
  });
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { settings: initial })); });
  return {
    graphRef, timers, unmount,
    async update(settings: GraphSettings) {
      await act(async () => { renderer!.update(React.createElement(Harness, { settings })); });
    },
  };
}

test('collision disable immediately drops cache ownership and re-enable creates a force for B', () => {
  const a = nodes('A');
  const b = nodes('B', 20);
  const mock = fakeGraph(a);
  const cache: { current: CollideForceXZ | null } = { current: null };
  applyCollisionRadius(mock.graph, cache, 8);
  const first = cache.current!;
  assert.equal(mock.forces.get('collide'), first);
  assert.equal(mock.lastInitialization(first).nodes, a);
  first(1); // Populate the real collision force's scratch buffers.

  applyCollisionRadius(mock.graph, cache, 0);
  assert.equal(cache.current, null, 'release the React cache immediately, before any rescan or reheat');
  assert.equal(mock.forces.has('collide'), false);
  applyCollisionRadius(mock.graph, cache, 0);
  applyCollisionRadius(mock.graph, cache, -1);
  assert.equal(mock.removals, 1, 'repeated disable is harmless');
  assert.equal(mock.nbodyNodes, a, 'collision cleanup leaves active charge alone');

  mock.swapNodes(b);
  assert.equal(mock.records.get(first)!.length, 1, 'dormant forces do not receive structural swaps');
  applyCollisionRadius(mock.graph, cache, 12);
  const second = cache.current!;
  assert.notEqual(second, first, 're-enable creates a fresh closure and scratch buffers');
  assert.deepEqual(mock.lastInitialization(second), { nodes: b, random: mock.random, dimensions: 3 });
  second(1);
  assert.ok(b[0].vx < 0 && b[1].vx > 0, 'current radius 12 collides at distance 20; old radius 8 would not');
  applyCollisionRadius(mock.graph, cache, 14);
  assert.equal(cache.current, second, 'positive radius changes reuse the active force');
});

test('collision cache is retained if removal fails and released on a successful retry', () => {
  const mock = fakeGraph(nodes('A'));
  const cache: { current: CollideForceXZ | null } = { current: null };
  applyCollisionRadius(mock.graph, cache, 8);
  const active = cache.current!;
  mock.failNextChange();
  assert.throws(() => applyCollisionRadius(mock.graph, cache, 0), /force change failed/);
  assert.equal(cache.current, active);
  assert.equal(mock.forces.get('collide'), active);
  applyCollisionRadius(mock.graph, cache, 0);
  applyCollisionRadius(mock.graph, cache, 0);
  assert.equal(cache.current, null);
  assert.equal(mock.removals, 1);
});

for (const initialMode of ['local', 'nbody'] as const) {
  const otherMode = initialMode === 'local' ? 'nbody' : 'local';
  test(`${initialMode} -> ${otherMode} releases A while dormant and reattaches to B with current settings`, async (t) => {
    const a = nodes('A');
    const b = nodes('B');
    const mock = fakeGraph(a);
    let settings = { ...DEFAULT_SETTINGS, repulsionMode: initialMode };
    const h = await mountSettings(t, mock, settings);
    assert.equal(h.timers.scheduled.length, 0, 'initial setup does not reheat');
    const first = mock.forces.get('charge')!;
    first(1);
    const oldVelocities = a.map(({ vx, vz }) => ({ vx, vz }));

    settings = { ...settings, repulsionMode: otherMode, chargeStrength: -80, chargeTheta: 1.8, linkDistance: 70 };
    await h.update(settings);
    const second = mock.forces.get('charge')!;
    assert.notEqual(second, first);
    assert.deepEqual(mock.lastInitialization(first).nodes, [], 'old array is detached immediately');
    assert.equal(mock.lastInitialization(second).nodes, a, 'replacement keeps the populated graph');
    first(1);
    assert.deepEqual(a.map(({ vx, vz }) => ({ vx, vz })), oldVelocities, 'dormant force cannot touch A');
    assert.deepEqual(h.timers.scheduled.map(({ delay }) => delay), [50]);
    assert.equal(mock.reheats, 0, 'release happens before the deferred reheat');

    mock.swapNodes(b);
    assert.equal(mock.lastInitialization(second).nodes, b);
    assert.deepEqual(mock.lastInitialization(first).nodes, []);
    const dormantInitializations = mock.records.get(first)!.length;
    settings = { ...settings, chargeStrength: -95, chargeTheta: 2.1, linkDistance: 15 };
    await h.update(settings);
    assert.equal(mock.forces.get('charge'), second);
    assert.equal(mock.records.get(first)!.length, dormantInitializations, 'same-mode changes do not reinstall forces');
    assert.deepEqual(mock.nbodySettings, { strength: -95, theta: 2.1 });
    const local = (initialMode === 'local' ? first : second) as LocalRepulsionForce;
    assert.equal(local.strength(), -95, 'cached local force receives current strength even while dormant');
    assert.equal(local.cellSize(), 40, 'cached local force receives the current minimum cell size');
    assert.equal(mock.values.linkDistance, 15);

    settings = { ...settings, repulsionMode: initialMode };
    await h.update(settings);
    assert.equal(mock.forces.get('charge'), first, 'mode switches preserve cached charge identity');
    assert.deepEqual(mock.lastInitialization(first), { nodes: b, random: mock.random, dimensions: 3 });
    assert.deepEqual(mock.lastInitialization(second).nodes, []);
    first(1);
    assert.deepEqual(a.map(({ vx, vz }) => ({ vx, vz })), oldVelocities, 'reattachment never revisits A');
    assert.ok(b.some(({ vx, vz }) => vx !== 0 || vz !== 0), 'reattached force operates on B');

    for (const mode of [otherMode, initialMode, otherMode]) {
      settings = { ...settings, repulsionMode: mode };
      await h.update(settings);
      const active = mock.forces.get('charge')!;
      const dormant = active === first ? second : first;
      assert.equal(mock.lastInitialization(active).nodes, b);
      assert.deepEqual(mock.lastInitialization(dormant).nodes, []);
      assert.deepEqual(h.timers.scheduled.map(({ delay }) => delay), [50], 'updates cancel the previous reheat');
    }
    const active = mock.forces.get('charge')!;
    await h.unmount();
    await h.unmount();
    assert.equal(h.timers.scheduled.length, 0, 'cleanup cancels pending reheat');
    assert.equal(mock.lastInitialization(active).nodes, b, 'effect cleanup never empties the installed force');
  });
}

test('settings hooks preserve empty-graph guards, deferred reheats and graph identity fences', async (t) => {
  const mock = fakeGraph([]);
  let settings = { ...DEFAULT_SETTINGS, collideRadius: 8 };
  const h = await mountSettings(t, mock, settings);
  assert.equal(h.timers.scheduled.length, 0);
  settings = { ...settings, collideRadius: 0, repulsionMode: 'nbody', chargeStrength: -75 };
  await h.update(settings);
  assert.equal(h.timers.scheduled.length, 0, 'changes on empty graphs do not reheat');
  assert.equal(mock.nbodySettings.strength, -75, 'empty-graph guard still allows configuration');

  const b = nodes('B');
  mock.swapNodes(b);
  settings = { ...settings, collideRadius: 12, chargeStrength: -85, alphaDecay: 0.03, warmupTicks: 20 };
  await h.update(settings);
  const firstCollision = mock.forces.get('collide')!;
  assert.equal(mock.lastInitialization(firstCollision).nodes, b);
  assert.equal(mock.values.alphaDecay, 0.03);
  assert.equal(mock.values.warmupTicks, 20);
  assert.deepEqual(h.timers.scheduled.map(({ delay }) => delay), [50, 50]);
  assert.equal(mock.reheats, 0);
  h.graphRef.current = null;
  h.timers.fireAll();
  assert.equal(mock.reheats, 0, 'deferred callbacks cannot wake an obsolete graph');

  h.graphRef.current = mock.graph;
  settings = { ...settings, collideRadius: 0, chargeStrength: -90 };
  await h.update(settings);
  settings = { ...settings, collideRadius: 16, chargeStrength: -100 };
  await h.update(settings);
  assert.notEqual(mock.forces.get('collide'), firstCollision, 'hook uses the cache-dropping collision adapter');
  assert.equal(mock.lastInitialization(mock.forces.get('collide')!).nodes, b);
  assert.deepEqual(h.timers.scheduled.map(({ delay }) => delay), [50, 50]);
  h.timers.fireAll();
  assert.equal(mock.reheats, 2);
  assert.equal(mock.engineStarts, 2, 'each deferred reheat wakes the idle controller');
});
