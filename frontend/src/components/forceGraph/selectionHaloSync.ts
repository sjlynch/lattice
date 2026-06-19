// Selection halos used to be updated via `graph.refresh()`, which
// re-runs `nodeThreeObject` for *every* node — for a project with 1000+
// files that meant 1000+ fresh sprite allocations per click just to
// add or remove the light-blue halo on one node.
//
// `applySelectionHaloDelta` instead walks only the affected ids,
// reaches through the library's `__threeObj` binding, and toggles the
// halo sibling child via `setNodeHalo`. Cost is O(|added| + |removed|)
// per selection change.

import type { ForceGraph3DInstance } from '3d-force-graph';
import type * as THREE from 'three';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import { setNodeHalo } from './halo';
import { isGhost } from './timelineDiff';

// three-forcegraph's default `objBindAttr`. The library attaches the
// mounted root object back onto the sim node under this key after every
// `nodeThreeObject` call. The 3d-force-graph types don't surface this
// (it's a configurable internal), so we read it via a local cast.
const OBJ_BIND_ATTR = '__threeObj' as const;

type SimNodeWithObj = GraphNode & { [OBJ_BIND_ATTR]?: THREE.Object3D };

function getMountedRoot(node: SimNodeWithObj): THREE.Object3D | undefined {
  return node[OBJ_BIND_ATTR];
}

// Determine the base size used when this node was last mounted, so the
// halo we add now matches the ring scale used by `buildNodeObject`.
// Ghost nodes always use `fileNodeSize` (see `nodeObjectFactory`).
function baseSizeFor(node: GraphNode, settings: GraphSettings): number {
  if (isGhost(node)) return settings.fileNodeSize;
  return node.kind === 'dir' ? settings.dirNodeSize : settings.fileNodeSize;
}

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

  // `graphData()` returns the library's internal nodes array — same
  // objects the library binds `__threeObj` onto. We index by id so
  // the diff lookups stay O(1).
  const getGraphData = graph.graphData as unknown as () => { nodes?: object[] };
  const nodes = (getGraphData.call(graph)?.nodes ?? []) as SimNodeWithObj[];
  if (nodes.length === 0) return;

  // Build a single id→node index instead of two passes; selection
  // deltas usually touch a handful of ids so the map is cheap.
  const byId = new Map<string, SimNodeWithObj>();
  for (const n of nodes) {
    if (typeof n.id === 'string') byId.set(n.id, n);
  }

  // Newly deselected — strip the halo.
  for (const id of prev) {
    if (next.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    const root = getMountedRoot(node);
    if (root) setNodeHalo(root, false, baseSizeFor(node, settings));
  }
  // Newly selected — add the halo.
  for (const id of next) {
    if (prev.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    const root = getMountedRoot(node);
    if (root) setNodeHalo(root, true, baseSizeFor(node, settings));
  }
}
