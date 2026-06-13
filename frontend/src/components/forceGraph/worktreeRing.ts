// Worktree-modified ring. Drawn as a sibling child of a node's root Group
// (same toggle mechanism as the selection halo in halo.ts), but visually
// distinct: a double concentric ring colored by the owning task so it reads
// differently from the single light-blue selection halo and the git
// change-rings. Shown while `W` is held to mark every file changed by a
// not-yet-merged task.
//
// Textures and materials are cached per color (there are at most a few dozen
// live task colors, and slots are reused, so the cache stays small).

import * as THREE from 'three';

const RING_TAG = 'lattice:worktree-ring';
const SIZE = 128;

function rgba(c: THREE.Color, a: number): string {
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(
    c.b * 255,
  )}, ${a})`;
}

const textureCache = new Map<string, THREE.CanvasTexture>();

function ringTexture(color: string): THREE.CanvasTexture {
  let tex = textureCache.get(color);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const col = new THREE.Color(color);

  // Soft glow so the ring reads against a similarly-colored sprite.
  const grad = ctx.createRadialGradient(cx, cy, SIZE * 0.3, cx, cy, SIZE * 0.5);
  grad.addColorStop(0, rgba(col, 0));
  grad.addColorStop(0.7, rgba(col, 0.28));
  grad.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Two concentric crisp strokes = the distinct "worktree" look.
  ctx.strokeStyle = rgba(col, 1);
  ctx.lineWidth = SIZE * 0.035;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.46, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = SIZE * 0.028;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.36, 0, Math.PI * 2);
  ctx.stroke();

  tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  textureCache.set(color, tex);
  return tex;
}

const materialCache = new Map<string, THREE.SpriteMaterial>();

function ringMaterial(color: string): THREE.SpriteMaterial {
  let mat = materialCache.get(color);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: ringTexture(color),
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    materialCache.set(color, mat);
  }
  return mat;
}

function findRingChild(root: THREE.Object3D): THREE.Sprite | null {
  for (const child of root.children) {
    if (child.userData[RING_TAG]) return child as THREE.Sprite;
  }
  return null;
}

// Toggle (or recolor) a worktree ring on a node's root Group.
export function setNodeWorktreeRing(
  root: THREE.Object3D,
  on: boolean,
  color: string,
  baseSize: number,
): void {
  const existing = findRingChild(root);
  if (!on) {
    if (existing) root.remove(existing);
    return;
  }
  if (existing) {
    // Already ringed — just make sure it's the right color.
    if (existing.userData[`${RING_TAG}:color`] !== color) {
      existing.material = ringMaterial(color);
      existing.userData[`${RING_TAG}:color`] = color;
    }
    return;
  }
  const ring = new THREE.Sprite(ringMaterial(color));
  const s = baseSize * 2.0;
  ring.scale.set(s, s, 1);
  ring.renderOrder = 11;
  ring.raycast = () => {};
  ring.userData[RING_TAG] = true;
  ring.userData[`${RING_TAG}:color`] = color;
  root.add(ring);
}
