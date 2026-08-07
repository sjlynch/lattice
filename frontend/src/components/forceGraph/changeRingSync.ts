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
//
// A ghost's LINK has to move with it. `linkVisibility` is only consulted by the
// library's digest — which is exactly what this delta exists to avoid — so
// hiding the ghost disc on its own left the line to its parent directory still
// drawn: a connector dangling into empty space once the scrubber moved past the
// deletion commit. Both link renderers are therefore synced alongside the node:
// the library's per-link object (`__lineObj`) directly, and the batched
// `LineSegments` (which captured its visible set at its last rebuild) via a
// re-capture. Conversely, a ghost the delta can't *show* — because some earlier
// `graph.refresh()` ran while it was out of the window, and the digest drops
// filtered-out nodes from the scene entirely — falls back to a refresh, since
// there's no mounted object left to toggle back on.

import type { ForceGraph3DInstance } from '3d-force-graph';
import type * as THREE from 'three';
import type { GraphNode } from '../../api';
import { setNodeChangeRing, type ChangeKind } from './changeRing';
import type { GraphSettings } from './graphSettings';
import { getInstancedLinks } from './instancedLinks';
import { clearLabelsAndRefresh } from './hooks/refresh';
import { isGhost, relForward } from './timelineDiff';

// three-forcegraph's default `objBindAttr`; the library binds the mounted
// root object back onto the sim node under this key (same as selectionHaloSync).
const OBJ_BIND_ATTR = '__threeObj' as const;
// The link-side equivalent: the per-link `Line` (or, with batched links on, the
// empty placeholder `Object3D`) the library mounts for each *visible* link.
const LINE_BIND_ATTR = '__lineObj' as const;

type SimNodeWithObj = GraphNode & { [OBJ_BIND_ATTR]?: THREE.Object3D };

type SimLinkWithObj = {
  source: SimNodeWithObj | string;
  target: SimNodeWithObj | string;
  [LINE_BIND_ATTR]?: THREE.Object3D;
};

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

// The ghost end of a link, or null when neither endpoint is one. Ghost links
// are minted parent-dir → ghost (`buildGhostGraphData`), but check both ends so
// this doesn't silently depend on that orientation. Endpoints are still id
// strings until `graphData()` hydrates them — a link in that state has no
// mounted object to toggle either, so skipping it is correct.
function ghostEndpoint(link: SimLinkWithObj): SimNodeWithObj | null {
  const source = typeof link.source === 'object' ? link.source : null;
  if (source && isGhost(source)) return source;
  const target = typeof link.target === 'object' ? link.target : null;
  if (target && isGhost(target)) return target;
  return null;
}

// Mirror the ghosts' in-place visibility onto the per-link objects hanging off
// them, so a ghost that just vanished doesn't leave its line to the parent
// directory drawn (and one that just appeared isn't linkless). Cheap enough to
// re-assert every ghost link rather than only the affected ones — it runs only
// on the rare tick where a ghost's presence actually flipped.
function syncGhostLinkObjects(
  links: SimLinkWithObj[],
  next: Map<string, ChangeKind>,
): void {
  for (const link of links) {
    const ghost = ghostEndpoint(link);
    if (!ghost) continue;
    // Absent while the link is filtered out of the library's digest; with
    // batched links on it's the empty placeholder, so this is a harmless no-op
    // there and the batched re-capture below does the real work.
    const obj = link[LINE_BIND_ATTR];
    if (!obj) continue;
    const want = next.has(ghost.path);
    if (obj.visible !== want) obj.visible = want;
  }
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

  // `graphData()` returns the library's internal nodes/links arrays — the same
  // objects it binds `__threeObj` / `__lineObj` onto.
  const getGraphData = graph.graphData as unknown as () => {
    nodes?: object[];
    links?: object[];
  };
  const graphData = getGraphData.call(graph);
  const nodes = (graphData?.nodes ?? []) as SimNodeWithObj[];
  if (nodes.length === 0) return false;

  // Change rings are sized off `fileNodeSize` — they only ever ride on file
  // nodes (dirs never get one; see `nodeObjectFactory`).
  const baseSize = settings.fileNodeSize;
  let changed = false;
  // A ghost disc was shown/hidden → its link renderers need the same flip.
  let ghostFlipped = false;
  // A ghost should be showing but has no mounted object at all → only a
  // re-digest can bring it (and its link) back.
  let needsRemount = false;

  for (const node of nodes) {
    const root = node[OBJ_BIND_ATTR];

    if (isGhost(node)) {
      // Ghost paths are already root-relative, forward-slash. The ghost's
      // grey disc + red ring is intrinsic to its built sprite — only its
      // visibility tracks the change map.
      const rel = node.path;
      if (!affected.has(rel)) continue;
      const want = next.has(rel);
      if (!root) {
        // Not in the scene: a `graph.refresh()` while this ghost was outside
        // the window (releasing an H/Z/D view, a sprite-size change, …) made
        // the library's digest drop it and delete its `__threeObj`. Nothing to
        // toggle — request the re-digest below.
        if (want) needsRemount = true;
        continue;
      }
      if (root.visible !== want) {
        root.visible = want;
        ghostFlipped = true;
        changed = true;
      }
      continue;
    }

    if (!root) continue;
    if (node.kind !== 'file') continue;
    const rel = relForward(node.path, scanRoot);
    if (!affected.has(rel)) continue;
    // 'deleted' on a real (still-in-scan) file shows no ring — same guard as
    // `buildNodeObject`; the deleted *ghost* (if any) carries the red ring.
    const kind = next.get(rel);
    setNodeChangeRing(root, kind && kind !== 'deleted' ? kind : null, baseSize);
    changed = true;
  }

  if (needsRemount) {
    // Rebuilds every node object from the live change map, so it subsumes the
    // in-place toggles above — including the ghost links, which the digest
    // re-evaluates through `linkVisibility`. Routed through the shared helper
    // so the label registries are released rather than leaked.
    clearLabelsAndRefresh(graph);
    changed = true;
  } else if (ghostFlipped) {
    syncGhostLinkObjects((graphData?.links ?? []) as SimLinkWithObj[], next);
  }
  if (ghostFlipped || needsRemount) {
    // The batched renderer draws from a link array captured at its last
    // rebuild, so the vanished ghost's segment is still in the buffer (or the
    // restored one still missing) until it re-reads `linkVisibility`. No-op
    // when batched links are off.
    getInstancedLinks(graph)?.rebuild();
  }

  return changed;
}
