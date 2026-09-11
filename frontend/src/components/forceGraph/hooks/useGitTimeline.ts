import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import {
  fetchGitHistory,
  subscribeGitStatus,
  type GitHistoryResult,
  type ScanResult,
} from '../../../api';
import { applyChangeRingDelta } from '../changeRingSync';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { computeChangeMap } from '../timelineDiff';
import { reconcileTimelineRange } from '../timelineRange';
import type { ChangeKind } from '../changeRing';
import { resetChangeRingsForProjectSwitch } from '../timelineReset';
import { createGitHistoryRefresh } from './gitHistoryRefresh';

const EMPTY_HISTORY: GitHistoryResult = {
  isRepo: false,
  commits: [],
  uncommitted: { changes: [] },
  deletedPaths: [],
  signature: '',
};

// History is fetched once per project *and then kept live*: the backend's
// /ws/git-status watcher pushes a compact signature whenever the repo state
// changes (a commit, stage, checkout, or a working-tree edit), and we re-fetch
// on a new signature. Without this the scrubber's commit list + uncommitted
// view stayed stale until a full page refresh — so a commit still showed the
// old "dirty" state and a fresh edit never lit up. The scrubber range is two
// tick indices into [0, commits.length], where commits.length is the working-
// tree slot. Defaults to [oldest, WT] so the user sees every change ringed.
//
// changeMap (rel-path → kind) is recomputed on every range/history change.
// Stored in a ref so the nodeThreeObject closure (wired once at mount) reads
// the latest map without forcing a re-mount.
export function useGitTimeline(
  activeFolder: string,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  data: ScanResult | null,
  // True while a metric view (health/loc/dead) is showing. The change map still
  // updates underneath, but its rings/ghosts are suppressed in those views — so
  // the in-place scrub delta is skipped (it'd re-add a ring or re-show a ghost
  // the active view hid). Releasing the view runs a full refresh that re-syncs
  // every node from the latest map.
  metricOverlayActiveRef: MutableRefObject<boolean>,
) {
  const [history, setHistory] = useState<GitHistoryResult | null>(null);
  const [range, setRange] = useState<{ left: number; right: number }>({
    left: 0,
    right: 0,
  });
  const changeMapRef = useRef<Map<string, ChangeKind>>(new Map());
  // Latest loaded history for range reconciliation and preserving the last
  // good timeline if a background refresh fails.
  const historyRef = useRef<GitHistoryResult | null>(null);
  // Scan root is read live by the delta walker to resolve real file nodes'
  // absolute paths to the rel-paths the change map is keyed by — matching
  // `nodeObjectFactory` (`dataRef.current?.root`). Mirrored each render so
  // the scrub effect, which doesn't depend on `data`, still sees the latest.
  const scanRootRef = useRef('');
  scanRootRef.current = data?.root ?? '';

  // Apply a freshly-fetched history: update the mirrors + state and reconcile
  // the scrubber range into the (possibly shifted) new tick space. From the
  // reset baseline (historyRef null, range {0,0}) this yields the full
  // [0, commits.length] range, i.e. the first-load default.
  const applyHistory = useCallback((h: GitHistoryResult) => {
    const oldWt = historyRef.current?.commits.length ?? 0;
    const newWt = h.commits.length;
    historyRef.current = h;
    setHistory(h);
    setRange((prev) => reconcileTimelineRange(prev, oldWt, newWt));
  }, []);

  // Reset + first fetch whenever the active project changes. A project switch
  // A→B otherwise leaves `history` — and the derived change map / ghosts — at
  // A's values during the async window before B resolves: B's freshly-built
  // nodes then inherit A's change rings on shared paths (package.json, …) and
  // A's deleted-file ghosts get injected into B's graph. So strip the previous
  // project's rings/ghosts and empty `changeMapRef` up front; with `history`
  // null the reconcile effect below is a no-op and `prepareGhostMerge` builds
  // no ghosts until B resolves.
  useEffect(() => {
    const graph = graphRef.current;
    const touched = resetChangeRingsForProjectSwitch(
      graph,
      changeMapRef,
      settingsRef.current,
      scanRootRef.current,
    );
    if (touched) getIdleController(graph)?.wakeForRefresh();
    historyRef.current = null;
    setHistory(null);
    setRange({ left: 0, right: 0 });

    if (!activeFolder) return;
    const refresh = createGitHistoryRefresh({
      load: (signal) => fetchGitHistory(activeFolder, 10, signal),
      onHistory: applyHistory,
      onError: () => {
        // A failed background refresh keeps the last good timeline. Initial
        // failures still resolve the empty state instead of staying loading.
        if (!historyRef.current) applyHistory(EMPTY_HISTORY);
      },
    });
    refresh.start();
    const unsubscribe = subscribeGitStatus(activeFolder, refresh.notifySignature);
    return () => {
      refresh.dispose();
      unsubscribe();
    };
  }, [activeFolder, graphRef, settingsRef, applyHistory]);

  // Recompute the change map when the slider range moves (or history updates),
  // then apply the prev→next diff in place: only the nodes whose ChangeKind
  // actually flipped get their ring added/removed/recolored (and ghost nodes
  // whose presence flipped get their visibility toggled). The scrubber emits
  // range changes continuously while dragging and many adjacent ticks share the
  // exact same change set, so `applyChangeRingDelta` no-ops (and we skip the
  // wake) when nothing changed. This replaced a `graph.refresh()` that rebuilt
  // every node's THREE object on every flip — see `changeRingSync`.
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
    // While a metric view is active its refresh already stripped every ring and
    // hid the ghosts; keep the map current (so releasing the view re-syncs to
    // the scrubbed position) but don't paint the delta back in.
    if (metricOverlayActiveRef.current) return;
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
  }, [history, range, graphRef, settingsRef, metricOverlayActiveRef]);

  return { history, range, setRange, changeMapRef };
}
