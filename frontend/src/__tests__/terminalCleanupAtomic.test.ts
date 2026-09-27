import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Ctx, TerminalSpec } from '../terminal/terminalTypes';
import {
  planCloseTerminals,
  removeTerminalFromList,
  reorderTerminalInList,
  setStatusInList,
  terminalIdsForTask,
} from '../terminal/terminalState.ts';
import { TerminalsProvider, useTerminals } from '../TerminalsContext.tsx';
import { installGlobal } from './domDoubles.ts';

function term(
  id: string,
  taskId: string | undefined,
  serverId: string,
): TerminalSpec {
  return { id, taskId, serverId, label: id, cwd: `/wt/${id}` };
}

// Two terminals share a taskId (the worktree-agent pty + its conflict
// resolver, say); a third belongs to a different task. The shared scenario
// from useTaskTerminalCleanup, which fires closeTerminalsForTask on a
// qa/done/deleted transition.
function fixture(): TerminalSpec[] {
  return [
    term('a', 't1', 'sa'),
    term('b', 't1', 'sb'),
    term('c', 't2', 'sc'),
  ];
}

test('terminalIdsForTask collects every terminal sharing the task id', () => {
  assert.deepEqual(terminalIdsForTask(fixture(), 't1'), ['a', 'b']);
  assert.deepEqual(terminalIdsForTask(fixture(), 't2'), ['c']);
  assert.deepEqual(terminalIdsForTask(fixture(), 'nope'), []);
});

test('closeTerminalsForTask plan removes ALL matching terminals atomically and deletes each serverId exactly once', () => {
  const terminals = fixture();

  // This mirrors what closeTerminalsForTask now does: collect the ids, then
  // hand them to the batched close (planCloseTerminals) which computes the
  // post-close list + the serverId DELETEs from a SINGLE snapshot.
  const ids = terminalIdsForTask(terminals, 't1');
  const { serverIdsToDelete, next } = planCloseTerminals(terminals, new Set(ids));

  // Both task-t1 terminals are gone; the unrelated t2 terminal survives.
  assert.deepEqual(
    next.map((t) => t.id),
    ['c'],
    'both terminals for the task are removed in one pass — neither resurrected',
  );

  // Each backend session is DELETEd exactly once (no duplicate, no miss).
  assert.deepEqual(serverIdsToDelete, ['sa', 'sb']);
  assert.equal(
    new Set(serverIdsToDelete).size,
    serverIdsToDelete.length,
    'no serverId is deleted twice',
  );
});

test('regression: the old per-id close loop resurrected a sibling tab; the batched close does not', () => {
  const prev = fixture();
  const ids = terminalIdsForTask(prev, 't1'); // ['a', 'b']

  // Reproduce the OLD bug: closeTerminalsForTask looped closeTerminal(id),
  // and each closeTerminal re-read the SAME stale snapshot (terminalsRef only
  // syncs in an effect after render, never mid-loop) and called setTerminals
  // with that snapshot minus just its own id. The last write therefore won —
  // removing only 'b' and leaving 'a' (already "closed") back in the list.
  let oldFinal = prev;
  for (const id of ids) {
    oldFinal = removeTerminalFromList(prev, id); // NOTE: prev, not oldFinal
  }
  assert.deepEqual(
    oldFinal.map((t) => t.id),
    ['a', 'c'],
    'documents the bug: terminal "a" is resurrected by the stale-snapshot loop',
  );

  // The new atomic path removes both from one snapshot — no resurrection.
  const { next } = planCloseTerminals(prev, new Set(ids));
  assert.deepEqual(next.map((t) => t.id), ['c']);
});

test('planCloseTerminals dedupes the DELETE even if an id is passed twice', () => {
  const terminals = fixture();
  // The old closeTerminals iterated the raw ids array, so a duplicated id
  // fired two DELETEs for one session — which on Windows crashed node-pty's
  // helper. planCloseTerminals walks the terminal list once, keyed by the id
  // set, so each live session contributes at most one DELETE.
  const { serverIdsToDelete } = planCloseTerminals(
    terminals,
    new Set(['a', 'a', 'b']),
  );
  assert.deepEqual(serverIdsToDelete, ['sa', 'sb']);
});

// Cross-task regression: the single-call atomicity above wasn't enough.
// useTaskTerminalCleanup's first effect loops closeTerminalsForTask(task.id)
// once PER qa/done/deleted task in a synchronous batch. Each call routed
// through the OLD closeTerminals, which read the same pre-batch terminalsRef
// snapshot (the ref only re-syncs in the [terminals] effect after render) and
// did a NON-functional setTerminals(next). React kept only the last call's
// setState — that snapshot minus just its own task's ids — so every other
// finalizing task's terminals came back as dead 'session lost' tabs. This
// drives the REAL context so a functional removal is what's actually asserted.
test('two closeTerminalsForTask calls batched in one update remove every task’s terminals (no cross-task clobber)', () => {
  const deletes: string[] = [];
  const store = new Map<string, string>();
  const restores = [
    // tsx compiles the app's .tsx with the classic JSX runtime, so components
    // emit React.createElement without importing React — expose it globally.
    installGlobal('React', React),
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('sessionStorage', {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }),
    installGlobal(
      'fetch',
      ((url: string, init?: { method?: string }) => {
        if (init?.method === 'DELETE') deletes.push(url);
        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch,
    ),
  ];

  let ctx: Ctx | null = null;
  function Capture() {
    ctx = useTerminals();
    return null;
  }

  let renderer!: ReturnType<typeof TestRenderer.create>;
  try {
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          TerminalsProvider,
          null,
          React.createElement(Capture),
        ),
      );
    });

    // Seed: task t1 owns two terminals (worktree agent + its conflict
    // resolver), task t2 owns one. Both tasks are about to finalize together.
    act(() => {
      ctx!.addTerminal({ label: 'a', cwd: '/wt/a', taskId: 't1', serverId: 'sa' });
      ctx!.addTerminal({ label: 'b', cwd: '/wt/b', taskId: 't1', serverId: 'sb' });
      ctx!.addTerminal({ label: 'c', cwd: '/wt/c', taskId: 't2', serverId: 'sc' });
    });
    assert.deepEqual(
      ctx!.terminals.map((t) => t.taskId),
      ['t1', 't1', 't2'],
      'seed: two t1 terminals + one t2 terminal',
    );

    // The failure mode: both closeTerminalsForTask calls fire in ONE React
    // batch, each reading the same pre-batch snapshot.
    act(() => {
      ctx!.closeTerminalsForTask('t1');
      ctx!.closeTerminalsForTask('t2');
    });

    assert.deepEqual(
      ctx!.terminals,
      [],
      'both tasks’ terminals are removed and stay removed — none resurrected',
    );
    assert.deepEqual(
      deletes.sort(),
      ['/api/terminals/sa', '/api/terminals/sb', '/api/terminals/sc'],
      'each backend session is DELETEd exactly once across the batch',
    );
  } finally {
    act(() => renderer.unmount());
    for (const restore of restores.reverse()) restore();
  }
});

// With the board open, the registry's `upsert` for a freshly spawned task pty
// mounts its tab (tagged with the taskId) BEFORE the `task-spawned` event
// arrives. The spawn handler's "one tab per task" close then DELETEd that very
// tab — killing every queued run and every Resume ~30 ms after it started
// (2026-09-23). The delivered pty must survive the per-task close.
test('terminalIdsForTask spares the tab the task-spawned event is delivering', () => {
  const tabs = [
    { id: 'old', taskId: 't1', serverId: 'srv-old' },
    { id: 'new', taskId: 't1', serverId: 'srv-new' },
    { id: 'other', taskId: 't2', serverId: 'srv-x' },
  ] as unknown as Parameters<typeof terminalIdsForTask>[0];
  assert.deepEqual(terminalIdsForTask(tabs, 't1'), ['old', 'new'], 'no keep: legacy behaviour');
  assert.deepEqual(terminalIdsForTask(tabs, 't1', { id: 'new' }), ['old']);
  assert.deepEqual(terminalIdsForTask(tabs, 't1', { serverId: 'srv-new' }), ['old'], 'matched by pty id too');
  assert.deepEqual(terminalIdsForTask(tabs, 't1', { id: 'absent', serverId: 'absent' }), ['old', 'new']);
});

// reorderTerminalInList feeds TerminalsContext.reorderTerminal, whose result
// becomes the persisted tab order (PATCH /api/terminal-tabs {order}). It must
// work on ids over the FULL list even though the tab strip shows only a
// scoped, search-filtered subset — applying filtered indices to the full list
// scrambles the durable order (cf. the taskboard lane bug, 5ad4044).
function ids(list: TerminalSpec[]): string[] {
  return list.map((t) => t.id);
}

function lettered(...names: string[]): TerminalSpec[] {
  return names.map((n) => term(n, undefined, `s${n}`));
}

test('reorderTerminalInList: a forward drag lands after the target, a backward drag before it', () => {
  const input = lettered('a', 'b', 'c', 'd', 'e');
  const snapshot = ids(input);

  assert.deepEqual(ids(reorderTerminalInList(input, 'a', 'd')), ['b', 'c', 'd', 'a', 'e'], 'forward: after the target');
  assert.deepEqual(ids(reorderTerminalInList(input, 'e', 'b')), ['a', 'e', 'b', 'c', 'd'], 'backward: before the target');
  // Adjacent drags swap in either direction.
  assert.deepEqual(ids(reorderTerminalInList(input, 'b', 'c')), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(ids(reorderTerminalInList(input, 'c', 'b')), ['a', 'c', 'b', 'd', 'e']);

  assert.deepEqual(ids(input), snapshot, 'the input array is never mutated');
});

test('reorderTerminalInList over a filtered subset keeps hidden tabs in place and in order', () => {
  // Only a, b, c are visible in the strip; x and y belong to another
  // project/panel or are filtered out by the search.
  const input = lettered('a', 'x', 'b', 'y', 'c');
  const snapshot = ids(input);

  const out = reorderTerminalInList(input, 'a', 'c');
  assert.deepEqual(ids(out), ['x', 'b', 'y', 'c', 'a'], 'a lands directly after c');
  assert.equal(out.length, input.length, 'no tab dropped or duplicated');
  assert.deepEqual(new Set(ids(out)), new Set(snapshot));
  assert.deepEqual(
    ids(out).filter((id) => id === 'x' || id === 'y'),
    ['x', 'y'],
    'hidden tabs keep their relative order',
  );
  assert.deepEqual(
    ids(out).filter((id) => id === 'a' || id === 'b' || id === 'c'),
    ['b', 'c', 'a'],
    'the visible subset reflects the drop',
  );

  // Backward over the same hidden tabs: c onto a lands before a.
  assert.deepEqual(ids(reorderTerminalInList(input, 'c', 'a')), ['c', 'a', 'x', 'b', 'y']);

  assert.deepEqual(ids(input), snapshot, 'the input array is never mutated');
});

test('reorderTerminalInList no-ops return the input reference unchanged', () => {
  const input = lettered('a', 'b', 'c');
  const snapshot = ids(input);

  assert.equal(reorderTerminalInList(input, 'b', 'b'), input, 'dragged onto itself');
  assert.equal(reorderTerminalInList(input, 'nope', 'b'), input, 'unknown dragged id');
  assert.equal(reorderTerminalInList(input, 'b', 'nope'), input, 'unknown target id');

  assert.deepEqual(ids(input), snapshot, 'the input array is never mutated');
});

// A repeated status report (`live` on every (re)connect) must hand back the
// SAME array, or the whole tab strip re-renders on each report.
test('setStatusInList returns the same reference when nothing changes and a fresh array otherwise', () => {
  const input: TerminalSpec[] = [
    { ...term('a', undefined, 'sa'), status: 'live' },
    { ...term('b', undefined, 'sb'), status: 'exited', exitCode: 1 },
    term('c', undefined, 'sc'),
  ];
  const snapshot = input.map((t) => ({ ...t }));

  assert.equal(setStatusInList(input, 'nope', 'dead'), input, 'unknown id');
  assert.equal(setStatusInList(input, 'a', 'live'), input, 'identical status, no exit code');
  assert.equal(setStatusInList(input, 'b', 'exited', 1), input, 'identical status + exit code');

  const changed = setStatusInList(input, 'a', 'reconnecting');
  assert.notEqual(changed, input);
  assert.equal(changed[0].status, 'reconnecting');
  assert.equal(changed[1], input[1], 'untouched tabs keep their object identity');
  assert.equal(changed[2], input[2]);

  // Same status, but the exit code goes undefined → 0.
  const exited: TerminalSpec[] = [{ ...term('a', undefined, 'sa'), status: 'exited' }, input[2]];
  const withCode = setStatusInList(exited, 'a', 'exited', 0);
  assert.notEqual(withCode, exited, 'an exit-code-only change is still a change');
  assert.equal(withCode[0].status, 'exited');
  assert.equal(withCode[0].exitCode, 0);
  assert.equal(withCode[1], exited[1]);
  assert.equal(exited[0].exitCode, undefined, 'the input tab is not mutated');

  assert.deepEqual(input, snapshot, 'the input array is never mutated');
});
