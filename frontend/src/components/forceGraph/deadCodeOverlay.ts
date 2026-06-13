// Dead-code overlay (active while the user holds `d`). Each file node is
// recolored by its reachability classification from the backend cross-file
// pass — green = reachable, red = unreachable/dead, grey = entry point or
// uncertain. Unlike the LOC/health overlays this is a pure recolor: no
// numeric label and no connector line, so it reuses the shared material cache
// rather than the metric-overlay label factory.

import * as THREE from 'three';
import { DIR_STYLE, getStyleFor, type ExtStyle, type Shape } from '../../extensionStyles';
import type { DeadCodeStatus, GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import { materialFor, spriteFor } from './sprites';

// Tri-state palette. `entry` and `uncertain` are deliberately neutral so the
// view never confidently flags an entry point or a non-code asset as dead.
export const DEAD_CODE_COLORS: Record<DeadCodeStatus, string> = {
  live: '#7ed884', // green — reachable from an entry point
  dead: '#f5615c', // red — unreachable, statically import-resolvable language
  entry: '#9aa6b2', // neutral — itself an entry-point root
  uncertain: '#5b626d', // dim grey — asset / unsupported language / dynamic-only
};

export const DEAD_CODE_LEGEND: { status: DeadCodeStatus; label: string }[] = [
  { status: 'live', label: 'Reachable' },
  { status: 'dead', label: 'Dead / orphaned' },
  { status: 'entry', label: 'Entry point' },
  { status: 'uncertain', label: 'Uncertain' },
];

function deadCodeStyle(node: GraphNode, color: string): ExtStyle {
  const baseShape: Shape =
    node.kind === 'dir' ? DIR_STYLE.shape : getStyleFor(node.ext).shape;
  return {
    // styleKey() folds on shape+color, so per-status colors already cache
    // independently; the ext string is cosmetic.
    ext: `dead:${baseShape}`,
    label: 'dead',
    shape: baseShape,
    color1: color,
  };
}

export function spriteForDeadCode(
  node: GraphNode,
  settings: GraphSettings,
): THREE.Object3D {
  // Directories aren't classified — keep their normal sprite so the tree
  // scaffolding stays readable while files carry the green/red signal.
  if (node.kind !== 'file') return spriteFor(node, settings);

  // No classification (a never-analyzed language, or a node predating the
  // field) reads as uncertain grey rather than implying the file is alive.
  const status: DeadCodeStatus = node.healthDetails?.deadCode ?? 'uncertain';
  const sprite = new THREE.Sprite(
    materialFor(deadCodeStyle(node, DEAD_CODE_COLORS[status])),
  );
  sprite.scale.set(settings.fileNodeSize, settings.fileNodeSize, 1);
  sprite.renderOrder = 12;
  return sprite;
}
