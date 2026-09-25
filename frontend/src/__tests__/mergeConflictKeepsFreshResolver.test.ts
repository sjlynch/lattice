import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Ctx } from '../terminal/terminalTypes';
import { TerminalsProvider, useTerminals } from '../TerminalsContext.tsx';
import { useMergeRunSync } from '../components/taskboard/hooks/useMergeRunSync.ts';
import { FakeWebSocket, installFakeWebSocket, installGlobal, installWindow } from './domDoubles.ts';

// A merge run's conflict resolver must survive its own `conflict` event.
//
// The backend records the resolver pty in the terminal-tab registry at spawn,
// and the registry's `upsert` usually mounts that tab (tagged with the task id,
// kind 'merge') BEFORE the merge-run `conflict` event arrives. The handler's
// "drop any stale tab for this task first" then DELETEd the resolver ~20 ms
// after it started; the run saw it dead, stopped, and a workflow Merge step
// failed with "made no progress" (2026-09-25). Same race the task-spawned
// handler already guards against (taskSpawnReplacesStaleTerminal.test.ts).

const project = 'C:/merge-conflict-keep';

function setup(t: TestContext) {
  const deletes: string[] = [];
  const store = new Map<string, string>();
  const restores = [
    installGlobal('React', React),
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installWindow({ location: { protocol: 'http:', host: 'localhost:5184' } }),
    installFakeWebSocket(),
    installGlobal('sessionStorage', {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }),
    installGlobal('fetch', ((url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') deletes.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
    }) as unknown as typeof fetch),
  ];
  let ctx: Ctx | null = null;
  function Capture() {
    ctx = useTerminals();
    useMergeRunSync(project, ctx.addTerminal, ctx.closeTerminalsForTask);
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(TerminalsProvider, null, React.createElement(Capture)),
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    for (const restore of restores.reverse()) restore();
  });
  const mergeRunsSocket = () => {
    const ws = FakeWebSocket.instances.find((s) => String(s.url).includes('/ws/merge-runs'));
    assert.ok(ws, 'useMergeRunSync opened /ws/merge-runs');
    return ws;
  };
  return {
    ctx: () => ctx!,
    deletes,
    sendConflict: async (ev: Record<string, unknown>) => {
      await act(async () => {
        mergeRunsSocket().onmessage?.({ data: JSON.stringify({ type: 'conflict', ...ev }) });
      });
    },
  };
}

const conflict = {
  runId: 'run-1',
  projectPath: project,
  taskId: 't1',
  command: 'claude "Read MERGE_INSTRUCTIONS.md"',
  cwd: '/wt/t1',
  conflictedFiles: ['a.ts'],
  serverId: 'fresh-pty',
  terminalId: 'tab_fresh',
};

test('a conflict event does not kill the resolver tab the registry already mounted', async (t) => {
  const s = setup(t);
  // The registry's upsert for the just-spawned resolver, landing first.
  act(() => {
    s.ctx().addTerminal({
      id: 'tab_fresh',
      label: 'merge:t1',
      cwd: '/wt/t1',
      taskId: 't1',
      kind: 'merge',
      serverId: 'fresh-pty',
      projectPath: project,
    }, false);
  });
  await s.sendConflict(conflict);

  const forT1 = s.ctx().terminals.filter((term) => term.taskId === 't1');
  assert.equal(forT1.length, 1, 'still exactly one resolver tab');
  assert.equal(forT1[0].serverId, 'fresh-pty');
  assert.deepEqual(s.deletes, [], 'the fresh resolver pty is never DELETEd');
});

test('a conflict event still replaces a stale resolver tab from an earlier attempt', async (t) => {
  const s = setup(t);
  act(() => {
    s.ctx().addTerminal({
      id: 'tab_old',
      label: 'merge:t1',
      cwd: '/wt/t1',
      taskId: 't1',
      kind: 'merge',
      serverId: 'old-pty',
      projectPath: project,
    }, false);
  });
  await s.sendConflict(conflict);

  const forT1 = s.ctx().terminals.filter((term) => term.taskId === 't1');
  assert.equal(forT1.length, 1);
  assert.equal(forT1[0].serverId, 'fresh-pty');
  // A registered tab closes through the registry (which kills its pty).
  assert.equal(s.deletes.length, 1, 'exactly one close fires');
  assert.match(s.deletes[0], /\/api\/terminal-tabs\/tab_old\b/, 'and it is the stale tab');
});
