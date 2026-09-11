import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { GitHistoryResult } from '../api';
import { useGitTimeline } from '../components/forceGraph/hooks/useGitTimeline.ts';
import { DEFAULT_SETTINGS } from '../components/forceGraph/graphSettings.ts';
import { FakeWebSocket, installFakeWebSocket, installGlobal, installWindow } from './domDoubles.ts';

function history(signature: string, count: number): GitHistoryResult {
  return {
    signature, isRepo: true, deletedPaths: [], uncommitted: { changes: [] },
    commits: Array.from({ length: count }, (_, i) => ({
      sha: `${signature}-${i}`, shortSha: `${signature}-${i}`, subject: 'fixture',
      authorName: 'test', date: i, changes: [],
    })),
  };
}

test('timeline coalesces HTTP/WS, preserves last-good history and range, and aborts old projects', async () => {
  const pending: Array<{
    path: string;
    signal: AbortSignal;
    resolve: (history: GitHistoryResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('React', React),
    installWindow({ location: { protocol: 'http:', host: 'fixture' } }),
    installFakeWebSocket(),
    installGlobal('fetch', (path: string, opts: RequestInit) => new Promise<Response>((resolve, reject) => {
      pending.push({ path, signal: opts.signal as AbortSignal, reject,
        resolve: (value) => resolve({ ok: true, json: async () => value } as Response) });
    })),
  ];
  let renderer: ReturnType<typeof TestRenderer.create> | undefined;
  let latest!: ReturnType<typeof useGitTimeline>;
  const graph = { current: null };
  const settings = { current: DEFAULT_SETTINGS };
  const metricMode = { current: false };
  function Harness({ folder }: { folder: string }) {
    latest = useGitTimeline(folder, graph, settings, null, metricMode);
    return null;
  }
  const notify = (signature: string) => FakeWebSocket.instances.at(-1)!.onmessage?.({
    data: JSON.stringify({ type: 'git-status', signature }),
  });
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { folder: '/A' })); });
    await act(async () => {
      notify('A1');
      pending[0].resolve(history('A1', 3));
    });
    assert.equal(pending.length, 1, 'initial WS snapshot shares the first HTTP request');
    assert.deepEqual(latest.range, { left: 0, right: 3 });
    await act(async () => { latest.setRange({ left: 1, right: 3 }); notify('A2'); });
    await act(async () => { pending[1].resolve(history('A2', 5)); });
    assert.deepEqual(latest.range, { left: 1, right: 5 }, 'working-tree handle follows new history');
    const lastGood = latest.history;
    await act(async () => { notify('A3'); });
    await act(async () => { pending[2].reject(new Error('backend restarting')); });
    assert.equal(latest.history, lastGood, 'background failure never blanks last good history');
    assert.deepEqual(latest.range, { left: 1, right: 5 });

    await act(async () => { notify('A3'); });
    assert.equal(pending[3].signal.aborted, false);
    await act(async () => { renderer!.update(React.createElement(Harness, { folder: '/B' })); });
    assert.equal(pending[3].signal.aborted, true);
    assert.equal(FakeWebSocket.instances[0].closed, true);
    assert.equal(latest.history, null);
    assert.deepEqual(latest.range, { left: 0, right: 0 });
    assert.ok(pending[4].path.includes('path=%2FB'));
    await act(async () => { pending[3].resolve(history('A3', 6)); });
    assert.equal(latest.history, null, 'old response is fenced even when fetch ignores abort');
    await act(async () => { pending[4].reject(new Error('first load failed')); });
    assert.equal(latest.history?.isRepo, false, 'initial failure still resolves an empty timeline');
    await act(async () => { notify('B1'); });
    await act(async () => { renderer!.unmount(); renderer = undefined; });
    assert.equal(pending[5].signal.aborted, true);
    await act(async () => { pending[5].resolve(history('B1', 1)); });
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    for (const cleanup of restore.reverse()) cleanup();
  }
});
