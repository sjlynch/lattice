import type { ForceGraph3DInstance } from '3d-force-graph';

// Camera can swing from straight overhead all the way down to ~45° below
// horizon (PI * 0.75 ≈ 135° from +Y), enough to peek up at the graph
// from underneath without ever flipping the root to the bottom.
const MIN_POLAR_ANGLE = 0;
const MAX_POLAR_ANGLE = Math.PI * 0.75;

// Sidebar drags emit 60+ ResizeObserver callbacks/sec; debounce so each
// settled frame triggers at most one Three.js resize rather than
// thrashing the GPU every pixel.
const RESIZE_DEBOUNCE_MS = 150;

// Cap WebGL's pixel ratio. On 4K / HiDPI displays the default devicePixelRatio
// can be 2+, which makes the fragment shader 4× more expensive for no visible
// gain on this kind of sprite-heavy scene.
const MAX_PIXEL_RATIO = 1.5;

// Tighten Three.js' WebGLRenderer so a still scene costs less per frame.
// Called once after `new ForceGraph3D(...)`. Safe to call again — every
// setter is idempotent.
export function configureRenderer(graph: ForceGraph3DInstance) {
  const renderer = graph.renderer();
  if (!renderer) return;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  renderer.setPixelRatio(Math.min(dpr, MAX_PIXEL_RATIO));
}

// Locks the world up vector and clamps OrbitControls so the camera never
// flips over and the root stays on top. Idempotent — safe to call right
// after `new ForceGraph3D(...)`.
export function configureCameraControls(graph: ForceGraph3DInstance) {
  graph.camera().up.set(0, 1, 0);

  const controls = graph.controls() as {
    minPolarAngle: number;
    maxPolarAngle: number;
    enableRotate?: boolean;
    update?: () => void;
  };
  if (controls) {
    controls.minPolarAngle = MIN_POLAR_ANGLE;
    controls.maxPolarAngle = MAX_POLAR_ANGLE;
    controls.update?.();
  }
}

// Works around a 3d-force-graph crash on right-click *directly over a
// node*. The library's node-drag `dragend` handler dispatches a synthetic
// `PointerEvent('pointerup', { pointerType: 'touch' })` to nudge the camera
// controls into releasing. Right-clicking a node makes DragControls fire
// `dragend` (its internal `_selected` is set) while the real mouse pointer
// is still tracked by OrbitControls — and that real pointer's id never
// matches the synthetic event's (which defaults to id 0). So OrbitControls'
// `_removePointer` no-ops, `_pointers.length` stays 1, and its multi-pointer
// (touch) path reads an undefined tracked-pointer position:
//   Uncaught TypeError: Cannot read properties of undefined (reading 'x')
//     at OrbitControls.onPointerUp …
// The real mouse `pointerup` cleans the controls' pointer state up correctly
// on its own, so we simply drop the bogus synthetic event. It's reliably
// identifiable because events built with `new PointerEvent(...)` and fed
// through `dispatchEvent` are untrusted (`isTrusted === false`), whereas
// genuine touch input is trusted. Must run before the first interaction so
// OrbitControls registers our wrapper as its document `pointerup` listener
// (it attaches that listener lazily inside `onPointerDown`). Idempotent.
export function guardNodeRightClickCrash(graph: ForceGraph3DInstance) {
  const controls = graph.controls() as {
    _onPointerUp?: (event: PointerEvent) => void;
    __latticeRightClickGuard?: boolean;
  } | null;
  if (!controls || typeof controls._onPointerUp !== 'function') return;
  if (controls.__latticeRightClickGuard) return;
  const originalPointerUp = controls._onPointerUp;
  controls._onPointerUp = (event: PointerEvent) => {
    if (event && event.isTrusted === false && event.pointerType === 'touch') {
      return;
    }
    originalPointerUp(event);
  };
  controls.__latticeRightClickGuard = true;
}

// Sizes the graph to its container and installs a debounced
// ResizeObserver so subsequent resizes stay coalesced. Returns a
// cleanup function that disconnects the observer and cancels any
// pending debounce timer.
export function createResizeObserver(
  graph: ForceGraph3DInstance,
  container: HTMLDivElement,
): () => void {
  const onResize = () => {
    graph.width(container.clientWidth);
    graph.height(container.clientHeight);
  };
  onResize();

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, RESIZE_DEBOUNCE_MS);
  });
  ro.observe(container);

  return () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    ro.disconnect();
  };
}
