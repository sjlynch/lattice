import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { TerminalSpec } from '../terminal/terminalTypes.ts';
import { SidebarPanes } from '../components/sidebar/SidebarPanes.tsx';
import { installGlobal } from './domDoubles.ts';

// Regression: Sidebar swapped the whole pane list out for the empty-panel
// message whenever the VIEWED panel had no tabs. With only startup tabs, a
// `switchPanel('terminals')` therefore unmounted every mounted TerminalPane in
// the project — the force-mounted startup panes included (WS closed, xterm
// disposed, ~2 MB scrollback replay on return; a serverless pane that had not
// received its `attached` frame yet reconnected as a SECOND pty). The pane
// list is now rendered unconditionally with the empty state as a sibling.

const P = 'C:/proj';

const startup: TerminalSpec = {
  id: 's1', label: 'dev', cwd: P, projectPath: P, kind: 'startup', startupId: 'dev',
  initialCommand: 'npm run dev', serverId: 'srv_s1', registered: true,
};

// Stand-in for TerminalPane (which imports xterm's CSS at module scope and
// cannot load under node:test): counts mounts and unmounts per tab.
const mounts: string[] = [];
const unmounts: string[] = [];
function StubPane({ id }: { id: string }) {
  useEffect(() => {
    mounts.push(id);
    return () => { unmounts.push(id); };
  }, [id]);
  return React.createElement('div', { className: 'stub-pane', 'data-id': id });
}

// The `.sidebar-pane` wrapper div's className (there is exactly one tab).
function paneWrapperClass(renderer: ReturnType<typeof TestRenderer.create>): string {
  const wrappers = renderer.root.findAll(
    (n) => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.startsWith('sidebar-pane'),
  );
  assert.equal(wrappers.length, 1, 'one pane wrapper');
  return wrappers[0].props.className as string;
}

function tree(panel: 'terminals' | 'startup') {
  return React.createElement(SidebarPanes, {
    activePanel: panel,
    activeFolder: P,
    projectTerminals: [startup],
    // Terminals panel: no regular tabs (empty), only the startup tab exists.
    panelTerminals: panel === 'startup' ? [startup] : [],
    // switchPanel clears activeId when the target panel is empty.
    activeId: panel === 'startup' ? startup.id : null,
    mountedIds: new Set([startup.id]),
    renderPane: (t) => React.createElement(StubPane, { key: t.id, id: t.id }),
  });
}

test('switching to an empty panel keeps the other panels\' mounted panes in the tree', () => {
  const restoreReact = installGlobal('React', React);
  const restoreActEnv = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let renderer!: ReturnType<typeof TestRenderer.create>;
  try {
    act(() => {
      renderer = TestRenderer.create(tree('startup'));
    });
    assert.deepEqual(mounts, ['s1'], 'the force-mounted startup pane mounts once');
    assert.equal(renderer.root.findAllByProps({ className: 'sidebar-empty' }).length, 0);

    // The Terminals panel is empty: the empty state shows, the startup pane
    // is hidden — but stays mounted.
    act(() => {
      renderer.update(tree('terminals'));
    });
    assert.equal(renderer.root.findAllByProps({ className: 'sidebar-empty' }).length, 1, 'empty state shown');
    assert.equal(renderer.root.findAllByType(StubPane).length, 1, 'pane still in the tree');
    assert.equal(paneWrapperClass(renderer), 'sidebar-pane hidden', 'the pane is hidden, not removed');
    assert.deepEqual(unmounts, [], 'no pane was unmounted by the panel switch');

    // Back to the Startup panel: the same pane instance, no remount.
    act(() => {
      renderer.update(tree('startup'));
    });
    assert.deepEqual(mounts, ['s1'], 'exactly one mount across the round trip');
    assert.deepEqual(unmounts, []);
    assert.equal(renderer.root.findAllByProps({ className: 'sidebar-empty' }).length, 0);
    assert.equal(paneWrapperClass(renderer), 'sidebar-pane ');
  } finally {
    act(() => renderer.unmount());
    restoreActEnv();
    restoreReact();
  }
});
