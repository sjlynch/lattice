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
import { applyTerminalTabsEvent, recordToSpec, restorableCount } from '../terminal/terminalRegistrySync.ts';
import { SidebarTab } from '../components/sidebar/SidebarTab.tsx';
import { useTerminalActions } from '../terminal/useTerminalActions.ts';
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
  run: (ctx: () => Ctx) => Promise<void>,
  cached?: TerminalSpec[],
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
  function Capture() { current = useTerminals(); return null; }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(React.StrictMode, null,
        React.createElement(TerminalsProvider, { activeFolder: '', restoreMode: null, children: React.createElement(Capture) })));
    });
    await run(() => current);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const restore of restores.reverse()) restore();
  }
}

function add(ctx: Ctx, id: string, taskId = 'task') {
  ctx.addTerminal({ id, label: id, cwd: project, projectPath: project, serverId: `pty_${id}`, taskId });
}

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
