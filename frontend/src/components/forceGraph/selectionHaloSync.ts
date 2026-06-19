// Selection halos used to be updated via `graph.refresh()`, which
// re-runs `nodeThreeObject` for *every* node — for a project with 1000+
// files that meant 1000+ fresh sprite allocations per click just to
// add or remove the light-blue halo on one node.
//
// `applySelectionHaloDelta` instead walks only the affected ids,
// reaches through the library's `__threeObj` binding, and toggles the
// halo sibling child via `setNodeHalo`. Cost is O(|added| + |removed|)
// per selection change. The mounted-node walk + id index + base-size are
// the shared `mountedNodes` helpers.

import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphSettings } from './graphSettings';
import { setNodeHalo } from './halo';
import { baseSizeFor, mountedNodesById, mountedRoot } from './mountedNodes';

export function applySelectionHaloDelta(
  graph: ForceGraph3DInstance,
  prev: Set<string>,
  next: Set<string>,
  settings: GraphSettings,
): void {
  // Early-out: if the symmetric difference is empty (nothing added or
  // removed) there's no halo to toggle, so skip the O(N) index build.
  // `useGraphSearch` pushes a fresh `selected` Set per keystroke — often
  // value-identical to the last — so this guard runs hot.
  let changed = false;
  for (const id of next) {
    if (!prev.has(id)) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    for (const id of prev) {
      if (!next.has(id)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;

  // Build a single id→node index instead of two passes; selection
  // deltas usually touch a handful of ids so the map is cheap.
  const byId = mountedNodesById(graph);
  if (byId.size === 0) return;

  // Newly deselected — strip the halo.
  for (const id of prev) {
    if (next.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    const root = mountedRoot(node);
    if (root) setNodeHalo(root, false, baseSizeFor(node, settings));
  }
  // Newly selected — add the halo.
  for (const id of next) {
    if (prev.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    const root = mountedRoot(node);
    if (root) setNodeHalo(root, true, baseSizeFor(node, settings));
  }
}
