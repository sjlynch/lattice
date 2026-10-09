// Security's project fence: a project switch aborts restored polling and any
// waiting scan, and late project snapshots, shared status reads and scan
// results — even after returning A → B → A — can neither attach a scan, leave
// a stale spinner nor reactivate the old view. A switch never POSTs a scan.
// Harness: securityOverlay.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import { fetchOpengrepStatus } from '../api/opengrep.ts';
import { installedStatus, json, result, setup } from './securityOverlay.fixture.ts';

test('project switches abort restored polling and ignore late project snapshots and scan results', async (t) => {
  const h = await setup(t);
  h.setStatus({ ...installedStatus,
    project: { path: 'C:/projA', scanning: true, runningScan: { id: 'og_first', startedAt: Date.now() }, lastScan: result.scan } });
  let complete!: (response: Response) => void;
  h.setGraphReply(() => new Promise<Response>((resolve) => { complete = resolve; }));
  await h.remount();
  const signal = h.requests[0].init!.signal!;
  h.setStatus(null);
  await h.update('C:/projB');
  assert.equal(signal.aborted, true);
  assert.equal(h.latest.security.scanning, false);
  await act(async () => { complete(json(result)); });
  assert.equal(h.latest.security.result, null);
  h.setStatus({ ...installedStatus,
    project: { path: 'C:/projA', scanning: true, runningScan: { id: 'og_first', startedAt: Date.now() }, lastScan: result.scan } });
  await act(async () => { await fetchOpengrepStatus('C:/projA'); });
  assert.equal(h.latest.security.scanning, false, 'a shared status for another project cannot attach a scan');
  await act(async () => { h.renderer.unmount(); });
  assert.equal(h.statusRequests[0].init!.signal!.aborted, true);
  await act(async () => { h.statusRequests[0].resolve(json(installedStatus)); });
  assert.equal(h.requests.length, 2, 'one running poll and one saved snapshot read; stale project answers add neither');
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
