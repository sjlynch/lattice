import { useEffect, useRef } from 'react';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { forceLocalRepulsion, type LocalRepulsionForce } from '../localRepulsionForce';
import { type GraphRef, hasMountedNodes } from './graphSettingsEffectUtils';

// The cell size (== interaction radius) of the local repulsion force is derived
// from the link distance so its reach scales with the graph's natural spacing.
function localCellSize(linkDistance: number): number {
  return Math.max(40, linkDistance * 2);
}

type PhysicsSettings = Pick<
  GraphSettings,
  | 'dagLevelDistance'
  | 'velocityDecay'
  | 'chargeStrength'
  | 'linkDistance'
  | 'chargeTheta'
  | 'repulsionMode'
>;

type CachedChargeForce = {
  // Only the empty-node initialization contract is needed for detachment.
  initialize(nodes: never[]): void;
  strength?: (n: number) => unknown;
  theta?: (n: number) => unknown;
};

export function usePhysicsAndRepulsionSettings(
  settings: PhysicsSettings,
  graphRef: GraphRef,
): void {
  // Apply physics + DAG settings to the running simulation. Reheats so changes
  // visibly take effect, but skips reheat on initial/no-node runs.
  const nbodyForceRef = useRef<CachedChargeForce | null>(null);
  const localForceRef = useRef<LocalRepulsionForce | null>(null);
  const appliedPhysicsRef = useRef<PhysicsSettings>(settings);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.dagLevelDistance(settings.dagLevelDistance);
    g.d3VelocityDecay(settings.velocityDecay);

    const d3Force = g.d3Force as unknown as (
      name: string,
      force?: unknown,
    ) => unknown;

    const current = d3Force('charge') as CachedChargeForce | undefined;
    if (!nbodyForceRef.current) nbodyForceRef.current = current ?? null;
    if (!localForceRef.current) {
      localForceRef.current = forceLocalRepulsion();
    }
    const nbody = nbodyForceRef.current;
    const local = localForceRef.current;

    // Keep both forces configured from the current settings so a mode flip is
    // instant and the active slider always applies regardless of mode.
    nbody?.strength?.(settings.chargeStrength);
    nbody?.theta?.(settings.chargeTheta);
    local.strength(settings.chargeStrength);
    local.cellSize(localCellSize(settings.linkDistance));

    const desired = settings.repulsionMode === 'local' ? local : nbody;
    if (desired && current !== desired) {
      d3Force('charge', desired);
      // Only empty the former force after replacement succeeds. Reattachment
      // lets d3 initialize it with current nodes, random source and dimensions.
      current?.initialize([]);
    }

    const link = g.d3Force('link') as
      | { distance?: (n: number) => unknown }
      | undefined;
    link?.distance?.(settings.linkDistance);

    const prev = appliedPhysicsRef.current;
    const changed =
      prev.dagLevelDistance !== settings.dagLevelDistance ||
      prev.velocityDecay !== settings.velocityDecay ||
      prev.chargeStrength !== settings.chargeStrength ||
      prev.linkDistance !== settings.linkDistance ||
      prev.chargeTheta !== settings.chargeTheta ||
      prev.repulsionMode !== settings.repulsionMode;
    appliedPhysicsRef.current = settings;
    if (!changed || !hasMountedNodes(g)) return;

    // Defer reheat until kapsule's debounced digest has installed state.layout.
    const timer = setTimeout(() => {
      if (graphRef.current === g) {
        g.d3ReheatSimulation();
        getIdleController(g)?.engineStarted();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [
    settings.dagLevelDistance,
    settings.velocityDecay,
    settings.chargeStrength,
    settings.linkDistance,
    settings.chargeTheta,
    settings.repulsionMode,
    graphRef,
  ]);
}
