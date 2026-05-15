// Code-health overlay (active while the user holds `h`). Each file node
// becomes a tinted shape with a vertical connector + camera-scaled text
// label showing its 0–100 health score. Labels are repulsed against
// each other in the parent component's RAF loop via healthLabelRegistry.

import type * as THREE from 'three';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import type { FloatingLabelEntry } from './floatingLabelSprite';
import { createMetricOverlaySpriteFactory } from './metricOverlayFactory';

// Health-score color thresholds. Health is 0–100 where 100 = best, so
// the polarity is inverted vs LOC: high score = green, low = red.
const HEALTH_RED = '#f57878';
const HEALTH_YELLOW = '#f5d76e';
const HEALTH_GREEN = '#7ed884';

export function healthColor(score: number): string {
  if (score < 40) return HEALTH_RED;
  if (score < 70) return HEALTH_YELLOW;
  return HEALTH_GREEN;
}

export const LABEL_Y = 100;

export type HealthLabelEntry = FloatingLabelEntry;
export const healthLabelRegistry = new Set<HealthLabelEntry>();

const metricSpriteForHealth = createMetricOverlaySpriteFactory({
  overlayKey: 'health',
  labelY: LABEL_Y,
  registry: healthLabelRegistry,
  valueForNode: (node) => node.health,
  colorForValue: healthColor,
});

export function spriteForHealth(
  node: GraphNode,
  settings: GraphSettings,
): THREE.Object3D {
  return metricSpriteForHealth(node, settings);
}
