// Selection halo. Adds a soft additive glow around a selected node by
// wrapping its sprite/group in a parent THREE.Group with a back-rendered
// sprite behind it.

import * as THREE from 'three';

let _haloTexture: THREE.CanvasTexture | null = null;
function haloTexture(): THREE.CanvasTexture {
  if (_haloTexture) return _haloTexture;
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(
    SIZE / 2, SIZE / 2, SIZE * 0.18,
    SIZE / 2, SIZE / 2, SIZE * 0.50,
  );
  grad.addColorStop(0, 'rgba(120, 200, 255, 0.85)');
  grad.addColorStop(0.55, 'rgba(120, 200, 255, 0.30)');
  grad.addColorStop(1, 'rgba(120, 200, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _haloTexture = tex;
  return tex;
}

let _haloMaterial: THREE.SpriteMaterial | null = null;
function haloMaterial(): THREE.SpriteMaterial {
  if (_haloMaterial) return _haloMaterial;
  _haloMaterial = new THREE.SpriteMaterial({
    map: haloTexture(),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  return _haloMaterial;
}

export function withHalo(child: THREE.Object3D, baseSize: number): THREE.Object3D {
  const group = new THREE.Group();
  const halo = new THREE.Sprite(haloMaterial());
  const s = baseSize * 1.9;
  halo.scale.set(s, s, 1);
  halo.renderOrder = -1;
  group.add(halo);
  group.add(child);
  return group;
}
