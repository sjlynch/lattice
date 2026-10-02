// The free-floating "Claude node" drawn for each in-progress Claude agent.
// A filled, task-colored disc with a soft outer glow so it reads clearly as
// "not a file" against the file sprites and the blue selection halo.
//
// Materials are cached per color string (there are at most a few dozen live
// agents, and `colorIndex` slots are reused, so the cache stays tiny). Both
// caches are disposed and emptied on graph teardown (spriteMaterialCache.ts).

import * as THREE from 'three';
import { finishCanvasTexture, newTextureCanvas, rgba } from './canvasTexture';
import { CLAUDE_NODE_RENDER_ORDER } from './renderOrders';
import { createSpriteMaterialCache } from './spriteMaterialCache';

const TEX_SIZE = 128;

function buildDiscTexture(color: string): THREE.CanvasTexture {
  const { canvas, ctx } = newTextureCanvas(TEX_SIZE);
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

  return finishCanvasTexture(canvas);
}

const materialCache = createSpriteMaterialCache<string>();

function discMaterial(color: string): THREE.SpriteMaterial {
  return materialCache.get(color, () =>
    new THREE.SpriteMaterial({
      map: buildDiscTexture(color),
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
  );
}

export function makeClaudeNode(color: string, size: number): THREE.Sprite {
  const sprite = new THREE.Sprite(discMaterial(color));
  sprite.scale.set(size, size, 1);
  // Above file sprites (NODE_RENDER_ORDER) and rings (RING_RENDER_ORDER) so the
  // agent is never occluded.
  sprite.renderOrder = CLAUDE_NODE_RENDER_ORDER;
  // The agent node is decorative — never a raycast hover/box-select target.
  sprite.raycast = () => {};
  return sprite;
}

// A satellite (subagent) node: a smaller hollow ring with a bright core, so it
// reads as a secondary "helper" of the parent's filled disc while sharing its
// color (subagents belong to that Claude). Same per-color material cache idea.
function buildSatelliteTexture(color: string): THREE.CanvasTexture {
  const { canvas, ctx } = newTextureCanvas(TEX_SIZE);
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

  return finishCanvasTexture(canvas);
}

const satelliteMaterialCache = createSpriteMaterialCache<string>();

function satelliteMaterial(color: string): THREE.SpriteMaterial {
  return satelliteMaterialCache.get(color, () =>
    new THREE.SpriteMaterial({
      map: buildSatelliteTexture(color),
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
  );
}

export function makeSatelliteNode(color: string, size: number): THREE.Sprite {
  const sprite = new THREE.Sprite(satelliteMaterial(color));
  sprite.scale.set(size, size, 1);
  sprite.renderOrder = CLAUDE_NODE_RENDER_ORDER;
  sprite.raycast = () => {};
  return sprite;
}
