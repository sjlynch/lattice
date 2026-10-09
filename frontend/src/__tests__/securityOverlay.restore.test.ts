// Security across a page refresh. A scan still running on the backend is
// restored from the status snapshot, never re-POSTed: refresh during the
// initial POST restores the exact scan and its countdown (from the backend
// start time; ticks never rebuild graph sprites; an expired estimate never
// means finished); a restored first scan shows an unknown ETA and a failed one
// clears the spinner with its error; a restored scan stays cancellable and a
// failed cancel leaves it running for a retry; a stale status never reactivates
// a cancelled or completed scan. Saved results restore on refresh, toggle
// without a scan and remember a hidden overlay, which reads no saved results on
// focus. Harness: securityOverlay.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import { installGlobal, installManualTimers } from './domDoubles.ts';
import { installedStatus, json, result, setup } from './securityOverlay.fixture.ts';

test('a restored scan can be cancelled; failed cancellation leaves the scan running and allows retry', async (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  const h = await setup(t);
  h.setStatus({ ...installedStatus, project: { path: 'C:/projA', scanning: true,
    runningScan: { id: 'og_first', startedAt: Date.now() }, lastScan: result.scan } });
  h.setGraphReply(async () => json({ status: 'running' }, 202));
  await h.remount();
  const pollSignal = h.requests[0].init!.signal!;
  h.setCancelReply(async () => json({ error: 'Try cancelling again.' }, 503));
  await act(async () => { await h.latest.security.onToggle(); });
  assert.equal(h.latest.security.scanning, true);
  assert.equal(h.latest.security.cancelling, false);
  assert.equal(h.chip().props.disabled, false);
  assert.equal(pollSignal.aborted, false);
  assert.match(h.latest.security.error!, /Try cancelling again/);
  h.setCancelReply(async () => json({ cancelled: true }));
  await act(async () => { await h.latest.security.onToggle(); });
  assert.equal(pollSignal.aborted, true);
  assert.equal(h.latest.security.scanning, false);
  assert.equal(h.latest.security.error, null);
  assert.equal(timers.scheduled.length, 0);
  assert.ok(h.requests.filter((r) => r.init?.method === 'POST').every((r) => r.url.endsWith('/scans/og_first/cancel')));
  await act(async () => { h.browserWindow.dispatchEvent(new Event('focus')); });
  assert.equal(h.latest.security.scanning, false, 'a stale status cannot reactivate the cancelled scan');
});

test('refresh during the initial POST restores the exact scan and its countdown without another POST', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const timers = installManualTimers();
  t.after(() => timers.restore());
  const h = await setup(t, { ...installedStatus,
    project: { path: 'C:/projA', scanning: false, runningScan: null,
      lastScan: { ...result.scan, durationMs: 65_000 } } });
  await act(async () => { void h.latest.security.onScan('full'); });
  const originalSignal = h.requests.find((r) => r.init?.method === 'POST')!.init!.signal!;
  now += 10_000;
  h.setStatus({ ...installedStatus,
    project: { path: 'c:\\ProjA', scanning: true, runningScan: { id: 'og_first', startedAt: 100_000 },
      lastScan: { ...result.scan, durationMs: 65_000 } } });
  h.setGraphReply(async () => json({ status: 'running' }, 202));
  await h.remount();
  assert.equal(originalSignal.aborted, true, 'refresh stops waiting for the original POST');
  assert.equal(h.chip().props['aria-busy'], true);
  assert.equal(h.chip().props.disabled, false);
  assert.equal(h.latest.securityModeRef.current, true, 'restored scans keep previous results visible while waiting');
  assert.equal(h.chip().findAll((n) => n.props.className === 'spinner graph-security-spinner').length, 1);
  const eta = () => h.chip().findByProps({ className: 'graph-overlay-chip-key graph-security-eta' }).children.join('');
  assert.equal(eta(), 'ETA ~0:55', 'the countdown uses the backend start time');
  const refreshes = h.refreshes;
  now += 1000;
  await act(async () => { timers.fireAll(); });
  assert.equal(eta(), 'ETA ~0:54');
  assert.equal(h.refreshes, refreshes, 'countdown ticks never rebuild graph sprites');
  now += 5000;
  await h.remount();
  assert.equal(eta(), 'ETA ~0:49', 'a second refresh does not reset the countdown');
  await act(async () => { h.pending.shift()!(json({ scanId: 'og_first', status: 'running' }, 202)); });
  assert.equal(h.chip().props['aria-busy'], true, 'an obsolete POST response cannot settle the restored chip');
  now += 60_000;
  await act(async () => { timers.fireAll(); });
  assert.equal(eta(), 'Over estimate');
  assert.equal(h.chip().props['aria-busy'], true, 'an expired estimate never means the scan finished');
  h.setGraphReply(async () => json(result));
  await act(async () => { timers.fireAll(); });
  assert.equal(h.chip().props['aria-busy'], false);
  assert.equal(h.latest.securityFilesRef.current?.get('c:/proja/src/a.ts')?.severity, 'ERROR');
  assert.equal(timers.scheduled.length, 0, 'both polling and countdown stop after completion');
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 1);
  assert.ok(h.requests.filter((r) => r.init?.method !== 'POST').every((r) => /\/scans\/(og_first|latest)\?/.test(r.url)));
  await act(async () => { h.chip().props.onClick(); });
  await act(async () => { h.browserWindow.dispatchEvent(new Event('focus')); });
  assert.equal(h.latest.security.active, false, 'a stale running snapshot cannot reactivate a completed scan');
});

test('restored first scans show an unknown ETA; a failed scan clears the spinner and reports its error', async (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  const h = await setup(t);
  h.setStatus({ ...installedStatus,
    project: { path: 'C:/projA', scanning: true, runningScan: { id: 'og_first', startedAt: Date.now() }, lastScan: null } });
  h.setGraphReply(async () => json({ status: 'running' }, 202));
  await h.remount();
  assert.equal(h.chip().findByProps({ className: 'graph-overlay-chip-key graph-security-eta' }).children.join(''), 'Estimating…');
  assert.equal(h.chip().props['aria-busy'], true);
  h.setGraphReply(async () => json({ error: 'OpenGrep scan failed.', code: 'scan-failed' }, 500));
  await act(async () => { timers.fireAll(); });
  assert.equal(h.chip().props['aria-busy'], false);
  assert.equal(h.chip().props.disabled, false);
  assert.match(h.renderer.root.findByProps({ role: 'alert' }).children.join(''), /scan failed/);
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 0);
  assert.equal(timers.scheduled.length, 0);
});

test('saved results restore on refresh, toggle without a scan, and expose a file findings panel', async (t) => {
  const values = new Map<string, string>();
  const restoreStorage = installGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value) });
  t.after(restoreStorage);
  const h = await setup(t, { ...installedStatus, project: { path: 'C:/projA', scanning: false, runningScan: null, lastScan: result.scan } });
  assert.equal(h.latest.security.active, true);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /scans\/latest\?/);
  await act(async () => { h.latest.security.onShowFindings('src/a.ts'); });
  assert.equal(h.latest.security.panelOpen, true);
  assert.equal(h.latest.security.panelFile, 'src/a.ts');
  await act(async () => { await h.latest.security.onToggle(); });
  assert.equal(h.latest.security.active, false);
  await h.remount();
  assert.equal(h.latest.security.active, false, 'refresh remembers that the overlay was hidden');
  assert.equal(h.latest.security.result?.shown, 1, 'the saved report remains available while hidden');
  await act(async () => { await h.latest.security.onToggle(); });
  assert.equal(h.latest.security.active, true);
  assert.equal(h.requests.filter((request) => request.init?.method === 'POST').length, 0);
});

test('with Security off and its panel closed, focus reads no saved results; turning it on reads once', async (t) => {
  const values = new Map<string, string>([['lattice.security.C:/projA', 'off']]);
  const restoreStorage = installGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value) });
  t.after(restoreStorage);
  const h = await setup(t, { ...installedStatus, project: { path: 'C:/projA', scanning: false, runningScan: null, lastScan: result.scan } });
  assert.equal(h.latest.security.active, false);
  const reads = () => h.requests.filter((r) => /scans\/latest\?/.test(r.url)).length;
  assert.equal(reads(), 1, 'the mount-time restore read');
  await act(async () => { h.browserWindow.dispatchEvent(new Event('focus')); });
  assert.equal(reads(), 1, 'a hidden overlay does not re-fetch the full result on focus');
  await act(async () => { await h.latest.security.onToggle(); });
  assert.equal(h.latest.security.active, true);
  assert.equal(reads(), 2, 'turning Security on refreshes once');
  await act(async () => { h.browserWindow.dispatchEvent(new Event('focus')); });
  assert.equal(reads(), 3, 'while shown, focus checks freshness again');
});
