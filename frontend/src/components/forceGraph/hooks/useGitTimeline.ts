import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { fetchGitHistory, type GitHistoryResult } from '../../../api';
import { computeChangeMap } from '../timelineDiff';
import type { ChangeKind } from '../changeRing';
import { clearLabelsAndRefresh } from './refresh';

// Two change maps are equal when they cover the same paths with the
// same kinds. Tracked as a 1-pass walk over the larger map; both ring
// maps are O(commits·changes) so this comparison is cheap relative to
// the full sprite-rebuild it replaces.
function changeMapsEqual(
  a: Map<string, ChangeKind>,
  b: Map<string, ChangeKind>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [path, kind] of a) {
    if (b.get(path) !== kind) return false;
  }
  return true;
}

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
) {
  const [history, setHistory] = useState<GitHistoryResult | null>(null);
  const [range, setRange] = useState<{ left: number; right: number }>({
    left: 0,
    right: 0,
  });
  const changeMapRef = useRef<Map<string, ChangeKind>>(new Map());

  // Fetch the last 10 commits + uncommitted status whenever the active
  // project changes. The scrubber drives ring colors and ghost-node
  // visibility from the cached result — no per-drag backend traffic.
  useEffect(() => {
    if (!activeFolder) {
      setHistory(null);
      setRange({ left: 0, right: 0 });
      return;
    }
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
  }, [activeFolder]);

  // Recompute the change map when the slider range moves and refresh
  // sprites so rings update. nodeVisibility (in the parent) also
  // re-evaluates on the same dep set, which hides/shows ghost nodes
  // for the new range. The scrubber emits range changes continuously
  // while dragging; many adjacent ticks share the exact same change
  // set, so we only refresh when the per-path ring kind actually
  // flipped — otherwise we'd rebuild every node's THREE object on
  // every scrubber pixel.
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
    if (!changeMapsEqual(prev, next)) {
      clearLabelsAndRefresh(graphRef.current);
    }
  }, [history, range, graphRef]);

  return { history, range, setRange, changeMapRef };
}
