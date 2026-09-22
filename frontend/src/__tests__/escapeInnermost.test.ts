import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Task } from '../api';
import { useFloatingPanelEscape } from '../components/floatingPanel/hooks.ts';
import { useEscapeToClose } from '../components/shared/useEscapeToClose.ts';
import { ConfirmProvider } from '../components/shared/ConfirmDialog.tsx';
import { NewTaskOverlay } from '../components/taskboard/NewTaskOverlay.tsx';
import { TaskDetailOverlay } from '../components/taskboard/TaskDetailOverlay.tsx';
import { LANE_BY_ID } from '../components/taskboard/lanes.ts';

// Regression: one Escape must close only the innermost open layer. Before the
// fix every layer (task overlays, Modal, FloatingPanel) added its own
// bubble-phase `window` keydown listener and none stopped propagation, so an
// Escape in the task editor closed the overlay AND the board panel behind it.
//
// A minimal `window` double models the DOM's dispatch order for a keydown
// whose target sits inside the document: window capture listeners first, then
// (unless propagation was stopped) window bubble listeners. Listeners on the
// same target all run regardless of stopPropagation — which is exactly why a
// plain capture+stop on two stacked layers is not enough and the shared hook
// keeps a layer stack.

type Listener = (e: { key: string; target: unknown; stopPropagation: () => void; preventDefault: () => void }) => void;

function makeFakeWindow() {
  const capture = new Set<Listener>();
  const bubble = new Set<Listener>();
  const bucket = (opts: unknown) =>
    opts === true || (typeof opts === 'object' && opts !== null && (opts as { capture?: boolean }).capture)
      ? capture
      : bubble;
  return {
    addEventListener(type: string, fn: Listener, opts?: unknown) {
      if (type === 'keydown') bucket(opts).add(fn);
    },
    removeEventListener(type: string, fn: Listener, opts?: unknown) {
      if (type === 'keydown') bucket(opts).delete(fn);
    },
    // `target` defaults to document.body — a keydown with nothing focused.
    dispatchKeydown(key: string, target: unknown = (g.document as { body: unknown }).body) {
      let stopped = false;
      const e = { key, target, stopPropagation: () => { stopped = true; }, preventDefault: () => {} };
      for (const fn of [...capture]) fn(e);
      if (stopped) return;
      for (const fn of [...bubble]) fn(e);
    },
  };
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let win: ReturnType<typeof makeFakeWindow>;

beforeEach(() => {
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    window: g.window,
    document: g.document,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  win = makeFakeWindow();
  g.window = win;
  g.document = {
    body: { tag: 'body' },
    documentElement: { tag: 'html' },
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    contains: () => false,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

// Stand-in for the FloatingPanel chrome: the real bubble-phase Escape hook.
function Panel({
  onClose,
  children,
  el = {},
}: {
  onClose: () => void;
  children?: React.ReactNode;
  el?: object;
}) {
  const ref = React.useRef(el as HTMLElement);
  useFloatingPanelEscape(true, onClose, ref);
  return React.createElement(React.Fragment, null, children);
}

// A keydown target that sits inside `panel` (models Element.closest).
const insidePanel = (panel: object) => ({
  closest: (sel: string) => (sel === '.floating-panel' ? panel : null),
});

function Layer({ onClose }: { onClose: () => void }) {
  useEscapeToClose(true, onClose);
  return null;
}

function mount(el: React.ReactElement) {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(el);
  });
  return renderer;
}

test('Escape in the new-task overlay closes the overlay, not the board panel', () => {
  let panelClosed = 0;
  let overlayClosed = 0;
  const renderer = mount(
    React.createElement(
      Panel,
      { onClose: () => { panelClosed += 1; } },
      React.createElement(NewTaskOverlay, {
        lane: LANE_BY_ID.open,
        onSubmit: () => {},
        onCancel: () => { overlayClosed += 1; },
      }),
    ),
  );

  act(() => win.dispatchKeydown('Escape'));
  assert.equal(overlayClosed, 1);
  assert.equal(panelClosed, 0, 'the panel behind the overlay must not close');

  // Other keys pass through untouched.
  act(() => win.dispatchKeydown('Enter'));
  assert.equal(overlayClosed, 1);
  assert.equal(panelClosed, 0);

  act(() => renderer.unmount());
});

test('Escape in the task detail overlay closes only the overlay', () => {
  const task: Task = {
    id: 't1',
    projectPath: 'C:/proj',
    title: 'Original title',
    description: 'Original description',
    status: 'open',
    createdAt: 0,
  };
  let panelClosed = 0;
  let overlayClosed = 0;
  const renderer = mount(
    React.createElement(
      ConfirmProvider,
      null,
      React.createElement(
        Panel,
        { onClose: () => { panelClosed += 1; } },
        React.createElement(TaskDetailOverlay, {
          task,
          onClose: () => { overlayClosed += 1; },
          onMove: () => {},
          onDelete: () => {},
          onSave: async () => true,
        }),
      ),
    ),
  );

  act(() => win.dispatchKeydown('Escape'));
  assert.equal(overlayClosed, 1);
  assert.equal(panelClosed, 0);

  act(() => renderer.unmount());
});

test('with no overlay open, Escape still reaches the panel', () => {
  let panelClosed = 0;
  const renderer = mount(
    React.createElement(Panel, { onClose: () => { panelClosed += 1; } }),
  );
  act(() => win.dispatchKeydown('Escape'));
  assert.equal(panelClosed, 1);
  act(() => renderer.unmount());
});

test('two stacked layers: only the top one closes, then the next takes over', () => {
  let outer = 0;
  let inner = 0;
  function Stack({ showInner }: { showInner: boolean }) {
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(Layer, { key: 'outer', onClose: () => { outer += 1; } }),
      showInner ? React.createElement(Layer, { key: 'inner', onClose: () => { inner += 1; } }) : null,
    );
  }
  const renderer = mount(React.createElement(Stack, { showInner: true }));

  act(() => win.dispatchKeydown('Escape'));
  assert.equal(inner, 1);
  assert.equal(outer, 0, 'the layer underneath must not close');

  // Inner layer goes away (e.g. the confirm dialog settled) → the outer layer
  // is the innermost again.
  act(() => renderer.update(React.createElement(Stack, { showInner: false })));
  act(() => win.dispatchKeydown('Escape'));
  assert.equal(inner, 1);
  assert.equal(outer, 1);

  act(() => renderer.unmount());
});

test('two open FloatingPanels: one Escape closes only the panel it was pressed in', () => {
  const a = { name: 'board' };
  const b = { name: 'settings' };
  let closedA = 0;
  let closedB = 0;
  const renderer = mount(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Panel, { key: 'a', el: a, onClose: () => { closedA += 1; } }),
      React.createElement(Panel, { key: 'b', el: b, onClose: () => { closedB += 1; } }),
    ),
  );

  // Pressed inside the older panel: only that one closes.
  act(() => win.dispatchKeydown('Escape', insidePanel(a)));
  assert.equal(closedA, 1);
  assert.equal(closedB, 0);

  // Nothing focused: only the most recently opened panel closes.
  act(() => win.dispatchKeydown('Escape'));
  assert.equal(closedA, 1);
  assert.equal(closedB, 1);

  // Focus in some control outside every panel (e.g. a terminal): none close.
  act(() => win.dispatchKeydown('Escape', { closest: () => null }));
  assert.equal(closedA, 1);
  assert.equal(closedB, 1);

  act(() => renderer.unmount());
});
