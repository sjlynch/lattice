// Batched node rendering: the library's per-node `THREE.Sprite` (in a per-node
// `Group`) collapses into one `InstancedMesh` per distinct base style (≈5–50 vs
// N), removing most per-frame draw calls when orbiting a settled graph (links:
// `instancedLinks.ts`).
//
// Each mesh reuses the EXACT `CanvasTexture` the per-node sprite uses
// (`materialFor` cache) through a `MeshBasicMaterial` whose vertex shader is
// patched (one `<project_vertex>` swap) to billboard each quad in view space —
// identical look to the sprite, no atlas/colorspace guesswork. Positions upload
// only on frames the layout moved (`nodeMotionDriver`: engine tick or drag, incl.
// after settle) plus one trailing settle frame, so a pure orbit is static.
//
// PICK PROXY: we do NOT remove the per-node Sprite/Group; `nodeObjectFactory`
// keeps it at `.visible = false` while batching (`batchedNodesRef`). Raycasting
// ignores `.visible`, so it stays the hover/right-click target and the anchor for
// halo, change/worktree rings and Alt labels.
//
// Recolor overlays (h/z/d) are not mirrored into instance colors: the mesh hides
// while any is active (`isBaseView()` false) and those modes — and ghosts — stay
// on the per-node sprite path. Style meshes own their instance buffers + billboard
// materials (`instancedNodeResources.ts`); this controller owns the shared quad
// through final teardown; sprite-cache textures are borrowed.

import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import {
  DIR_STYLE,
  getStyleFor,
  styleKey,
  type ExtStyle,
} from '../../extensionStyles';
import type { GraphNode } from '../../api';
import type { GraphSettings } from './graphSettings';
import { createMotionSyncGate } from './motionSyncGate';
import {
  capacityWithSlack,
  disposeMapValues,
  visibilityPredicate,
  wakeInstancedRefresh,
} from './instancedBatching';
import {
  createStyleMesh,
  disposeStyleMesh,
  type StyleMesh,
} from './instancedNodeResources';
import { isGhost } from './timelineDiff';
import {
  MATRIX_ELEMENTS,
  TRANSLATION_OFFSET,
  writeMatrix4x4,
  writeVertexTriple,
} from './matrixBuffer';

type SimNode = GraphNode & { x?: number; y?: number; z?: number };

// The library stamps these accessors onto the instance; reach them via a narrow
// cast (the published types are partial), mirroring instancedLinks.
type NodeGraph = {
  scene: () => THREE.Scene;
  graphData: () => { nodes: SimNode[] };
  nodeVisibility: () => unknown;
};

export type InstancedNodesOptions = {
  // Live graph render settings (node sizes).
  getSettings: () => GraphSettings;
  // True when no recolor overlay (health/loc/dead) owns the node sprites — the
  // only state in which the instanced base shapes should be shown.
  isBaseView: () => boolean;
};

export type InstancedNodes = {
  setEnabled(on: boolean): void;
  /** Re-read the visible node set + (re)size the per-style buffers. */
  rebuild(): void;
  /** Per-frame hook (wire to the scene frame driver). */
  onFrame(): void;
  dispose(): void;
};

// Extra slots so a few file additions don't force an InstancedMesh recreate.
const CAPACITY_SLACK = 32;

export function createInstancedNodes(
  graph: ForceGraph3DInstance,
  opts: InstancedNodesOptions,
): InstancedNodes {
  const g = graph as unknown as NodeGraph;
  const scene = g.scene();
  // One unit quad shared by every per-style InstancedMesh (instanceMatrix is
  // per-mesh, geometry can be shared). uv layout matches THREE.Sprite's quad, so
  // shape orientation (e.g. triangle apex) is preserved.
  const quad = new THREE.PlaneGeometry(1, 1);

  let enabled = false;
  const meshes = new Map<string, StyleMesh>();
  // Shared "should I re-upload positions this frame?" gate: engine-tick / drag
  // motion + one trailing settle frame + forced-dirty. See motionSyncGate.ts.
  const gate = createMotionSyncGate(graph);
  let lastBaseView = true;

  function baseStyleFor(node: SimNode): ExtStyle {
    return node.kind === 'dir' ? DIR_STYLE : getStyleFor(node.ext);
  }

  function scaleFor(node: SimNode, s: GraphSettings): number {
    return node.kind === 'dir' ? s.dirNodeSize : s.fileNodeSize;
  }

  function disposeMesh(sm: StyleMesh): void {
    disposeStyleMesh(scene, sm);
  }

  // Visible (per the library's installed nodeVisibility accessor), non-ghost
  // nodes grouped by base styleKey.
  function collectGroups(): Map<string, { style: ExtStyle; nodes: SimNode[] }> {
    const all = g.graphData().nodes || [];
    const isVisible = visibilityPredicate<SimNode>(g.nodeVisibility(), true);
    const groups = new Map<string, { style: ExtStyle; nodes: SimNode[] }>();
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (isGhost(n) || !isVisible(n)) continue;
      const style = baseStyleFor(n);
      const key = styleKey(style);
      let grp = groups.get(key);
      if (!grp) {
        grp = { style, nodes: [] };
        groups.set(key, grp);
      }
      grp.nodes.push(n);
    }
    return groups;
  }

  function rebuild(): void {
    if (!enabled) return;
    const groups = collectGroups();
    const s = opts.getSettings();
    const visible = enabled && opts.isBaseView();

    for (const [key, grp] of groups) {
      const count = grp.nodes.length;
      let sm = meshes.get(key);
      if (!sm || sm.capacity < count) {
        if (sm) disposeMesh(sm);
        sm = createStyleMesh(
          scene,
          quad,
          grp.style,
          capacityWithSlack(count, CAPACITY_SLACK),
        );
        meshes.set(key, sm);
      }
      sm.nodes = grp.nodes;
      sm.mesh.count = count;
      const arr = sm.mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < count; i++) {
        const n = grp.nodes[i];
        writeMatrix4x4(
          arr,
          i * MATRIX_ELEMENTS,
          scaleFor(n, s),
          n.x ?? 0,
          n.y ?? 0,
          n.z ?? 0,
        );
      }
      sm.mesh.instanceMatrix.needsUpdate = true;
      sm.mesh.visible = visible;
    }

    // Drop styles that no longer have any visible node.
    for (const [key, sm] of meshes) {
      if (!groups.has(key)) {
        disposeMesh(sm);
        meshes.delete(key);
      }
    }

    lastBaseView = opts.isBaseView();
    // Force a position sync on the next painted frame too (positions captured
    // here may be pre-hydration on a fresh structural swap).
    gate.markDirty();
    wakeInstancedRefresh(graph);
  }

  // Update only the translation columns from the live sim positions (the hot
  // per-frame path — 3 writes per node, no matrix alloc).
  function syncPositions(): void {
    for (const sm of meshes.values()) {
      const arr = sm.mesh.instanceMatrix.array as Float32Array;
      const nodes = sm.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        writeVertexTriple(
          arr,
          i * MATRIX_ELEMENTS + TRANSLATION_OFFSET,
          n.x ?? 0,
          n.y ?? 0,
          n.z ?? 0,
        );
      }
      sm.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function onFrame(): void {
    if (!enabled) return;
    const base = opts.isBaseView();
    if (base !== lastBaseView) {
      for (const sm of meshes.values()) sm.mesh.visible = base;
      lastBaseView = base;
      // Returning to base view: positions may have settled while hidden — force
      // one sync so the shapes land where the (now-shown) nodes are.
      if (base) gate.markDirty();
    }
    // Advance the gate every frame (so the motion flags decay even while the
    // meshes are hidden), but only re-upload when the base shapes are shown.
    const moved = gate.shouldSync();
    if (base && moved) syncPositions();
  }

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      gate.attach();
      rebuild();
    } else {
      gate.detach();
      disposeMapValues(meshes, disposeMesh);
      wakeInstancedRefresh(graph);
    }
  }

  function dispose(): void {
    gate.detach();
    disposeMapValues(meshes, disposeMesh);
    quad.dispose();
  }

  return { setEnabled, rebuild, onFrame, dispose };
}
