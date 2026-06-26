import type { ForceGraph3DInstance } from '3d-force-graph';
import { getIdleController } from './idleController';

export function capacityWithSlack(count: number, slack: number): number {
  return count + slack;
}

export function wakeInstancedRefresh(graph: ForceGraph3DInstance): void {
  getIdleController(graph)?.wakeForRefresh();
}

export function disposeMapValues<K, V>(
  map: Map<K, V>,
  dispose: (value: V) => void,
): void {
  for (const value of map.values()) dispose(value);
  map.clear();
}

export function visibilityPredicate<T>(
  raw: unknown,
  nonFunctionVisible = raw === undefined || !!raw,
): (value: T) => boolean {
  if (typeof raw === 'function') {
    const fn = raw as (value: T) => unknown;
    return (value: T) => !!fn(value);
  }
  return () => nonFunctionVisible;
}
