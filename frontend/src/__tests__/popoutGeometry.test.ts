import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialPopoutGeometry,
  isOutsideViewport,
  loadPopoutGeometry,
  popoutAtPointer,
  popoutFeatures,
  popoutStorageKey,
  readPopoutGeometry,
  sanitizePopoutGeometry,
  savePopoutGeometry,
} from '../components/floatingPanel/popoutGeometry.ts';
import { installGlobal } from './domDoubles.ts';

// A FloatingPanel pop-out's window placement (screen coordinates) persists per
// panel under `lattice.<thing>.popout`, beside its in-window
// `lattice.<thing>.window` geometry. A stored entry is whatever the key holds,
// so a malformed one must read as "nothing saved", never as a window opened
// at NaN or zero size.

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

test('the pop-out key sits beside the panel window key', () => {
  assert.equal(popoutStorageKey('lattice.fleet.window'), 'lattice.fleet.popout');
  assert.equal(popoutStorageKey('lattice.security.findings.window'), 'lattice.security.findings.popout');
  assert.equal(popoutStorageKey('lattice.odd'), 'lattice.odd.popout');
  assert.equal(popoutStorageKey(undefined), undefined, 'no panel key, no persistence');
});

test('sanitize keeps a well-formed entry and rejects the rest', () => {
  assert.deepEqual(sanitizePopoutGeometry({ left: -1200.4, top: 30, width: 800, height: 600 }), {
    left: -1200, // a monitor left of the primary one
    top: 30,
    width: 800,
    height: 600,
  });
  // Tiny sizes grow to the minimum instead of opening an unusable sliver.
  assert.deepEqual(sanitizePopoutGeometry({ left: 0, top: 0, width: 10, height: 10 }), {
    left: 0,
    top: 0,
    width: 360,
    height: 240,
  });
  for (const bad of [
    null,
    'x',
    {},
    { left: 0, top: 0, width: 0, height: 300 }, // a closed window reads innerWidth 0
    { left: null, top: 0, width: 400, height: 300 }, // NaN written by JSON.stringify
    { left: 0, top: '5', width: 400, height: 300 },
    { left: 0, top: 0, width: Infinity, height: 300 },
  ]) {
    assert.equal(sanitizePopoutGeometry(bad), null, JSON.stringify(bad));
  }
});

test('save / load round-trip through localStorage; garbage reads as nothing', (t) => {
  const storage = memoryStorage();
  t.after(installGlobal('localStorage', storage));
  savePopoutGeometry('lattice.fleet.popout', { left: 100, top: 50, width: 900, height: 700 });
  assert.deepEqual(loadPopoutGeometry('lattice.fleet.popout'), { left: 100, top: 50, width: 900, height: 700 });

  savePopoutGeometry('lattice.fleet.popout', { left: 0, top: 0, width: 0, height: 0 });
  assert.deepEqual(
    loadPopoutGeometry('lattice.fleet.popout'),
    { left: 100, top: 50, width: 900, height: 700 },
    'an invalid sample never overwrites the last good one',
  );

  storage.items.set('lattice.fleet.popout', '{not json');
  assert.equal(loadPopoutGeometry('lattice.fleet.popout'), null);
  assert.equal(loadPopoutGeometry(undefined), null);
  savePopoutGeometry(undefined, { left: 1, top: 1, width: 400, height: 400 }); // no key: no write
  assert.equal(storage.items.size, 1);
});

test('window.open features carry the rounded, sanitized geometry', () => {
  assert.equal(
    popoutFeatures({ left: 10.6, top: 20.2, width: 800.4, height: 600.5 }),
    'popup=yes,width=800,height=601,left=11,top=20',
  );
  assert.equal(
    popoutFeatures({ left: NaN, top: 0, width: 1, height: 1 }),
    'popup=yes,width=360,height=240,left=0,top=0',
  );
});

test('first pop-out opens over the panel; a drop opens at the pointer', () => {
  const main = { screenX: 200, screenY: 100, outerWidth: 1216, outerHeight: 900, innerWidth: 1200, innerHeight: 780 };
  // side border 8, top chrome 900-780-8 = 112, minus the popup's own ~40px.
  assert.deepEqual(initialPopoutGeometry({ pos: { x: 50, y: 60 }, size: { width: 720, height: 520 } }, main), {
    left: 200 + 8 + 50,
    top: 100 + 112 + 60 - 40,
    width: 720,
    height: 520,
  });
  // Released at screen (1500, 400) holding the titlebar 30px in, 10px down.
  assert.deepEqual(popoutAtPointer({ x: 1500, y: 400 }, { x: 30, y: 10 }, { width: 640, height: 480 }), {
    left: 1470,
    top: 350,
    width: 640,
    height: 480,
  });
  assert.deepEqual(readPopoutGeometry({ screenX: 5, screenY: 6, innerWidth: 700, innerHeight: 500 }), {
    left: 5,
    top: 6,
    width: 700,
    height: 500,
  });
});

test('the drag-out arm: only a pointer past the window edge counts', () => {
  const viewport = { width: 1000, height: 700 };
  assert.equal(isOutsideViewport(500, 300, viewport), false);
  assert.equal(isOutsideViewport(0, 0, viewport), false);
  assert.equal(isOutsideViewport(-1, 300, viewport), true);
  assert.equal(isOutsideViewport(500, -5, viewport), true);
  assert.equal(isOutsideViewport(1000, 300, viewport), true);
  assert.equal(isOutsideViewport(500, 700, viewport), true);
  // With a margin, grazing the edge does not count.
  assert.equal(isOutsideViewport(-10, 300, viewport, 24), false);
  assert.equal(isOutsideViewport(1020, 300, viewport, 24), false);
  assert.equal(isOutsideViewport(-25, 300, viewport, 24), true);
  assert.equal(isOutsideViewport(500, 724, viewport, 24), true);
});
