// Shared builders + the render harness for the useTerminalRegistrySync suites,
// split by behaviour across useTerminalRegistrySync.{mountHistory,restore,
// lateList,projectSwitch}.test.ts. `rec` builds a backend TerminalRecord,
// `spec` a registered frontend TerminalSpec (both in project P), `summary` a
// restore acknowledgement; `harness(initial, restoreMode)` is described below.
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

export const P = 'C:/proj';
export const OTHER = 'C:/other';

export function rec(over: Partial<TerminalRecord> & { id: string }): TerminalRecord {
  return {
    projectPath: P, cwd: P, label: over.id, order: 0, owner: 'user',
    launch: { initialCommand: 'claude', harness: 'claude' },
    serverId: `srv_${over.id}`, createdAt: 1, updatedAt: 1, ...over,
  };
}

export function spec(over: Partial<TerminalSpec> & { id: string }): TerminalSpec {
  return { label: over.id, cwd: P, projectPath: P, registered: true, ...over };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export function summary(ids: string[]): RestoreSummary {
  return { status: 'ok', adopted: 0, queued: ids.length, dropped: [], relaunchedIds: ids };
}

// Render the real provider/hook and Sidebar's mounting gates. Only HTTP, WS
// and the xterm pane are doubles; acknowledgements stay deferred until after
// registry events have committed.
export function harness(initial: TerminalSpec[] = [], restoreMode: RestoreTerminalsMode = 'never') {
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
