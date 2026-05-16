import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import type { GraphNode, ScanResult } from '../../api';
import { deletedSprite, withChangeRing, type ChangeKind } from './changeRing';
import type { GraphSettings } from './graphSettings';
import { withHalo } from './halo';
import { spriteForHealth } from './healthOverlay';
import { spriteForLabels } from './labelsOverlay';
import { spriteForLoc } from './locOverlay';
import { spriteFor } from './sprites';
import { isGhost, relForward } from './timelineDiff';

// Refs the node-object factory reads to pick the right sprite for the
// current overlay/selection state without forcing the parent hook to
// re-mount the graph when any of those values change.
export type NodeObjectRefs = {
  settingsRef: MutableRefObject<GraphSettings>;
  selectedRef: MutableRefObject<Set<string>>;
  dataRef: MutableRefObject<ScanResult | null>;
  locModeRef: MutableRefObject<boolean>;
  healthModeRef: MutableRefObject<boolean>;
  labelModeRef: MutableRefObject<boolean>;
  labelLevelRef: MutableRefObject<number>;
  nodeDepthsRef: MutableRefObject<Map<string, number>>;
  changeMapRef: MutableRefObject<Map<string, ChangeKind>>;
  // Extensions (lowercased, leading-dot) that the LOC and code-health
  // overlays should skip — matching files render as their normal sprite
  // instead of a tinted shape with a numeric label.
  metricsIgnoredExtsRef: MutableRefObject<Set<string>>;
};

// Picks the THREE.Object3D that represents a node in the current frame.
// The overlay/selection decision tree lives here so the initialization
// hook reads like lifecycle wiring; sprite materials themselves are
// cached inside the individual overlay modules.
export function buildNodeObject(node: GraphNode, refs: NodeObjectRefs): THREE.Object3D {
  const s = refs.settingsRef.current;
  const baseSize = node.kind === 'dir' ? s.dirNodeSize : s.fileNodeSize;

  // Ghost nodes (deleted files surfaced from git history) only exist in
  // the graph because the scrubber range picks up a delete event
  // somewhere — render them as a small grey disc with a red ring
  // instead of running spriteFor on a path that has no real file behind
  // it.
  if (isGhost(node)) {
    let obj: THREE.Object3D = deletedSprite(s.fileNodeSize);
    if (refs.selectedRef.current.has(node.id)) {
      obj = withHalo(obj, s.fileNodeSize);
    }
    return obj;
  }

  // For the LOC and health overlays, fall back to the plain sprite when
  // the file's extension is on the per-project ignore list — e.g.
  // config/prose files by default. Directories aren't measured by either
  // overlay anyway, so the check is file-only.
  const ignored =
    node.kind === 'file' &&
    !!node.ext &&
    refs.metricsIgnoredExtsRef.current.has(node.ext.toLowerCase());

  let obj: THREE.Object3D;
  if (refs.healthModeRef.current && !ignored) {
    obj = spriteForHealth(node, s);
  } else if (refs.locModeRef.current && !ignored) {
    obj = spriteForLoc(node, s);
  } else if (refs.labelModeRef.current) {
    const d = refs.nodeDepthsRef.current.get(node.id) ?? 0;
    obj = spriteForLabels(node, s, refs.labelLevelRef.current, d);
  } else {
    obj = spriteFor(node, s);
  }

  // Apply change ring before halo so the selection halo always wraps
  // the outermost layer.
  const root = refs.dataRef.current?.root || '';
  const rel = node.kind === 'file' ? relForward(node.path, root) : '';
  const kind = rel ? refs.changeMapRef.current.get(rel) : undefined;
  if (kind && kind !== 'deleted') {
    obj = withChangeRing(obj, baseSize, kind);
  }
  if (refs.selectedRef.current.has(node.id)) {
    return withHalo(obj, baseSize);
  }
  return obj;
}

// Native 3d-force-graph hover label. Files always defer to HealthTooltip
// (rendered separately in React), so suppress the library label there to
// avoid stacking two tooltips; directories keep the simple folder hint.
export function nativeNodeLabel(node: GraphNode): string {
  if (node.kind === 'file') return '';
  return `📁 ${node.name}`;
}
