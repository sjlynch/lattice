import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { fetchGitHistory, type GitHistoryResult, type ScanResult } from '../../../api';
import { applyChangeRingDelta } from '../changeRingSync';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { computeChangeMap } from '../timelineDiff';
import type { ChangeKind } from '../changeRing';
import { resetChangeRingsForProjectSwitch } from '../timelineReset';

// History is fetched once per project; the scrubber range is two
// tick indices into [0, commits.length], where commits.length is
// the working-tree slot. Defaults to [oldest, WT] so the user sees
// every change ringed when they land on the project.
//
// changeMap (rel-path → kind) is recomputed on every range/history
// change. Stored in a ref so the nodeThreeObject closure (wired once
// at mount) reads the latest map without forcing a re-mount.
export function useGitTimeline(
  activeFolder: string,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  data: ScanResult | null,
) {
  const [history, setHistory] = useState<GitHistoryResult | null>(null);
  const [range, setRange] = useState<{ left: number; right: number }>({
    left: 0,
    right: 0,
  });
  const changeMapRef = useRef<Map<string, ChangeKind>>(new Map());
  // Scan root is read live by the delta walker to resolve real file nodes'
  // absolute paths to the rel-paths the change map is keyed by — matching
  // `nodeObjectFactory` (`dataRef.current?.root`). Mirrored each render so
  // the scrub effect, which doesn't depend on `data`, still sees the latest.
  const scanRootRef = useRef('');
  scanRootRef.current = data?.root ?? '';

  // Fetch the last 10 commits + uncommitted status whenever the active
  // project changes. The scrubber drives ring colors and ghost-node
  // visibility from the cached result — no per-drag backend traffic.
  useEffect(() => {
    // Reset timeline state on EVERY active-folder change, not just to an empty
    // folder. A project switch A→B otherwise leaves `history` — and the derived
    // change map / ghosts — at A's values during the async window before B's git
    // history resolves: B's freshly-built nodes then inherit A's change rings on
    // shared paths (package.json, tsconfig.json, src/index.ts) and A's deleted-
    // file ghost discs get injected into B's graph until B's history lands. So
    // strip the previous project's rings/ghosts and empty `changeMapRef` up
    // front; with `history` null the reconcile effect below is a no-op (prev map
    // already empty) and `prepareGhostMerge` builds no ghosts until B resolves.
    const graph = graphRef.current;
    const touched = resetChangeRingsForProjectSwitch(
      graph,
      changeMapRef,
      settingsRef.current,
      scanRootRef.current,
    );
    if (touched) getIdleController(graph)?.wakeForRefresh();
    setHistory(null);
    setRange({ left: 0, right: 0 });

    if (!activeFolder) return;
    let cancelled = false;
    fetchGitHistory(activeFolder, 10)
      .then((h) => {
        if (cancelled) return;
        setHistory(h);
        // Default to the full range so every change in the loaded
        // window is visible at first paint.
        const last = h.commits.length; // tick index of working-tree slot
        setRange({ left: 0, right: last });
      })
      .catch(() => {
        if (cancelled) return;
        setHistory({ isRepo: false, commits: [], uncommitted: { changes: [] } });
      });
    return () => {
      cancelled = true;
    };
  }, [activeFolder, graphRef, settingsRef]);

  // Recompute the change map when the slider range moves, then apply the
  // prev→next diff in place: only the nodes whose ChangeKind actually flipped
  // get their ring added/removed/recolored (and ghost nodes whose presence
  // flipped get their visibility toggled). The scrubber emits range changes
  // continuously while dragging and many adjacent ticks share the exact same
  // change set, so `applyChangeRingDelta` no-ops (and we skip the wake) when
  // nothing changed. This replaced a `graph.refresh()` that rebuilt every
  // node's THREE object on every flip — see `changeRingSync`.
  useEffect(() => {
    const prev = changeMapRef.current;
    const next = history
      ? computeChangeMap(
          history.commits,
          history.uncommitted,
          range.left,
          range.right,
        )
      : new Map<string, ChangeKind>();
    changeMapRef.current = next;
    const graph = graphRef.current;
    if (!graph) return;
    const changed = applyChangeRingDelta(
      graph,
      prev,
      next,
      settingsRef.current,
      scanRootRef.current,
    );
    // Wake a few frames so the added/removed rings + ghost toggles paint; the
    // render loop is otherwise paused once the engine has settled.
    if (changed) getIdleController(graph)?.wakeForRefresh();
  }, [history, range, graphRef, settingsRef]);

  return { history, range, setRange, changeMapRef };
}
