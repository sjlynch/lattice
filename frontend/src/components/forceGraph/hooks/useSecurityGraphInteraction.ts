import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../../../api';
import type { SecurityOverlayControl } from './useSecurityOverlay';
import { securityPathKey } from '../securityOverlay';
import { mountedNodes } from '../mountedNodes';
import { getIdleController } from '../idleController';

export function useSecurityGraphInteraction(security: SecurityOverlayControl, graphRef: MutableRefObject<ForceGraph3DInstance | null>, setSelected: (ids: Set<string>) => void) {
  const pulse = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.onNodeClick((object: object, event: MouseEvent) => {
      if (!security.active || event.shiftKey || event.ctrlKey || event.metaKey) return;
      const node = object as GraphNode;
      if (node.kind !== 'file' || !security.result) return;
      const root = security.result.canonicalProject.replace(/[\\/]+$/, '');
      const file = security.result.files.find((f) => securityPathKey(`${root}/${f.path}`) === securityPathKey(node.path));
      const path = file?.path ?? node.path.replace(/\\/g, '/').slice(root.length + 1);
      setSelected(new Set([node.id])); security.onShowFindings?.(path);
    });
    return () => { graph.onNodeClick(() => {}); };
  }, [security.active, security.result, security.onShowFindings, graphRef, setSelected]);
  useEffect(() => () => { if (pulse.current) clearInterval(pulse.current); }, []);
  return useCallback((file: string) => {
    const graph = graphRef.current;
    if (!graph || !security.result) return;
    const root = security.result.canonicalProject.replace(/[\\/]+$/, '');
    const node = mountedNodes(graph).find((n) => securityPathKey(n.path) === securityPathKey(`${root}/${file}`));
    if (!node) return;
    setSelected(new Set([node.id]));
    const position = node as GraphNode & { x?: number; y?: number; z?: number };
    if (typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') return;
    const target = (graph.controls() as { target?: { x: number; y: number; z: number } }).target;
    const camera = graph.camera();
    graph.cameraPosition(target ? { x: camera.position.x + position.x - target.x,
      y: camera.position.y + position.y - target.y, z: camera.position.z + position.z - target.z } : {},
    { x: position.x, y: position.y, z: position.z }, 450);
    const idle = getIdleController(graph);
    if (pulse.current) clearInterval(pulse.current);
    idle?.wakeForRefresh();
    const until = Date.now() + 550;
    pulse.current = setInterval(() => { idle?.wakeForRefresh(); if (Date.now() >= until && pulse.current) { clearInterval(pulse.current); pulse.current = null; } }, 100);
  }, [security.result, graphRef, setSelected]);
}
