import * as THREE from 'three';
import type { MeasuredLabelTexture } from './labelTexture';
import {
  disableRaycast,
  restrictSpriteRaycast,
  type SpriteUvBounds,
} from './spritePicking';

const DEFAULT_HIT_BOUNDS = {
  minU: 0,
  maxU: 1,
  minV: 0,
  maxV: 1,
};

export type FloatingLabelSpriteConfig = {
  heightMultiplier: number;
  maxScale: number;
  aspectFallback: number;
  minScale?: number;
  refDistance?: number;
  renderOrder?: number;
  hitBounds?: SpriteUvBounds;
};

export type ConnectorLineConfig = {
  color: string;
  labelY: number;
  opacity: number;
  nodeAnchorY?: number;
  labelGap?: number;
};

export type FloatingLabelEntry = {
  label: THREE.Sprite;
  line: THREE.Line;
};

export function makeFloatingLabelSprite(
  texture: MeasuredLabelTexture,
  baseH: number,
  config: FloatingLabelSpriteConfig,
): THREE.Sprite {
  const aspect = texture._aspect ?? config.aspectFallback;
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const h = baseH * config.heightMultiplier;
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(h * aspect, h, 1);
  restrictSpriteRaycast(
    sprite,
    config.hitBounds ?? texture._hitBounds ?? DEFAULT_HIT_BOUNDS,
  );
  sprite.renderOrder = config.renderOrder ?? 999;

  const minScale = config.minScale ?? 6;
  const refDistance = config.refDistance ?? 200;
  const _pos = new THREE.Vector3();
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    sprite.getWorldPosition(_pos);
    const d = camera.position.distanceTo(_pos);
    const s = Math.max(minScale, Math.min(config.maxScale, (d / refDistance) * h));
    sprite.scale.set(s * aspect, s, 1);
  };

  return sprite;
}

export function makeConnectorLine(config: ConnectorLineConfig): THREE.Line {
  const nodeAnchorY = config.nodeAnchorY ?? 3;
  const labelGap = config.labelGap ?? 4;
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, nodeAnchorY, 0),
    new THREE.Vector3(0, config.labelY - labelGap, 0),
  ]);
  const lineMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(config.color),
    transparent: true,
    opacity: config.opacity,
  });
  const line = new THREE.Line(lineGeom, lineMat);
  disableRaycast(line);
  return line;
}
