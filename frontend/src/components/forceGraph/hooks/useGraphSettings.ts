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
  //
  // Guarded against two redundant refreshes: (1) the *initial mount*, and
  // (2) any run where no nodes are mounted yet. `nodeThreeObject` reads
  // `settingsRef.current` live, so the data-sync build already creates
  // sprites at the current sizes — a refresh before/at that point just
  // clears the label registries and wakes the idle loop for a
  // byte-identical rebuild. The previous-size ref also makes a settings
  // *object* swap that doesn't actually change a size (e.g. a project
  // switch landing on identical values) a no-op. Live slider drags still
  // refresh: the size changes, nodes are mounted, so the guard falls
  // through.
  const appliedSizesRef = useRef({
    fileNodeSize: settings.fileNodeSize,
    dirNodeSize: settings.dirNodeSize,
    labelSize: settings.labelSize,
  });
  useEffect(() => {
    const prev = appliedSizesRef.current;
    const changed =
      prev.fileNodeSize !== settings.fileNodeSize ||
      prev.dirNodeSize !== settings.dirNodeSize ||
      prev.labelSize !== settings.labelSize;
    appliedSizesRef.current = {
      fileNodeSize: settings.fileNodeSize,
      dirNodeSize: settings.dirNodeSize,
      labelSize: settings.labelSize,
    };
    const g = graphRef.current;
    if (!changed || !g || g.graphData().nodes.length === 0) return;
    clearLabelsAndRefresh(g);
  }, [settings.fileNodeSize, settings.dirNodeSize, settings.labelSize, graphRef]);

  // labelSpread doesn't need its own effect: the overlay RAFs run
  // continuously while their key is held and read
  // `settingsRef.current.labelSpread` fresh every tick, so the new
  // minDist takes effect on the next frame after the slider moves.

  // Apply physics + DAG settings to the running simulation. Reheats so
  // changes visibly take effect.
  //
  // The force params are pushed into the sim on *every* run — including
  // initial setup — because the graph is constructed only with
  // `dagLevelDistance`; charge/link/velocityDecay would otherwise sit at
  // the d3 defaults until the first slider drag, silently dropping a
  // project's persisted (non-default) physics. Cheap and idempotent.
  //
  // The *reheat*, by contrast, is skipped when it can't matter: on the
  // initial mount (previous-value guard) and whenever no nodes are
  // mounted (an empty sim has nothing to relax — the data-sync swap
  // reheats once it populates graphData). So a freshly-loaded settings
  // object no longer wakes the render loop for nothing; only an actual
  // physics/DAG change on a populated graph reheats.
  //
  // The reheat is deferred to a macrotask. Calling `d3ReheatSimulation()`
  // synchronously sets `engineRunning = true` via `resetCountdown()`. On
  // the very first run kapsule's debounced initial update hasn't fired
  // yet, so `state.layout` is still undefined — the next animation frame
  // would crash inside `layoutTick` with "Cannot read properties of
  // undefined (reading 'tick')". A short setTimeout lets kapsule's
  // ~1ms-debounced digest install `state.layout` before we reheat.
  const appliedPhysicsRef = useRef({
    dagLevelDistance: settings.dagLevelDistance,
    velocityDecay: settings.velocityDecay,
    chargeStrength: settings.chargeStrength,
    linkDistance: settings.linkDistance,
  });
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

    const prev = appliedPhysicsRef.current;
    const changed =
      prev.dagLevelDistance !== settings.dagLevelDistance ||
      prev.velocityDecay !== settings.velocityDecay ||
      prev.chargeStrength !== settings.chargeStrength ||
      prev.linkDistance !== settings.linkDistance;
    appliedPhysicsRef.current = {
      dagLevelDistance: settings.dagLevelDistance,
      velocityDecay: settings.velocityDecay,
      chargeStrength: settings.chargeStrength,
      linkDistance: settings.linkDistance,
    };
    if (!changed || g.graphData().nodes.length === 0) return;

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
