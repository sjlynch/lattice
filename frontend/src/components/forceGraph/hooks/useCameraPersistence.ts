import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { getIdleController } from '../idleController';
import {
  loadCameraState,
  readCameraState,
  saveCameraState,
} from '../cameraState';
import { useRefMirror } from './useRefMirror';

// How long after the last camera move we wait before persisting. OrbitControls
// fires a 'change' event on every rotate/pan/zoom frame; debouncing both keeps a
// drag from hammering localStorage every frame and persists only the resting
// view the user actually left the graph at.
const SAVE_DEBOUNCE_MS = 400;

type ControlsWithEvents = {
  target?: { x: number; y: number; z: number };
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

// Persists the graph camera (position + orbit target) per project and restores
// it on mount / project switch, so a page refresh returns to the same vantage
// point. `up` is locked to +Y in `sceneSetup`, so position + target capture the
// whole view.
//
// Two cooperating effects share one debounce timer:
//  - a mount-scoped listener on the OrbitControls 'change' event that, after the
//    user stops moving, snapshots the live camera and writes it to the *current*
//    project (read live via a ref so it follows project switches);
//  - a per-project effect that cancels any pending save and re-aims the camera
//    to that project's saved view.
//
// The library only auto-fits the camera while it's still at its construction
// default (see 3d-force-graph's onUpdate re-aim guard), so a restored non-default
// view survives subsequent data loads without being clobbered.
export function useCameraPersistence(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  activeFolder: string,
) {
  const activeFolderRef = useRefMirror(activeFolder);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Attach the save-on-change listener once for the graph's lifetime. It reads
  // the project through a ref so the same listener follows project switches.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const controls = graph.controls() as ControlsWithEvents | null;
    if (!controls?.addEventListener) return;

    const onChange = () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        const g = graphRef.current;
        if (!g) return;
        const state = readCameraState(g);
        if (state) saveCameraState(activeFolderRef.current, state);
      }, SAVE_DEBOUNCE_MS);
    };

    controls.addEventListener('change', onChange);
    return () => {
      controls.removeEventListener?.('change', onChange);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [graphRef, activeFolderRef]);

  // Restore the saved view when the project changes (and on first mount). Cancel
  // any pending save first so a not-yet-flushed move from the previous project
  // can't land on the new one.
  useEffect(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const graph = graphRef.current;
    if (!graph) return;
    const saved = loadCameraState(activeFolder);
    if (!saved) return;
    // Instant (no tween) re-aim, then wake the loop a few frames so the new
    // camera actually paints if the scene was already settled.
    graph.cameraPosition(saved.position, saved.target, 0);
    getIdleController(graph)?.wakeForRefresh();
  }, [graphRef, activeFolder]);
}
