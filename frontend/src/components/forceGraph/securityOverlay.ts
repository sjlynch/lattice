import * as THREE from 'three';
import type { GraphNode, OpengrepGraphFile, OpengrepGraphResult } from '../../api';
import { getStyleFor } from '../../extensionStyles';
import type { GraphSettings } from './graphSettings';
import { materialFor, spriteFor } from './sprites';
import { NODE_RENDER_ORDER } from './renderOrders';

export const SECURITY_COLORS = {
  ERROR: '#f5615c',
  WARNING: '#f5d76e',
  INFO: '#80baff',
  clear: '#7ed884',
  unknown: '#5b626d',
};

export function securityPathKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function securityFilesByPath(result: OpengrepGraphResult): Map<string, OpengrepGraphFile> {
  const root = result.canonicalProject.replace(/[\\/]+$/, '');
  return new Map(result.files.map((file) => [securityPathKey(`${root}/${file.path}`), file]));
}

export function securityColor(file: OpengrepGraphFile | undefined): string {
  if (file?.severity) return SECURITY_COLORS[file.severity];
  return file && !file.incomplete ? SECURITY_COLORS.clear : SECURITY_COLORS.unknown;
}

// Pure recolor: retain each language's shape and keep directory scaffolding.
export function spriteForSecurity(
  node: GraphNode,
  settings: GraphSettings,
  files: ReadonlyMap<string, OpengrepGraphFile> | null,
): THREE.Object3D {
  if (node.kind !== 'file') return spriteFor(node, settings);
  const color = securityColor(files?.get(securityPathKey(node.path)));
  const shape = getStyleFor(node.ext).shape;
  const sprite = new THREE.Sprite(materialFor({ ext: `security:${shape}`, label: 'security', shape, color1: color }));
  sprite.scale.set(settings.fileNodeSize, settings.fileNodeSize, 1);
  sprite.renderOrder = NODE_RENDER_ORDER;
  return sprite;
}
