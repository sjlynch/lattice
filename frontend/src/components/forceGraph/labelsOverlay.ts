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
  type LabelTextureOptions,
} from './labelTexture';
import { spriteFor } from './sprites';

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

// Local-space registry of active name-label sprites + their connector
// lines. The relaxation loop in ForceGraphView walks this each frame to
// spread overlapping labels apart and to keep the connector's upper
// endpoint anchored to its label, mirroring the LOC overlay.
export type LabelEntry = FloatingLabelEntry;
export const labelsRegistry = new Set<LabelEntry>();

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

// Build a node object for labels mode. If the node sits at the active
// depth, attach a floating name label + connector; otherwise just render
// the normal sprite. File-node labels are gated behind `showFileLabels`
// (Shift held): with Alt alone, only directory names are shown.
export function spriteForLabels(
  node: GraphNode,
  settings: GraphSettings,
  activeDepth: number,
  nodeDepth: number,
  showFileLabels: boolean,
): THREE.Object3D {
  const base = spriteFor(node, settings);
  if (nodeDepth !== activeDepth) return base;
  if (node.kind === 'file' && !showFileLabels) return base;

  const group = new THREE.Group();
  group.add(base);

  const color = node.kind === 'dir' ? '#e6c07b' : '#dce4f0';
  const line = makeConnectorLine({
    color,
    labelY: LABEL_Y,
    opacity: 0.7,
  });
  group.add(line);

  const label = makeNameSprite(node.name, color, settings.labelSize);
  label.position.set(0, LABEL_Y, 0);
  group.add(label);

  labelsRegistry.add({ label, line });

  return group;
}
