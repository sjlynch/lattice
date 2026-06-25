// Batched node rendering — collapses the library's one-`THREE.Sprite`-per-node
// (mounted inside a per-node `Group`) into a handful of `THREE.InstancedMesh`es,
// one per distinct base style present (≈5–50, vs N). This removes the bulk of
// the per-frame draw calls / scene traversal that makes orbiting a *settled*
// graph spike CPU — the other half of the problem batched links solved (see
// `instancedLinks.ts` and `plans/graph-perf-plan.md` Tier 3b).
//
// WHAT. For every visible, non-ghost node we draw its base shape into a shared
// `InstancedMesh` keyed by `styleKey` (shape+colors). The mesh reuses the EXACT
// same `CanvasTexture` the per-node sprite uses (from the `materialFor` cache),
// drawn through a `MeshBasicMaterial` whose vertex shader is patched (one
// `<project_vertex>` swap) to billboard each unit quad toward the camera in view
// space — so the look (texture, color management, flipY, uv orientation, world
// sizing) is identical to the sprite it replaces, with no atlas/colorspace
// guesswork. Per-instance position is re-uploaded only on frames the layout
// moved (shared `nodeMotionDriver` — engine tick OR a node drag, incl. a drag
// after the layout settles — + one trailing settle frame, exactly like batched
// links), so a pure orbit is static.
//
// PICK PROXY. We do NOT remove the per-node `Sprite`/`Group`. `nodeObjectFactory`
// keeps mounting the base sprite but sets it `.visible = false` while batching is
// on (see `batchedNodesRef`). three.js raycasting ignores `.visible` (it tests
// only `object.layers`; `Sprite.raycast` has no visibility guard), so the
// invisible sprite stays a hover/right-click PICK TARGET and every overlay that
// hangs off the per-node Group — selection halo, change ring, worktree ring, Alt
// labels — keeps anchoring to it unchanged. This is what keeps the change
// minimal and the view modes intact.
//
// OVERLAYS. The recolor overlays (health `h` / loc `z` / dead `d`) recolor the
// per-node sprite AND (for h/z) add label/connector children. Rather than mirror
// their recolor precedence into per-instance colors, the instanced mesh simply
// HIDES itself while any of those overlays is active (`isBaseView()` is false)
// and `nodeObjectFactory` leaves the recolored sprite visible — so those modes
// run on the proven per-node path unchanged. The instanced mesh only ever draws
// the base (no-overlay) view, which is the orbit-cost steady state. Ghosts
// (deleted-file discs) likewise keep their per-node sprite and are excluded here.

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
import { getIdleController } from './idleController';
import { materialFor } from './sprites';
import { isGhost } from './timelineDiff';
import { NODE_RENDER_ORDER } from './renderOrders';

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

// One InstancedMesh per distinct base style currently on screen.
type StyleMesh = {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshBasicMaterial;
  // Nodes in buffer order; length === mesh.count.
  nodes: SimNode[];
  capacity: number;
};

// Extra slots so a few file additions don't force an InstancedMesh recreate.
const CAPACITY_SLACK = 32;

// Patch a MeshBasicMaterial so each instance billboards toward the camera. We
// keep the stock map/uv/colorspace chunks (identical sampling to SpriteMaterial)
// and replace only `<project_vertex>`: take the instance's center (translation
// column of instanceMatrix) into view space, then offset by the quad vertex
// scaled by the per-instance uniform scale (diagonal of instanceMatrix). This is
// the classic view-space billboard — camera rotation is handled implicitly, so
// instance matrices never need re-uploading on orbit, only on layout motion.
function makeBillboardMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    // Match the per-node sprite material: never depth-tested (so links can't
    // occlude nodes) and no depth write (transparent pass).
    depthTest: false,
    depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      [
        'vec3 instCenter = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);',
        'float instScale = instanceMatrix[0][0];',
        'vec4 mvPosition = modelViewMatrix * vec4(instCenter, 1.0);',
        'mvPosition.xy += transformed.xy * instScale;',
        'gl_Position = projectionMatrix * mvPosition;',
      ].join('\n'),
    );
  };
  // The patched source diverges from a stock MeshBasicMaterial, and three keys
  // its program cache on the *generated* source (onBeforeCompile edits are
  // invisible to that key). A stable custom key both prevents three from handing
  // us a cached stock program AND lets all per-style billboard materials share
  // one compiled program (they differ only by the `map` uniform).
  mat.customProgramCacheKey = () => 'lattice:billboardNode';
  return mat;
}

// Write a scale+translation matrix into instanceMatrix.array at instance `i`
// (column-major). Avoids allocating a THREE.Matrix4 per node per rebuild.
function writeMatrix(
  arr: Float32Array,
  i: number,
  scale: number,
  x: number,
  y: number,
  z: number,
): void {
  const o = i * 16;
  arr[o] = scale;
  arr[o + 1] = 0;
  arr[o + 2] = 0;
  arr[o + 3] = 0;
  arr[o + 4] = 0;
  arr[o + 5] = scale;
  arr[o + 6] = 0;
  arr[o + 7] = 0;
  arr[o + 8] = 0;
  arr[o + 9] = 0;
  arr[o + 10] = 1;
  arr[o + 11] = 0;
  arr[o + 12] = x;
  arr[o + 13] = y;
  arr[o + 14] = z;
  arr[o + 15] = 1;
}

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

  function createStyleMesh(style: ExtStyle, capacity: number): StyleMesh {
    // Reuse the per-node sprite's cached texture so the look is byte-identical
    // and we don't duplicate canvas work. The texture is module-owned by the
    // sprite material cache — never dispose it here.
    const texture = materialFor(style).map as THREE.Texture;
    const material = makeBillboardMaterial(texture);
    const mesh = new THREE.InstancedMesh(quad, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // One object spanning the whole graph; its (unmaintained) bounding sphere
    // would wrongly cull it. Never raycast it — the per-node sprites are the
    // pick targets. Match the sprite renderOrder (NODE_RENDER_ORDER) so draw
    // order is unchanged.
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.renderOrder = NODE_RENDER_ORDER;
    mesh.userData['lattice:batchedNodes'] = true;
    scene.add(mesh);
    return { mesh, material, nodes: [], capacity };
  }

  function disposeStyleMesh(sm: StyleMesh): void {
    scene.remove(sm.mesh);
    // Frees the per-mesh instanceMatrix GPU buffer (not the geometry/material).
    sm.mesh.dispose();
    // Geometry (`quad`) is shared and disposed once in dispose(); the texture is
    // owned by the sprite cache. Only the per-style material is ours to free.
    sm.material.dispose();
  }

  // Visible (per the library's installed nodeVisibility accessor), non-ghost
  // nodes grouped by base styleKey.
  function collectGroups(): Map<string, { style: ExtStyle; nodes: SimNode[] }> {
    const all = g.graphData().nodes || [];
    const raw = g.nodeVisibility();
    const isVisible =
      typeof raw === 'function'
        ? (n: SimNode) => !!(raw as (n: SimNode) => unknown)(n)
        : () => true;
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
        if (sm) disposeStyleMesh(sm);
        sm = createStyleMesh(grp.style, count + CAPACITY_SLACK);
        meshes.set(key, sm);
      }
      sm.nodes = grp.nodes;
      sm.mesh.count = count;
      const arr = sm.mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < count; i++) {
        const n = grp.nodes[i];
        writeMatrix(arr, i, scaleFor(n, s), n.x ?? 0, n.y ?? 0, n.z ?? 0);
      }
      sm.mesh.instanceMatrix.needsUpdate = true;
      sm.mesh.visible = visible;
    }

    // Drop styles that no longer have any visible node.
    for (const [key, sm] of meshes) {
      if (!groups.has(key)) {
        disposeStyleMesh(sm);
        meshes.delete(key);
      }
    }

    lastBaseView = opts.isBaseView();
    // Force a position sync on the next painted frame too (positions captured
    // here may be pre-hydration on a fresh structural swap).
    gate.markDirty();
    getIdleController(graph)?.wakeForRefresh();
  }

  // Update only the translation columns from the live sim positions (the hot
  // per-frame path — 3 writes per node, no matrix alloc).
  function syncPositions(): void {
    for (const sm of meshes.values()) {
      const arr = sm.mesh.instanceMatrix.array as Float32Array;
      const nodes = sm.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const o = i * 16;
        arr[o + 12] = n.x ?? 0;
        arr[o + 13] = n.y ?? 0;
        arr[o + 14] = n.z ?? 0;
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
      for (const sm of meshes.values()) disposeStyleMesh(sm);
      meshes.clear();
      getIdleController(graph)?.wakeForRefresh();
    }
  }

  function dispose(): void {
    gate.detach();
    for (const sm of meshes.values()) disposeStyleMesh(sm);
    meshes.clear();
    quad.dispose();
  }

  return { setEnabled, rebuild, onFrame, dispose };
}
