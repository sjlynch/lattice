// Name labels (Alt overlay) used to ride on each node's `nodeThreeObject`, so
// changing the visible depth band — or toggling the Shift (file-label) gate —
// meant a `graph.refresh()`, which the library implements by disposing and
// rebuilding EVERY node sprite. On a project with thousands of files that is a
// full teardown/rebuild per wheel notch.
//
// `applyLabelsToGraph` instead walks the sim nodes once and toggles each label
// in place on the already-mounted root via `applyNodeLabelState` (the same
// halo / worktree-ring pattern as `selectionHaloSync`). The per-node check is
// O(N) but cheap; only the handful of nodes that actually gain or lose a label
// allocate/free a sprite. No sprite is rebuilt and the d3 engine is untouched.

import type { ForceGraph3DInstance } from '3d-force-graph';
import type * as THREE from 'three';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import { applyNodeLabelState } from './labelsOverlay';

// three-forcegraph's default `objBindAttr` — the mounted root object the
// library stashes back onto each sim node (see `selectionHaloSync`).
const OBJ_BIND_ATTR = '__threeObj' as const;

type SimNodeWithObj = GraphNode & { [OBJ_BIND_ATTR]?: THREE.Object3D };

// Reconcile every mounted node's label against the current overlay state.
// `enabled` false (Alt released) drives `activeDepth` to a band no node sits on,
// so every label is stripped. When `selectedIds` is non-empty the overlay shows
// only those nodes' labels (depth band + Shift gate ignored) — see
// `shouldShowLabel`. Depths come from the precomputed id→depth map.
export function applyLabelsToGraph(
  graph: ForceGraph3DInstance,
  nodeDepths: Map<string, number>,
  settings: GraphSettings,
  activeDepth: number,
  showFileLabels: boolean,
  enabled: boolean,
  selectedIds: Set<string>,
): void {
  const getGraphData = graph.graphData as unknown as () => { nodes?: object[] };
  const nodes = (getGraphData.call(graph)?.nodes ?? []) as SimNodeWithObj[];
  // A band no real node occupies (depths are >= 0) → every label is removed.
  const band = enabled ? activeDepth : -1;
  // The selection only narrows the overlay while Alt is held; with Alt released
  // pass none so every label is stripped regardless of what's selected.
  const sel = enabled ? selectedIds : null;
  for (const node of nodes) {
    const root = node[OBJ_BIND_ATTR];
    if (!root) continue;
    const depth = nodeDepths.get(node.id) ?? 0;
    applyNodeLabelState(root, node, settings, band, depth, showFileLabels, sel);
  }
}
