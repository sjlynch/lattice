import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { type PointerEvent as ReactPointerEvent } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useSidebarWidth } from '../hooks/useSidebarWidth.ts';
import type { UserSettingsResult } from '../hooks/useUserSettings.ts';
import type { UserSettings } from '../api';
import { installGlobal, installWindow } from './domDoubles.ts';

// Exercise the real hook with controlled browser resources. The unrelated
// listeners remain installed so cleanup must return to the original baseline.
const PROJECT = 'C:/development/project-A';
const OTHER_PROJECT = 'C:/development/project-B';
const loadedSettings: UserSettingsResult = {
  settings: { sidebarWidth: 400, sidebarMaximized: false },
  loaded: true,
};
const eventTypes = ['resize', 'pointermove', 'pointerup', 'pointercancel'] as const;
type Pointer = Pick<PointerEvent, 'type' | 'clientX' | 'pointerId'>;
type Listener = (event: Pointer) => void;
const unrelatedListener: Listener = () => {};

let listeners: Map<string, Set<Listener>>;
let frames: Map<number, FrameRequestCallback>;
let cancelledFrames: number[];
let bodyStyle: { userSelect: string; cursor: string };
let writes: Array<{ project: string; settings: Partial<UserSettings> }>;
let restores: Array<() => void>;
let sidebar: ReturnType<typeof useSidebarWidth>;
let renders: number;
let renderer: ReturnType<typeof TestRenderer.create> | undefined;
let viewport: { innerWidth: number };

beforeEach(() => {
  listeners = new Map(eventTypes.map((type) => [type, new Set([unrelatedListener])]));
  frames = new Map();
  cancelledFrames = [];
  bodyStyle = { userSelect: 'text', cursor: 'crosshair' };
  writes = [];
  renders = 0;
  viewport = { innerWidth: 1000 };
  let nextFrame = 1;
  restores = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installWindow(Object.assign(viewport, {
      addEventListener(type: string, listener: Listener) {
        const registered = listeners.get(type) ?? new Set<Listener>();
        registered.add(listener);
        listeners.set(type, registered);
      },
      removeEventListener(type: string, listener: Listener) {
        listeners.get(type)?.delete(listener);
      },
    })),
    installGlobal('document', { body: { style: bodyStyle } }),
    installGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    }),
    installGlobal('cancelAnimationFrame', (id: number) => {
      cancelledFrames.push(id);
      frames.delete(id);
    }),
    installGlobal('fetch', async (url: string, init: RequestInit) => {
      const parsed = new URL(url, 'http://lattice.test');
      assert.equal(parsed.pathname, '/api/settings');
      assert.equal(init.method, 'PATCH');
      const settings = JSON.parse(String(init.body)) as Partial<UserSettings>;
      writes.push({ project: parsed.searchParams.get('project')!, settings });
      return { ok: true, json: async () => settings };
    }),
  ];
});

afterEach(async () => {
  try {
    await unmount();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
});

function Harness({ folder, settings }: { folder: string; settings: UserSettingsResult }) {
  sidebar = useSidebarWidth(folder, settings);
  renders++;
  return null;
}

async function mount(folder = PROJECT) {
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { folder, settings: loadedSettings }));
  });
}

async function unmount() {
  if (!renderer) return;
  await act(async () => renderer!.unmount());
  renderer = undefined;
}

function makeResizer(failRelease = false) {
  const captures: number[] = [];
  const releases: number[] = [];
  const captured = new Set<number>();
  return {
    captures,
    releases,
    captured,
    setPointerCapture(id: number) {
      captures.push(id);
      captured.add(id);
    },
    releasePointerCapture(id: number) {
      releases.push(id);
      if (failRelease) throw new Error('resizer is detached');
      captured.delete(id);
    },
  };
}

async function start(target: ReturnType<typeof makeResizer>, pointerId = 7) {
  await act(async () => {
    sidebar.onResizerPointerDown({
      currentTarget: target,
      pointerId,
      preventDefault() {},
    } as unknown as ReactPointerEvent<HTMLDivElement>);
  });
}

function pointer(type: string, clientX: number, pointerId = 7): Pointer {
  return { type, clientX, pointerId };
}

async function dispatch(type: string, clientX = 0, pointerId = 7) {
  await act(async () => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      listener(pointer(type, clientX, pointerId));
    }
  });
}

function gestureListener(type: string): Listener {
  const owned = [...(listeners.get(type) ?? [])].filter((listener) => listener !== unrelatedListener);
  assert.equal(owned.length, 1);
  return owned[0];
}

function pendingFrame(): FrameRequestCallback {
  assert.equal(frames.size, 1);
  return [...frames.values()][0];
}

async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

function listenerCounts() {
  return eventTypes.map((type) => listeners.get(type)!.size);
}

function assertReleased(mounted = true) {
  assert.deepEqual(listenerCounts(), [mounted ? 2 : 1, 1, 1, 1]);
  assert.equal(frames.size, 0);
  assert.deepEqual(bodyStyle, { userSelect: 'text', cursor: 'crosshair' });
}

test('unmount during a drag releases listeners, RAF, capture and body styles without persisting', async () => {
  const baseline = listenerCounts();
  await mount();
  const target = makeResizer();
  await start(target);
  assert.deepEqual(listenerCounts(), [2, 2, 2, 2]);
  assert.deepEqual(bodyStyle, { userSelect: 'none', cursor: 'ew-resize' });
  await dispatch('pointermove', 550);
  await dispatch('pointermove', 950);
  const frame = pendingFrame();
  const move = gestureListener('pointermove');
  const up = gestureListener('pointerup');
  const cancel = gestureListener('pointercancel');
  assert.equal(sidebar.sidebarWidth, 400, 'moves wait for the coalesced frame');
  const rendersBeforeUnmount = renders;

  await unmount();
  assertReleased(false);
  assert.deepEqual(listenerCounts(), baseline);
  assert.equal(cancelledFrames.length, 1);
  assert.deepEqual(target.captures, [7]);
  assert.deepEqual(target.releases, [7]);
  assert.equal(target.captured.size, 0);
  assert.deepEqual(writes, []);

  // Invoke both window dispatches and already-captured callbacks after teardown.
  await dispatch('pointermove', 600);
  await dispatch('pointerup', 600);
  await dispatch('pointercancel');
  await act(async () => {
    move(pointer('pointermove', 650));
    frame(0);
    up(pointer('pointerup', 700));
    cancel(pointer('pointercancel', 0));
  });
  assertReleased(false);
  assert.equal(renders, rendersBeforeUnmount);
  assert.deepEqual(writes, []);
  assert.deepEqual(target.releases, [7]);
});

test('repeated mount/start/unmount cycles return all resources to baseline', async () => {
  const baseline = listenerCounts();
  for (let cycle = 0; cycle < 8; cycle++) {
    await mount();
    const target = makeResizer();
    await start(target, cycle + 1);
    await dispatch('pointermove', 500 + cycle, cycle + 1);
    assert.equal(frames.size, 1);
    await unmount();
    assertReleased(false);
    assert.deepEqual(listenerCounts(), baseline);
    assert.deepEqual(target.releases, [cycle + 1]);
    assert.equal(target.captured.size, 0);
  }
  assert.equal(cancelledFrames.length, 8);
  assert.deepEqual(writes, []);
});

for (const [releaseX, expectedWidth, folder] of [
  [512.4, 512, PROJECT],
  [120, 240, PROJECT],
  [800, 800, PROJECT],
  [525, 525, ''],
] as const) {
  test(`pointerup at ${releaseX} preserves width clamping and single-write behavior (folder=${folder})`, async () => {
    await mount(folder);
    const target = makeResizer();
    await start(target);
    await dispatch('pointermove', 950);
    const frame = pendingFrame();
    const up = gestureListener('pointerup');
    await dispatch('pointerup', releaseX);
    assert.equal(sidebar.sidebarWidth, expectedWidth);
    assert.equal(sidebar.sidebarMaximized, false);
    assert.deepEqual(writes, folder ? [{
      project: folder,
      settings: { sidebarWidth: expectedWidth, sidebarMaximized: false },
    }] : []);
    assertReleased();
    assert.equal(cancelledFrames.length, 1);
    await act(async () => {
      frame(0);
      up(pointer('pointerup', 999));
    });
    assert.equal(sidebar.sidebarWidth, expectedWidth);
    assert.equal(sidebar.sidebarMaximized, false);
    assert.equal(writes.length, folder ? 1 : 0);
    await unmount();
    assertReleased(false);
    assert.deepEqual(target.releases, [7], 'normal completion clears the cleanup ref');
  });
}

test('full-width release retains the last non-full width, with resize and double-click reset intact', async () => {
  await mount();
  const target = makeResizer();
  await start(target);
  await dispatch('pointermove', 500);
  await dispatch('pointermove', 612.6);
  assert.equal(frames.size, 1, 'moves coalesce into one frame');
  await flushFrames();
  assert.equal(sidebar.sidebarWidth, 613);
  await dispatch('pointermove', 950);
  await flushFrames();
  assert.equal(sidebar.sidebarMaximized, true);
  assert.equal(sidebar.sidebarWidth, 613);
  await dispatch('pointermove', 600);
  await dispatch('pointerup', 901);
  assert.equal(sidebar.sidebarMaximized, true);
  assert.equal(sidebar.sidebarWidth, 613);
  assert.deepEqual(writes, [{ project: PROJECT, settings: { sidebarMaximized: true } }]);
  assertReleased();

  viewport.innerWidth = 800;
  await dispatch('resize');
  assert.equal(sidebar.sidebarWidth, 600);
  assert.equal(sidebar.sidebarMaximized, true);
  await act(async () => sidebar.onResizerDoubleClick());
  assert.equal(sidebar.sidebarWidth, 380);
  assert.equal(sidebar.sidebarMaximized, false);
  assert.deepEqual(writes[1], {
    project: PROJECT,
    settings: { sidebarWidth: 380, sidebarMaximized: false },
  });
  assert.equal(writes.length, 2);
});

for (const [lastX, expectedWidth, maximized] of [[560.8, 561, false], [950, 400, true]] as const) {
  test(`pointercancel uses the last move (${lastX}) and persists once`, async () => {
    await mount();
    const target = makeResizer();
    await start(target);
    await dispatch('pointermove', lastX);
    await dispatch('pointercancel', 0);
    assert.equal(sidebar.sidebarWidth, expectedWidth);
    assert.equal(sidebar.sidebarMaximized, maximized);
    assert.deepEqual(writes, [{
      project: PROJECT,
      settings: maximized
        ? { sidebarMaximized: true }
        : { sidebarWidth: expectedWidth, sidebarMaximized: false },
    }]);
    assertReleased();
    assert.equal(cancelledFrames.length, 1);
    await unmount();
    assert.deepEqual(target.releases, [7]);
  });
}

test('pointercancel without any move tears down without changing or persisting width', async () => {
  await mount();
  const target = makeResizer();
  await start(target);
  await dispatch('pointercancel', 0);
  assert.equal(sidebar.sidebarWidth, 400);
  assert.equal(sidebar.sidebarMaximized, false);
  assertReleased();
  assert.deepEqual(writes, []);
  assert.deepEqual(target.releases, [7]);
});

test('a replacement drag releases the previous one and rejects its late callbacks', async () => {
  await mount();
  const first = makeResizer();
  await start(first);
  await dispatch('pointermove', 950);
  const oldFrame = pendingFrame();
  const oldMove = gestureListener('pointermove');
  const oldUp = gestureListener('pointerup');

  const second = makeResizer();
  await start(second, 9);
  assert.deepEqual(first.releases, [7]);
  assert.deepEqual(listenerCounts(), [2, 2, 2, 2]);
  assert.equal(frames.size, 0);
  await dispatch('pointermove', 550, 9);
  await act(async () => {
    oldMove(pointer('pointermove', 950));
    oldFrame(0);
    oldUp(pointer('pointerup', 900));
  });
  assert.equal(sidebar.sidebarWidth, 400);
  assert.equal(sidebar.sidebarMaximized, false);
  assert.equal(frames.size, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(bodyStyle, { userSelect: 'none', cursor: 'ew-resize' });
  await flushFrames();
  assert.equal(sidebar.sidebarWidth, 550);
  await dispatch('pointerup', 600, 9);
  assert.deepEqual(writes, [{
    project: PROJECT,
    settings: { sidebarWidth: 600, sidebarMaximized: false },
  }]);
  assertReleased();
  await unmount();
  assert.deepEqual(first.releases, [7]);
  assert.deepEqual(second.releases, [9]);
});

test('normal release still persists to the current folder when it changes during a drag', async () => {
  await mount();
  await start(makeResizer());
  await dispatch('pointermove', 550);
  await act(async () => renderer!.update(React.createElement(Harness, {
    folder: OTHER_PROJECT,
    settings: { settings: null, loaded: false },
  })));
  await dispatch('pointerup', 600);
  assert.deepEqual(writes, [{
    project: OTHER_PROJECT,
    settings: { sidebarWidth: 600, sidebarMaximized: false },
  }]);
  assertReleased();
});

test('unmount cleanup continues when releasing pointer capture throws', async () => {
  await mount();
  const target = makeResizer(true);
  await start(target);
  await dispatch('pointermove', 550);
  await unmount();
  assertReleased(false);
  assert.deepEqual(target.releases, [7]);
  assert.equal(cancelledFrames.length, 1);
  assert.deepEqual(writes, []);
});
