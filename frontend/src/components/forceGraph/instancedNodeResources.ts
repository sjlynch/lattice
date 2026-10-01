// Per-style batched-node resources. Textures belong to the sprite cache; the
// shared quad belongs to the controller in instancedNodes.ts.

import * as THREE from 'three';
import type { GraphNode } from '../../api';
import type { ExtStyle } from '../../extensionStyles';
import { materialFor } from './sprites';
import { NODE_RENDER_ORDER } from './renderOrders';

type SimNode = GraphNode & { x?: number; y?: number; z?: number };

// One InstancedMesh per distinct base style currently on screen.
export type StyleMesh = {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshBasicMaterial;
  // Nodes in buffer order; length === mesh.count.
  nodes: SimNode[];
  capacity: number;
};

// Patch a MeshBasicMaterial so each instance billboards toward the camera. We
// keep the stock map/uv/colorspace chunks (identical sampling to SpriteMaterial)
// and replace only `<project_vertex>`: take the instance's center (translation
// column of instanceMatrix) into view space, then offset by the quad vertex
// scaled by the per-instance uniform scale (diagonal of instanceMatrix). This is
// the classic view-space billboard — camera rotation is handled implicitly, so
// instance matrices never need re-uploading on orbit, only on layout motion.
export function makeBillboardMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
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

export function createStyleMesh(
  scene: THREE.Scene,
  quad: THREE.PlaneGeometry,
  style: ExtStyle,
  capacity: number,
): StyleMesh {
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

export function disposeStyleMesh(scene: THREE.Scene, sm: StyleMesh): void {
  scene.remove(sm.mesh);
  // Frees the per-mesh instanceMatrix GPU buffer (not the geometry/material).
  sm.mesh.dispose();
  // Geometry (`quad`) is shared and disposed once by the controller; the texture
  // is owned by the sprite cache. Only the per-style material is ours to free.
  sm.material.dispose();
}
