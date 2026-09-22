import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activateFocusScope, isTopFocusTrap, pushFocusTrap, removeFocusTrap } from '../hooks/useFocusTrap.ts';
import { installGlobal } from './domDoubles.ts';

// FloatingPanel is non-modal (`trapTab: false`): panels have no backdrop and sit
// side by side, so its old Tab trap pulled focus from older panels / the page
// into the newest panel. It must still move focus in and restore it on close,
// but never listen for Tab nor join the modal trap stack.

type Listener = (e: unknown) => void;

function makeEnv() {
  const listeners = new Map<string, Set<Listener>>();
  const doc = {
    activeElement: null as unknown,
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
    contains: () => true,
  };
  const makeEl = () => {
    const el = {
      getClientRects: () => [{}],
      focus: () => {
        doc.activeElement = el;
      },
    };
    return el;
  };
  const opener = makeEl();
  const inner = makeEl();
  const container = {
    contains: (node: unknown) => node === inner,
    querySelectorAll: () => [inner],
  };
  const keydownCount = () => listeners.get('keydown')?.size ?? 0;
  return { doc, opener, inner, container, keydownCount };
}

test('trapTab:false focuses in and restores, without a Tab listener or trap-stack entry', () => {
  const env = makeEnv();
  const restore = installGlobal('document', env.doc);
  try {
    env.opener.focus();
    const modal = Symbol('modal');
    pushFocusTrap(modal);

    const dispose = activateFocusScope(
      env.container as unknown as HTMLElement,
      env.opener as unknown as HTMLElement,
      { trapTab: false },
    );
    assert.equal(env.doc.activeElement, env.inner, 'focus moves into the panel');
    assert.equal(env.keydownCount(), 0, 'no Tab handler installed');
    assert.equal(isTopFocusTrap(modal), true, 'panel does not preempt the open modal');

    dispose();
    assert.equal(env.doc.activeElement, env.opener, 'focus restored to the opener');
    removeFocusTrap(modal);
  } finally {
    restore();
  }
});

test('default (modal) scope still traps Tab and owns the top of the stack', () => {
  const env = makeEnv();
  const restore = installGlobal('document', env.doc);
  try {
    const below = Symbol('below');
    pushFocusTrap(below);
    const dispose = activateFocusScope(
      env.container as unknown as HTMLElement,
      env.opener as unknown as HTMLElement,
    );
    assert.equal(env.keydownCount(), 1);
    assert.equal(isTopFocusTrap(below), false);
    dispose();
    assert.equal(env.keydownCount(), 0);
    assert.equal(isTopFocusTrap(below), true);
    removeFocusTrap(below);
  } finally {
    restore();
  }
});
