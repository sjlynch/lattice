import * as THREE from 'three';
import type { GraphNode } from '../../api';
import { DIR_STYLE, getStyleFor, type ExtStyle, type Shape } from '../../extensionStyles';
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
import { materialFor, spriteFor } from './sprites';

const METRIC_LABEL_TEXTURE_OPTIONS: LabelTextureOptions = {
  font: 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif',
  strokeWidth: 10,
  height: 96,
  padX: 18,
  minWidth: 80,
  maxEntries: 256,
};

const METRIC_LABEL_HEIGHT_MULT = 2;

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
  const textureCache = createLabelTextureCache();

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
    colorSprite.renderOrder = 12;
    group.add(colorSprite);

    const line = makeConnectorLine({
      color,
      labelY: config.labelY,
      opacity: 0.9,
    });
    group.add(line);

    const texture = buildMeasuredLabelTexture(
      textureCache,
      String(value),
      color,
      METRIC_LABEL_TEXTURE_OPTIONS,
    );
    const label = makeFloatingLabelSprite(texture, settings.labelSize, {
      heightMultiplier: METRIC_LABEL_HEIGHT_MULT,
      maxScale: 100,
      aspectFallback: 1,
    });
    label.position.set(0, config.labelY, 0);
    group.add(label);

    config.registry.add({ label, line });

    return group;
  };
}
