// Labels overlay (active while the user holds Alt). Each node at the
// currently-active depth gets a name label floating above it; alt+wheel
// scrolls through depth levels so the user can read the graph one band of
// names at a time without overwhelming clutter.

import * as THREE from 'three';
import type { GraphNode } from '../../api';
import { spriteFor } from './sprites';
import type { GraphSettings } from './graphSettings';

// Node depth derived from path: root has depth 0; every path separator past
// the root prefix bumps the depth by one. Works for both POSIX and Windows
// separators since we count both.
export function depthFor(node: GraphNode, root: string): number {
  if (!root || !node.path.startsWith(root)) return 0;
  const rest = node.path.slice(root.length);
  let n = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest.charCodeAt(i);
    if (ch === 47 /* / */ || ch === 92 /* \ */) n++;
  }
  return n;
}

const labelTextureCache = new Map<string, THREE.CanvasTexture>();

function buildNameTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;
  const H = 96;
  const padX = 32;
  // Measure once with a throwaway context to size the canvas to the text.
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
  const measured = Math.ceil(probe.measureText(text).width);
  const W = Math.max(160, measured + padX * 2);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 56px -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, W / 2, H / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  // Stash aspect on the texture so the sprite can read it without
  // re-measuring.
  (tex as THREE.CanvasTexture & { _aspect?: number })._aspect = W / H;
  labelTextureCache.set(key, tex);
  return tex;
}

const LABEL_REF_DIST = 200;
const LABEL_Y = 90;

function makeNameSprite(text: string, color: string, baseH: number): THREE.Sprite {
  const tex = buildNameTexture(text, color);
  const aspect = (tex as THREE.CanvasTexture & { _aspect?: number })._aspect ?? 3;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const h = baseH * 1.6;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(h * aspect, h, 1);
  sprite.renderOrder = 999;

  const _pos = new THREE.Vector3();
  sprite.onBeforeRender = (_r, _s, camera) => {
    sprite.getWorldPosition(_pos);
    const d = camera.position.distanceTo(_pos);
    const s = Math.max(6, Math.min(120, (d / LABEL_REF_DIST) * h));
    sprite.scale.set(s * aspect, s, 1);
  };

  return sprite;
}

// Build a node object for labels mode. If the node sits at the active
// depth, attach a floating name label + connector; otherwise just render
// the normal sprite.
export function spriteForLabels(
  node: GraphNode,
  settings: GraphSettings,
  activeDepth: number,
  nodeDepth: number,
): THREE.Object3D {
  const base = spriteFor(node, settings);
  if (nodeDepth !== activeDepth) return base;

  const group = new THREE.Group();
  group.add(base);

  const color = node.kind === 'dir' ? '#e6c07b' : '#dce4f0';
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 3, 0),
    new THREE.Vector3(0, LABEL_Y - 4, 0),
  ]);
  const lineMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.7,
  });
  group.add(new THREE.Line(lineGeom, lineMat));

  const label = makeNameSprite(node.name, color, settings.labelSize);
  label.position.set(0, LABEL_Y, 0);
  group.add(label);

  return group;
}
