// Security scans start only from an explicit chip click — never from an
// effect, a rerender or a graph update — and waiting keeps the normal graph
// view with the chip cancellable. A second click before acceptance cancels the
// accepted scan id once; cancelling an update keeps the prior snapshot while a
// completed scan wins a late (false) cancellation; an unavailable engine clears
// the spinner and shows the server error without retrying; long scans poll the
// accepted id without POSTing again (no old client deadline) and cancellation
// clears the polling timer. Harness: securityOverlay.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import type { OpengrepGraphFile } from '../api';
import { runOpengrepGraphScan } from '../api/opengrep.ts';
import { installGlobal, installManualTimers } from './domDoubles.ts';
import { installedStatus, json, result, setup } from './securityOverlay.fixture.ts';

async function microtasks() {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

test('only a chip click starts a scan; waiting keeps the graph visible and the chip cancellable', async (t) => {
  const h = await setup(t);
  assert.equal(h.requests.length, 0);
  await h.update('C:/projA');
  assert.equal(h.requests.length, 0, 'rerendering cannot scan');
  assert.equal(h.refreshes, 0);
  await act(async () => { h.chip().props.onClick(); });
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].init!.body as string), { project: 'C:/projA', async: true, acceptImmediately: true, mode: 'full' });
  assert.equal(h.chip().props['aria-busy'], true);
  assert.equal(h.chip().props.disabled, false);
  assert.equal(h.chip().findAll((n) => n.props.className === 'spinner graph-security-spinner').length, 1);
  assert.equal(h.latest.securityModeRef.current, false, 'waiting keeps the normal graph view and its file nodes');
  assert.equal(h.latest.securityFilesRef.current, null);
  await act(async () => { h.pending.shift()!(json({ scanId: 'og_first', status: 'running' }, 202)); });
  assert.equal(h.latest.security.scanning, false);
  assert.equal(h.latest.security.active, true);
  assert.equal(h.chip().props.disabled, false);
  assert.equal(h.chip().findAll((n) => n.props.className === 'spinner graph-security-spinner').length, 0);
  assert.match(h.requests[1].url, /\/scans\/og_first\?/);
  assert.equal(new URL(h.requests[1].url, 'http://test').searchParams.get('format'), 'graph');
  assert.equal((h.latest.securityFilesRef.current as ReadonlyMap<string, OpengrepGraphFile> | null)?.get('c:/proja/src/a.ts')?.severity, 'ERROR');
  assert.equal(h.chip().findAllByType('span').at(-1)?.children.join(''), '1');
  await h.update('C:/projA');
  assert.equal(h.requests.length, 3, 'completion enables one read-only freshness check; rerendering never starts a scan');
  await act(async () => { h.chip().props.onClick(); });
  assert.equal(h.latest.security.active, false);
  assert.equal(h.latest.securityFilesRef.current, null);
  assert.equal(h.requests.length, 3, 'turning the view off cannot scan');
  await act(async () => { h.chip().props.onClick(); });
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 1, 'reenabling reuses saved results');
  await act(async () => { void h.latest.security.onScan('incremental'); });
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 2, 'updating requires an explicit scan action');
  assert.equal(h.latest.security.estimatedDurationMs, 1250, 'the completed scan supplies an ETA for the next activation');
});

test('a second click before acceptance cancels the accepted scan id once and clears the spinner', async (t) => {
  const h = await setup(t);
  await act(async () => { h.chip().props.onClick(); });
  await act(async () => { h.chip().props.onClick(); });
  assert.equal(h.chip().props.disabled, true, 'the chip disables only while cancellation is pending');
  assert.match(h.chip().findAllByType('span').map((s) => s.children.join('')).join(' '), /Cancelling/);
  await act(async () => { void h.latest.security.onToggle(); });
  assert.equal(h.requests.length, 1, 'cancel intent waits for the accepted id without posting another scan');
  await act(async () => { h.pending.shift()!(json({ scanId: 'og_first', status: 'running' }, 202)); });
  const cancels = h.requests.filter((r) => r.url.endsWith('/cancel'));
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].url, '/api/opengrep/scans/og_first/cancel');
  assert.deepEqual(JSON.parse(cancels[0].init!.body as string), { project: 'C:/projA' });
  assert.equal(h.latest.security.scanning, false);
  assert.equal(h.latest.security.active, false);
  assert.equal(h.latest.security.result, null, 'a racing result cannot turn the cancelled view on');
  assert.equal(h.latest.security.error, null);
  assert.equal(h.requests[0].init!.signal!.aborted, true, 'HTTP waiting stops after the backend confirms cancellation');
});

test('cancelling an update retains the prior snapshot and a completed scan wins a late cancellation', async (t) => {
  const h = await setup(t, { ...installedStatus, project: { path: 'C:/projA', scanning: false, runningScan: null, lastScan: result.scan } });
  await act(async () => { void h.latest.security.onScan('incremental'); });
  assert.equal(h.latest.security.result?.scan.id, 'og_first');
  assert.equal(h.latest.securityModeRef.current, true);
  await act(async () => { void h.latest.security.onToggle(); });
  await act(async () => { h.pending.shift()!(json({ scanId: 'og_update', status: 'running' }, 202)); });
  assert.equal(h.latest.security.scanning, false);
  assert.equal(h.latest.security.result?.scan.id, 'og_first');
  assert.equal(h.latest.security.active, true);
  h.setCancelReply(async () => json({ cancelled: false }));
  h.setGraphReply(async () => json({ ...result, scan: { ...result.scan, id: 'og_completed', startedAt: 2000 } }));
  await act(async () => { void h.latest.security.onScan('full'); });
  await act(async () => { void h.latest.security.onToggle(); });
  await act(async () => { h.pending.shift()!(json({ scanId: 'og_completed', status: 'running' }, 202)); });
  assert.equal(h.latest.security.result?.scan.id, 'og_completed', 'a false cancel response allows completed results to publish');
  assert.equal(h.latest.security.scanning, false);
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
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const restore = installGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST') return json({ scanId: 'og_long', status: 'running' }, 202);
    return ++polls < 3 ? json({ status: 'running' }, 202) : json(result);
  });
  t.after(restore);
  const controller = new AbortController();
  const pending = runOpengrepGraphScan('C:/projA', controller.signal);
  await microtasks();
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 1500);
  now += 20 * 60_000;
  timers.fireAll();
  await microtasks();
  assert.equal(timers.scheduled.length, 1, 'a running scan stays cancellable after the old client deadline');
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
