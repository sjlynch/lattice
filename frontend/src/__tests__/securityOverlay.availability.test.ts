// The Security chip stays hidden until engine availability is confirmed:
// unknown, a failed status read, or a managed install record without a usable
// engine all stay hidden and can't scan. Availability is re-read on a Settings
// status refresh (PATH installs count; an older startup status can't hide a
// newly installed engine), on returning to the browser (never from a hidden
// tab) and by polling an installation to completion even without Settings
// mounted; unmount stops observing. Losing the engine cancels a waiting scan
// and clears the overlay, and reinstalling never reactivates an old scan — no
// availability change ever POSTs a scan. Harness: securityOverlay.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import { fetchOpengrepStatus } from '../api/opengrep.ts';
import { installManualTimers } from './domDoubles.ts';
import { installedStatus, json, result, setup } from './securityOverlay.fixture.ts';

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
