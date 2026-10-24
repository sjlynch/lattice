import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeAllPopouts,
  interactionDocument,
  isLatticeHidden,
  onLatticeVisibilityChange,
  popoutDocuments,
  registerPopout,
  subscribePopouts,
} from '../components/floatingPanel/popoutRegistry.ts';
import { readMemGauges } from '../debug/memDiag.ts';
import { installGlobal } from './domDoubles.ts';

// The module-level set of open FloatingPanel pop-outs. Pinned: the main window
// closing closes every pop-out (saving its geometry first); "hidden" for
// polling means EVERY Lattice window is hidden (a board popped out on another
// monitor keeps polling with the main window minimised), and its change signal
// fires only on a flip, following pop-outs as they open and close; a confirm
// goes to the window the user last pressed in; every listener is released.

type CountingTarget = EventTarget & { listeners: () => number; visibilityState: string };

function countingTarget(extra: Record<string, unknown> = {}): CountingTarget {
  const target = new EventTarget() as CountingTarget;
  let count = 0;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
    count += 1;
    add(...args);
  };
  target.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>) => {
    count -= 1;
    remove(...args);
  };
  target.listeners = () => count;
  return Object.assign(target, { visibilityState: 'visible' }, extra);
}

function makePopup() {
  const doc = countingTarget();
  const popup = {
    closed: false,
    document: doc,
    close() {
      popup.closed = true;
    },
  };
  return popup;
}

function setVisibility(doc: CountingTarget, state: 'visible' | 'hidden') {
  doc.visibilityState = state;
  doc.dispatchEvent(new Event('visibilitychange'));
}

function installMain(t: { after: (fn: () => void) => void }) {
  const doc = countingTarget();
  const win = countingTarget();
  t.after(installGlobal('document', doc));
  t.after(installGlobal('window', win));
  return { doc, win };
}

test('register / unregister: documents, subscribers, gauge, main listeners only while open', (t) => {
  const main = installMain(t);
  const popup = makePopup();
  let notified = 0;
  const unsubscribe = subscribePopouts(() => {
    notified += 1;
  });

  const unregister = registerPopout(popup as unknown as Window);
  assert.deepEqual(popoutDocuments(), [popup.document]);
  assert.equal(readMemGauges()['floatingPanel.popouts'], 1);
  assert.equal(notified, 1);
  assert.ok(main.doc.listeners() > 0 && main.win.listeners() > 0, 'main hooks while a pop-out is open');

  // A popup that has closed no longer counts, even before it unregisters.
  popup.closed = true;
  assert.deepEqual(popoutDocuments(), []);
  popup.closed = false;

  unregister();
  unregister(); // idempotent
  assert.deepEqual(popoutDocuments(), []);
  assert.equal(notified, 2);
  assert.equal(readMemGauges()['floatingPanel.popouts'], 0);
  assert.equal(popup.document.listeners(), 0, "the pop-out's listeners are released");
  assert.equal(main.doc.listeners(), 0, 'main listeners go with the last pop-out');
  assert.equal(main.win.listeners(), 0);
  unsubscribe();
  assert.equal(readMemGauges()['floatingPanel.popoutSubscribers'], 0);
});

test('the main window going away closes every pop-out, saving geometry first', (t) => {
  const main = installMain(t);
  const a = makePopup();
  const b = makePopup();
  const saved: string[] = [];
  const offA = registerPopout(a as unknown as Window, () => saved.push(a.closed ? 'a-after' : 'a'));
  const offB = registerPopout(b as unknown as Window, () => saved.push('b'));

  main.win.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(saved, ['a', 'b']);
  assert.equal(a.closed, true);
  assert.equal(b.closed, true);

  // A failing save never keeps a window open.
  const c = makePopup();
  const offC = registerPopout(c as unknown as Window, () => {
    throw new Error('quota');
  });
  closeAllPopouts();
  assert.equal(c.closed, true);
  offA();
  offB();
  offC();
});

test('hidden = every Lattice window hidden; the change signal fires only on a flip', (t) => {
  const main = installMain(t);
  const calls: boolean[] = [];
  const stop = onLatticeVisibilityChange(() => calls.push(isLatticeHidden()));

  setVisibility(main.doc, 'hidden');
  assert.deepEqual(calls, [true]);
  setVisibility(main.doc, 'hidden'); // no flip, no call
  assert.deepEqual(calls, [true]);

  // A visible pop-out opening while the main window is hidden: visible again.
  const popup = makePopup();
  const unregister = registerPopout(popup as unknown as Window);
  assert.equal(isLatticeHidden(), false);
  assert.deepEqual(calls, [true, false]);

  // The pop-out's own visibility counts.
  setVisibility(popup.document, 'hidden');
  assert.deepEqual(calls, [true, false, true]);
  setVisibility(main.doc, 'visible');
  assert.deepEqual(calls, [true, false, true, false]);
  setVisibility(main.doc, 'hidden');
  setVisibility(popup.document, 'visible');
  assert.deepEqual(calls, [true, false, true, false, true, false]);

  // Closing it while the main window is hidden flips to hidden.
  unregister();
  assert.deepEqual(calls, [true, false, true, false, true, false, true]);
  assert.equal(popup.document.listeners(), 0);

  stop();
  setVisibility(main.doc, 'visible');
  assert.equal(calls.length, 7, 'nothing after stop');
  assert.equal(main.doc.listeners(), 0);
});

test('a confirm goes to the Lattice window the user last pressed in', (t) => {
  const main = installMain(t);
  assert.equal(interactionDocument(), main.doc, 'no pop-out: the main window');
  const popup = makePopup();
  const unregister = registerPopout(popup as unknown as Window);
  assert.equal(interactionDocument(), popup.document, 'a fresh pop-out has the focus');

  main.doc.dispatchEvent(new Event('pointerdown'));
  assert.equal(interactionDocument(), main.doc);
  popup.document.dispatchEvent(new Event('keydown'));
  assert.equal(interactionDocument(), popup.document);

  popup.closed = true; // closed but not yet unregistered: never a dead window
  assert.equal(interactionDocument(), main.doc);
  popup.closed = false;
  unregister();
  assert.equal(interactionDocument(), main.doc);
});
