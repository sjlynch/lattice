// Per-graph memory gauges for the debug line (debug/memDiag.ts). Registered
// when a graph is initialized and unregistered at its teardown, so a remount
// (project switch, Retry) never leaves a reader pointing at a dead renderer.
// `gl.*` are three's live GPU object counts: geometries/textures that only
// ever climb across project switches or overlay toggles are undisposed
// resources; `gl.programs` climbing means shader variants are piling up.

import type { ForceGraph3DInstance } from '3d-force-graph';
import { registerMemGauge } from '../../debug/memDiag';

export function registerGraphMemGauges(graph: ForceGraph3DInstance): () => void {
  const info = () => graph.renderer()?.info;
  const unregister = [
    registerMemGauge('gl.geometries', () => info()?.memory.geometries ?? -1),
    registerMemGauge('gl.textures', () => info()?.memory.textures ?? -1),
    registerMemGauge('gl.programs', () => info()?.programs?.length ?? -1),
    registerMemGauge('graph.nodes', () => graph.graphData().nodes.length),
    registerMemGauge('graph.links', () => graph.graphData().links.length),
  ];
  return () => {
    for (const off of unregister) off();
  };
}
