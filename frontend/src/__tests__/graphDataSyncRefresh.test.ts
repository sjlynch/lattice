import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphLink, GraphNode, ScanResult } from '../api';
import {
  METRIC_REFRESH_COALESCE_MS,
  useGraphDataSync,
} from '../components/forceGraph/hooks/useGraphDataSync.ts';
import { installGlobal, installManualTimers } from './domDoubles.ts';

// `useGraphDataSync` against a fake graph that counts `refresh()` and
// `graphData(...)` swaps. Manual timers keep the coalescing window and the
// label-trim deferral directly assertable.

const ROOT = '/project';

// Metric-only HealthUpdates keep the `links` array identity, so reuse one array
// per shape.
const linksByFileCount = new Map<number, GraphLink[]>();
function linksFor(files: number): GraphLink[] {
  let links = linksByFileCount.get(files);
  if (!links) {
    links = Array.from({ length: files }, (_, i) => ({ source: ROOT, target: `${ROOT}/f${i}.ts` }));
    linksByFileCount.set(files, links);
  }
  return links;
}

function scan(health: number, files = 2): ScanResult {
  const fileNodes: GraphNode[] = Array.from({ length: files }, (_, i) => ({
    id: `${ROOT}/f${i}.ts`,
    name: `f${i}.ts`,
    path: `${ROOT}/f${i}.ts`,
    kind: 'file' as const,
    ext: '.ts',
    health: i === 0 ? health : 70,
  }));
  return {
    root: ROOT,
    nodes: [{ id: ROOT, name: 'project', path: ROOT, kind: 'dir' }, ...fileNodes],
    links: linksFor(files),
  };
}

type GraphDataShape = { nodes: GraphNode[]; links: unknown[] };

function fakeGraph() {
  let current: GraphDataShape = { nodes: [], links: [] };
  const counts = { refreshes: 0, swaps: 0 };
  const graph = {
    graphData(next?: GraphDataShape) {
      if (next === undefined) return current;
      current = next;
      counts.swaps++;
      return graph;
    },
    refresh() {
      counts.refreshes++;
      return graph;
    },
    enablePointerInteraction() {
      return graph;
    },
  };
  return {
    counts,
    graph: graph as unknown as ForceGraph3DInstance,
    simNode: (id: string) => current.nodes.find((node) => node.id === id),
  };
}

function mountDataSync(t: TestContext) {
  const timers = installManualTimers();
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('React', React),
  ];
  const fake = fakeGraph();
  const graphRef: { current: ForceGraph3DInstance | null } = { current: fake.graph };
  const healthModeRef = { current: true };
  const locModeRef = { current: false };
  const deadModeRef = { current: false };
  const onResetSelection = () => {};
  function Harness({ data }: { data: ScanResult | null }) {
    useGraphDataSync({
      graphRef,
      data,
      history: null,
      onResetSelection,
      healthModeRef,
      locModeRef,
      deadModeRef,
    });
    return null;
  }
  let renderer: ReturnType<typeof TestRenderer.create> | undefined;
  t.after(async () => {
    try {
      if (renderer) await act(async () => { renderer!.unmount(); });
    } finally {
      timers.restore();
      for (const cleanup of restore.reverse()) cleanup();
    }
  });
  return {
    timers,
    fake,
    healthModeRef,
    async show(data: ScanResult | null) {
      await act(async () => {
        const element = React.createElement(Harness, { data });
        if (renderer) renderer.update(element);
        else renderer = TestRenderer.create(element);
      });
    },
    async unmount() {
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    },
    delays: () => timers.scheduled.map((timer) => timer.delay),
  };
}

test('ten metric-only batches under a held H view coalesce into one refresh; unmount cancels a pending one', async (t) => {
  const sync = mountDataSync(t);
  await sync.show(scan(50));
  assert.equal(sync.fake.counts.swaps, 1, 'first load is a full graphData swap');
  // No label was ever built, so the swap's batched clear has nothing to trim.
  assert.deepEqual(sync.delays(), []);

  for (let i = 1; i <= 10; i++) await sync.show(scan(50 + i));

  assert.equal(sync.fake.counts.swaps, 1, 'metric-only updates never swap graphData');
  assert.equal(sync.fake.simNode(`${ROOT}/f0.ts`)?.health, 60, 'values are patched immediately');
  assert.equal(sync.fake.counts.refreshes, 0, 'no refresh before the window elapses');
  assert.deepEqual(sync.delays(), [METRIC_REFRESH_COALESCE_MS], 'one pending refresh for all ten batches');

  sync.timers.fireAll();
  assert.equal(sync.fake.counts.refreshes, 1, 'exactly one refresh once the window elapses');
  assert.equal(sync.timers.scheduled.length, 0);

  for (let i = 11; i <= 13; i++) await sync.show(scan(50 + i));
  assert.deepEqual(sync.delays(), [METRIC_REFRESH_COALESCE_MS]);
  await sync.unmount();
  assert.equal(sync.timers.scheduled.length, 0, 'unmount cancels the pending refresh');
  sync.timers.fireAll();
  assert.equal(sync.fake.counts.refreshes, 1, 'zero refreshes after unmount');
});

test('a full swap, a data reset or a released view drops the pending metric refresh', async (t) => {
  const sync = mountDataSync(t);
  await sync.show(scan(50));

  // A structural change rebuilds every node object itself.
  await sync.show(scan(51));
  assert.deepEqual(sync.delays(), [METRIC_REFRESH_COALESCE_MS]);
  await sync.show(scan(51, 3));
  assert.equal(sync.fake.counts.swaps, 2);
  assert.deepEqual(sync.delays(), [], 'the swap cancelled the pending refresh');

  // Project switch / scan reset.
  await sync.show(scan(52, 3));
  assert.deepEqual(sync.delays(), [METRIC_REFRESH_COALESCE_MS]);
  await sync.show(null);
  assert.equal(sync.fake.counts.swaps, 3);
  assert.deepEqual(sync.delays(), [], 'the reset cancelled the pending refresh');

  // The view was released (its keyup refreshed already) before the window ran out.
  await sync.show(scan(53, 3));
  await sync.show(scan(54, 3));
  assert.deepEqual(sync.delays(), [METRIC_REFRESH_COALESCE_MS]);
  sync.healthModeRef.current = false;
  sync.timers.fireAll();

  assert.equal(sync.fake.counts.swaps, 4);
  assert.equal(sync.fake.counts.refreshes, 0);
  assert.equal(sync.timers.scheduled.length, 0);
});
