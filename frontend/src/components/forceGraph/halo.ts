// Selection ring. Wraps a selected node's sprite in a thin light-blue
// ring drawn the same way as the timeline scrubber change rings, so the
// selection state reads as another ring color rather than a bloom glow.

import * as THREE from 'three';

const RING_COLOR = '#7ad0ff';

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

export function withHalo(child: THREE.Object3D, baseSize: number): THREE.Object3D {
  const group = new THREE.Group();
  const ring = new THREE.Sprite(ringMaterial());
  // Slightly larger than the change rings so a node selected during a
  // scrubber view shows both rings concentrically.
  const s = baseSize * 1.8;
  ring.scale.set(s, s, 1);
  ring.renderOrder = 0;
  group.add(ring);
  group.add(child);
  return group;
}
