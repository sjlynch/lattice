// The free-floating "Claude node" drawn for each in-progress Claude agent.
// A filled, task-colored disc with a soft outer glow so it reads clearly as
// "not a file" against the file sprites and the blue selection halo.
//
// Materials are cached per color string (there are at most a few dozen live
// agents, and `colorIndex` slots are reused, so the cache stays tiny).

import * as THREE from 'three';

const TEX_SIZE = 128;

function rgba(c: THREE.Color, a: number): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function buildDiscTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  const col = new THREE.Color(color);

  // Soft outer glow.
  const glowR = TEX_SIZE * 0.5;
  const glow = ctx.createRadialGradient(cx, cy, TEX_SIZE * 0.22, cx, cy, glowR);
  glow.addColorStop(0, rgba(col, 0.55));
  glow.addColorStop(0.6, rgba(col, 0.22));
  glow.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Solid filled disc.
  const discR = TEX_SIZE * 0.3;
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.fillStyle = rgba(col, 1);
  ctx.fill();

  // Lit highlight for a 3D-ball feel.
  const hi = ctx.createRadialGradient(
    cx - discR * 0.35,
    cy - discR * 0.4,
    1,
    cx - discR * 0.35,
    cy - discR * 0.4,
    discR * 1.1,
  );
  hi.addColorStop(0, 'rgba(255,255,255,0.45)');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hi;
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.fill();

  // Crisp rim.
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba(col.clone().offsetHSL(0, 0, 0.12), 0.9);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const materialCache = new Map<string, THREE.SpriteMaterial>();

function discMaterial(color: string): THREE.SpriteMaterial {
  let mat = materialCache.get(color);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: buildDiscTexture(color),
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    materialCache.set(color, mat);
  }
  return mat;
}

export function makeClaudeNode(color: string, size: number): THREE.Sprite {
  const sprite = new THREE.Sprite(discMaterial(color));
  sprite.scale.set(size, size, 1);
  // Above file sprites (12) and rings (11) so the agent is never occluded.
  sprite.renderOrder = 13;
  // The agent node is decorative — never a raycast hover/box-select target.
  sprite.raycast = () => {};
  return sprite;
}

// A satellite (subagent) node: a smaller hollow ring with a bright core, so it
// reads as a secondary "helper" of the parent's filled disc while sharing its
// color (subagents belong to that Claude). Same per-color material cache idea.
function buildSatelliteTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  const col = new THREE.Color(color);

  // Faint glow (dimmer than the parent so the parent dominates).
  const glowR = TEX_SIZE * 0.5;
  const glow = ctx.createRadialGradient(cx, cy, TEX_SIZE * 0.18, cx, cy, glowR);
  glow.addColorStop(0, rgba(col, 0.32));
  glow.addColorStop(0.6, rgba(col, 0.12));
  glow.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Hollow ring.
  const ringR = TEX_SIZE * 0.27;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.lineWidth = TEX_SIZE * 0.09;
  ctx.strokeStyle = rgba(col, 1);
  ctx.stroke();

  // Bright core dot.
  ctx.beginPath();
  ctx.arc(cx, cy, TEX_SIZE * 0.1, 0, Math.PI * 2);
  ctx.fillStyle = rgba(col.clone().offsetHSL(0, 0, 0.18), 0.95);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const satelliteMaterialCache = new Map<string, THREE.SpriteMaterial>();

function satelliteMaterial(color: string): THREE.SpriteMaterial {
  let mat = satelliteMaterialCache.get(color);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: buildSatelliteTexture(color),
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    satelliteMaterialCache.set(color, mat);
  }
  return mat;
}

export function makeSatelliteNode(color: string, size: number): THREE.Sprite {
  const sprite = new THREE.Sprite(satelliteMaterial(color));
  sprite.scale.set(size, size, 1);
  sprite.renderOrder = 13;
  sprite.raycast = () => {};
  return sprite;
}
