import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  isElementLike,
  panelHostFor,
  PanelHostProvider,
  usePanelDocument,
  usePanelWindow,
  type PanelHost,
} from '../hooks/usePanelDocument.ts';
import { activateFocusScope } from '../hooks/useFocusTrap.ts';
import { useEscapeToClose } from '../components/shared/useEscapeToClose.ts';
import { useFloatingPanelEscape } from '../components/floatingPanel/hooks.ts';
import { installGlobal } from './domDoubles.ts';

// A popped-out FloatingPanel's content lives in ANOTHER window, and the global
// `document` / `window` are always the main window's. Panel code reads its
// host through `usePanelDocument` / `usePanelWindow`; the shared Escape stacks
// listen in the window each layer is in now and only ever act on a key pressed
// in that window; moving a panel between windows re-targets the listener but
// keeps its place in the open order; focus scopes use the container's own
// document. Two hand-driven fake windows stand in for the main window and a
// pop-out.

type Key = { key: string; target: unknown; stopPropagation: () => void; preventDefault: () => void };
type Listener = (e: Key) => void;

function makeWindow(name: string) {
  const capture = new Set<Listener>();
  const bubble = new Set<Listener>();
  const isCapture = (opts: unknown) =>
    opts === true || (typeof opts === 'object' && opts !== null && !!(opts as { capture?: boolean }).capture);
  const doc = {
    name: `${name}.document`,
    body: { name: `${name}.body` },
    documentElement: { name: `${name}.html` },
    activeElement: null as unknown,
  };
  const win = {
    name,
    document: doc,
    addEventListener(type: string, fn: Listener, opts?: unknown) {
      if (type === 'keydown') (isCapture(opts) ? capture : bubble).add(fn);
    },
    removeEventListener(type: string, fn: Listener, opts?: unknown) {
      if (type === 'keydown') (isCapture(opts) ? capture : bubble).delete(fn);
    },
    listeners: () => capture.size + bubble.size,
    /** Capture listeners, then (unless stopped) bubble ones; target = body by default. */
    press(key: string, target: unknown = doc.body) {
      let stopped = false;
      const e: Key = { key, target, stopPropagation: () => { stopped = true; }, preventDefault: () => {} };
      for (const fn of [...capture]) fn(e);
      if (stopped) return;
      for (const fn of [...bubble]) fn(e);
    },
  };
  Object.assign(doc, { defaultView: win });
  return win;
}

type FakeWindow = ReturnType<typeof makeWindow>;
const hostOf = (win: FakeWindow) => ({ doc: win.document, win }) as unknown as PanelHost;

function withEnv(t: { after: (fn: () => void) => void }) {
  const main = makeWindow('main');
  const popout = makeWindow('popout');
  t.after(installGlobal('React', React));
  t.after(installGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  t.after(installGlobal('window', main));
  t.after(installGlobal('document', main.document));
  return { main, popout };
}

function mount(element: React.ReactElement) {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** Renders `children` in `win`'s panel host (null = no provider: the main window). */
const In = ({ win, children }: { win: FakeWindow | null; children?: React.ReactNode }) =>
  React.createElement(PanelHostProvider, { value: win ? hostOf(win) : null }, children);

test('outside any panel the globals; inside, the provided host', (t) => {
  const { main, popout } = withEnv(t);
  const seen: unknown[] = [];
  function Probe() {
    seen.push([usePanelDocument(), usePanelWindow()]);
    return null;
  }
  const r = mount(React.createElement(React.Fragment, null,
    React.createElement(Probe),
    React.createElement(In, { win: popout }, React.createElement(Probe))));
  assert.deepEqual(seen, [[main.document, main], [popout.document, popout]]);
  act(() => r.unmount());

  assert.deepEqual(panelHostFor(popout.document as unknown as Document), { doc: popout.document, win: popout });
  assert.equal(isElementLike({ closest: () => null }), true, 'a pop-out realm element');
  assert.equal(isElementLike({ name: 'text node' }), false);
  assert.equal(isElementLike(null), false);
});

function Layer({ onClose }: { onClose: () => void }) {
  useEscapeToClose(true, onClose);
  return null;
}

test('an Escape layer acts only on keys pressed in its own window', (t) => {
  const { main, popout } = withEnv(t);
  const closed: string[] = [];
  const r = mount(React.createElement(React.Fragment, null,
    React.createElement(Layer, { onClose: () => closed.push('main overlay') }),
    // Opened later (top of the stack overall), but in the pop-out.
    React.createElement(In, { win: popout }, React.createElement(Layer, { onClose: () => closed.push('popout overlay') }))));

  act(() => main.press('Escape'));
  assert.deepEqual(closed, ['main overlay'], "the pop-out's newer layer does not shadow the main window's");
  act(() => popout.press('Escape'));
  assert.deepEqual(closed, ['main overlay', 'popout overlay']);
  act(() => r.unmount());
  assert.equal(main.listeners() + popout.listeners(), 0);
});

test('moving a layer to a pop-out re-targets its listener and keeps its stack place', (t) => {
  const { main, popout } = withEnv(t);
  const closed: string[] = [];
  const tree = (firstIn: FakeWindow | null) => React.createElement(React.Fragment, null,
    React.createElement(In, { win: firstIn, key: 'first' }, React.createElement(Layer, { onClose: () => closed.push('first') })),
    React.createElement(In, { win: popout, key: 'second' }, React.createElement(Layer, { onClose: () => closed.push('second') })));
  const r = mount(tree(null));
  assert.equal(main.listeners(), 1);

  act(() => r.update(tree(popout))); // the first layer's panel popped out
  assert.equal(main.listeners(), 0, 'nothing left listening in the main window');
  act(() => popout.press('Escape'));
  assert.deepEqual(closed, ['second'], 'the later-opened layer is still the innermost');
  act(() => r.unmount());
});

function Panel({ el, win, onClose }: { el: object; win: FakeWindow; onClose: () => void }) {
  const ref = React.useRef(el as HTMLElement);
  useFloatingPanelEscape(true, onClose, ref, win as unknown as Window);
  return null;
}

test('panel Escape: "nothing focused" means the newest panel IN THAT WINDOW', (t) => {
  const { main, popout } = withEnv(t);
  const board = { name: 'board' };
  const fleet = { name: 'fleet' };
  const closed: string[] = [];
  const tree = (boardWin: FakeWindow) => React.createElement(React.Fragment, null,
    React.createElement(Panel, { key: 'board', el: board, win: boardWin, onClose: () => closed.push('board') }),
    React.createElement(Panel, { key: 'fleet', el: fleet, win: popout, onClose: () => closed.push('fleet') }));
  const r = mount(tree(main));

  act(() => main.press('Escape'));
  assert.deepEqual(closed, ['board'], 'Fleet opened later, but it is in the pop-out');
  act(() => popout.press('Escape'));
  assert.deepEqual(closed, ['board', 'fleet']);
  act(() => main.press('Escape', { closest: (s: string) => (s === '.floating-panel' ? fleet : null) }));
  assert.deepEqual(closed, ['board', 'fleet'], 'a panel element from another window never matches');

  // The board pops out too: it keeps its (older) place in the open order.
  act(() => r.update(tree(popout)));
  act(() => popout.press('Escape'));
  assert.deepEqual(closed, ['board', 'fleet', 'fleet']);
  act(() => popout.press('Escape', { closest: (s: string) => (s === '.floating-panel' ? board : null) }));
  assert.deepEqual(closed, ['board', 'fleet', 'fleet', 'board']);
  act(() => r.unmount());
  assert.equal(main.listeners() + popout.listeners(), 0);
});

test("a focus scope uses its container's document, not the main one", (t) => {
  const { main } = withEnv(t);
  const docListeners: string[] = [];
  Object.assign(main.document, {
    addEventListener: () => docListeners.push('main'),
    removeEventListener: () => {},
  });
  const inner = { getClientRects: () => [{}], focus: () => { popoutDoc.activeElement = inner; } };
  const popoutDoc = {
    activeElement: null as unknown,
    addEventListener: (type: string) => docListeners.push(`popout:${type}`),
    removeEventListener: (type: string) => docListeners.push(`popout-off:${type}`),
    contains: () => true,
  };
  const container = {
    ownerDocument: popoutDoc,
    contains: (node: unknown) => node === inner,
    querySelectorAll: () => [inner],
  };
  const dispose = activateFocusScope(container as unknown as HTMLElement, null);
  assert.equal(popoutDoc.activeElement, inner, "focus moved in, judged by the pop-out's activeElement");
  dispose();
  assert.deepEqual(docListeners, ['popout:keydown', 'popout-off:keydown']);
});
