// A single fan-out over the three library signals that mean "node positions may
// have changed, so any batched geometry mirroring them must re-sync": the
// per-tick `onEngineTick`, and the per-pointermove `onNodeDrag` / `onNodeDragEnd`
// drag callbacks. All three are SINGLE-SLOT setters on the graph instance and
// the batched-link + batched-node renderers both need them, so they register
// here (mirrors `sceneFrameDriver` over `onBeforeRender`) instead of fighting
// over the slots.
//
// Why all three, not just `onEngineTick`: that fires only on frames the engine
// actually ticks. While the layout is warm a drag rides those ticks. But once it
// SETTLES (`d3ForceLayout.alpha() < d3AlphaMin`), a drag's `resetCountdown()`
// sets `engineRunning = true` yet the very next `layoutTick` re-trips the
// `alpha < d3AlphaMin` stop branch BEFORE `layout.tick()` can raise alpha toward
// the drag's `alphaTarget(0.3)` — so `layout.tick()` and `onEngineTick()` are
// skipped and the engine never restarts (`three-forcegraph.mjs` tickFrame). The
// drag handler has already written the new `node.x/y/z` and fires `onNodeDrag`
// regardless of engine state, so that callback is the reliable "a node moved"
// signal during a settled-graph drag — without it, dragged batched links/nodes
// froze once the physics had settled. `onNodeDragEnd` catches the final release.
//
// The installed dispatchers must never be cleared back to `null` (the library
// calls them); leaving an idle dispatcher in place when no listeners remain is
// harmless.

type Listener = () => void;
// Drag listeners receive the moved node + the per-event {x,y,z} translate delta
// (typed `unknown` to keep the driver decoupled from the node/graph types — the
// consumer casts). `isEnd` distinguishes `onNodeDrag` (false) from the final
// `onNodeDragEnd` (true).
export type DragListener = (
  node: unknown,
  translate: unknown,
  isEnd: boolean,
) => void;

const KEY = '__nodeMotionDriver' as const;

type MotionDriver = {
  listeners: Set<Listener>;
  // Cached iteration array, rebuilt only on membership change — same
  // no-alloc / no-mid-iteration-mutation contract as sceneFrameDriver.
  list: Listener[];
  dirty: boolean;
  // Listeners that need the drag node + delta (subtree-follow, DAG-Y lock).
  // Run BEFORE the motion dispatch on a drag event, so any position mutation
  // they make is already in place when the batched-geometry sync reads it.
  dragListeners: Set<DragListener>;
};

type WithDriver = { [KEY]?: MotionDriver };

type MotionGraph = {
  onEngineTick: (fn: () => void) => unknown;
  onNodeDrag: (fn: (node: unknown, translate: unknown) => void) => unknown;
  onNodeDragEnd: (fn: (node: unknown, translate: unknown) => void) => unknown;
};

// Install the dispatchers onto the graph's single-slot motion callbacks.
// Idempotent — safe to call at init alongside the frame driver, and self-installs
// on the first `onNodeMotion(graph, cb)` subscription if init didn't.
export function attachNodeMotionDriver(graph: object): void {
  const holder = graph as WithDriver;
  if (holder[KEY]) return;
  const driver: MotionDriver = {
    listeners: new Set(),
    list: [],
    dirty: false,
    dragListeners: new Set(),
  };
  holder[KEY] = driver;

  const dispatch = () => {
    if (driver.listeners.size === 0) return;
    if (driver.dirty) {
      driver.list = [...driver.listeners];
      driver.dirty = false;
    }
    const list = driver.list;
    for (let i = 0; i < list.length; i++) list[i]();
  };

  // A drag fires the drag listeners (with the node + delta) FIRST so their
  // position mutations are in place, then the arg-less motion dispatch so the
  // batched-geometry sync re-reads the just-mutated positions.
  const onDrag = (node: unknown, translate: unknown, isEnd: boolean) => {
    if (driver.dragListeners.size > 0) {
      for (const cb of [...driver.dragListeners]) cb(node, translate, isEnd);
    }
    dispatch();
  };

  const g = graph as unknown as MotionGraph;
  g.onEngineTick(dispatch);
  g.onNodeDrag((node, translate) => onDrag(node, translate, false));
  g.onNodeDragEnd((node, translate) => onDrag(node, translate, true));
}

// Register a node-motion callback; returns an unsubscribe. Auto-attaches the
// dispatchers if needed so callers don't have to order an explicit attach first.
export function onNodeMotion(graph: object | null, cb: Listener): () => void {
  if (!graph) return () => {};
  attachNodeMotionDriver(graph);
  const driver = (graph as WithDriver)[KEY]!;
  driver.listeners.add(cb);
  driver.dirty = true;
  return () => {
    driver.listeners.delete(cb);
    driver.dirty = true;
  };
}

// Register a drag callback (node + per-event {x,y,z} delta + isEnd); returns an
// unsubscribe. Used by `useNodeDragBehavior` for subtree-follow + DAG-Y lock.
export function onNodeDragMove(
  graph: object | null,
  cb: DragListener,
): () => void {
  if (!graph) return () => {};
  attachNodeMotionDriver(graph);
  const driver = (graph as WithDriver)[KEY]!;
  driver.dragListeners.add(cb);
  return () => {
    driver.dragListeners.delete(cb);
  };
}
