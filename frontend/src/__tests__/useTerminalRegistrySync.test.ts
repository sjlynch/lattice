import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TerminalsProvider, useTerminals } from '../TerminalsContext.tsx';
import type { Ctx, TerminalSpec } from '../terminal/terminalTypes';
import type { RestoreSummary, RestoreTerminalsMode, TerminalRecord, TerminalTabsEvent } from '../api/types/terminalTabs';
import { terminalBelongsToProject } from '../terminal/terminalScope.ts';
import { SidebarPanes } from '../components/sidebar/SidebarPanes.tsx';
import { useMountedTerminalIds } from '../components/sidebar/hooks/useMountedTerminalIds.ts';
import type { Panel } from '../components/sidebar/hooks/usePanelState';
import { FakeWebSocket, installFakeWebSocket, installGlobal } from './domDoubles.ts';

const P = 'C:/proj';
const OTHER = 'C:/other';

function rec(over: Partial<TerminalRecord> & { id: string }): TerminalRecord {
  return {
    projectPath: P, cwd: P, label: over.id, order: 0, owner: 'user',
    launch: { initialCommand: 'claude', harness: 'claude' },
    serverId: `srv_${over.id}`, createdAt: 1, updatedAt: 1, ...over,
  };
}

function spec(over: Partial<TerminalSpec> & { id: string }): TerminalSpec {
  return { label: over.id, cwd: P, projectPath: P, registered: true, ...over };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function summary(ids: string[]): RestoreSummary {
  return { status: 'ok', adopted: 0, queued: ids.length, dropped: [], relaunchedIds: ids };
}

// Render the real provider/hook and Sidebar's mounting gates. Only HTTP, WS
// and the xterm pane are doubles; acknowledgements stay deferred until after
// registry events have committed.
function harness(initial: TerminalSpec[] = [], restoreMode: RestoreTerminalsMode = 'never') {
  const requests: { url: URL; method: string; reply: ReturnType<typeof deferred<Response>> }[] = [];
  const store = new Map([['lattice.terminals', JSON.stringify({ terminals: initial, activeId: initial[0]?.id ?? null })]]);
  const restores = [
    installGlobal('React', React),
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('window', { location: { protocol: 'http:', host: 'localhost:5183' } }),
    installGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    }),
    installFakeWebSocket(),
    installGlobal('fetch', (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost:5183');
      const method = init?.method ?? 'GET';
      if ((url.pathname === '/api/terminal-tabs' && method === 'GET') ||
        url.pathname === '/api/terminal-tabs/restore' ||
        (url.pathname.startsWith('/api/terminal-tabs/') && method === 'DELETE')) {
        const reply = deferred<Response>();
        requests.push({ url, method, reply });
        return reply.promise;
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }),
  ];
  const mounts: (string | undefined)[] = [];
  const unmounts: (string | undefined)[] = [];
  let ctx!: Ctx;
  let mountedIds!: ReadonlySet<string>;
  let currentFolder = P;
  let activePanel: Panel = 'terminals';
  let renderer!: ReturnType<typeof TestRenderer.create>;
  function Pane({ terminal }: { terminal: TerminalSpec }) {
    useEffect(() => {
      mounts.push(terminal.serverId);
      return () => { unmounts.push(terminal.serverId); };
    }, []);
    return React.createElement('span', { 'data-pty': terminal.serverId, 'data-tab': terminal.id });
  }
  function Probe({ folder }: { folder: string }) {
    ctx = useTerminals();
    const terminals = ctx.terminals.filter((t) => terminalBelongsToProject(t, folder));
    const startupTerminals = terminals.filter((t) => t.kind === 'startup');
    mountedIds = useMountedTerminalIds(ctx.activeId, startupTerminals, terminals, ctx.terminals);
    const panelTerminals = terminals.filter((t) => activePanel === 'startup' ? t.kind === 'startup'
      : activePanel === 'merging' ? t.kind === 'merge' : !t.kind);
    return React.createElement(SidebarPanes, {
      activePanel, activeFolder: folder, projectTerminals: terminals,
      panelTerminals, activeId: ctx.activeId, mountedIds,
      renderPane: (terminal) => React.createElement(Pane, { key: `${terminal.id}:${terminal.relaunchNonce ?? 0}`, terminal }),
    });
  }
  function tree(folder: string) {
    return React.createElement(TerminalsProvider, {
      activeFolder: folder, restoreMode, children: React.createElement(Probe, { folder }),
    });
  }
  act(() => { renderer = TestRenderer.create(tree(P)); });
  return {
    get ctx() { return ctx; },
    get mountedIds() { return mountedIds; },
    get paneIds() { return renderer.root.findAllByType('span').map((pane) => pane.props['data-tab']); },
    mounts, unmounts, requests,
    socket(folder = P) {
      const socket = FakeWebSocket.instances.filter((s) => new URL(s.url).searchParams.get('project') === folder).at(-1);
      assert.ok(socket, `registry socket for ${folder}`);
      return socket;
    },
    emit(ev: TerminalTabsEvent, socket?: FakeWebSocket) {
      const target = socket ?? this.socket();
      act(() => { target.onmessage?.({ data: JSON.stringify(ev) }); });
    },
    request(path: string, folder = P, index = 0) {
      const request = requests.filter((r) => r.url.pathname === path && r.url.searchParams.get('project') === folder)[index];
      assert.ok(request, `${path} request ${index} for ${folder}`);
      return request;
    },
    async answer(request: (typeof requests)[number], body: unknown, status = 200) {
      await act(async () => { request.reply.resolve(new Response(JSON.stringify(body), { status })); });
    },
    switchTo(folder: string) {
      currentFolder = folder;
      act(() => { renderer.update(tree(folder)); });
    },
    switchPanel(panel: Panel) {
      activePanel = panel;
      act(() => { renderer.update(tree(currentFolder)); });
    },
    dispose() {
      act(() => { renderer.unmount(); });
      for (const restore of restores.reverse()) restore();
    },
  };
}

test('mount history stays bounded while viewed, startup and fallback tabs are repeatedly removed', async () => {
  const h = harness();
  try {
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [] });
    for (let i = 0; i < 10; i++) {
      const viewed = `viewed_${i}`;
      const startup = `startup_${i}`;
      const fallback = `fallback_${i}`;
      const lazy = `lazy_${i}`;
      act(() => {
        h.ctx.addTerminal(spec({ id: viewed, serverId: `srv_${viewed}` }));
        h.ctx.addTerminal(spec({ id: startup, kind: 'startup', serverId: `srv_${startup}` }), false);
        h.ctx.addTerminal(spec({ id: fallback, registered: false }), false);
        h.ctx.addTerminal(spec({ id: lazy, serverId: `srv_${lazy}` }), false);
      });
      assert.deepEqual(h.mountedIds, new Set([viewed, startup, fallback]));
      const beforeRemoval = h.mountedIds;

      h.emit({ type: 'removed', projectPath: P, id: viewed });
      assert.equal(h.ctx.activeId, viewed, 'the registry removes the tab before selection reconciles');
      assert.ok(!h.ctx.terminals.some((t) => t.id === viewed));
      assert.deepEqual(h.mountedIds, new Set([startup, fallback]), 'a stale activeId cannot reinsert the retired id');
      assert.deepEqual(beforeRemoval, new Set([viewed, startup, fallback]), 'published sets stay immutable');

      h.emit({ type: 'ended', projectPath: P, id: startup, ended: { at: 2, reason: 'closed' } });
      h.emit({ type: 'removed', projectPath: P, id: lazy });
      act(() => { h.ctx.closeTerminal(fallback); });
      assert.deepEqual(h.ctx.terminals, []);
      assert.deepEqual(h.mountedIds, new Set(), 'closed ids do not accumulate across cycles');
      act(() => { h.ctx.setActiveId(null); });
    }
    act(() => { h.ctx.setActiveId('already-removed'); });
    assert.deepEqual(h.mountedIds, new Set(), 'changing to an absent activeId cannot add it');
  } finally { h.dispose(); }
});

test('mount history keeps its identity when terminal decorations or unviewed membership change', () => {
  const h = harness([spec({ id: 'viewed', serverId: 'srv_viewed' })]);
  try {
    const mountedIds = h.mountedIds;
    act(() => { h.ctx.setStatus('viewed', 'live'); });
    assert.strictEqual(h.mountedIds, mountedIds);
    act(() => { h.ctx.addTerminal(spec({ id: 'unviewed', serverId: 'srv_unviewed' }), false); });
    assert.strictEqual(h.mountedIds, mountedIds, 'pre-spawned tabs stay lazy until viewed');
    h.emit({ type: 'removed', projectPath: P, id: 'unviewed' });
    assert.strictEqual(h.mountedIds, mountedIds, 'removing an unviewed tab does not change history');
    assert.deepEqual(h.mountedIds, new Set(['viewed']));
  } finally { h.dispose(); }
});

test('surviving tabs keep remembered activation across panels and A -> B -> A', () => {
  const h = harness([
    spec({ id: 'a', serverId: 'srv_a' }),
    spec({ id: 'lazy', serverId: 'srv_lazy' }),
    spec({ id: 'startup', kind: 'startup', serverId: 'srv_startup' }),
    spec({ id: 'b', projectPath: OTHER, cwd: OTHER, serverId: 'srv_b' }),
  ]);
  try {
    const initial = h.mountedIds;
    assert.deepEqual(initial, new Set(['a', 'startup']));
    act(() => { h.ctx.setActiveId(null); });
    h.switchPanel('startup');
    assert.strictEqual(h.mountedIds, initial, 'hidden regular tabs retain their viewed status');
    h.switchPanel('merging');
    assert.strictEqual(h.mountedIds, initial, 'an empty panel does not retire any ids');
    assert.deepEqual(h.paneIds, ['a', 'startup']);
    h.switchPanel('terminals');
    h.switchTo(OTHER);
    assert.strictEqual(h.mountedIds, initial, 'leaving a project does not retire its tabs');
    assert.deepEqual(h.paneIds, [], 'the other project remains lazy until viewed');
    act(() => { h.ctx.setActiveId('b'); });
    const bothProjects = h.mountedIds;
    assert.deepEqual(bothProjects, new Set(['a', 'startup', 'b']));
    act(() => { h.ctx.setActiveId(null); });
    h.switchTo(P);
    assert.strictEqual(h.mountedIds, bothProjects);
    assert.deepEqual(h.paneIds, ['a', 'startup'], 'returning to A mounts surviving viewed tabs without reactivation');
    assert.equal(h.mounts.filter((id) => id === 'srv_a').length, 2);
    assert.ok(!h.mountedIds.has('lazy'));
  } finally { h.dispose(); }
});

test('pending and failed registered closes retain mount history until removal is confirmed', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_a' })]);
  try {
    const mountedIds = h.mountedIds;
    act(() => { h.ctx.closeTerminal('a'); });
    assert.equal(h.ctx.terminals[0]?.closeState, 'closing');
    assert.strictEqual(h.mountedIds, mountedIds);
    assert.deepEqual(h.paneIds, ['a']);
    await h.answer(h.request('/api/terminal-tabs/a'), { error: 'kill unconfirmed' }, 503);
    assert.equal(h.ctx.terminals[0]?.closeState, 'failed');
    assert.equal(h.ctx.terminals[0]?.serverId, 'srv_a');
    assert.strictEqual(h.mountedIds, mountedIds);
    assert.deepEqual(h.paneIds, ['a']);
    assert.deepEqual(h.unmounts, []);
    act(() => { h.ctx.closeTerminal('a'); });
    assert.strictEqual(h.mountedIds, mountedIds);
    await h.answer(h.request('/api/terminal-tabs/a', P, 1), { ok: true });
    assert.deepEqual(h.ctx.terminals, []);
    assert.deepEqual(h.mountedIds, new Set());
    assert.deepEqual(h.unmounts, ['srv_a']);
  } finally { h.dispose(); }
});

test('startup and fallback mounting preserve pending and failed restore gates', () => {
  const h = harness([
    spec({ id: 'active', serverId: 'srv_active' }),
    spec({ id: 'lazy', serverId: 'srv_lazy' }),
    spec({ id: 'startup', kind: 'startup', serverId: 'srv_startup' }),
    spec({ id: 'fallback', registered: false }),
    spec({ id: 'pending', restore: 'pending' }),
    spec({ id: 'failed', restore: 'failed' }),
    spec({ id: 'startup-pending', kind: 'startup', restore: 'pending' }),
    spec({ id: 'startup-failed', kind: 'startup', restore: 'failed' }),
  ]);
  try {
    assert.deepEqual(h.mountedIds, new Set(['active', 'startup', 'fallback', 'startup-pending', 'startup-failed']));
    assert.deepEqual(h.paneIds, ['active', 'startup', 'fallback']);
    const mountedIds = h.mountedIds;
    act(() => { h.ctx.setServerId('fallback', 'srv_fallback'); });
    assert.strictEqual(h.mountedIds, mountedIds, 'capturing a fallback pty preserves its mount history');
    assert.deepEqual(h.unmounts, [], 'capturing a fallback pty does not recreate its pane');
    for (const id of ['pending', 'failed']) {
      act(() => { h.ctx.setActiveId(id); });
      assert.ok(h.mountedIds.has(id), 'activation is remembered while restore gates the pane');
      assert.deepEqual(h.paneIds, ['active', 'startup', 'fallback']);
    }
    act(() => { h.ctx.setActiveId(null); });
    const beforeRestore = h.mountedIds;
    h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'pending' }) });
    assert.strictEqual(h.mountedIds, beforeRestore);
    assert.deepEqual(h.paneIds, ['active', 'startup', 'fallback', 'pending'], 'a surviving viewed tab mounts once restore succeeds');
    assert.ok(!h.mountedIds.has('lazy'));
  } finally { h.dispose(); }
});

for (const eventType of ['upsert', 'restored'] as const) {
  test(`a ${eventType} WS event before the restore acknowledgement keeps the new pty mounted`, async () => {
    const h = harness([spec({ id: 'a', serverId: 'srv_old', status: 'dead' })]);
    try {
      await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
      let restoring!: Promise<RestoreSummary | null>;
      act(() => { restoring = h.ctx.restoreTabs(); });
      h.emit({ type: 'upsert', projectPath: P, record: rec({ id: 'a', serverId: 'srv_new', label: 'new label' }) });
      if (eventType === 'restored') {
        h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new', label: 'new label' }) });
      }
      act(() => { h.ctx.setStatus('a', 'live'); });
      const current = h.ctx.terminals[0];
      assert.equal(current?.relaunchNonce, 1);
      assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
      await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
      await restoring;
      assert.strictEqual(h.ctx.terminals[0], current);
      assert.equal(h.ctx.terminals[0]?.status, 'live');
      assert.equal(h.ctx.terminals[0]?.restore, undefined);
      assert.deepEqual(h.unmounts, ['srv_old'], 'the new pane stays mounted after the acknowledgement');
    } finally { h.dispose(); }
  });
}

test('restore failure or removal before an acknowledgement remains authoritative', async () => {
  const h = harness([spec({ id: 'failed', serverId: 'srv_failed' }), spec({ id: 'removed', serverId: 'srv_removed' })]);
  try {
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'failed' }), rec({ id: 'removed' })] });
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    h.emit({ type: 'restore-failed', projectPath: P, id: 'failed', reason: 'no capacity' });
    h.emit({ type: 'ended', projectPath: P, id: 'removed', ended: { at: 2, reason: 'closed' } });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['failed', 'removed']));
    await restoring;
    assert.deepEqual(h.ctx.terminals.map((t) => t.id), ['failed']);
    assert.equal(h.ctx.terminals[0]?.restore, 'failed');
    assert.equal(h.ctx.terminals[0]?.restoreReason, 'no capacity');
    assert.equal(h.ctx.terminals[0]?.serverId, undefined);
    assert.deepEqual(h.mounts, ['srv_failed'], 'failed tabs never mount a serverless pane');
  } finally { h.dispose(); }
});

test('a restore acknowledgement still marks genuinely queued tabs pending when WS events were missed', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
    await restoring;
    assert.equal(h.ctx.terminals[0]?.restore, 'pending');
    assert.equal(h.ctx.terminals[0]?.serverId, undefined);
    assert.equal(h.ctx.terminals[0]?.restored, true);
    assert.deepEqual(h.unmounts, ['srv_old']);
    assert.deepEqual(h.mounts, ['srv_old']);
    h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new' }) });
    assert.equal(h.ctx.terminals[0]?.restore, undefined);
    assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
  } finally { h.dispose(); }
});

test('a queue acknowledgement also supersedes an older list when no WS event arrived', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
    await restoring;
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    assert.equal(h.ctx.terminals[0]?.serverId, undefined);
    assert.equal(h.ctx.terminals[0]?.restore, 'pending');
    assert.deepEqual(h.mounts, ['srv_old']);
  } finally { h.dispose(); }
});

test('a hello during restore protects new ptys and failures while the summary queues an unchanged stale pty', async () => {
  const h = harness([
    spec({ id: 'restored', serverId: 'srv_old' }),
    spec({ id: 'failed', restore: 'pending' }),
    spec({ id: 'queued', serverId: 'srv_stale' }),
  ]);
  try {
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    h.emit({ type: 'hello', tabs: [
      rec({ id: 'restored', serverId: 'srv_new' }),
      rec({ id: 'failed', serverId: undefined, ended: { at: 2, reason: 'restore-failed', detail: 'boom' } }),
      rec({ id: 'queued', serverId: 'srv_stale' }),
    ] });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['restored', 'failed', 'queued']));
    await restoring;
    assert.equal(h.ctx.terminals.find((t) => t.id === 'restored')?.serverId, 'srv_new');
    assert.equal(h.ctx.terminals.find((t) => t.id === 'failed')?.restoreReason, 'restore-failed: boom');
    assert.equal(h.ctx.terminals.find((t) => t.id === 'queued')?.restore, 'pending');
    assert.equal(h.ctx.terminals.find((t) => t.id === 'queued')?.serverId, undefined);
    assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
    assert.deepEqual(h.unmounts, ['srv_old']);
  } finally { h.dispose(); }
});

test('restores remain single-flighted in a project and explicit retry requests still reach the backend', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    let first!: Promise<RestoreSummary | null>;
    let repeated!: Promise<RestoreSummary | null>;
    let retry!: Promise<RestoreSummary | null>;
    act(() => {
      first = h.ctx.restoreTabs();
      repeated = h.ctx.restoreTabs();
      retry = h.ctx.restoreTabs({ retry: true });
    });
    assert.equal(h.requests.filter((r) => r.url.pathname.endsWith('/restore')).length, 2);
    const explicit = h.request('/api/terminal-tabs/restore', P, 1);
    assert.equal(explicit.url.searchParams.get('retry'), '1');
    await h.answer(explicit, { ...summary([]), status: 'already-running' });
    await retry;
    assert.equal(h.ctx.lastRestore?.summary.status, 'already-running');
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
    assert.deepEqual(await first, await repeated);
    assert.equal(h.ctx.terminals[0]?.restore, 'pending');
  } finally { h.dispose(); }
});

for (const hello of [false, true]) {
  test(`late list preserves new pty, failures, removals and remote additions (${hello ? 'with' : 'without'} hello)`, async () => {
    const h = harness([
      spec({ id: 'a', serverId: 'srv_old', status: 'dead' }),
      spec({ id: 'removed', serverId: 'srv_removed' }),
      spec({ id: 'failed', serverId: 'srv_failed' }),
      spec({ id: 'foreign', projectPath: OTHER, cwd: OTHER, serverId: 'srv_foreign' }),
    ]);
    try {
      const old = [rec({ id: 'a', serverId: 'srv_old' }), rec({ id: 'removed' }), rec({ id: 'failed' })];
      if (hello) h.emit({ type: 'hello', tabs: old });
      h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new', label: 'updated label' }) });
      h.emit({ type: 'removed', projectPath: P, id: 'removed' });
      h.emit({ type: 'ended', projectPath: P, id: 'failed', ended: { at: 2, reason: 'restore-failed', detail: 'boom' } });
      h.emit({ type: 'upsert', projectPath: P, record: rec({ id: 'remote' }) });
      act(() => { h.ctx.setStatus('a', 'live'); });
      const current = h.ctx.terminals.find((t) => t.id === 'a');
      await h.answer(h.request('/api/terminal-tabs'), { tabs: old });
      assert.strictEqual(h.ctx.terminals.find((t) => t.id === 'a'), current);
      assert.equal(current?.label, 'updated label');
      assert.equal(current?.serverId, 'srv_new');
      assert.equal(current?.relaunchNonce, 1);
      assert.ok(h.ctx.terminals.some((t) => t.id === 'remote'));
      assert.ok(h.ctx.terminals.some((t) => t.id === 'foreign'));
      assert.ok(!h.ctx.terminals.some((t) => t.id === 'removed'));
      assert.equal(h.ctx.terminals.find((t) => t.id === 'failed')?.restoreReason, 'restore-failed: boom');
      assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
      assert.deepEqual(h.unmounts, ['srv_old']);
    } finally { h.dispose(); }
  });
}

test('a newer hello supersedes the entire old list, including records it omitted', async () => {
  const h = harness();
  try {
    h.emit({ type: 'hello', tabs: [rec({ id: 'remote' })] });
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'obsolete' })] });
    assert.deepEqual(h.ctx.terminals.map((t) => t.id), ['remote']);
  } finally { h.dispose(); }
});

test('local registered additions during the list fetch remain protected', async () => {
  const h = harness();
  try {
    act(() => { h.ctx.addTerminal(spec({ id: 'local', serverId: 'srv_local' }), false); });
    h.emit({ type: 'hello', tabs: [] });
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [] });
    assert.deepEqual(h.ctx.terminals.map((t) => t.id), ['local']);
  } finally { h.dispose(); }
});

test('hello can trigger auto-restore before the initial list resolves, without either response reverting success', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })], 'always');
  try {
    h.emit({ type: 'hello', tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    const restore = h.request('/api/terminal-tabs/restore');
    h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new' }) });
    await h.answer(restore, summary(['a']));
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    assert.equal(h.ctx.terminals[0]?.serverId, 'srv_new');
    assert.equal(h.ctx.terminals[0]?.restore, undefined);
    assert.equal(h.requests.filter((r) => r.url.pathname.endsWith('/restore')).length, 1);
  } finally { h.dispose(); }
});

test('project switches fence stale list, restore and socket callbacks, including A -> B -> A', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    const firstList = h.request('/api/terminal-tabs');
    const firstSocket = h.socket();
    let oldRestore!: Promise<RestoreSummary | null>;
    act(() => { oldRestore = h.ctx.restoreTabs(); });
    const firstRestore = h.request('/api/terminal-tabs/restore');
    h.switchTo(OTHER);
    h.emit({ type: 'hello', tabs: [rec({ id: 'b', projectPath: OTHER, cwd: OTHER })] }, h.socket(OTHER));
    let otherRestore!: Promise<RestoreSummary | null>;
    act(() => { otherRestore = h.ctx.restoreTabs(); });
    const secondRestore = h.request('/api/terminal-tabs/restore', OTHER);
    h.switchTo(P);
    h.emit({ type: 'hello', tabs: [rec({ id: 'a', serverId: 'srv_new' })] });
    let currentRestore!: Promise<RestoreSummary | null>;
    act(() => { currentRestore = h.ctx.restoreTabs(); });
    const currentRequest = h.request('/api/terminal-tabs/restore', P, 1);
    const current = h.ctx.terminals.find((t) => t.id === 'a');
    h.emit({ type: 'removed', projectPath: P, id: 'a' }, firstSocket);
    await h.answer(firstList, { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    await h.answer(firstRestore, summary(['a']));
    await oldRestore;
    await h.answer(secondRestore, summary(['b']));
    await otherRestore;
    assert.strictEqual(h.ctx.terminals.find((t) => t.id === 'a'), current);
    assert.equal(h.ctx.terminals.find((t) => t.id === 'b')?.serverId, 'srv_b');
    assert.equal(h.ctx.lastRestore, null, 'old visits cannot publish restore notices');
    await h.answer(currentRequest, { ...summary([]), adopted: 1 });
    await currentRestore;
  } finally { h.dispose(); }
});
