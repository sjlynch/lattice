import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as THREE from 'three';
import TestRenderer, { act } from 'react-test-renderer';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode, OpengrepGraphResult } from '../api';
import { fetchOpengrepStatus, runOpengrepGraphScan, type OpengrepStatus } from '../api/opengrep.ts';
import { useSecurityOverlay } from '../components/forceGraph/hooks/useSecurityOverlay.ts';
import { useGraphFilter } from '../components/forceGraph/hooks/useGraphFilter.ts';
import { useBatchedLinks } from '../components/forceGraph/hooks/useBatchedLinks.ts';
import { GraphOverlayKey } from '../components/forceGraph/GraphOverlayKey.tsx';
import { SECURITY_COLORS, securityColor, securityFilesByPath, securityPathKey } from '../components/forceGraph/securityOverlay.ts';
import { installGlobal, installManualTimers } from './domDoubles.ts';

// Security must never POST from an effect, a project change, or a graph update.
// Drive the real chip + hook with delayed HTTP, including out-of-scope results.
const result: OpengrepGraphResult = {
  canonicalProject: 'C:/projA',
  scan: { id: 'og_first', project: 'C:/projA', startedAt: 0, finishedAt: 1250, durationMs: 1250,
    engine: { version: '1.30.0', source: 'path' }, packIds: [], rulePaths: [], targets: ['C:/projA'],
    exitCode: 0, findings: 1, bySeverity: { ERROR: 1, WARNING: 0, INFO: 0 },
    scannedFiles: 2, errors: 0, partiallyParsed: 0, jsonFile: '' },
  files: [
    { path: 'src/a.ts', severity: 'ERROR', findings: 1, incomplete: false },
    { path: 'clean.json', severity: null, findings: 0, incomplete: false },
  ],
  shown: 1, errors: 0, partiallyParsed: 0, skippedRules: 0,
};
const noPins = { health: false, loc: false, dead: false, worktree: false, labels: false };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function microtasks() {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

const installedStatus: OpengrepStatus = {
  available: true, engine: { command: 'opengrep', source: 'path', version: '1.30.0' },
  managedVersion: '1.30.0', managedInstalled: false, platformAsset: null, installJob: null, packs: [],
};

async function setup(t: TestContext, status: OpengrepStatus | null = installedStatus) {
  const restoreReact = installGlobal('React', React);
  const restoreAct = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const browserWindow = new EventTarget();
  const browserDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const restoreWindow = installGlobal('window', browserWindow);
  const restoreDocument = installGlobal('document', browserDocument);
  const requests: { url: string; init?: RequestInit }[] = [];
  const statusReads: { url: string; init?: RequestInit }[] = [];
  const statusRequests: { init?: RequestInit; resolve: (response: Response) => void }[] = [];
  const pending: ((response: Response) => void)[] = [];
  let nextStatus = status;
  const restoreFetch = installGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/opengrep/status')) {
      statusReads.push({ url, init });
      if (nextStatus) return Promise.resolve(json(nextStatus));
      return new Promise<Response>((resolve) => statusRequests.push({ init, resolve }));
    }
    requests.push({ url, init });
    if (init?.method === 'POST') return new Promise<Response>((resolve) => pending.push(resolve));
    return Promise.resolve(json(result));
  });
  let refreshes = 0;
  const graph = { refresh: () => { refreshes++; }, enablePointerInteraction: () => graph } as unknown as ForceGraph3DInstance;
  const graphRef = { current: graph };
  let latest!: ReturnType<typeof useSecurityOverlay>;
  function Harness({ project }: { project: string }) {
    latest = useSecurityOverlay(project, graphRef);
    return React.createElement(GraphOverlayKey, { pinned: noPins, active: noPins,
      onTogglePin: () => {}, security: latest.security });
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { project: 'C:/projA' })); });
  t.after(async () => {
    await act(async () => { renderer.unmount(); });
    restoreFetch(); restoreDocument(); restoreWindow(); restoreAct(); restoreReact();
  });
  return {
    requests, pending, get latest() { return latest; }, get refreshes() { return refreshes; },
    statusRequests, statusReads, browserWindow, browserDocument,
    setStatus: (next: OpengrepStatus | null) => { nextStatus = next; },
    chip: () => renderer.root.findAllByType('button').find((b) =>
      b.findAllByType('span').some((s) => s.children.includes('Security')))!,
    update: async (project: string) => { await act(async () => { renderer.update(React.createElement(Harness, { project })); }); },
    renderer,
  };
}

test('only a chip click starts a scan; spinner stays inside the disabled chip until results arrive', async (t) => {
  const h = await setup(t);
  assert.equal(h.requests.length, 0);
  await h.update('C:/projA');
  assert.equal(h.requests.length, 0, 'rerendering cannot scan');
  assert.equal(h.refreshes, 0);
  await act(async () => { h.chip().props.onClick(); });
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].init!.body as string), { project: 'C:/projA', async: true });
  assert.equal(h.chip().props['aria-busy'], true);
  assert.equal(h.chip().props.disabled, true);
  assert.equal(h.chip().findAll((n) => n.props.className === 'spinner graph-security-spinner').length, 1);
  assert.equal(h.latest.securityModeRef.current, true);
  assert.equal(h.latest.securityFilesRef.current, null);
  await act(async () => { void h.latest.security.onToggle(); });
  assert.equal(h.requests.length, 1, 'duplicate activation is single-flight');
  await act(async () => { h.pending.shift()!(json({ scanId: 'og_first', status: 'running' }, 202)); });
  assert.equal(h.latest.security.scanning, false);
  assert.equal(h.latest.security.active, true);
  assert.equal(h.chip().props.disabled, false);
  assert.equal(h.chip().findAll((n) => n.props.className === 'spinner graph-security-spinner').length, 0);
  assert.match(h.requests[1].url, /\/scans\/og_first\?/);
  assert.equal(new URL(h.requests[1].url, 'http://test').searchParams.get('format'), 'graph');
  assert.equal(h.latest.securityFilesRef.current?.get('c:/proja/src/a.ts')?.severity, 'ERROR');
  assert.equal(h.chip().findAllByType('span').at(-1)?.children.join(''), '1.3s');
  await h.update('C:/projA');
  assert.equal(h.requests.length, 2, 'new renders never refresh a completed scan');
  await act(async () => { h.chip().props.onClick(); });
  assert.equal(h.latest.security.active, false);
  assert.equal(h.latest.securityFilesRef.current, null);
  assert.equal(h.requests.length, 2, 'turning the view off cannot scan');
  await act(async () => { h.chip().props.onClick(); });
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 2, 'reenabling explicitly starts a fresh scan');
});

test('Security is hidden until engine availability is confirmed, including an unusable managed installation', async (t) => {
  const h = await setup(t, null);
  assert.equal(h.chip(), undefined, 'unknown availability stays hidden');
  assert.equal(h.renderer.root.findAllByType('button').length, 5, 'other overlay chips remain visible');
  await act(async () => { void h.latest.security.onToggle(); });
  assert.equal(h.requests.length, 0, 'unknown availability cannot start a scan');
  await act(async () => {
    h.statusRequests.shift()!.resolve(json({ ...installedStatus, available: false, engine: null, managedInstalled: true }));
  });
  assert.equal(h.latest.security.available, false);
  assert.equal(h.chip(), undefined, 'a managed install record alone is insufficient');
  await act(async () => { void h.latest.security.onToggle(); });
  assert.equal(h.requests.length, 0);
});

test('Settings status refresh reveals an external engine without starting a scan or accepting an older status', async (t) => {
  const h = await setup(t, null);
  h.setStatus(installedStatus);
  await act(async () => { await fetchOpengrepStatus('C:/settings-project'); });
  assert.equal(h.latest.security.available, true, 'PATH installs count even though managedInstalled is false');
  assert.ok(h.chip());
  assert.equal(h.latest.security.active, false);
  assert.equal(h.requests.length, 0);
  await act(async () => {
    h.statusRequests.shift()!.resolve(json({ ...installedStatus, available: false, engine: null }));
  });
  assert.ok(h.chip(), 'an older startup status cannot hide a newly installed engine');
});

test('returning to the browser rechecks engine availability without a scan', async (t) => {
  const h = await setup(t, { ...installedStatus, available: false, engine: null });
  assert.equal(h.chip(), undefined);
  h.setStatus(installedStatus);
  await act(async () => { h.browserWindow.dispatchEvent(new Event('focus')); });
  assert.ok(h.chip());
  assert.equal(h.statusReads.length, 2);
  assert.equal(h.requests.length, 0);
  h.setStatus({ ...installedStatus, available: false, engine: null });
  h.browserDocument.visibilityState = 'hidden';
  await act(async () => { h.browserDocument.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(h.statusReads.length, 2, 'a hidden tab does not probe');
  h.browserDocument.visibilityState = 'visible';
  await act(async () => { h.browserDocument.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(h.chip(), undefined);
  assert.equal(h.statusReads.length, 3);
  assert.equal(h.requests.length, 0);
});

test('installation status continues polling until completion even without Settings mounted', async (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  const h = await setup(t, { ...installedStatus, available: false, engine: null,
    installJob: { status: 'running', phase: 'checking', version: '1.30.0', asset: 'engine',
      receivedBytes: 100, totalBytes: 100, startedAt: 0 } });
  assert.equal(h.chip(), undefined);
  assert.equal(timers.scheduled.length, 1);
  h.setStatus(installedStatus);
  await act(async () => { timers.fireAll(); });
  assert.ok(h.chip());
  assert.equal(h.statusReads.length, 2);
  assert.equal(timers.scheduled.length, 0, 'availability does not poll when there is no installation');
  assert.equal(h.requests.length, 0);
});

test('failed status reads keep an unconfirmed chip hidden and unmount stops status observation', async (t) => {
  const h = await setup(t, null);
  await act(async () => { h.statusRequests.shift()!.resolve(json({ error: 'backend unavailable' }, 503)); });
  assert.equal(h.chip(), undefined);
  assert.equal(h.requests.length, 0);
  await act(async () => { h.browserWindow.dispatchEvent(new Event('focus')); });
  const pendingStatus = h.statusRequests.shift()!;
  await act(async () => { h.renderer.unmount(); });
  assert.equal(pendingStatus.init!.signal!.aborted, true);
  h.browserWindow.dispatchEvent(new Event('focus'));
  assert.equal(h.statusReads.length, 2, 'unmount removes the refresh listener');
  await act(async () => { pendingStatus.resolve(json(installedStatus)); });
  assert.equal(h.requests.length, 0);
});

test('losing the engine cancels pending scan waiting and clears the security overlay', async (t) => {
  const h = await setup(t);
  await act(async () => { h.chip().props.onClick(); });
  const signal = h.requests[0].init!.signal!;
  h.setStatus({ ...installedStatus, available: false, engine: null });
  await act(async () => { await fetchOpengrepStatus(); });
  assert.equal(h.chip(), undefined);
  assert.equal(signal.aborted, true);
  assert.equal(h.latest.securityModeRef.current, false);
  await act(async () => { h.pending.shift()!(json({ scan: result.scan })); });
  assert.equal(h.latest.security.result, null);
  h.setStatus(installedStatus);
  await act(async () => { await fetchOpengrepStatus(); });
  assert.ok(h.chip());
  assert.equal(h.latest.security.active, false, 'reinstallation does not reactivate an old scan');
  assert.equal(h.requests.length, 1, 'availability changes never POST another scan');
});

test('project switches abort waiting and fence late results, even when returning to the same project', async (t) => {
  const h = await setup(t);
  await act(async () => { h.chip().props.onClick(); });
  const signal = h.requests[0].init!.signal!;
  await h.update('C:/projB');
  assert.equal(signal.aborted, true);
  assert.equal(h.latest.security.active, false);
  assert.equal(h.latest.security.scanning, false);
  assert.equal(h.requests.length, 1);
  await h.update('C:/projA');
  assert.equal(h.latest.security.scanning, false, 'no stale spinner on A → B → A');
  await act(async () => { h.pending.shift()!(json({ scan: result.scan })); });
  assert.equal(h.latest.security.result, null, 'a cancelled request cannot reactivate the old view');
  assert.equal(h.latest.securityFilesRef.current, null);
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 1);
});

test('an unavailable engine clears the spinner and shows the server error without retrying', async (t) => {
  const h = await setup(t);
  await act(async () => { h.chip().props.onClick(); });
  await act(async () => { h.pending.shift()!(json({ error: 'Install OpenGrep in Settings → Tools.', code: 'not-installed' }, 409)); });
  assert.equal(h.latest.security.scanning, false);
  assert.equal(h.latest.security.active, false);
  assert.equal(h.chip().props.disabled, false);
  assert.match(h.renderer.root.findByProps({ role: 'alert' }).children.join(''), /Install OpenGrep/);
  await h.update('C:/projA');
  assert.equal(h.requests.length, 1, 'a failure does not retry automatically');
});

test('long scans poll the accepted id without POSTing again and cancellation clears the polling timer', async (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  const requests: string[] = [];
  let polls = 0;
  const restore = installGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') return json({ scanId: 'og_long', status: 'running' }, 202);
    return ++polls === 1 ? json({ status: 'running' }, 202) : json(result);
  });
  t.after(restore);
  const controller = new AbortController();
  const pending = runOpengrepGraphScan('C:/projA', controller.signal);
  await microtasks();
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 1500);
  timers.fireAll();
  assert.equal((await pending).shown, 1);
  assert.equal(requests.filter((r) => r.startsWith('POST')).length, 1);
  assert.ok(requests.slice(1).every((r) => r.includes('/scans/og_long?')));
  polls = 0;
  const cancelled = runOpengrepGraphScan('C:/projA', controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  await microtasks();
  controller.abort();
  await rejected;
  assert.equal(timers.scheduled.length, 0);
});

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
