// Registered DELETE failures used to remove the only visible handle to a
// still-running PTY. Drive the real provider, including StrictMode updaters,
// with deferred HTTP replies; existing cleanup assertions remain unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TerminalsProvider, useTerminals } from '../TerminalsContext.tsx';
import type { Ctx, TerminalSpec } from '../terminal/terminalTypes';
import type { TerminalRecord } from '../api/types/terminalTabs';
import type { Task } from '../api/types/tasks';
import { applyTerminalTabsEvent, recordToSpec, restorableCount } from '../terminal/terminalRegistrySync.ts';
import { SidebarTab } from '../components/sidebar/SidebarTab.tsx';
import { useTerminalActions } from '../terminal/useTerminalActions.ts';
import { useTaskTerminalCleanup } from '../components/taskboard/hooks/useTaskTerminalCleanup.ts';
import { installGlobal, installManualTimers } from './domDoubles.ts';

const project = 'C:/terminal-close-test';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function withProvider(
  fetcher: typeof fetch,
  run: (ctx: () => Ctx, cleanup: {
    setTasks: (tasks: Task[]) => void;
    renderCount: () => number;
  }) => Promise<void>,
  cached?: TerminalSpec[],
  initialTasks: Task[] = [],
) {
  const storage = new Map<string, string>();
  if (cached) storage.set('lattice.terminals', JSON.stringify({ terminals: cached, activeId: cached[0]?.id }));
  const restores = [
    installGlobal('React', React),
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    }),
    installGlobal('fetch', fetcher),
  ];
  let current!: Ctx;
  let setTasks!: (tasks: Task[]) => void;
  let renders = 0;
  function Capture() {
    current = useTerminals();
    const [tasks, updateTasks] = React.useState(initialTasks);
    setTasks = updateTasks;
    // Bound a regression's render storm so a held DELETE cannot hang the test.
    assert.ok(++renders <= 100, 'terminal cleanup must settle without a render loop');
    useTaskTerminalCleanup(tasks, current.terminals, current.closeTerminals);
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(React.StrictMode, null,
        React.createElement(TerminalsProvider, { activeFolder: '', restoreMode: null, children: React.createElement(Capture) })));
    });
    await run(() => current, { setTasks: (tasks) => setTasks(tasks), renderCount: () => renders });
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const restore of restores.reverse()) restore();
  }
}

function add(ctx: Ctx, id: string, taskId = 'task') {
  ctx.addTerminal({ id, label: id, cwd: project, projectPath: project, serverId: `pty_${id}`, taskId });
}

function task(status: Task['status'], id = 'task'): Task {
  return { id, status, title: id, projectPath: project, createdAt: 1 };
}

for (const failure of ['rejected', '503'] as const) {
  test(`task cleanup ${failure}: stays idle while pending/failed and permits explicit retry`, async () => {
    const first = deferred<Response>();
    const retry = deferred<Response>();
    const calls: string[] = [];
    await withProvider((async (url, init) => {
      assert.equal(init?.method, 'DELETE');
      calls.push(String(url));
      assert.ok(calls.length <= 2, 'automatic cleanup must never retry a failed DELETE');
      return calls.length === 1 ? first.promise : retry.promise;
    }) as typeof fetch, async (ctx, cleanup) => {
      await act(async () => { add(ctx(), 'a'); });
      const beforeClose = cleanup.renderCount();
      await act(async () => { cleanup.setTasks([task('ready_to_merge')]); });
      assert.equal(calls.length, 1);
      assert.equal(ctx().terminals[0]!.closeState, 'closing');
      assert.equal(ctx().activeId, 'a');
      assert.ok(cleanup.renderCount() <= beforeClose + 4, 'only the task and close-state changes render');

      const pendingList = ctx().terminals;
      const pendingRenders = cleanup.renderCount();
      await act(async () => {
        ctx().closeTerminals([]);
        ctx().closeTerminals(['missing']);
        ctx().closeTerminals(['a', 'a']);
        ctx().closeTerminal('a');
        ctx().closeTerminalsForTask('task');
        await Promise.resolve();
      });
      assert.equal(calls.length, 1, 'overlapping commands reuse the original close');
      assert.equal(ctx().terminals, pendingList);
      assert.equal(cleanup.renderCount(), pendingRenders, 'pending/no-op closes schedule no renders');

      await act(async () => {
        if (failure === 'rejected') first.reject(new TypeError('Failed to fetch'));
        else first.resolve(Response.json({ error: 'kill unconfirmed' }, { status: 503 }));
      });
      const failed = ctx().terminals[0]!;
      assert.equal(failed.id, 'a');
      assert.equal(failed.registered, true);
      assert.equal(failed.serverId, 'pty_a', 'failed close retains PTY ownership');
      assert.equal(failed.closeState, 'failed');
      assert.match(failed.closeError!, /Failed to fetch|kill unconfirmed/);
      assert.equal(ctx().activeId, 'a');
      assert.equal(calls.length, 1);

      const failedRenders = cleanup.renderCount();
      await act(async () => { await Promise.resolve(); });
      assert.equal(cleanup.renderCount(), failedRenders, 'failed close remains visibly retryable without rendering');
      assert.equal(ctx().terminals[0], failed);
      // Fresh task snapshots and later finalization must not retry themselves.
      for (const status of ['ready_to_merge', 'qa', 'done', 'deleted'] as const) {
        await act(async () => { cleanup.setTasks([task(status)]); });
        assert.equal(calls.length, 1);
        assert.equal(ctx().terminals[0], failed);
      }

      await act(async () => { ctx().closeTerminal('a'); });
      assert.equal(calls.length, 2, 'explicit retry issues exactly one new DELETE');
      assert.equal(ctx().terminals[0]!.closeState, 'closing');
      const retryRenders = cleanup.renderCount();
      await act(async () => { await Promise.resolve(); });
      assert.equal(cleanup.renderCount(), retryRenders);
      await act(async () => { retry.resolve(Response.json({ ok: true })); });
      assert.deepEqual(ctx().terminals, []);
      assert.equal(ctx().activeId, null);
      assert.equal(calls.length, 2);
    }, undefined, [task('in_progress')]);
  });
}

test('real task cleanup composes mixed closes, spares ready resolvers, and handles later tabs', async () => {
  const replies = new Map(['a', 'b'].map((id) => [id, deferred<Response>()]));
  const calls: string[] = [];
  await withProvider((async (url, init) => {
    assert.equal(init?.method, 'DELETE');
    calls.push(String(url));
    const id = /terminal-tabs\/([^?]+)/.exec(String(url))?.[1];
    return id && replies.has(id) ? replies.get(id)!.promise : Response.json({ ok: true });
  }) as typeof fetch, async (ctx, cleanup) => {
    await act(async () => {
      add(ctx(), 'a', 'ready');
      ctx().addTerminal({ label: 'fallback', cwd: project, taskId: 'ready', serverId: 'legacy' });
      ctx().addTerminal({ label: 'resolver', cwd: project, taskId: 'ready', kind: 'merge', serverId: 'resolver' });
      add(ctx(), 'b', 'final');
      ctx().addTerminal({ label: 'final resolver', cwd: project, taskId: 'final', kind: 'merge', serverId: 'final-resolver' });
      ctx().addTerminal({ label: 'done', cwd: project, taskId: 'done', serverId: 'done' });
      ctx().addTerminal({ label: 'deleted', cwd: project, taskId: 'deleted', serverId: 'deleted' });
      ctx().addTerminal({ id: 'failed', label: 'failed', cwd: project, projectPath: project,
        taskId: 'final', serverId: 'pty_failed', closeState: 'failed', closeError: 'Retry close' });
      add(ctx(), 'live', 'live');
      ctx().setActiveId('a');
    });
    const finalTasks = [task('ready_to_merge', 'ready'), task('qa', 'final'),
      task('done', 'done'), task('deleted', 'deleted'), task('in_progress', 'live')];
    await act(async () => { cleanup.setTasks(finalTasks); });
    assert.deepEqual(ctx().terminals.map((t) => t.label), ['a', 'resolver', 'b', 'failed', 'live']);
    assert.equal(ctx().activeId, 'a', 'registered selection remains until confirmation');
    assert.equal(calls.length, 6, 'two registered and four fallback PTYs close exactly once');
    assert.equal(new Set(calls).size, 6);
    assert.ok(calls.includes('/api/terminals/final-resolver'), 'finalization closes resolvers too');
    assert.ok(!calls.includes('/api/terminals/resolver'), 'ready-to-merge preserves its resolver');
    const pendingRenders = cleanup.renderCount();
    await act(async () => { await Promise.resolve(); });
    assert.equal(cleanup.renderCount(), pendingRenders);

    // Arrivals while the task is already eligible must use the committed list,
    // even though the child's cleanup effect runs before parent passive effects.
    await act(async () => { add(ctx(), 'late', 'final'); });
    assert.ok(!ctx().terminals.some((t) => t.id === 'late'));
    assert.equal(calls.length, 7);
    await act(async () => {
      ctx().addTerminal({ label: 'late fallback', cwd: project, taskId: 'ready', serverId: 'late-fallback' });
    });
    assert.ok(!ctx().terminals.some((t) => t.label === 'late fallback'));
    assert.equal(calls.length, 8);

    await act(async () => {
      replies.get('b')!.resolve(Response.json({ ok: true }));
    });
    assert.deepEqual(ctx().terminals.map((t) => t.label), ['a', 'resolver', 'failed', 'live']);
    assert.equal(ctx().terminals[0]!.closeState, 'closing', 'another task confirms without waiting for a');
    assert.equal(calls.length, 8);
    await act(async () => {
      replies.get('a')!.resolve(Response.json({ error: 'kill unconfirmed' }, { status: 503 }));
    });
    assert.deepEqual(ctx().terminals.map((t) => t.label), ['a', 'resolver', 'failed', 'live']);
    assert.equal(ctx().terminals[0]!.closeState, 'failed');
    assert.equal(calls.length, 8, 'failure does not retry itself');

    await act(async () => { cleanup.setTasks(finalTasks.map((t) => t.id === 'ready' ? { ...t, status: 'qa' as const } : t)); });
    assert.deepEqual(ctx().terminals.map((t) => t.id), ['a', 'failed', 'live']);
    assert.equal(calls.length, 9, 'only the resolver becomes a fresh cleanup candidate');
  });
});

for (const failure of ['rejected', '502', '503'] as const) {
  test(`registered close ${failure}: retains ownership/feedback and allows a later retry`, async () => {
    const first = deferred<Response>();
    const calls: string[] = [];
    await withProvider((async (url, init) => {
      assert.equal(init?.method, 'DELETE');
      calls.push(String(url));
      return calls.length === 1 ? first.promise : Response.json({ ok: true });
    }) as typeof fetch, async (ctx) => {
      await act(async () => { add(ctx(), 'a'); add(ctx(), 'b'); ctx().setActiveId('a'); });
      await act(async () => { ctx().closeTerminal('a'); ctx().closeTerminal('a'); });
      assert.equal(calls.length, 1, 'overlapping closes issue one DELETE outside StrictMode updaters');
      assert.equal(ctx().terminals[0]!.closeState, 'closing');
      assert.equal(ctx().activeId, 'a', 'selection remains until confirmation');
      await act(async () => {
        if (failure === 'rejected') first.reject(new TypeError('Failed to fetch'));
        else first.resolve(Response.json({ error: 'Backend unavailable' }, { status: Number(failure) }));
      });
      const failed = ctx().terminals.find((t) => t.id === 'a')!;
      assert.equal(failed.serverId, 'pty_a');
      assert.equal(failed.registered, true);
      assert.equal(failed.closeState, 'failed');
      assert.match(failed.closeError!, /Failed to fetch|Backend unavailable/);
      assert.equal(ctx().activeId, 'a');
      await act(async () => { ctx().closeTerminal('a'); });
      assert.deepEqual(ctx().terminals.map((t) => t.id), ['b']);
      assert.equal(ctx().activeId, 'b');
      assert.equal(calls.length, 2);
      assert.match(calls[1]!, /terminal-tabs\/a\?project=C%3A%2Fterminal-close-test$/);
    });
  });
}

test('bulk close deduplicates and composes with task cleanup, retaining only unconfirmed registered tabs', async () => {
  const replies = new Map(['a', 'b', 'c'].map((id) => [id, deferred<Response>()]));
  const deletes: string[] = [];
  await withProvider((async (url) => {
    deletes.push(String(url));
    const id = /terminal-tabs\/([^?]+)/.exec(String(url))?.[1];
    return id ? replies.get(id)!.promise : Response.json({ ok: true });
  }) as typeof fetch, async (ctx) => {
    await act(async () => {
      add(ctx(), 'a', 't1'); add(ctx(), 'b', 't1'); add(ctx(), 'c', 't2');
      ctx().addTerminal({ label: 'fallback', cwd: project, serverId: 'legacy', taskId: 't1' });
    });
    await act(async () => {
      ctx().closeTerminals(['a', 'a', 'b']);
      ctx().closeTerminalsForTask('t1');
      ctx().closeTerminalsForTask('t2');
    });
    assert.equal(deletes.length, 4, 'each registered tab and the legacy PTY is deleted once');
    assert.deepEqual(ctx().terminals.map((t) => t.id), ['a', 'b', 'c'], 'unregistered removal stays immediate');
    await act(async () => {
      replies.get('a')!.resolve(Response.json({ ok: true }));
      replies.get('b')!.resolve(Response.json({ error: 'kill unconfirmed' }, { status: 503 }));
      replies.get('c')!.resolve(Response.json({ ok: true }));
    });
    assert.deepEqual(ctx().terminals.map((t) => t.id), ['b'], 'successes compose without resurrecting siblings');
    assert.equal(ctx().terminals[0]!.closeState, 'failed');
    assert.equal(ctx().terminals[0]!.serverId, 'pty_b');
  });
});

test('retry after a lost acknowledgement accepts an already-removed tab without another PTY DELETE', async () => {
  const deletes: string[] = [];
  await withProvider((async (url) => {
    deletes.push(String(url));
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof fetch, async (ctx) => {
    await act(async () => { add(ctx(), 'a'); });
    await act(async () => { ctx().closeTerminal('a'); });
    assert.deepEqual(ctx().terminals, []);
    assert.equal(deletes.length, 1);
    assert.match(deletes[0]!, /terminal-tabs/);
  });
});

test('a cached in-flight close becomes retryable on reload and command identities stay stable', async () => {
  const cached: TerminalSpec = {
    id: 'a', label: 'a', cwd: project, projectPath: project, serverId: 'pty_a', registered: true, closeState: 'closing',
  };
  await withProvider((async () => Response.json({ ok: true })) as typeof fetch, async (ctx) => {
    assert.equal(ctx().terminals[0]!.closeState, 'failed', 'the old request cannot leave × disabled forever');
    const before = ctx();
    await act(async () => { add(ctx(), 'b'); ctx().renameTerminal('a', '   '); });
    assert.equal(ctx().terminals[0]!.label, 'a', 'empty names remain ignored');
    for (const name of ['addTerminal', 'setActiveId', 'closeTerminal', 'closeTerminals', 'closeTerminalsForTask',
      'renameTerminal', 'reorderTerminal', 'setServerId', 'setStatus'] as const) {
      assert.equal(ctx()[name], before[name], `${name} keeps its callback identity`);
    }
  }, [cached]);
});

test('pending close snapshots/upserts remain visible, own their PTY, and never offer restore', () => {
  const record: TerminalRecord = {
    id: 'a', projectPath: project, cwd: project, label: 'a', order: 0, owner: 'user', launch: {},
    serverId: 'pty_a', createdAt: 1, updatedAt: 2, closePending: true, ended: { reason: 'closed', at: 2 },
  };
  const spec = recordToSpec(record);
  assert.equal(spec.closeState, 'failed');
  assert.equal(spec.serverId, 'pty_a');
  assert.equal(restorableCount([record]), 0);
  assert.deepEqual(applyTerminalTabsEvent([], { type: 'upsert', projectPath: project, record }), [spec]);
  assert.deepEqual(applyTerminalTabsEvent([spec], {
    type: 'ended', projectPath: project, id: 'a', ended: { reason: 'closed', at: 3 },
  }), [], 'only confirmed close removes the tab');
});

test('failed close renders visible feedback and an accessible retry button', async () => {
  const restores = [installGlobal('React', React), installGlobal('IS_REACT_ACT_ENVIRONMENT', true)];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  const noop = () => {};
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SidebarTab, {
        id: 'a', label: 'Agent', cwd: project, closeState: 'failed', closeError: 'kill unconfirmed',
        isActive: false, isDragging: false, isDragOver: false, isEditing: false, activeTabRef: { current: null },
        onActivate: noop, onClose: noop, onStartRename: noop, onRename: noop, onCancelRename: noop,
        onContextMenu: noop, onDragStart: noop, onDragOver: noop, onDrop: noop, onDragEnd: noop,
      }));
    });
    const button = renderer.root.findByType('button');
    assert.equal(button.props['aria-label'], 'Retry closing terminal');
    assert.equal(button.props.disabled, false);
    assert.ok(renderer.root.findAllByType('span').some((span) => span.children.join('').includes('Close failed')));
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const restore of restores.reverse()) restore();
  }
});

test('order debounce retains its scheduled project/order across a switch and cancels only on unmount', async () => {
  const patches: { url: string; body: unknown }[] = [];
  const restores = [
    installGlobal('React', React), installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('fetch', (async (url: string, init: RequestInit) => {
      patches.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch),
  ];
  const timers = installManualTimers();
  let actions!: ReturnType<typeof useTerminalActions>;
  function Capture({ folder }: { folder: string }) {
    const [terminals, setTerminals] = React.useState<TerminalSpec[]>([
      { id: 'a', label: 'a', cwd: project, projectPath: project, registered: true },
      { id: 'b', label: 'b', cwd: project, projectPath: project, registered: true },
    ]);
    const [, setActiveIdState] = React.useState<string | null>(null);
    const terminalsRef = React.useRef(terminals);
    const activeFolderRef = React.useRef(folder);
    const addedDuringFetchRef = React.useRef<Set<string> | null>(null);
    React.useEffect(() => { terminalsRef.current = terminals; }, [terminals]);
    React.useEffect(() => { activeFolderRef.current = folder; }, [folder]);
    actions = useTerminalActions({ setTerminals, setActiveIdState, terminalsRef, activeFolderRef, addedDuringFetchRef });
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Capture, { folder: project })); });
    await act(async () => { actions.reorderTerminal('a', 'b'); });
    assert.deepEqual(timers.scheduled.map((timer) => timer.delay), [300]);
    await act(async () => { renderer.update(React.createElement(Capture, { folder: 'C:/other-project' })); });
    assert.equal(timers.scheduled.length, 1, 'project switches do not cancel the old order PATCH');
    await act(async () => { timers.fireAll(); });
    assert.deepEqual(patches, [{
      url: `/api/terminal-tabs?project=${encodeURIComponent(project)}`, body: { order: ['b', 'a'] },
    }]);
    await act(async () => { actions.reorderTerminal('b', 'a'); });
    assert.equal(timers.scheduled.length, 1);
    await act(async () => { renderer.unmount(); });
    assert.equal(timers.scheduled.length, 0, 'unmount cancels the remaining debounce');
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    timers.restore();
    for (const restore of restores.reverse()) restore();
  }
});
