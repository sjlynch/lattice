// Selection ring. Drawn as a sibling child of the node's root Group so
// it can be toggled in/out per-id without rebuilding the node's THREE
// objects — see `setNodeHalo` below. The ring is a single shared
// material so a graph with N selected nodes still allocates exactly one
// GPU resource for the halo.

import * as THREE from 'three';

const RING_COLOR = '#7ad0ff';
// Tag used on the halo Sprite's `userData` so `setNodeHalo(off)` can
// locate the existing ring without iterating the whole child list.
const HALO_TAG = 'lattice:halo';

let _ringTexture: THREE.CanvasTexture | null = null;
function ringTexture(): THREE.CanvasTexture {
  if (_ringTexture) return _ringTexture;
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const ringR = SIZE * 0.42;
  const ringW = SIZE * 0.04;

  // Soft glow so the ring still reads against a similarly-colored sprite.
  const grad = ctx.createRadialGradient(cx, cy, ringR - ringW * 1.5, cx, cy, ringR + ringW * 1.5);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.45, RING_COLOR + 'aa');
  grad.addColorStop(0.55, RING_COLOR + 'aa');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Crisp thin solid stroke on top.
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = RING_COLOR;
  ctx.lineWidth = ringW;
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _ringTexture = tex;
  return tex;
}

let _ringMaterial: THREE.SpriteMaterial | null = null;
function ringMaterial(): THREE.SpriteMaterial {
  if (_ringMaterial) return _ringMaterial;
  _ringMaterial = new THREE.SpriteMaterial({
    map: ringTexture(),
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  return _ringMaterial;
}

function buildHaloSprite(baseSize: number): THREE.Sprite {
  const ring = new THREE.Sprite(ringMaterial());
  // Slightly larger than the change rings so a node selected during a
  // scrubber view shows both rings concentrically.
  const s = baseSize * 1.8;
  ring.scale.set(s, s, 1);
  ring.renderOrder = 11;
  ring.userData[HALO_TAG] = true;
  return ring;
}

function findHaloChild(root: THREE.Object3D): THREE.Object3D | null {
  // child counts are tiny (root + base + optional halo); a direct scan
  // beats keeping a side map and the userData check is O(1).
  for (const child of root.children) {
    if (child.userData[HALO_TAG]) return child;
  }
  return null;
}

// Toggle a halo ring as a sibling child of the node's root Group. Called
// from the selection-change handler instead of `graph.refresh()` — we
// touch only the affected nodes' THREE objects, so the cost is O(delta)
// not O(nodes).
export function setNodeHalo(
  root: THREE.Object3D,
  selected: boolean,
  baseSize: number,
): void {
  const existing = findHaloChild(root);
  if (selected) {
    if (existing) return;
    root.add(buildHaloSprite(baseSize));
  } else {
    if (!existing) return;
    root.remove(existing);
  }
}
