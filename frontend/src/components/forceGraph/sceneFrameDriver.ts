// A single fan-out over THREE's `scene.onBeforeRender`, which fires at the head
// of every real render (i.e. every frame the render loop is actually running —
// see idleController for what keeps it running). Overlays that need a per-frame
// tick register a callback here instead of each wrapping `scene.onBeforeRender`
// themselves: a chain of independently mounted/unmounted wrappers is fragile to
// tear down in the right order, whereas one dispatcher iterating a Set is not.
//
// Because callbacks fire only while the render loop runs, this is the natural
// partner of the idle controller: a feature wakes the loop by holding an idle
// reason (or via an external event that does), then its onFrame callback runs
// each frame and decides whether to keep holding. When everything settles and
// the loop pauses, callbacks simply stop firing until the next wake — which is
// exactly what render-on-demand wants (no work while nothing changes), and it
// means stale-state triggers (a slider drag = `interact`, a layout reheat =
// `engine`, a sprite rebuild = `refresh`) each re-run every callback for free.

import type * as THREE from 'three';

export type FrameCallback = (nowMs: number) => void;

const KEY = '__frameDriver' as const;

type FrameDriver = {
  callbacks: Set<FrameCallback>;
  // A cached iteration array rebuilt only when membership changes, so the hot
  // per-frame path neither allocates (no `[...set]` every frame) nor risks a
  // mid-iteration mutation: a callback added/removed during dispatch flips
  // `dirty` and is reflected on the NEXT frame, never the in-flight one.
  list: FrameCallback[];
  dirty: boolean;
};

type WithDriver = { [KEY]?: FrameDriver };

function sceneOf(graph: object): THREE.Scene {
  return (graph as unknown as { scene: () => THREE.Scene }).scene();
}

// Install the single dispatcher onto the graph's scene. Idempotent — safe to
// call once at graph init alongside the idle controller.
export function attachFrameDriver(graph: object): void {
  const holder = graph as WithDriver;
  if (holder[KEY]) return;
  const driver: FrameDriver = { callbacks: new Set(), list: [], dirty: false };
  holder[KEY] = driver;

  const scene = sceneOf(graph);
  const prev = scene.onBeforeRender;
  const dispatch = ((...args: Parameters<THREE.Scene['onBeforeRender']>) => {
    prev.apply(scene, args);
    if (driver.callbacks.size === 0) return;
    if (driver.dirty) {
      driver.list = [...driver.callbacks];
      driver.dirty = false;
    }
    const now = performance.now();
    const list = driver.list;
    for (let i = 0; i < list.length; i++) list[i](now);
  }) as THREE.Scene['onBeforeRender'];
  scene.onBeforeRender = dispatch;
}

// Register a per-frame callback; returns an unsubscribe. No-op (returns a noop
// unsubscribe) if the driver was never attached — callers stay simple.
export function onFrame(graph: object | null, cb: FrameCallback): () => void {
  const driver = graph ? (graph as WithDriver)[KEY] : undefined;
  if (!driver) return () => {};
  driver.callbacks.add(cb);
  driver.dirty = true;
  return () => {
    driver.callbacks.delete(cb);
    driver.dirty = true;
  };
}
