import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useGraphViewKeyboard } from '../components/forceGraph/hooks/useGraphViewKeyboard.ts';

// Regression: the graph's window-level Escape handler cleared the graph search
// and selection for an Escape typed into ANY text field — most visibly an agent
// terminal (xterm's helper textarea doesn't stop propagation), where Escape is
// how you interrupt the agent. Text fields outside the graph view must now be
// left alone; the graph's own fields (and non-text targets) still get it.

type KeyEvent = { key: string; target: unknown };
type Listener = (e: KeyEvent) => void;

function makeFakeWindow() {
  const listeners = new Set<Listener>();
  return {
    addEventListener(type: string, fn: Listener) {
      if (type === 'keydown') listeners.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      if (type === 'keydown') listeners.delete(fn);
    },
    dispatchKeydown(key: string, target: unknown) {
      for (const fn of [...listeners]) fn({ key, target });
    },
  };
}

function textarea(insideGraph: boolean) {
  return {
    tagName: 'TEXTAREA',
    isContentEditable: false,
    closest: (sel: string) => (insideGraph && sel === '.graph-view-root' ? {} : null),
  };
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let win: ReturnType<typeof makeFakeWindow>;

beforeEach(() => {
  saved = { IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT, window: g.window };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  win = makeFakeWindow();
  g.window = win;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

function mountKeyboard(searchQuery: string) {
  const calls = { setSearchQuery: 0, setSelected: 0 };
  function Harness() {
    useGraphViewKeyboard({
      contextMenu: null,
      setContextMenu: () => {},
      modalOpen: false,
      searchQuery,
      setSearchQuery: () => { calls.setSearchQuery += 1; },
      clearCurrentMatch: () => {},
      selectedRef: { current: new Set(['a']) },
      setSelected: () => { calls.setSelected += 1; },
    });
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  return { calls, renderer };
}

test('Escape in a text field outside the graph (agent terminal) leaves search + selection alone', () => {
  const { calls, renderer } = mountKeyboard('foo');
  win.dispatchKeydown('Escape', textarea(false));
  assert.deepEqual(calls, { setSearchQuery: 0, setSelected: 0 });
  act(() => renderer.unmount());
});

test('Escape on a non-text target still clears the search, then the selection', () => {
  const withQuery = mountKeyboard('foo');
  win.dispatchKeydown('Escape', null);
  assert.equal(withQuery.calls.setSearchQuery, 1);
  act(() => withQuery.renderer.unmount());

  const noQuery = mountKeyboard('');
  win.dispatchKeydown('Escape', { tagName: 'CANVAS' });
  assert.equal(noQuery.calls.setSelected, 1);
  act(() => noQuery.renderer.unmount());
});

test('Escape in a text field inside the graph view still reaches the handler', () => {
  const { calls, renderer } = mountKeyboard('');
  win.dispatchKeydown('Escape', textarea(true));
  assert.equal(calls.setSelected, 1);
  act(() => renderer.unmount());
});
