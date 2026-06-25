// The `engine` reason and its safety timer. Mirrors three-forcegraph's
// boolean `engineRunning` as a single ledger hold: acquired on data load /
// physics reheat (`engineStarted`), released by `graph.onEngineStop`
// (`engineStopped`). The safety timer is the belt-and-braces auto-release if
// the library ever drops that callback.

import type { ReasonLedger } from './idleControllerReasons';

// Belt-and-braces auto-release for the `engine` reason. The library
// normally fires `onEngineStop` within `cooldownTime` (now 8 s, see
// useForceGraphInitialization), but on the off chance an upstream
// change ever drops or swallows the callback we don't want the render
// loop pinned forever. Sized comfortably above cooldownTime + a margin
// for the warmup ticks.
const ENGINE_SAFETY_TIMEOUT_MS = 20000;

export type EngineReason = {
  engineStarted(): void;
  engineStopped(): void;
  isEngineHot(): boolean;
  destroy(): void;
};

export function createEngineReason(
  ledger: ReasonLedger,
  sync: () => void,
): EngineReason {
  // engine is boolean here (mirrors three-forcegraph's engineRunning); the
  // boolean guards against double acquire/release, so the ledger count tracks
  // it as a single hold.
  let engineHeld = false;
  let engineSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearEngineSafety() {
    if (engineSafetyTimer) {
      clearTimeout(engineSafetyTimer);
      engineSafetyTimer = null;
    }
  }
  function armEngineSafety() {
    clearEngineSafety();
    engineSafetyTimer = setTimeout(() => {
      engineSafetyTimer = null;
      // Library failed to fire onEngineStop within the cooldown window.
      // Force-release so the render loop can suspend.
      if (engineHeld) {
        engineHeld = false;
        ledger.release('engine');
        sync();
      }
    }, ENGINE_SAFETY_TIMEOUT_MS);
  }
  function engineStarted() {
    if (engineHeld) {
      // Already held — just rearm the safety timer because the d3
      // engine was just re-warmed (graphData() swap or explicit reheat).
      armEngineSafety();
      return;
    }
    engineHeld = true;
    ledger.acquire('engine');
    armEngineSafety();
    sync();
  }
  function engineStopped() {
    if (!engineHeld) return;
    engineHeld = false;
    ledger.release('engine');
    clearEngineSafety();
    sync();
  }
  // Whether the d3 layout is currently live (nodes may be moving this frame).
  // Consumers that cache per-frame geometry derived from node positions (e.g.
  // the Agent Presence Layer's graph bounds) use this to recompute only while
  // positions can change and reuse the cache once the layout has settled.
  function isEngineHot(): boolean {
    return engineHeld;
  }
  function destroy() {
    clearEngineSafety();
  }

  return { engineStarted, engineStopped, isEngineHot, destroy };
}
