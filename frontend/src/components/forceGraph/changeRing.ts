// Change-rings overlay for the timeline scrubber. Wraps a node sprite in
// a colored ring sprite (added=green, modified=yellow, deleted=red) and,
// for the deleted case, swaps the underlying sprite for a smaller grey
// disc so removed files read as "ghosts" without the user having to
// inspect the ring color.
//
// Materials are cached per kind, so a graph with thousands of changed
// nodes still allocates exactly four GPU resources (three rings + one
// ghost disc).

import * as THREE from 'three';

export type ChangeKind = 'added' | 'modified' | 'deleted';

const RING_COLORS: Record<ChangeKind, string> = {
  added: '#46d27a',
  modified: '#e5c046',
  deleted: '#f57878',
};

const ringTextureCache = new Map<ChangeKind, THREE.CanvasTexture>();
const ringMaterialCache = new Map<ChangeKind, THREE.SpriteMaterial>();

function buildRingTexture(kind: ChangeKind): THREE.CanvasTexture {
  const cached = ringTextureCache.get(kind);
  if (cached) return cached;
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  // Soft outer glow first so the ring still reads against a similarly-
  // colored sprite. Gradient peaks at the ring radius and fades out.
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const ringR = SIZE * 0.42;
  const ringW = SIZE * 0.06;

  const grad = ctx.createRadialGradient(cx, cy, ringR - ringW * 1.5, cx, cy, ringR + ringW * 1.5);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.45, RING_COLORS[kind] + 'aa');
  grad.addColorStop(0.55, RING_COLORS[kind] + 'aa');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Crisp solid stroke on top so the ring outline is sharp at all zooms.
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = RING_COLORS[kind];
  ctx.lineWidth = ringW;
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  ringTextureCache.set(kind, tex);
  return tex;
}

function ringMaterial(kind: ChangeKind): THREE.SpriteMaterial {
  let mat = ringMaterialCache.get(kind);
  if (mat) return mat;
  mat = new THREE.SpriteMaterial({
    map: buildRingTexture(kind),
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  ringMaterialCache.set(kind, mat);
  return mat;
}

let _ghostTex: THREE.CanvasTexture | null = null;
let _ghostMat: THREE.SpriteMaterial | null = null;
function ghostMaterial(): THREE.SpriteMaterial {
  if (_ghostMat) return _ghostMat;
  if (!_ghostTex) {
    const SIZE = 128;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const r = SIZE / 2 - 14;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(110, 116, 125, 0.55)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.stroke();
    _ghostTex = new THREE.CanvasTexture(canvas);
    _ghostTex.minFilter = THREE.LinearFilter;
    _ghostTex.magFilter = THREE.LinearFilter;
    _ghostTex.colorSpace = THREE.SRGBColorSpace;
    _ghostTex.needsUpdate = true;
  }
  _ghostMat = new THREE.SpriteMaterial({
    map: _ghostTex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  return _ghostMat;
}

// Wrap an existing sprite in a parent group with a colored ring sprite
// behind it. The ring sits at renderOrder=0 so the source sprite (which
// is renderOrder>=1) paints over the inner part of the disc.
export function withChangeRing(
  child: THREE.Object3D,
  baseSize: number,
  kind: ChangeKind,
): THREE.Object3D {
  const group = new THREE.Group();
  const ring = new THREE.Sprite(ringMaterial(kind));
  // Ring slightly larger than the node so it reads as an outline, not
  // an overlay.
  const s = baseSize * 1.6;
  ring.scale.set(s, s, 1);
  ring.renderOrder = 11;
  group.add(ring);
  group.add(child);
  return group;
}

// Render a "deleted" node from scratch: small grey disc + red ring.
// Used for files that no longer exist in the working tree but were
// alive at some point inside the scrubber range.
export function deletedSprite(baseSize: number): THREE.Object3D {
  const group = new THREE.Group();
  const ring = new THREE.Sprite(ringMaterial('deleted'));
  const ringScale = baseSize * 1.6 * 0.7;
  ring.scale.set(ringScale, ringScale, 1);
  ring.renderOrder = 11;

  const disc = new THREE.Sprite(ghostMaterial());
  // Smaller than a normal file node so deleted files read at a glance.
  const discScale = baseSize * 0.6;
  disc.scale.set(discScale, discScale, 1);
  disc.renderOrder = 12;

  group.add(ring);
  group.add(disc);
  return group;
}
