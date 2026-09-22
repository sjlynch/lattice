import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { getIdleController } from '../idleController';
import { mountedNodesById } from '../mountedNodes';
import { useRefMirror } from './useRefMirror';

// Camera fly duration when stepping to a search match, and the cadence we
// re-wake the render loop at while it animates. The library steps its camera
// tween inside the render frame (`tweenGroup.update` in three-render-objects'
// `tick`), which the idle controller pauses once the scene settles — so a
// programmatic focus must keep the loop awake for the whole transition.
// `wakeForRefresh` holds it only ~120 ms, hence the pulse < that interval.
const CAMERA_FOCUS_MS = 450;
const CAMERA_FOCUS_PULSE_MS = 100;

// Prev/next match navigation for the graph search bar. The current match is
// tracked by *id* (not a numeric index), so its "X of Y" position derives
// straight from the live match list — when the set changes under us (the
// contents pass landing, a file rename) a dropped id simply reads as "no
// current match", no reset bookkeeping. Stepping recenters the camera on the
// match's node (already ringed as a member of `selected`). The list is read
// through a ref so the step handlers stay referentially stable (keeping the
// memoized HUD off the per-keystroke render path). A fresh query / Escape
// clears the cursor via the returned `clearCurrentMatch`.
export function useGraphSearchNavigation(params: {
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  searchMatches: string[];
}) {
  const { graphRef, searchMatches } = params;

  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  const searchMatchesRef = useRefMirror(searchMatches);

  // Pan the camera to center a match's node, preserving the current viewing
  // angle + distance (translate camera by the same delta as the orbit target).
  const cameraPulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const focusNodeById = useCallback(
    (nodeId: string) => {
      const graph = graphRef.current;
      if (!graph) return;
      const node = mountedNodesById(graph).get(nodeId) as
        | { x?: number; y?: number; z?: number }
        | undefined;
      if (!node) return;
      const { x, y, z } = node;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof z !== 'number'
      ) {
        return;
      }
      const camera = graph.camera();
      const controls = graph.controls() as {
        target?: { x: number; y: number; z: number };
      };
      const target = controls?.target;
      if (camera && target) {
        const dx = x - target.x;
        const dy = y - target.y;
        const dz = z - target.z;
        graph.cameraPosition(
          {
            x: camera.position.x + dx,
            y: camera.position.y + dy,
            z: camera.position.z + dz,
          },
          { x, y, z },
          CAMERA_FOCUS_MS,
        );
      } else {
        graph.cameraPosition({}, { x, y, z }, CAMERA_FOCUS_MS);
      }
      // Keep the render loop awake so the camera tween actually advances (the
      // idle controller pauses it once settled). Pulse the refresh wake faster
      // than its ~120 ms hold for the transition, then let it settle on its own.
      const idle = getIdleController(graph);
      if (idle) {
        if (cameraPulseRef.current) clearInterval(cameraPulseRef.current);
        idle.wakeForRefresh();
        let elapsed = 0;
        cameraPulseRef.current = setInterval(() => {
          elapsed += CAMERA_FOCUS_PULSE_MS;
          idle.wakeForRefresh();
          if (elapsed >= CAMERA_FOCUS_MS && cameraPulseRef.current) {
            clearInterval(cameraPulseRef.current);
            cameraPulseRef.current = null;
          }
        }, CAMERA_FOCUS_PULSE_MS);
      }
    },
    [graphRef],
  );
  useEffect(
    () => () => {
      if (cameraPulseRef.current) clearInterval(cameraPulseRef.current);
    },
    [],
  );

  // Pure id step (no side effect in the updater, so it's safe under batching /
  // StrictMode): wrap-around from the current match, or start at the first/last
  // when there's none. The camera follow runs in the effect below, off the
  // committed id — so a rapid double-step animates once to the final match
  // instead of fighting two tweens.
  //
  // `focusSeq` bumps on every step so the camera re-centers even when the step
  // lands on the SAME id (a single match, or wrapping back onto the current
  // one) — keying the effect on the id alone skipped that, so after orbiting
  // away "next" on a one-match search did nothing.
  const [focusSeq, setFocusSeq] = useState(0);
  const stepMatch = useCallback(
    (delta: number) => {
      setFocusSeq((n) => n + 1);
      setCurrentMatchId((curId) => {
        const list = searchMatchesRef.current;
        if (list.length === 0) return null;
        const cur = curId ? list.indexOf(curId) : -1;
        const next =
          cur < 0
            ? delta > 0
              ? 0
              : list.length - 1
            : (cur + delta + list.length) % list.length;
        return list[next];
      });
    },
    [searchMatchesRef],
  );
  useEffect(() => {
    if (currentMatchId) focusNodeById(currentMatchId);
  }, [currentMatchId, focusSeq, focusNodeById]);
  const goPrevMatch = useCallback(() => stepMatch(-1), [stepMatch]);
  const goNextMatch = useCallback(() => stepMatch(1), [stepMatch]);
  // 1-based position of the current match in the live list (0 = none / dropped).
  const searchMatchPosition = useMemo(() => {
    if (!currentMatchId) return 0;
    const i = searchMatches.indexOf(currentMatchId);
    return i >= 0 ? i + 1 : 0;
  }, [searchMatches, currentMatchId]);

  // Drop the current-match cursor (a fresh query or Escape). Stable so the
  // memoized HUD / Escape listener stay off the per-keystroke render path.
  const clearCurrentMatch = useCallback(() => setCurrentMatchId(null), []);

  return { searchMatchPosition, goPrevMatch, goNextMatch, clearCurrentMatch };
}
