import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HealthMetrics, ScanResult } from '../api';
import { createHealthUpdateScheduler } from '../hooks/healthUpdateScheduler.ts';
import { snapshotForScanResult, type ProjectScanSnapshot } from '../hooks/scanSnapshot.ts';
import { installGlobal, installManualTimers } from './domDoubles.ts';

const ROOT = '/project';
const FILE = '/project/app.ts';
const metrics = (loc: number) => ({ score: 80, loc }) as HealthMetrics;
function scan(loc = 1): ScanResult {
  return { root: ROOT, nodes: [
    { id: ROOT, path: ROOT, name: 'project', kind: 'dir' },
    { id: FILE, path: FILE, name: 'app.ts', kind: 'file', ext: '.ts', loc },
  ], links: [{ source: ROOT, target: FILE }] };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function harness() {
  const timers = installManualTimers();
  const pending: Array<{ resolve: (scan: ScanResult) => void; signal: AbortSignal }> = [];
  const restoreFetch = installGlobal('fetch', (_url: string, opts: RequestInit) =>
    new Promise<Response>((resolve) => pending.push({
      resolve: (body) => resolve({ ok: true, json: async () => body } as Response),
      signal: opts.signal as AbortSignal,
    })));
  const scanResultRef = { current: scan() as ScanResult | null };
  let snapshot = snapshotForScanResult(ROOT, scanResultRef.current!);
  const snapshots: ProjectScanSnapshot[] = [];
  let requestId = 0;
  const scheduler = createHealthUpdateScheduler({
    activeFolder: ROOT, scanResultRef,
    setSnapshot: (action) => {
      snapshot = typeof action === 'function' ? action(snapshot) : action;
      snapshots.push(snapshot);
    },
    requestId: { next: () => ++requestId, isCurrent: (id) => id === requestId },
  });
  return {
    scheduler, timers, pending, scanResultRef, snapshots,
    start: () => { scheduler.handleEvent({ type: 'rescan', reason: 'config' }); timers.fireAll(); },
    cleanup: () => { scheduler.dispose(); restoreFetch(); timers.restore(); },
  };
}

test('a scan resolving during the removal debounce never resurrects a deleted node', async () => {
  const h = harness();
  try {
    h.start();
    h.scheduler.handleEvent({ type: 'removed', filePath: FILE });
    assert.equal(h.scanResultRef.current!.nodes.length, 1);
    h.pending[0].resolve(scan());
    await flush();
    assert.equal(h.scanResultRef.current!.nodes.length, 1);
    assert.equal(h.snapshots.length, 1, 'stale scan must not publish another shape');
    assert.equal(h.timers.scheduled.length, 1, 'replacement scan remains debounced');
  } finally { h.cleanup(); }
});

test('metrics received and flushed during a slow scan survive its older response', async () => {
  const h = harness();
  try {
    h.start();
    const latest = metrics(99);
    h.scheduler.handleEvent({ type: 'updated', filePath: FILE, metrics: latest });
    h.timers.fireAll();
    assert.equal(h.scanResultRef.current!.nodes[1].loc, 99);
    h.pending[0].resolve(scan(1));
    await flush();
    assert.equal(h.scanResultRef.current!.nodes[1].loc, 99);
    assert.equal(h.scanResultRef.current!.nodes[1].healthDetails, latest);
  } finally { h.cleanup(); }
});

test('repeated structural updates while scanning run at most one scan and one follow-up', async () => {
  const h = harness();
  try {
    h.start();
    for (let i = 0; i < 20; i++) {
      h.scheduler.handleEvent({ type: 'rescan', reason: 'config' });
      h.timers.fireAll();
    }
    assert.equal(h.pending.length, 1, 'slow repository walks cannot overlap');
    h.pending[0].resolve(scan());
    await flush();
    assert.equal(h.snapshots.length, 0, 'superseded result must not paint');
    h.timers.fireAll();
    assert.equal(h.pending.length, 2);
    h.pending[1].resolve(scan(20));
    await flush();
    assert.equal(h.scanResultRef.current!.nodes[1].loc, 20);
    assert.equal(h.timers.scheduled.length, 0);
  } finally { h.cleanup(); }
});

test('pending metrics are applied before a scan publishes and keep its links identity', async () => {
  const h = harness();
  try {
    h.start();
    h.scheduler.handleEvent({ type: 'updated', filePath: FILE, metrics: metrics(7) });
    const response = scan(1);
    h.pending[0].resolve(response);
    await flush();
    assert.equal(h.scanResultRef.current!.nodes[1].loc, 7);
    assert.equal(h.scanResultRef.current!.links, response.links);
    h.timers.fireAll();
    assert.equal(h.snapshots.length, 1, 'batch flush after replay is a no-op');
  } finally { h.cleanup(); }
});

test('disposing cancels the HTTP scan and fences queued health events and late results', async () => {
  const h = harness();
  try {
    h.start();
    h.scheduler.dispose();
    assert.equal(h.pending[0].signal.aborted, true);
    h.scheduler.handleEvent({ type: 'updated', filePath: FILE, metrics: metrics(9) });
    h.pending[0].resolve(scan(9));
    await flush();
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.timers.scheduled.length, 0);
  } finally { h.cleanup(); }
});
