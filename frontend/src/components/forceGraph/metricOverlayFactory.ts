import * as THREE from 'three';
import type { GraphNode } from '../../api';
import { DIR_STYLE, getStyleFor, type ExtStyle, type Shape } from '../../extensionStyles';
import type { GraphSettings } from './graphSettings';
import {
  disposeLabelEntry,
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
import { materialFor, spriteFor } from './sprites';
import { NODE_RENDER_ORDER } from './renderOrders';

const METRIC_LABEL_TEXTURE_OPTIONS: LabelTextureOptions = {
  font: 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif',
  strokeWidth: 10,
  height: 96,
  padX: 18,
  minWidth: 80,
  maxEntries: 256,
};

const METRIC_LABEL_HEIGHT_MULT = 2;
const METRIC_LABEL_HIT_BOUNDS = {
  minU: 0,
  maxU: 1,
  minV: 0,
  maxV: 1,
};

// Minimum desired separation (graph units, before the user's `labelSpread`
// multiplier) between two metric labels in the LOC (`z`) and health (`h`)
// repulsion loops — shared by both since their labels are equally short
// (≤4-digit LOC / 0–100 health). The Alt name-label overlay deliberately uses a
// WIDER base (`LABEL_REPULSION_BASE` in labelsOverlay.ts) because filenames are
// much longer and would visibly overlap at this distance; keep the two values
// in view of each other when retuning either overlay.
export const METRIC_REPULSION_BASE = 55;

// ONE label-texture cache shared across ALL metric overlays (health + LOC), so
// identical number textures (e.g. "42" in the same color) aren't duplicated per
// overlay — the rendered glyph is a pure function of (text, color, options) and
// METRIC_LABEL_TEXTURE_OPTIONS is the same for both. Module-owned, like the
// shared materials in floatingLabelSprite — never disposed per-node.
const sharedMetricLabelTextureCache = createLabelTextureCache();

export type MetricOverlayConfig = {
  overlayKey: string;
  labelY: number;
  registry: Set<FloatingLabelEntry>;
  valueForNode: (node: GraphNode) => number | null | undefined;
  colorForValue: (value: number) => string;
};

function metricShapeStyle(node: GraphNode, color: string, overlayKey: string): ExtStyle {
  const baseShape: Shape =
    node.kind === 'dir' ? DIR_STYLE.shape : getStyleFor(node.ext).shape;
  return {
    ext: `${overlayKey}:${baseShape}`,
    label: overlayKey,
    shape: baseShape,
    color1: color,
  };
}

export function createMetricOverlaySpriteFactory(
  config: MetricOverlayConfig,
): (node: GraphNode, settings: GraphSettings) => THREE.Object3D {
  return (node, settings) => {
    if (node.kind !== 'file') return spriteFor(node, settings);

    const value = config.valueForNode(node);
    if (value == null) return spriteFor(node, settings);

    const color = config.colorForValue(value);
    const group = new THREE.Group();

    const colorSprite = new THREE.Sprite(
      materialFor(metricShapeStyle(node, color, config.overlayKey)),
    );
    colorSprite.scale.set(settings.fileNodeSize, settings.fileNodeSize, 1);
    colorSprite.renderOrder = NODE_RENDER_ORDER;
    group.add(colorSprite);

    // The numeric value label (+ its connector line) is opt-in. In most
    // projects the labels overlap so heavily they obscure the recolor they
    // annotate, so they default off (`settings.metricLabels`) — the tinted
    // shape alone still conveys the health/LOC band by color. When off we skip
    // the connector/label/registry entry entirely so there's nothing for the
    // per-frame repulsion loop to relax. The colored sprite is still the
    // hover/pick target, so the health tooltip works with or without the label.
    if (settings.metricLabels) {
      const line = makeConnectorLine({
        color,
        labelY: config.labelY,
        opacity: 0.9,
      });
      group.add(line);

      const texture = buildMeasuredLabelTexture(
        sharedMetricLabelTextureCache,
        String(value),
        color,
        METRIC_LABEL_TEXTURE_OPTIONS,
      );
      const label = makeFloatingLabelSprite(texture, settings.labelSize, {
        heightMultiplier: METRIC_LABEL_HEIGHT_MULT,
        maxScale: 100,
        aspectFallback: 1,
        // Numeric metric labels are already measured tightly. Let the whole
        // sprite quad count as hoverable so health-score labels reliably anchor
        // the health tooltip after the shared-label refactor.
        hitBounds: METRIC_LABEL_HIT_BOUNDS,
      });
      label.position.set(0, config.labelY, 0);
      group.add(label);

      config.registry.add({ label, line });
    }

    return group;
  };
}

// Release every entry's metric-label texture refcount, dispose its cloned
// connector geometry, then empty the registry. The LOC + health overlays are
// torn down by clearing their registry wholesale (they share
// `sharedMetricLabelTextureCache`); releasing here keeps the texture refcounts
// balanced against the build-time increments so freed metric textures stay
// reclaimable across the constant clear→refresh→rebuild cycles, and disposing
// each entry's per-line geometry frees the GPU buffer the library leaves
// orphaned when `graph.refresh()` replaces the node objects.
export function clearMetricLabelRegistry(registry: Set<FloatingLabelEntry>): void {
  for (const entry of registry) {
    disposeLabelEntry(entry);
    releaseLabelTexture(sharedMetricLabelTextureCache, entry.label.material.map);
  }
  registry.clear();
}
