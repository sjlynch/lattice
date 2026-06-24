// Shared "should I re-upload node positions this frame?" gate for the batched
// renderers (`instancedLinks.ts` / `instancedNodes.ts`). Both collapse many
// per-object draw calls into one batched object and re-upload the GPU position
// buffer ONLY on frames where node positions actually moved — never during a
// pure orbit of a settled graph (the whole point of batching). The motion signal
// is the shared node-motion driver (engine tick OR a node drag — incl. a drag
// AFTER the layout settles, which `onEngineTick` alone misses; see
// `nodeMotionDriver.ts`) plus one trailing "settle" frame (the final cooldown
// tick updates positions without firing a motion event), plus a forced sync after
// a rebuild / re-enable (`markDirty`).
//
// This three-flag state machine was byte-for-byte duplicated in both controllers
// and is subtle, load-bearing logic — the "one trailing settle frame" trick, and
// editing it in only one file reintroduced a drag-freeze regression. It lives
// here once so there is a single source of truth. Each controller keeps its own
// (different) `syncPositions()` body and just calls `shouldSync()` to decide
// whether to run it.

import type { ForceGraph3DInstance } from '3d-force-graph';
import { onNodeMotion } from './nodeMotionDriver';

export type MotionSyncGate = {
  /** Force a sync regardless of motion (after a rebuild / re-enable). */
  markDirty(): void;
  /**
   * Whether positions should be re-uploaded this frame. Advances the per-frame
   * motion bookkeeping as a side effect (clears the dirty flag when it reports a
   * sync, and rolls the "one trailing settle frame" state), so it MUST be called
   * exactly once per frame — including frames a caller ultimately decides not to
   * sync, so the motion flags still decay.
   */
  shouldSync(): boolean;
  /** Subscribe to the node-motion driver (engine tick / drag). Hold while live. */
  attach(): void;
  /** Unsubscribe from the node-motion driver. */
  detach(): void;
};

export function createMotionSyncGate(graph: ForceGraph3DInstance): MotionSyncGate {
  // Set by the node-motion driver (engine tick or a drag): positions moved, so
  // the buffer needs a re-sync this frame. Both fire BEFORE the frame's render
  // (and onFrame), so the sync picks up the just-updated positions same frame.
  let movedThisFrame = false;
  // Carries one extra sync into the settling frame: the final cooldown tick
  // updates positions WITHOUT firing a motion event, so trail the last moved frame.
  let movedLastFrame = false;
  // Force one sync regardless of motion (after a rebuild / re-enable).
  let dirty = false;
  // Unsubscribe handle for the shared node-motion listener (held only while on).
  let unsub: (() => void) | null = null;

  const onTick = () => {
    movedThisFrame = true;
  };

  function markDirty(): void {
    dirty = true;
  }

  function shouldSync(): boolean {
    const sync = movedThisFrame || movedLastFrame || dirty;
    if (sync) dirty = false;
    movedLastFrame = movedThisFrame;
    movedThisFrame = false;
    return sync;
  }

  function attach(): void {
    unsub = onNodeMotion(graph, onTick);
  }

  function detach(): void {
    unsub?.();
    unsub = null;
  }

  return { markDirty, shouldSync, attach, detach };
}
