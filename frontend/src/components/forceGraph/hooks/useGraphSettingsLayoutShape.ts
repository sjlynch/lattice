import { useEffect, useRef } from 'react';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { forceCollideXZ, type CollideForceXZ } from '../layoutShapeForces';
import { type GraphRef, hasMountedNodes } from './graphSettingsEffectUtils';

type LayoutShapeSettings = Pick<
  GraphSettings,
  'alphaDecay' | 'warmupTicks' | 'collideRadius'
>;

export function useLayoutShapeSettings(
  settings: LayoutShapeSettings,
  graphRef: GraphRef,
): void {
  // The "Spread" tab: engine-cooling knobs (alphaDecay/warmupTicks) plus an
  // optional X/Z-plane collision force. Push values every run so persisted
  // non-defaults apply after reload, but only reheat populated graphs on change.
  const collideForceRef = useRef<CollideForceXZ | null>(null);
  const appliedRef = useRef<LayoutShapeSettings>(settings);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;

    g.d3AlphaDecay(settings.alphaDecay);
    g.warmupTicks(settings.warmupTicks);

    const d3Force = g.d3Force as unknown as (
      name: string,
      force?: unknown,
    ) => unknown;

    if (settings.collideRadius > 0) {
      if (!collideForceRef.current) collideForceRef.current = forceCollideXZ();
      collideForceRef.current.radius(settings.collideRadius);
      if (d3Force('collide') !== collideForceRef.current) {
        d3Force('collide', collideForceRef.current);
      }
    } else if (d3Force('collide')) {
      d3Force('collide', null);
    }

    const prev = appliedRef.current;
    const changed =
      prev.alphaDecay !== settings.alphaDecay ||
      prev.warmupTicks !== settings.warmupTicks ||
      prev.collideRadius !== settings.collideRadius;
    appliedRef.current = settings;
    if (!changed || !hasMountedNodes(g)) return;

    const timer = setTimeout(() => {
      if (graphRef.current === g) {
        g.d3ReheatSimulation();
        getIdleController(g)?.engineStarted();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [settings.alphaDecay, settings.warmupTicks, settings.collideRadius, graphRef]);
}
