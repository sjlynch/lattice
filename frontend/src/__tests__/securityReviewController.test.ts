import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useSecurityFindings } from '../components/forceGraph/hooks/useSecurityFindings';
import { installGlobal } from './domDoubles';

test('review controller allows cancelling a pending admission, prevents duplicate actions and fences project switches', async (t) => {
  const restoreAct = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const restoreWindow = installGlobal('window', new EventTarget());
  const restoreDocument = installGlobal('document', { visibilityState: 'visible' });
  const reads: string[] = [];
  const restoreFetch = installGlobal('fetch', async (url: string) => {
    reads.push(url);
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  });
  let current!: ReturnType<typeof useSecurityFindings>;
  let refreshed = 0;
  function Harness({ project }: { project: string }) { current = useSecurityFindings(project, async () => { refreshed++; }); return null; }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { project: 'C:/A' })); });
  t.after(async () => { await act(async () => renderer.unmount()); restoreFetch(); restoreDocument(); restoreWindow(); restoreAct(); });
  assert.equal(current.reviews.length, 0);
  let resolve!: (value: string) => void;
  let start!: Promise<string | undefined>;
  let duplicateCalls = 0;
  await act(async () => { start = current.act(() => new Promise<string>((r) => { resolve = r; })); });
  assert.equal(current.busy, true);
  await act(async () => { await current.act(async () => { duplicateCalls++; }); });
  assert.equal(duplicateCalls, 0);
  await act(async () => { await current.act(async () => 'cancelled', 'Cancelled', true); });
  assert.equal(current.notice, 'Cancelled');
  assert.equal(current.busy, true, 'the original admission is still settling');
  await act(async () => { resolve('started'); await start; });
  assert.equal(current.busy, false);
  assert.equal(refreshed, 2);
  let old!: Promise<string | undefined>;
  await act(async () => { old = current.act(() => new Promise<string>((r) => { resolve = r; }), 'Old project'); });
  await act(async () => { renderer.update(React.createElement(Harness, { project: 'C:/B' })); });
  assert.equal(current.busy, false);
  await act(async () => { resolve('old-result'); assert.equal(await old, undefined); });
  assert.equal(current.notice, null);
  assert.equal(refreshed, 2, 'old mutation cannot refresh the new project');
  assert.ok(reads.some((url) => url.includes('project=C%3A%2FB')));
});
