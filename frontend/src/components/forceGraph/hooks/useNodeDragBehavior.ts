import { useEffect, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { onNodeDragMove } from '../nodeMotionDriver';
import { getIdleController } from '../idleController';

// Two drag-UX behaviors, wired through the shared node-motion driver's drag
// callback (so they coexist with the batched-geometry sync that rides the same
// single-slot `onNodeDrag`). Active regardless of the batched-render toggles.
//
// 1. PHYSICS-ACTIVE DRAG. Dragging a node should let its children follow (via
//    the link springs) and its siblings make room (via repulsion) — i.e. the
//    library's intended drag behavior, where the sim stays gently warm
//    (`alphaTarget(0.3)`) so neighbours react. That works fine WHILE the layout
//    is still warm, but once it SETTLES it stops: Lattice bounds the engine with
//    `d3AlphaMin(0.005)` (useForceGraphInitialization), and on a settled graph
//    the next `tickFrame` re-trips the `alpha < d3AlphaMin` stop branch BEFORE
//    `layout.tick()` can raise alpha toward the drag's target — so the engine
//    never re-ticks and only the dragged node (pinned directly via `fx/fy/fz`)
//    moves. We lift that freeze for the duration of the gesture by setting
//    `d3AlphaMin(0)`, so the library's own per-event `alphaTarget(0.3)` warms
//    the sim again; nodes already at equilibrium barely move (near-zero net
//    force) while the dragged node's neighbours visibly follow. Restored to the
//    configured min on drag end, after which the library's `alphaTarget(0)`
//    lets it cool back to rest. (Earlier this hook rigidly translated the whole
//    descendant subtree instead — which made dragging a top-level directory
//    haul the entire graph as a block. Physics is what the user actually wanted.)
//
// 2. DAG-Y LOCK. In `td` DAG mode each node's Y is pinned to its depth level
//    (`fy`, set once at graph build — three-forcegraph.mjs). The library's drag
//    handler overwrites `fy` with the free 3D drag-Y, knocking the node off its
//    level, and never restores it. We re-pin `fy` (and `y`) to the node's
//    dragstart Y (`__initialPos.y`, captured by the library before the drag
//    moved it = the depth-pinned level), so a drag only slides the node within
//    its horizontal plane. Neighbours keep their OWN `fy` (their levels), so the
//    physics-driven follow above moves them in X/Z only.

type SimNode = {
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  // Node-data position captured by the library at dragstart (= the depth-pinned
  // Y in td mode, before the drag moved it).
  __initialPos?: { x: number; y: number; z: number };
};

// The library stamps `d3AlphaMin` as a getter/setter (kapsule config prop):
// `d3AlphaMin()` reads, `d3AlphaMin(v)` sets.
type DragGraph = { d3AlphaMin: (v?: number) => number | unknown };

const DEFAULT_ALPHA_MIN = 0.005;

export function useNodeDragBehavior(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
) {
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const g = graph as unknown as DragGraph;

    // Per-gesture state: whether we've already lifted the settled-freeze for the
    // current drag, and the alpha-min to restore when it ends.
    let gestureActive = false;
    let prevAlphaMin = DEFAULT_ALPHA_MIN;

    function restoreFreeze() {
      if (!gestureActive) return;
      g.d3AlphaMin(prevAlphaMin);
      gestureActive = false;
    }

    const off = onNodeDragMove(graph, (nodeRaw, _translateRaw, isEnd) => {
      const node = nodeRaw as SimNode;

      if (isEnd) {
        // Restore the configured settle floor; the library's own dragend handler
        // sets `alphaTarget(0)` so the now-warm sim cools back to rest.
        restoreFreeze();
        return;
      }

      // DAG-Y lock: undo the library's `fy = dragY` so the node stays on its
      // level (and so the engine tick, which respects `fy`, can't drift it in Y).
      if (node.__initialPos) {
        node.fy = node.y = node.__initialPos.y;
      }

      if (!gestureActive) {
        gestureActive = true;
        // Lift the settled-freeze so the library's per-event `alphaTarget(0.3)`
        // can actually warm the sim (see header). Children/siblings then follow
        // via the link springs + repulsion.
        const cur = g.d3AlphaMin();
        prevAlphaMin = typeof cur === 'number' ? cur : DEFAULT_ALPHA_MIN;
        g.d3AlphaMin(0);
        // Hold the render loop at full speed through the warm-up and the
        // post-release settle; onEngineStop (wired at init) releases it.
        getIdleController(graph)?.engineStarted();
      }
    });

    return () => {
      // A drag in flight at unmount (rare) must not leave the freeze lifted.
      restoreFreeze();
      off();
    };
    // graphRef is stable; the drag listener reads everything live.
  }, [graphRef]);
}
