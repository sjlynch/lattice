// How the Security view paints the graph: severity colors distinguish
// findings, scanned clear files and unknown coverage (Windows paths fold case,
// POSIX paths stay case-sensitive); with Security on, metrics-ignored config
// files stay visible while ghosts hide and normal filters still apply; batched
// links recapture config visibility when Security toggles over a pinned metric
// view (metricOverlayActive stays true throughout). None of this can scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as THREE from 'three';
import TestRenderer, { act } from 'react-test-renderer';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../api';
import { useGraphFilter } from '../components/forceGraph/hooks/useGraphFilter.ts';
import { useBatchedLinks } from '../components/forceGraph/hooks/useBatchedLinks.ts';
import { SECURITY_COLORS, securityColor, securityFilesByPath, securityPathKey } from '../components/forceGraph/securityOverlay.ts';
import { installGlobal } from './domDoubles.ts';
import { result } from './securityOverlay.fixture.ts';

test('security color and path mapping distinguish findings, scanned clear files, and unknown coverage', () => {
  for (const severity of ['ERROR', 'WARNING', 'INFO'] as const) {
    assert.equal(securityColor({ path: 'x.ts', severity, findings: 1, incomplete: true }), SECURITY_COLORS[severity]);
  }
  assert.equal(securityColor(result.files[1]), SECURITY_COLORS.clear);
  assert.equal(securityColor({ ...result.files[1], incomplete: true }), SECURITY_COLORS.unknown);
  assert.equal(securityColor(undefined), SECURITY_COLORS.unknown);
  assert.equal(securityFilesByPath(result).get(securityPathKey('c:\\ProjA\\SRC\\A.ts'))?.severity, 'ERROR');
  assert.notEqual(securityPathKey('/repo/A.ts'), securityPathKey('/repo/a.ts'), 'POSIX paths remain case-sensitive');
});

test('Security keeps metrics-ignored config files visible while hiding ghosts; normal filters still apply', async (t) => {
  const restore = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let nodeVisible!: (n: GraphNode) => boolean;
  let linkVisible!: (l: object) => boolean;
  const graph = {
    nodeVisibility: (fn: typeof nodeVisible) => { nodeVisible = fn; return graph; },
    linkVisibility: (fn: typeof linkVisible) => { linkVisible = fn; return graph; },
  } as unknown as ForceGraph3DInstance;
  const graphRef = { current: graph };
  const hidden = new Set(['.md']);
  const changeMapRef = { current: new Map<'gone.ts', 'deleted'>([['gone.ts', 'deleted']]) };
  const ignoredRef = { current: new Set(['.json']) };
  const metricRef = { current: true };
  const securityRef = { current: true };
  function Harness() {
    useGraphFilter(graphRef, hidden, changeMapRef, ignoredRef, metricRef, true, securityRef);
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
  t.after(async () => { await act(async () => { renderer.unmount(); }); restore(); });
  const config: GraphNode = { id: 'config', name: 'app.json', path: 'C:/proj/app.json', kind: 'file', ext: '.json' };
  const ghost: GraphNode = { ...config, id: '__ghost__:gone.ts', path: 'gone.ts' };
  assert.equal(nodeVisible(config), true);
  assert.equal(nodeVisible(ghost), false);
  assert.equal(nodeVisible({ ...config, ext: '.md' }), false);
  assert.equal(linkVisible({ source: config, target: ghost }), false);
  securityRef.current = false;
  assert.equal(nodeVisible(config), false, 'returning to Health uses its ignore list through the existing accessor');
  metricRef.current = false;
  assert.equal(nodeVisible(config), true);
  assert.equal(nodeVisible(ghost), true);
});

test('batched links recapture config visibility when Security toggles over a pinned metric view', async (t) => {
  const restore = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const scene = new THREE.Scene();
  const source = { id: 'root', name: 'proj', path: 'C:/proj', kind: 'dir', x: 0, y: 0, z: 0 };
  const target = { id: 'config', name: 'app.json', path: 'C:/proj/app.json', kind: 'file', ext: '.json', x: 1, y: 0, z: 0 };
  let visibility: unknown;
  const graph = {
    scene: () => scene,
    graphData: () => ({ nodes: [source, target], links: [{ source, target }] }),
    nodeVisibility: () => graph,
    linkVisibility: (fn?: unknown) => fn ? (visibility = fn, graph) : visibility,
    linkColor: () => '#f0f0f0', linkOpacity: () => 1, linkThreeObject: () => {},
    onEngineTick: () => {}, onNodeDrag: () => {}, onNodeDragEnd: () => {},
  } as unknown as ForceGraph3DInstance;
  const graphRef = { current: graph };
  const hidden = new Set<string>();
  const changeMapRef = { current: new Map<string, 'deleted'>() };
  const ignoredRef = { current: new Set(['.json']) };
  const metricRef = { current: true };
  const securityRef = { current: false };
  function Harness({ active }: { active: boolean }) {
    securityRef.current = active;
    useGraphFilter(graphRef, hidden, changeMapRef, ignoredRef, metricRef, true, securityRef);
    useBatchedLinks(graphRef, true, hidden, 0, true, true, active);
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { active: false })); });
  t.after(async () => { await act(async () => { renderer.unmount(); }); restore(); });
  const batched = scene.children.find((o) => o.userData['lattice:batchedLinks']) as THREE.LineSegments;
  assert.equal(batched.geometry.drawRange.count, 0);
  await act(async () => { renderer.update(React.createElement(Harness, { active: true })); });
  assert.equal(batched.geometry.drawRange.count, 2, 'Security restores the config link even though metricOverlayActive stayed true');
  await act(async () => { renderer.update(React.createElement(Harness, { active: false })); });
  assert.equal(batched.geometry.drawRange.count, 0, 'Health hides the config link again');
});
