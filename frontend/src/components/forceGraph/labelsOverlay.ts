// Labels overlay (active while the user holds Alt). Each node at the
// currently-active depth gets a name label floating above it; alt+wheel
// scrolls through depth levels so the user can read the graph one band of
// names at a time without overwhelming clutter.

import * as THREE from 'three';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import {
  type FloatingLabelEntry,
  makeConnectorLine,
  makeFloatingLabelSprite,
} from './floatingLabelSprite';
import {
  buildMeasuredLabelTexture,
  createLabelTextureCache,
  releaseLabelTexture,
  type LabelTextureOptions,
} from './labelTexture';
import { isGhost } from './timelineDiff';

// Node depth derived from path: root has depth 0; every path separator past
// the root prefix bumps the depth by one. Works for both POSIX and Windows
// separators since we count both.
export function depthFor(node: GraphNode, root: string): number {
  if (!root || !node.path.startsWith(root)) return 0;
  const rest = node.path.slice(root.length);
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest.charCodeAt(i);
    if (ch === 47 /* / */ || ch === 92 /* \\ */) n++;
  }
  return n;
}

const NAME_LABEL_TEXTURE_OPTIONS: LabelTextureOptions = {
  font: 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif',
  strokeWidth: 10,
  height: 96,
  padX: 20,
  minWidth: 96,
  maxEntries: 256,
};
const nameLabelTextureCache = createLabelTextureCache();

// Pushed up well clear of the node — same offset as the LOC overlay — so
// dense clusters of labels can fan out without crashing into their nodes.
export const LABEL_Y = 100;

// Minimum desired separation (graph units, before the user's `labelSpread`
// multiplier) between two name labels in the Alt-labels repulsion loop. Wider
// than the metric overlays' base (`METRIC_REPULSION_BASE` = 55 in
// metricOverlayFactory.ts) because filenames are much longer than the 3-digit
// LOC / 0–100 health values and would visibly overlap at that distance.
export const LABEL_REPULSION_BASE = 90;

// Local-space registry of active name-label sprites + their connector
// lines. The relaxation loop in ForceGraphView walks this each frame to
// spread overlapping labels apart and to keep the connector's upper
// endpoint anchored to its label, mirroring the LOC overlay.
export type LabelEntry = FloatingLabelEntry;
export const labelsRegistry = new Set<LabelEntry>();

// Tag carried by the label sprite + connector line, and the entry stash on the
// node's root `userData`, so a label can be toggled in place on an already-
// mounted node without rebuilding its sprite (the halo / worktree-ring pattern).
const LABEL_ENTRY = 'lattice:labelEntry';

function makeNameSprite(text: string, color: string, baseH: number): THREE.Sprite {
  const texture = buildMeasuredLabelTexture(
    nameLabelTextureCache,
    text,
    color,
    NAME_LABEL_TEXTURE_OPTIONS,
  );
  return makeFloatingLabelSprite(texture, baseH, {
    heightMultiplier: 1.6,
    maxScale: 120,
    aspectFallback: 3,
  });
}

// Whether this node should carry a name label for the current Alt-overlay
// state. Ghosts never get labels. When the user has an active selection
// (`selectedIds` non-empty) the overlay narrows to exactly those nodes —
// their labels show regardless of depth band or the Shift file gate, and no
// other node gets one. With no selection it falls back to the depth-band
// behavior: the node must sit on the active depth band, and file nodes only
// when Shift is held (Alt alone shows directory names only).
function shouldShowLabel(
  node: GraphNode,
  activeDepth: number,
  nodeDepth: number,
  showFileLabels: boolean,
  selectedIds?: Set<string> | null,
): boolean {
  if (isGhost(node)) return false;
  if (selectedIds && selectedIds.size > 0) return selectedIds.has(node.id);
  if (nodeDepth !== activeDepth) return false;
  if (node.kind === 'file' && !showFileLabels) return false;
  return true;
}

function disposeLabelEntry(entry: FloatingLabelEntry): void {
  // The label texture (nameLabelTextureCache), the sprite material (shared per
  // texture) and the connector's line material (shared per color) are all
  // module-owned caches in floatingLabelSprite/labelTexture — disposing any of
  // them here would break every other label still using them. The connector
  // geometry is the only thing this entry solely owns (a per-line clone of the
  // shared template), so it's the only thing we free. (Part A invariant.)
  entry.line.geometry.dispose();
  // Drop this sprite's reference to its label texture so the cache can reclaim
  // the texture once nothing else draws it (refcount-aware eviction). The
  // texture itself is NOT disposed here — it's shared and may still be in use.
  releaseLabelTexture(nameLabelTextureCache, entry.label.material.map);
}

// Release every active name label's texture refcount, then empty the registry.
// The blanket teardown paths (structural swap / refresh) drop all label sprites
// at once via the registry rather than per-entry, so they must release here to
// keep refcounts balanced against the build-time increments — otherwise evicted-
// but-rebuilt textures would accumulate phantom references and never be
// reclaimable.
export function clearNameLabelRegistry(): void {
  for (const entry of labelsRegistry) {
    releaseLabelTexture(nameLabelTextureCache, entry.label.material.map);
  }
  labelsRegistry.clear();
}

// Add or remove a node's floating name label as a sibling child of its root
// Group, keeping `labelsRegistry` and the root's stashed entry in lock-step.
// Idempotent: safe to call every frame / from both the node-object factory
// (full rebuilds) and the in-place delta walker (depth/Shift scrolling), so
// neither path needs a global `graph.refresh()`.
export function applyNodeLabelState(
  root: THREE.Object3D,
  node: GraphNode,
  settings: GraphSettings,
  activeDepth: number,
  nodeDepth: number,
  showFileLabels: boolean,
  selectedIds?: Set<string> | null,
): void {
  const want = shouldShowLabel(node, activeDepth, nodeDepth, showFileLabels, selectedIds);
  const existing = root.userData[LABEL_ENTRY] as FloatingLabelEntry | undefined;
  if (want) {
    if (existing) return;
    const color = node.kind === 'dir' ? '#e6c07b' : '#dce4f0';
    const line = makeConnectorLine({ color, labelY: LABEL_Y, opacity: 0.7 });
    const label = makeNameSprite(node.name, color, settings.labelSize);
    label.position.set(0, LABEL_Y, 0);
    root.add(line);
    root.add(label);
    const entry: FloatingLabelEntry = { label, line };
    labelsRegistry.add(entry);
    root.userData[LABEL_ENTRY] = entry;
  } else {
    if (!existing) return;
    labelsRegistry.delete(existing);
    root.remove(existing.label);
    root.remove(existing.line);
    disposeLabelEntry(existing);
    delete root.userData[LABEL_ENTRY];
  }
}
