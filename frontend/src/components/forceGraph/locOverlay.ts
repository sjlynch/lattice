// Lines-of-code overlay (active while the user holds `z`). Each file node
// becomes a tinted shape with a vertical connector + camera-scaled text
// label showing its LOC count. Labels are repulsed against each other by the
// scene-frame-driven repulsion step (`labelRepulsionFrames`) via
// locLabelRegistry.

import type * as THREE from 'three';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import type { FloatingLabelEntry } from './floatingLabelSprite';
import { createMetricOverlaySpriteFactory } from './metricOverlayFactory';

// Lines-of-code thresholds for the "z" view. >1000 = red, >600 = yellow,
// otherwise green. Kept in sync with the legend chip wording.
const LOC_RED = '#f57878';
const LOC_YELLOW = '#f5d76e';
const LOC_GREEN = '#7ed884';

export function locColor(loc: number): string {
  if (loc > 1000) return LOC_RED;
  if (loc > 600) return LOC_YELLOW;
  return LOC_GREEN;
}

// World-space Y offset of the label sprite above its file node. Pushed up
// well clear of the node so dense clusters don't overlap their labels.
export const LABEL_Y = 100;

// Local-space registry of active LOC label sprites. The scene-frame-driven
// repulsion step (`labelRepulsionFrames` → `repelLabels`) walks this each frame
// to apply pairwise repulsion and to keep each connector line's upper endpoint
// anchored to its label.
export type LocLabelEntry = FloatingLabelEntry;
export const locLabelRegistry = new Set<LocLabelEntry>();

const metricSpriteForLoc = createMetricOverlaySpriteFactory({
  overlayKey: 'loc',
  labelY: LABEL_Y,
  registry: locLabelRegistry,
  valueForNode: (node) => node.loc,
  colorForValue: locColor,
});

export function spriteForLoc(
  node: GraphNode,
  settings: GraphSettings,
): THREE.Object3D {
  return metricSpriteForLoc(node, settings);
}
