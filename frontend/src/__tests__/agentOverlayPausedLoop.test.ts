import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { AgentOverlayCtx } from '../components/forceGraph/agentOverlayContext.ts';
import type { SimNode } from '../components/forceGraph/agentOverlayTypes.ts';
import {
  BEAM_TTL_MS,
  SATELLITE_IDLE_TTL_MS,
} from '../components/forceGraph/agentOverlayConstants.ts';
import { reapStaleSatellites } from '../components/forceGraph/hooks/agentOverlayEvents.ts';
import { installCanvasDocument } from './domDoubles.ts';

// Regression: expired focus beams and missed-SubagentStop satellites were only
// disposed inside `tick`, which runs only while the graph renders. The render
// loop is paused for a hidden tab or a 0×0 graph (terminal maximized), so an
// agent exploring files in the background left a Line + BufferGeometry +
// LineBasicMaterial in the scene group for every distinct file it touched.
// None of these tests ever call `tick`.

const restoreDocument = installCanvasDocument();
after(restoreDocument);
const { AgentOverlay } = await import('../components/forceGraph/agentOverlay.ts');

function makeGraph() {
  const scene = new THREE.Scene();
  const nodes: SimNode[] = [{ id: 'f0', path: 'src/f0.ts', x: 0, y: 0, z: 0 }];
  const graph = {
    scene: () => scene,
    graphData: () => ({ nodes, links: [] }),
  } as unknown as ForceGraph3DInstance;
  return graph;
}

function context(overlay: InstanceType<typeof AgentOverlay>): AgentOverlayCtx {
  return (overlay as unknown as { ctx: AgentOverlayCtx }).ctx;
}

for (const host of ['agent', 'satellite'] as const) {
  test(`expired ${host} focus beams are released while no frame renders`, (t) => {
    const graph = makeGraph();
    const overlay = new AgentOverlay(graph, 4);
    t.after(() => overlay.destroy(graph));
    const ctx = context(overlay);
    overlay.setAgents([{ taskId: 'a', color: '#ffffff' }], graph);
    const agent = ctx.agents.get('a')!;
    let now = 1000;
    if (host === 'satellite') overlay.addSubagent('a', 'sub', 'Explore', now);
    const beamHost = host === 'agent' ? agent : agent.satellites.get('sub')!;
    const baseline = ctx.group.children.length;
    let geometries = 0;
    let materials = 0;

    for (let i = 0; i < 200; i++) {
      const file = `src/f${i}.ts`;
      const applied = host === 'agent'
        ? overlay.addActivity('a', file, 'start', now)
        : overlay.addSubagentActivity('a', 'sub', 'Explore', file, 'start', now);
      assert.equal(applied, true);
      const beam = beamHost.beams.get(file)!;
      beam.geometry.addEventListener('dispose', () => geometries++);
      beam.material.addEventListener('dispose', () => materials++);
      // At most the current (persistent) beam plus the one just demoted.
      assert.ok(beamHost.beams.size <= 2, `beams after ${i + 1}: ${beamHost.beams.size}`);
      assert.ok(
        ctx.group.children.length <= baseline + 2,
        `group children after ${i + 1}: ${ctx.group.children.length}`,
      );
      now += BEAM_TTL_MS + 1;
    }

    assert.equal(geometries, 198, 'every expired beam geometry was disposed');
    assert.equal(materials, 198, 'every expired beam material was disposed');
    assert.equal(beamHost.beams.get('src/f199.ts')?.endAt, Infinity, 'current file stays lit');
    assert.equal(beamHost.currentFile, 'src/f199.ts');
  });
}

test('the reap timer disposes a satellite past its idle deadline without a tick', (t) => {
  const graph = makeGraph();
  const overlay = new AgentOverlay(graph, 4);
  t.after(() => overlay.destroy(graph));
  const ctx = context(overlay);
  overlay.setAgents([{ taskId: 'a', color: '#ffffff' }], graph);
  const agent = ctx.agents.get('a')!;
  let kicks = 0;
  let wakes = 0;
  const kick = () => kicks++;
  const wakeRefresh = () => wakes++;

  // A subagent whose SubagentStop was missed: it touched a file (leaving a
  // persistent current-file beam), then went quiet.
  const start = 1000;
  overlay.addSubagentActivity('a', 'dead', 'Explore', 'src/f0.ts', 'start', start);
  const dead = agent.satellites.get('dead')!;
  const deadBeam = dead.beams.get('src/f0.ts')!;
  const deadObjects = [dead.node, dead.tether.line, deadBeam.line];
  let disposed = 0;
  deadBeam.geometry.addEventListener('dispose', () => disposed++);
  dead.tether.geometry.addEventListener('dispose', () => disposed++);

  // Not yet due: nothing is reaped and the loop is left asleep.
  reapStaleSatellites(overlay, start + SATELLITE_IDLE_TTL_MS, kick, wakeRefresh);
  assert.equal(agent.satellites.get('dead'), dead);
  assert.deepEqual([kicks, wakes], [0, 0]);

  // Due: the dead satellite goes; a recently-seen sibling survives the beat.
  const due = start + SATELLITE_IDLE_TTL_MS + 1;
  overlay.addSubagent('a', 'live', 'Plan', due - 1000);
  reapStaleSatellites(overlay, due, kick, wakeRefresh);
  assert.equal(agent.satellites.has('dead'), false);
  assert.equal(agent.satellites.has('live'), true);
  for (const obj of deadObjects) assert.equal(ctx.group.children.includes(obj), false);
  assert.equal(dead.beams.size, 0);
  assert.equal(disposed, 2, 'beam and tether geometries disposed');
  // The removal still wakes the loop so a visible graph repaints it.
  assert.deepEqual([kicks, wakes], [1, 1]);

  // Nothing left to reap: the next beat is a no-op.
  reapStaleSatellites(overlay, due + 1, kick, wakeRefresh);
  assert.deepEqual([kicks, wakes], [1, 1]);
});
