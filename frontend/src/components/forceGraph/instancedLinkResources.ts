// Graph-local GPU resources for batched links. The controller supplies captured
// links and lazy material inputs; this owner retains no link array or scheduler.
import * as THREE from 'three';
import { capacityWithSlack } from './instancedBatching';
import { LINK_RENDER_ORDER } from './renderOrders';
import { writeVertexTriple } from './matrixBuffer';

type SimNode = { x?: number; y?: number; z?: number };
export type SimLink = { source: SimNode | string; target: SimNode | string };

type MaterialSource = {
  /** Sample the current color only when allocating a material. */
  sampleColor(link: SimLink | undefined): unknown;
  readOpacity(): number;
};

export type InstancedLinkResources = {
  hasBatch(): boolean;
  rebuild(links: SimLink[]): void;
  syncPositions(links: SimLink[]): void;
  dispose(): void;
};

// Flat 1px screen-space lines read heavier than the distance-attenuated lit
// cylinders they replace (constant width regardless of zoom, and unlit), so a
// dense graph turns into a bright web. Damp the configured link opacity for the
// batched look so the lines stay as subtle connectors.
const FLAT_LINE_OPACITY_SCALE = 0.55;

// Extra link slots reserved when the position buffer has to grow, so a few
// added/un-hidden links don't force a reallocation every rebuild. Mirrors
// instancedNodes' CAPACITY_SLACK — makes the buffer-replacement (and the GPU
// free below) rare rather than per-growth.
const CAPACITY_SLACK = 64;

// Build a THREE color the same way the library does (CSS string → sRGB-managed
// color) plus the separate alpha, so the batched material matches the per-link
// material's color/opacity exactly. `linkOpacity` multiplies the color's alpha.
function parseLinkColor(input: unknown): { css: string; alpha: number } {
  const str = typeof input === 'string' ? input : '';
  const m = str.match(/rgba?\(([^)]+)\)/i);
  if (!m) return { css: str || '#f0f0f0', alpha: 1 };
  const parts = m[1].split(',').map((s) => s.trim());
  const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
  return {
    css: `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`,
    alpha: Number.isFinite(a) ? a : 1,
  };
}

// Write each link's two endpoint vertices (6 floats per link) into `out`, in
// `links` order, starting at `out[0]`. Exported for the regression test.
//
// Endpoints are hydrated from id strings to node refs only after graphData() is
// applied. While a link's source/target is still a string, we must NOT skip its
// write: on a freshly-grown buffer those slots are zero, but the draw range
// still includes the segment, so a stale (0,0,0) vertex against the hydrated
// partner renders a stray line converging on the world origin for a frame or
// two. Instead, collapse a not-yet-hydrated segment to a DEGENERATE (both
// vertices equal) line — reuse whichever endpoint is hydrated for both vertices,
// or the origin if neither is — so it draws as an invisible zero-length line
// until the next rebuild lands the hydrated refs.
export function writeLinkSegments(links: SimLink[], out: Float32Array): void {
  let w = 0;
  for (let i = 0; i < links.length; i++) {
    const s = links[i].source;
    const t = links[i].target;
    const so = typeof s === 'object' ? s : null;
    const to = typeof t === 'object' ? t : null;
    const a = so ?? to;
    const b = to ?? so;
    writeVertexTriple(out, w, a?.x ?? 0, a?.y ?? 0, a?.z ?? 0);
    writeVertexTriple(out, w + 3, b?.x ?? 0, b?.y ?? 0, b?.z ?? 0);
    w += 6;
  }
}

export function createInstancedLinkResources(
  scene: THREE.Scene,
  materialSource: MaterialSource,
): InstancedLinkResources {
  let geometry: THREE.BufferGeometry | null = null;
  let material: THREE.LineBasicMaterial | null = null;
  let lineSegments: THREE.LineSegments | null = null;
  let positions = new Float32Array(0);

  function ensureMaterial(sampleLink: SimLink | undefined): THREE.LineBasicMaterial {
    if (material) return material;
    const { css, alpha } = parseLinkColor(materialSource.sampleColor(sampleLink));
    const opacity = alpha * materialSource.readOpacity() * FLAT_LINE_OPACITY_SCALE;
    material = new THREE.LineBasicMaterial({
      color: new THREE.Color(css),
      transparent: opacity < 1,
      opacity,
      // Match the library: opaque lines write depth, translucent ones don't.
      depthWrite: opacity >= 1,
    });
    return material;
  }

  function syncPositions(links: SimLink[]): void {
    if (!geometry) return;
    const attr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    writeLinkSegments(links, positions);
    attr.needsUpdate = true;
  }

  function rebuild(links: SimLink[]): void {
    const needed = links.length * 2 * 3;
    if (!geometry) geometry = new THREE.BufferGeometry();
    if (positions.length < needed) {
      // Free the previous position attribute's GPU buffer before swapping in the
      // larger one. three.js does NOT delete a replaced BufferAttribute's GPU
      // buffer on setAttribute — it's freed only via the renderer's
      // attributes.remove(), which only geometry.dispose() (over the attributes
      // still in the geometry) routes to. Without this, every growth (un-hiding
      // an ext, added files, first hydration) orphaned the prior buffer on the
      // GPU until unmount. Dispose BEFORE the swap, while the old attribute is
      // still in the geometry; the next render re-uploads the new buffer (the
      // geometry re-registers its dispose listener automatically). Grow with
      // slack so this realloc+free is rare (mirrors instancedNodes).
      if (geometry.getAttribute('position')) geometry.dispose();
      positions = new Float32Array(
        capacityWithSlack(links.length, CAPACITY_SLACK) * 2 * 3,
      );
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
    geometry.setDrawRange(0, links.length * 2);
    if (!lineSegments) {
      lineSegments = new THREE.LineSegments(geometry, ensureMaterial(links[0]));
      // Match the library's link renderOrder so links draw behind the
      // depth-test-disabled node sprites (NODE_RENDER_ORDER), as before.
      lineSegments.renderOrder = LINK_RENDER_ORDER;
      // One object spanning the whole graph — never cull it as a unit (its
      // bounding sphere leaves the frustum long before the links do).
      lineSegments.frustumCulled = false;
      lineSegments.raycast = () => {};
      lineSegments.userData['lattice:batchedLinks'] = true;
      scene.add(lineSegments);
    }
    lineSegments.visible = true;
    // Sync the rebuilt buffer directly so the new lines paint this frame.
    syncPositions(links);
  }

  function dispose(): void {
    if (lineSegments) {
      scene.remove(lineSegments);
      lineSegments = null;
    }
    geometry?.dispose();
    geometry = null;
    material?.dispose();
    material = null;
    positions = new Float32Array(0);
  }

  return { hasBatch: () => lineSegments !== null, rebuild, syncPositions, dispose };
}
