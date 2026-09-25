import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

// This suite never reaches a real backend: every API request and WebSocket is
// intercepted. It can target an isolated Vite instance via LATTICE_E2E_BASE_URL.
const PROJECT = 'C:/lattice-graph-fixture';
const fixture = {
  root: PROJECT,
  nodes: [
    { id: PROJECT, path: PROJECT, name: 'fixture', kind: 'dir' },
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `${PROJECT}/file${i}.ts`, path: `${PROJECT}/file${i}.ts`,
      name: `file${i}.ts`, kind: 'file', ext: '.ts', loc: 10, health: 80,
    })),
  ],
  links: Array.from({ length: 80 }, (_, i) => ({ source: PROJECT, target: `${PROJECT}/file${i}.ts` })),
};

async function openGraph(page: Page) {
  const currentFixture = structuredClone(fixture);
  const sockets = new Map<string, Set<WebSocketRoute>>();
  await page.routeWebSocket('**/ws/**', (ws) => {
    const channel = new URL(ws.url()).pathname;
    const peers = sockets.get(channel) ?? new Set<WebSocketRoute>();
    peers.add(ws);
    sockets.set(channel, peers);
    ws.onClose(() => peers.delete(ws));
  });
  let scans = 0;
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = {};
    if (url.pathname === '/api/scan') { json = currentFixture; scans++; }
    else if (url.pathname === '/api/default-root') json = { path: PROJECT };
    else if (url.pathname === '/api/git-history') json = {
      isRepo: true, commits: [], uncommitted: { changes: [] }, deletedPaths: [], signature: 'fixture',
    };
    else if (url.pathname === '/api/check-git') json = { hasGit: true };
    else if (url.pathname === '/api/settings') json = { startupTerminals: [], sidebarWidth: 240 };
    else if (url.pathname === '/api/tasks') json = { tasks: [] };
    else if (/\/active$/.test(url.pathname)) json = [];
    else if (url.pathname === '/api/terminals') json = [];
    else if (url.pathname === '/api/pi-models') json = { menu: [], models: [] };
    else if (url.pathname === '/api/workflows') json = [];
    else if (url.pathname === '/api/terminal-tabs') json = { tabs: [] };
    // Restore runs on open (restoreTerminalsOnOpen defaults to 'always'), and
    // its notice reads the whole summary — a bare `{}` crashed the app.
    else if (url.pathname === '/api/terminal-tabs/restore') json = { status: 'ok', adopted: 0, queued: 0, dropped: [] };
    await route.fulfill({ json });
  });
  await page.addInitScript((project) => {
    sessionStorage.setItem('lattice.activeFolder', project);
    // Bound the settling phase for software WebGL CI while exercising the
    // same graph physics, batched renderers, scan pipeline, and idle gate.
    localStorage.setItem(`lattice.graphSettings.${project}`, JSON.stringify({ alphaDecay: 0.08 }));
  }, PROJECT);
  await page.goto('/');
  // Read the graph ref through React's mounted tree, keeping instrumentation
  // entirely in the test (no production debug globals or graph API exposure).
  await page.waitForFunction(() => {
    const root = document.getElementById('root') as any;
    const key = Object.keys(root ?? {}).find((k) => k.startsWith('__reactContainer$'));
    const current = key && root[key]?.stateNode?.current;
    const stack = current ? [current] : [];
    while (stack.length) {
      const fiber = stack.pop();
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
        const graph = hook.memoizedState?.current;
        if (graph && typeof graph.graphData === 'function' && graph.graphData().nodes.length > 0) {
          (window as any).__testGraph = graph;
          return true;
        }
      }
    }
    return false;
  });
  await page.evaluate(() => {
    const graph = (window as any).__testGraph;
    const counts = (window as any).__graphCounts = { frames: 0, swaps: 0, ticks: 0 };
    const scene = graph.scene();
    const render = scene.onBeforeRender;
    scene.onBeforeRender = function (...args: any[]) { counts.frames++; return render.apply(this, args); };
    const data = graph.graphData;
    graph.graphData = function (...args: any[]) { if (args.length) counts.swaps++; return data.apply(this, args); };
    const tick = graph.onEngineTick();
    graph.onEngineTick(() => { counts.ticks++; tick(); });
  });
  await expect.poll(() => page.evaluate(() => !(window as any).__testGraph.__idleController.isEngineHot())).toBe(true);
  await page.waitForTimeout(350);
  return {
    send: (channel: string, message: unknown) => {
      expect(sockets.get(channel)?.size ?? 0, `connected ${channel}`).toBeGreaterThan(0);
      for (const ws of sockets.get(channel)!) ws.send(JSON.stringify(message));
    },
    scans: () => scans,
    addFile: () => {
      const id = `${PROJECT}/new-file.ts`;
      currentFixture.nodes.push({ id, path: id, name: 'new-file.ts', kind: 'file', ext: '.ts', loc: 12, health: 80 });
      currentFixture.links.push({ source: PROJECT, target: id });
    },
  };
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const graph = (window as any).__testGraph;
    return {
      ...(window as any).__graphCounts,
      camera: graph.camera().position.toArray(),
      positions: graph.graphData().nodes.map((n: any) => [n.id, n.x, n.y, n.z]),
    };
  });
}

test('settled graph stays asleep and stationary through metric bursts and identical rescans', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const app = await openGraph(page);
  const before = await snapshot(page);
  for (let i = 0; i < 80; i++) app.send('/ws/health', {
    type: 'updated', filePath: `${PROJECT}/file${i}.ts`, metrics: { score: 81, loc: 11 },
  });
  await page.waitForTimeout(500);
  const metrics = await snapshot(page);
  expect(metrics.frames).toBe(before.frames);
  expect(metrics.positions).toEqual(before.positions);
  expect(metrics.camera).toEqual(before.camera);
  expect(metrics.swaps).toBe(before.swaps);
  expect(metrics.ticks).toBe(before.ticks);
  const priorScans = app.scans();
  app.send('/ws/health', { type: 'rescan', reason: 'directory', path: PROJECT });
  await expect.poll(app.scans).toBe(priorScans + 1);
  await page.waitForTimeout(400);
  const rescan = await snapshot(page);
  expect(rescan.positions).toEqual(before.positions);
  expect(rescan.camera).toEqual(before.camera);
  expect(rescan.swaps).toBe(before.swaps);
  expect(rescan.ticks).toBe(before.ticks);
  expect(rescan.frames).toBe(before.frames);
  expect(errors).toEqual([]);
  test.info().annotations.push({ type: 'measurement', description: '80 metric updates + identical rescan: 0 additional frames, simulation ticks, graph swaps, or position changes' });

  // Positive control: the optimization must still populate an actual file
  // addition, refresh both batch buffers, and let its new layout settle.
  app.addFile();
  app.send('/ws/health', { type: 'rescan', reason: 'directory', path: PROJECT });
  await expect.poll(async () => (await snapshot(page)).positions.length).toBe(fixture.nodes.length + 1);
  await expect.poll(async () => (await snapshot(page)).ticks).toBeGreaterThan(rescan.ticks);
  const structural = await snapshot(page);
  expect(structural.swaps).toBe(rescan.swaps + 1);
  expect(structural.frames).toBeGreaterThan(rescan.frames);
  expect(structural.positions.some((n: unknown[]) => n[0] === `${PROJECT}/new-file.ts`)).toBe(true);
  expect(errors).toEqual([]);
});

test('render-only overlay toggles preserve settled node and camera positions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openGraph(page);
  const before = await snapshot(page);
  await page.getByRole('button', { name: 'LOC Z', exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'LOC Z', exact: true }).click();
  await page.waitForTimeout(400);
  const after = await snapshot(page);
  expect(after.positions).toEqual(before.positions);
  expect(after.camera).toEqual(before.camera);
  expect(after.swaps).toBe(before.swaps);
  expect(after.ticks).toBe(before.ticks);
  expect(errors).toEqual([]);
});
