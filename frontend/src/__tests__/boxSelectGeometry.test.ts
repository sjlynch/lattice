import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  isTinyDrag,
  normalizeDragRect,
  projectNodeToScreen,
  selectNodesInRect,
  type PositionedGraphNode,
} from '../components/forceGraph/hooks/boxSelectGeometry.ts';

function testCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function node(id: string, kind: 'file' | 'dir', overrides: Partial<PositionedGraphNode>): PositionedGraphNode {
  return { id, name: id, path: id, kind, ...overrides };
}

function ids(selected: Set<string>): string[] {
  return [...selected].sort();
}

test('normalizeDragRect produces top-left/bottom-right bounds for any drag direction', () => {
  assert.deepEqual(normalizeDragRect({ x: 20, y: 30 }, { x: 5, y: 10 }), {
    x1: 5,
    y1: 10,
    x2: 20,
    y2: 30,
  });
});

test('isTinyDrag treats only drags smaller than the click threshold as clicks', () => {
  assert.equal(isTinyDrag({ x1: 0, y1: 0, x2: 3.99, y2: 3.99 }), true);
  assert.equal(isTinyDrag({ x1: 0, y1: 0, x2: 4, y2: 3.99 }), false);
  assert.equal(isTinyDrag({ x1: 0, y1: 0, x2: 3.99, y2: 4 }), false);
});

test('projectNodeToScreen maps graph coordinates into viewport pixels', () => {
  const camera = testCamera();

  assert.deepEqual(
    projectNodeToScreen(node('center', 'file', { x: 0, y: 0, z: 0 }), camera, {
      width: 100,
      height: 100,
    }),
    { x: 50, y: 50 },
  );
  assert.deepEqual(
    projectNodeToScreen(node('offset', 'file', { x: 0.5, y: 0.25, z: 0 }), camera, {
      width: 100,
      height: 100,
    }),
    { x: 75, y: 37.5 },
  );
});

test('projectNodeToScreen skips nodes without positions or outside camera depth', () => {
  const camera = testCamera();
  const viewport = { width: 100, height: 100 };

  assert.equal(projectNodeToScreen(node('missing', 'file', {}), camera, viewport), null);
  assert.equal(projectNodeToScreen(node('beyond-far', 'file', { x: 0, y: 0, z: -20 }), camera, viewport), null);
});

test('selectNodesInRect selects projected visible files and respects hidden extensions', () => {
  const camera = testCamera();
  const viewport = { width: 100, height: 100 };
  const rect = { x1: 40, y1: 40, x2: 80, y2: 60 };
  const nodes: PositionedGraphNode[] = [
    node('center-ts', 'file', { ext: 'ts', x: 0, y: 0, z: 0 }),
    node('hidden-js', 'file', { ext: 'JS', x: 0.1, y: 0, z: 0 }),
    node('extensionless', 'file', { x: 0.2, y: 0, z: 0 }),
    node('inside-dir', 'dir', { x: 0.3, y: 0, z: 0 }),
    node('outside-rect', 'file', { ext: 'ts', x: -0.9, y: 0.9, z: 0 }),
    node('unpositioned', 'file', { ext: 'ts' }),
  ];

  assert.deepEqual(
    ids(
      selectNodesInRect(nodes, {
        rect,
        camera,
        viewport,
        includeDirs: false,
        hiddenExts: new Set(['js', '*']),
      }),
    ),
    ['center-ts'],
  );

  assert.deepEqual(
    ids(
      selectNodesInRect(nodes, {
        rect,
        camera,
        viewport,
        includeDirs: true,
        hiddenExts: new Set(['js', '*']),
      }),
    ),
    ['center-ts', 'inside-dir'],
  );
});

test('selectNodesInRect skips nodes the graph visibility accessor hides (ghosts, metric-ignored files)', () => {
  const camera = testCamera();
  const viewport = { width: 100, height: 100 };
  const rect = { x1: 40, y1: 40, x2: 80, y2: 60 };
  const nodes: PositionedGraphNode[] = [
    node('visible-ts', 'file', { ext: 'ts', x: 0, y: 0, z: 0 }),
    node('hidden-ghost', 'file', { ext: 'ts', x: 0.1, y: 0, z: 0 }),
  ];
  const opts = { rect, camera, viewport, includeDirs: false, hiddenExts: new Set<string>() };

  assert.deepEqual(ids(selectNodesInRect(nodes, opts)), ['hidden-ghost', 'visible-ts']);
  assert.deepEqual(
    ids(selectNodesInRect(nodes, { ...opts, isVisible: (n) => n.id !== 'hidden-ghost' })),
    ['visible-ts'],
  );
});
