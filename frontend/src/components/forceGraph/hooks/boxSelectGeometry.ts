import * as THREE from 'three';
import type { GraphNode } from '../../../api';

export type DragRect = { x1: number; y1: number; x2: number; y2: number };
export type ScreenPoint = { x: number; y: number };
export type ViewportSize = { width: number; height: number };
export type PositionedGraphNode = GraphNode & {
  x?: number | null;
  y?: number | null;
  z?: number | null;
};

export const TINY_DRAG_PX = 4;

export function normalizeDragRect(start: ScreenPoint, end: ScreenPoint): DragRect {
  return {
    x1: Math.min(start.x, end.x),
    y1: Math.min(start.y, end.y),
    x2: Math.max(start.x, end.x),
    y2: Math.max(start.y, end.y),
  };
}

export function isTinyDrag(rect: DragRect, thresholdPx = TINY_DRAG_PX): boolean {
  return Math.abs(rect.x2 - rect.x1) < thresholdPx && Math.abs(rect.y2 - rect.y1) < thresholdPx;
}

export function projectNodeToScreen(
  node: PositionedGraphNode,
  camera: THREE.Camera,
  viewport: ViewportSize,
): ScreenPoint | null {
  return projectNodeToScreenWithVector(node, camera, viewport, new THREE.Vector3());
}

export type SelectNodesInRectOptions = {
  rect: DragRect;
  camera: THREE.Camera;
  viewport: ViewportSize;
  includeDirs: boolean;
  hiddenExts: ReadonlySet<string>;
  // The graph's live node-visibility accessor. Nodes it hides are still laid
  // out (ghost/deleted-file nodes outside the scrubber window, metrics-ignored
  // files while H/Z/D is showing), so without this a box drawn over their empty
  // space selected invisible nodes and inflated the selection count.
  isVisible?: (node: PositionedGraphNode) => boolean;
};

export function selectNodesInRect(
  nodes: Iterable<PositionedGraphNode>,
  options: SelectNodesInRectOptions,
): Set<string> {
  const next = new Set<string>();
  const projected = new THREE.Vector3();

  for (const node of nodes) {
    if (!isNodeEligibleForBoxSelect(node, options.includeDirs, options.hiddenExts)) continue;
    if (options.isVisible && !options.isVisible(node)) continue;

    const point = projectNodeToScreenWithVector(
      node,
      options.camera,
      options.viewport,
      projected,
    );
    if (!point) continue;
    if (isPointInRect(point, options.rect)) next.add(node.id);
  }

  return next;
}

function isNodeEligibleForBoxSelect(
  node: PositionedGraphNode,
  includeDirs: boolean,
  hiddenExts: ReadonlySet<string>,
): boolean {
  if (!includeDirs && node.kind === 'dir') return false;
  if (node.kind === 'file') {
    const key = node.ext ? node.ext.toLowerCase() : '*';
    if (hiddenExts.has(key)) return false;
  }
  return true;
}

function projectNodeToScreenWithVector(
  node: PositionedGraphNode,
  camera: THREE.Camera,
  viewport: ViewportSize,
  vector: THREE.Vector3,
): ScreenPoint | null {
  if (node.x == null || node.y == null || node.z == null) return null;

  vector.set(node.x, node.y, node.z).project(camera);
  // Behind the camera or beyond the far plane — skip.
  if (vector.z < -1 || vector.z > 1) return null;

  return {
    x: (vector.x * 0.5 + 0.5) * viewport.width,
    y: (-vector.y * 0.5 + 0.5) * viewport.height,
  };
}

function isPointInRect(point: ScreenPoint, rect: DragRect): boolean {
  return point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2;
}
