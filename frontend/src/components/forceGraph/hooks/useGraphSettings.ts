import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { loadSettings, type GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { clearLabelsAndRefresh } from './refresh';

// Owns the GraphSettings state, mirrored ref, and per-project
// localStorage persistence. Also drives sprite-size refreshes and
// physics reheats when the user tweaks values from the panel.
//
// The ref keeps the latest value visible to THREE callbacks
// (nodeThreeObject is wired once at mount) while the state drives the
// panel UI.
export function useGraphSettings(
  activeFolder: string,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
) {
  const [settings, setSettings] = useState<GraphSettings>(() =>
    loadSettings(activeFolder),
  );
  const settingsRef = useRef<GraphSettings>(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Reload persisted settings when the active project changes.
  useEffect(() => {
    setSettings(loadSettings(activeFolder));
  }, [activeFolder]);

  // Persist settings whenever they change.
  useEffect(() => {
    if (!activeFolder) return;
    try {
      localStorage.setItem(
        `lattice.graphSettings.${activeFolder}`,
        JSON.stringify(settings),
      );
    } catch {
      /* ignore quota */
    }
  }, [activeFolder, settings]);

  // Re-render sprites when render-only settings (sizes) change.
  useEffect(() => {
    clearLabelsAndRefresh(graphRef.current);
  }, [settings.fileNodeSize, settings.dirNodeSize, settings.labelSize, graphRef]);

  // labelSpread doesn't need its own effect: the overlay RAFs run
  // continuously while their key is held and read
  // `settingsRef.current.labelSpread` fresh every tick, so the new
  // minDist takes effect on the next frame after the slider moves.

  // Apply physics + DAG settings to the running simulation. Reheats so
  // changes visibly take effect.
  //
  // The reheat is deferred to a macrotask. Calling `d3ReheatSimulation()`
  // synchronously sets `engineRunning = true` via `resetCountdown()`. On
  // the very first run kapsule's debounced initial update hasn't fired
  // yet, so `state.layout` is still undefined — the next animation frame
  // would crash inside `layoutTick` with "Cannot read properties of
  // undefined (reading 'tick')". A short setTimeout lets kapsule's
  // ~1ms-debounced digest install `state.layout` before we reheat.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.dagLevelDistance(settings.dagLevelDistance);
    g.d3VelocityDecay(settings.velocityDecay);
    const charge = g.d3Force('charge') as
      | { strength?: (n: number) => unknown }
      | undefined;
    charge?.strength?.(settings.chargeStrength);
    const link = g.d3Force('link') as
      | { distance?: (n: number) => unknown }
      | undefined;
    link?.distance?.(settings.linkDistance);
    const timer = setTimeout(() => {
      if (graphRef.current === g) {
        g.d3ReheatSimulation();
        getIdleController(g)?.engineStarted();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [
    settings.dagLevelDistance,
    settings.velocityDecay,
    settings.chargeStrength,
    settings.linkDistance,
    graphRef,
  ]);

  return { settings, setSettings, settingsRef };
}
