// In-place delta walkers for the `W` worktree-modified rings (the same
// sibling-child toggle pattern as `selectionHaloSync` / `changeRingSync`):
// never a `graph.refresh()`, just `setNodeWorktreeRing` on each mounted root.
//
// The ring is the one per-node overlay whose state is NOT derivable inside
// `decideSpriteState` — it comes from a fetched path→color snapshot. So the
// live snapshot is parked in `worktreeRingsRef` (null while the view is
// inactive) and `buildNodeObject` re-attaches the ring from it on every full
// rebuild. Without that, any rebuild that runs while the view is active — a
// metric-view toggle, a node-size slider, the batched-nodes flip, a change to
// the metrics-ignore list, a file-save rescan — replaced every root and
// silently dropped every ring.

import type { MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphSettings } from './graphSettings';
import { getIdleController } from './idleController';
import { baseSizeFor, mountedNodes, mountedRoot } from './mountedNodes';
import { normalizeWorktreePath, setNodeWorktreeRing } from './worktreeRing';

// Normalized path → task color for the active `W` snapshot; `null` when the
// view is inactive (no ring is ever attached from a null map).
export type WorktreeRingsRef = MutableRefObject<Map<string, string> | null>;

// Publish `pathColors` as the live snapshot and reconcile every mounted node
// against it in one O(N) pass: ring the hits (recoloring an existing ring in
// place), strip everything else.
export function applyWorktreeRings(
  graph: ForceGraph3DInstance,
  ringsRef: WorktreeRingsRef,
  pathColors: Map<string, string>,
  settings: GraphSettings,
): void {
  ringsRef.current = pathColors;
  for (const node of mountedNodes(graph)) {
    const root = mountedRoot(node);
    if (!root) continue;
    const color =
      typeof node.path === 'string'
        ? pathColors.get(normalizeWorktreePath(node.path))
        : undefined;
    if (color) setNodeWorktreeRing(root, true, color, baseSizeFor(node, settings));
    else setNodeWorktreeRing(root, false, '', 0);
  }
  getIdleController(graph)?.wakeForRefresh();
}

// Drop the snapshot and strip every tagged ring across the whole graph. A
// one-shot O(N) walk rather than a remembered id set: a full rebuild between
// apply and clear replaces the roots the set pointed at (the factory re-rings
// them from the snapshot), so only the scene itself knows what's ringed.
export function clearWorktreeRings(
  graph: ForceGraph3DInstance | null,
  ringsRef: WorktreeRingsRef,
): void {
  if (ringsRef.current === null) return;
  ringsRef.current = null;
  if (!graph) return;
  for (const node of mountedNodes(graph)) {
    const root = mountedRoot(node);
    if (root) setNodeWorktreeRing(root, false, '', 0);
  }
  getIdleController(graph)?.wakeForRefresh();
}
