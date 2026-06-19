// Timeline change-rings used to be updated via `graph.refresh()`, which
// re-runs `nodeThreeObject` for *every* node — for a 1000-file project that
// meant 1000+ fresh sprite allocations on every scrubber notch that flipped
// the change set, even though a single commit usually touches a handful of
// files.
//
// `applyChangeRingDelta` instead diffs the previous change map against the
// next one, walks only the affected rel-paths, reaches through the library's
// `__threeObj` binding, and toggles the change-ring sibling child via
// `setNodeChangeRing`. Cost is O(|changed paths|) ring mutations plus one
// O(N) node scan to resolve paths → mounted objects — the expensive part (the
// per-node sprite/texture rebuild) is gone. Mirrors `selectionHaloSync` and
// `labelSync`.
//
// It also flips ghost-node visibility for the same affected paths: a deleted
// file's ghost disc is built once by `nodeObjectFactory`, but it should only
// show while its path is in the active change map. The full-refresh path used
// to re-run `nodeVisibility` for that; with the refresh gone, the delta does
// it directly for the paths whose presence changed (see `useGraphFilter` — its
// accessor still reads the live map for genuine refreshes / data swaps).

import type { ForceGraph3DInstance } from '3d-force-graph';
import type * as THREE from 'three';
import type { GraphNode } from '../../api';
import { setNodeChangeRing, type ChangeKind } from './changeRing';
import type { GraphSettings } from './graphSettings';
import { isGhost, relForward } from './timelineDiff';

// three-forcegraph's default `objBindAttr`; the library binds the mounted
// root object back onto the sim node under this key (same as selectionHaloSync).
const OBJ_BIND_ATTR = '__threeObj' as const;

type SimNodeWithObj = GraphNode & { [OBJ_BIND_ATTR]?: THREE.Object3D };

// Rel-paths whose change kind differs between the two maps (added, removed,
// or recolored). These are the only nodes whose ring / ghost visibility can
// possibly need touching.
function changedPaths(
  prev: Map<string, ChangeKind>,
  next: Map<string, ChangeKind>,
): Set<string> {
  const out = new Set<string>();
  for (const [p, k] of next) {
    if (prev.get(p) !== k) out.add(p);
  }
  for (const p of prev.keys()) {
    if (!next.has(p)) out.add(p);
  }
  return out;
}

// Apply the prev→next change-map diff in place. Returns whether any mounted
// node was actually touched, so the caller can wake a few refresh frames only
// when something changed (the render loop is otherwise paused once settled).
export function applyChangeRingDelta(
  graph: ForceGraph3DInstance,
  prev: Map<string, ChangeKind>,
  next: Map<string, ChangeKind>,
  settings: GraphSettings,
  scanRoot: string,
): boolean {
  const affected = changedPaths(prev, next);
  if (affected.size === 0) return false;

  // `graphData()` returns the library's internal nodes array — the same
  // objects it binds `__threeObj` onto.
  const getGraphData = graph.graphData as unknown as () => { nodes?: object[] };
  const nodes = (getGraphData.call(graph)?.nodes ?? []) as SimNodeWithObj[];
  if (nodes.length === 0) return false;

  // Change rings are sized off `fileNodeSize` — they only ever ride on file
  // nodes (dirs never get one; see `nodeObjectFactory`).
  const baseSize = settings.fileNodeSize;
  let changed = false;

  for (const node of nodes) {
    const root = node[OBJ_BIND_ATTR];
    if (!root) continue;

    if (isGhost(node)) {
      // Ghost paths are already root-relative, forward-slash. The ghost's
      // grey disc + red ring is intrinsic to its built sprite — only its
      // visibility tracks the change map.
      const rel = node.path;
      if (!affected.has(rel)) continue;
      const want = next.has(rel);
      if (root.visible !== want) {
        root.visible = want;
        changed = true;
      }
      continue;
    }

    if (node.kind !== 'file') continue;
    const rel = relForward(node.path, scanRoot);
    if (!affected.has(rel)) continue;
    // 'deleted' on a real (still-in-scan) file shows no ring — same guard as
    // `buildNodeObject`; the deleted *ghost* (if any) carries the red ring.
    const kind = next.get(rel);
    setNodeChangeRing(root, kind && kind !== 'deleted' ? kind : null, baseSize);
    changed = true;
  }

  return changed;
}
