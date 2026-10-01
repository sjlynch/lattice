import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { subscribeTerminalActivity } from '../api/terminals.ts';
import { useBusyAgentTerminals } from '../components/sidebar/hooks/useBusyAgentTerminals.ts';
import { SidebarTabsBar } from '../components/sidebar/SidebarTabsBar.tsx';
import type { TerminalSpec, TerminalStatus } from '../terminal/terminalTypes.ts';
import {
  FakeWebSocket, installFakeWebSocket, installGlobal, installManualTimers,
  installWindow, type ManualTimers,
} from './domDoubles.ts';

let timers: ManualTimers;
let restore: (() => void)[];
let unsubscribe: (() => void)[];

beforeEach(() => {
  timers = installManualTimers();
  restore = [timers.restore, installFakeWebSocket(),
    installWindow({ location: { protocol: 'http:', host: 'fixture.invalid' } }),
    installGlobal('React', React), installGlobal('IS_REACT_ACT_ENVIRONMENT', true)];
  unsubscribe = [];
});

afterEach(() => {
  for (const stop of unsubscribe.reverse()) stop();
  for (const cleanup of restore.reverse()) cleanup();
});

function socket(): FakeWebSocket {
  const current = FakeWebSocket.instances.at(-1);
  assert.ok(current);
  return current;
}

function activity(ws: FakeWebSocket, busy: unknown[]): void {
  ws.onmessage?.({ data: JSON.stringify({ type: 'terminal-activity', busy }) });
}

test('shared terminal activity clears on disconnect and never replays stale busy ids to late subscribers', () => {
  const first: string[][] = [];
  const second: string[][] = [];
  const late: string[][] = [];
  const stopFirst = subscribeTerminalActivity('/project', (ids) => first.push(ids));
  unsubscribe.push(stopFirst);
  const original = socket();
  original.serverAccept();
  activity(original, ['codex-session']);
  unsubscribe.push(subscribeTerminalActivity('/project', (ids) => second.push(ids)));
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(second, [['codex-session']], 'connected late joiner gets the current snapshot');

  original.serverDrop();
  assert.deepEqual(first.at(-1), []);
  assert.deepEqual(second.at(-1), []);
  unsubscribe.push(subscribeTerminalActivity('/project', (ids) => late.push(ids)));
  assert.deepEqual(late, [], 'disconnected channel cannot replay its old busy snapshot');

  stopFirst();
  timers.fireAll();
  const replacement = socket();
  assert.notEqual(replacement, original);
  replacement.serverAccept();
  activity(replacement, ['new-session']);
  assert.deepEqual(first, [['codex-session'], []], 'unsubscribed listener stays detached');
  assert.deepEqual(second.at(-1), ['new-session']);
  assert.deepEqual(late, [['new-session']]);
  activity(original, ['stale-session']);
  original.serverDrop();
  assert.deepEqual(second.at(-1), ['new-session']);
  assert.equal(timers.scheduled.length, 1, 'stale close cannot add another reconnect timer');
});

test('terminal activity normalizes duplicate and invalid ids and accepts an empty snapshot', () => {
  const updates: string[][] = [];
  unsubscribe.push(subscribeTerminalActivity('/normalize', (ids) => updates.push(ids)));
  activity(socket(), ['a', 'b']);
  activity(socket(), ['a', 'a', null, 4, '']);
  activity(socket(), []);
  assert.deepEqual(updates, [['a', 'b'], ['a'], []]);
});

test('busy hook resets on project change and disconnect while preserving unchanged set identity', async () => {
  const rendered: { project: string; ids: ReadonlySet<string> }[] = [];
  function Harness({ project }: { project: string }) {
    const ids = useBusyAgentTerminals(project);
    rendered.push({ project, ids });
    return null;
  }
  let root: ReturnType<typeof TestRenderer.create> | undefined;
  try {
    await act(async () => { root = TestRenderer.create(React.createElement(Harness, { project: '/a' })); });
    const original = socket();
    await act(async () => { activity(original, ['session-a']); });
    const stableIds = rendered.at(-1)?.ids;
    await act(async () => { activity(original, ['session-a']); });
    assert.equal(rendered.at(-1)?.ids, stableIds);

    const beforeSwitch = rendered.length;
    await act(async () => { root!.update(React.createElement(Harness, { project: '/b' })); });
    assert.ok(rendered.slice(beforeSwitch).every((frame) => frame.ids.size === 0),
      'even the first render of another project must not expose the previous snapshot');
    assert.equal(original.closed, true);
    await act(async () => { activity(original, ['stale']); });
    assert.equal(rendered.at(-1)?.ids.size, 0);

    const current = socket();
    await act(async () => { activity(current, ['session-b']); });
    assert.deepEqual([...rendered.at(-1)!.ids], ['session-b']);
    await act(async () => { current.serverDrop(); });
    assert.equal(rendered.at(-1)?.ids.size, 0);
    await act(async () => { root!.update(React.createElement(Harness, { project: '' })); });
    assert.equal(rendered.at(-1)?.ids.size, 0);
    assert.equal(timers.scheduled.length, 0);
  } finally {
    await act(async () => { root?.unmount(); });
  }
});

function renderTabs(terminal: TerminalSpec, busyServerIds: ReadonlySet<string>): string {
  const noop = () => {};
  return renderToStaticMarkup(React.createElement(SidebarTabsBar, {
    visibleTerminals: [terminal], filter: '', busyServerIds,
    activeId: null, setActiveId: noop, closeTerminal: noop, renameTerminal: noop,
    tabsRef: { current: null }, activeTabRef: { current: null },
    canScrollLeft: false, canScrollRight: false, scrollTabs: noop,
    handleTabContextMenu: noop, reorderTerminal: noop,
  }));
}

test('actual sidebar tabs suppress exited/dead spinners but preserve busy unopened tabs', () => {
  const terminal: TerminalSpec = { id: 'local', serverId: 'server', label: 'Codex', cwd: '/project' };
  const busy = new Set(['server']);
  for (const status of ['exited', 'dead'] satisfies TerminalStatus[]) {
    const html = renderTabs({ ...terminal, status }, busy);
    assert.doesNotMatch(html, /sidebar-tab-spinner/);
    assert.match(html, new RegExp(`sidebar-tab-status ${status}`));
  }
  assert.match(renderTabs(terminal, busy), /sidebar-tab-spinner/, 'unmounted tabs have no connection status');
  assert.match(renderTabs({ ...terminal, status: 'live' }, busy), /sidebar-tab-spinner/);
});

test('actual sidebar tabs match current serverId rather than local id or an earlier session', () => {
  const terminal: TerminalSpec = { id: 'local', serverId: 'new-session', label: 'Codex', cwd: '/project' };
  assert.doesNotMatch(renderTabs(terminal, new Set(['local', 'old-session'])), /sidebar-tab-spinner/);
  assert.match(renderTabs(terminal, new Set(['new-session'])), /sidebar-tab-spinner/);
  assert.doesNotMatch(renderTabs({ ...terminal, serverId: undefined }, new Set(['local'])), /sidebar-tab-spinner/);
});
