import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { fetchWorktreeModified } from '../../../api';
import { taskColor } from '../../../taskColors';
import { setChangeRingsSuppressed, setNodeChangeRingsVisible } from '../changeRing';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { mountedNodes, mountedRoot } from '../mountedNodes';
import { normalizeWorktreePath } from '../worktreeRing';
import {
  applyWorktreeRings,
  clearWorktreeRings,
  type WorktreeRingsRef,
} from '../worktreeRingSync';
import { momentaryLetterMode, useHoldKeyMode } from './useHoldKeyMode';

// `W` outlines every file changed by a not-yet-merged task (in_progress +
// ready_to_merge), ringed in that task's color — active while `W` is held OR
// while the Worktree view is pinned (the overlay-key chip latches the same
// state). Same chord pattern as `h`/`z` (keyup / blur / visibilitychange all
// clear the hold — see `useHoldKeyMode`) so the rings can't get stuck on if the
// user alt-tabs while holding the key; `pinned` is independent of those resets.
//
// The modified-file set comes from a git-backed snapshot fetched once on
// activation (`GET /api/tasks/worktree-modified`). Momentary by design — release
// (or unpin) and re-activate to refresh.
//
// The snapshot is published through `worktreeRingsRef` (owned by the
// coordinator, shared with `nodeObjectFactory`) so a full sprite rebuild while
// the view is active re-attaches the rings instead of dropping them — see
// `worktreeRingSync`.

export function useWorktreeHighlight(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  activeFolder: string,
  pinned: boolean,
  worktreeRingsRef: WorktreeRingsRef,
) {
  // Guards against a stale fetch (key released before it resolved) painting
  // rings after the fact.
  const activeRef = useRef(false);
  // Bumped on every activation. A project switch while active runs cleanup
  // (deactivate, activeRef → false) then immediately re-activates (activeRef →
  // true) for the new folder, so the bare `activeRef` boolean can't tell a late
  // fetch from the OLD project apart from the current activation — and that late
  // fetch's paths miss the new graph, so its applyRings strips the new project's
  // correct rings. Capture this id per activation and bail after the await if it
  // moved on.
  const runIdRef = useRef(0);
  // `held` tracks just the `W` key; the effective state is held OR pinned.
  const [held, setHeld] = useState(false);

  // Toggle every timeline change-ring across the graph. While `W` is held we
  // hide them so they don't stack with the worktree rings (the two ring
  // styles are too hard to tell apart side by side).
  const setChangeRingsVisible = useCallback(
    (visible: boolean) => {
      const graph = graphRef.current;
      if (!graph) return;
      for (const node of mountedNodes(graph)) {
        const root = mountedRoot(node);
        if (root) setNodeChangeRingsVisible(root, visible);
      }
      getIdleController(graph)?.wakeForRefresh();
    },
    [graphRef],
  );

  // Strip every ring across the graph and drop the published snapshot. A
  // one-shot O(N) scene walk, not a remembered id set: a rebuild between apply
  // and clear replaces the roots such a set pointed at.
  const clearRings = useCallback(() => {
    clearWorktreeRings(graphRef.current, worktreeRingsRef);
  }, [graphRef, worktreeRingsRef]);

  // Publish the snapshot and ring every mounted match in one O(N) pass (the
  // factory re-rings from the same snapshot on any later full rebuild).
  const applyRings = useCallback(
    (pathColors: Map<string, string>) => {
      const graph = graphRef.current;
      if (!graph) return;
      applyWorktreeRings(graph, worktreeRingsRef, pathColors, settingsRef.current);
    },
    [graphRef, settingsRef, worktreeRingsRef],
  );

  const activate = useCallback(async () => {
    if (activeRef.current || !activeFolder) return;
    activeRef.current = true;
    const runId = ++runIdRef.current;
    // Suppress the git change-rings immediately (before the fetch resolves)
    // so the worktree rings are the only rings on screen while `W` is held.
    // Two parts: latch the suppression flag so any ring minted later (a full
    // rebuild or a scrub-delta add) starts hidden, and hide the rings already
    // mounted right now. Without the flag the rings reappear on the next refresh.
    setChangeRingsSuppressed(true);
    setChangeRingsVisible(false);
    try {
      const tasks = await fetchWorktreeModified(activeFolder);
      // Released while fetching, or a project switch re-activated for a different
      // folder since this fetch began — either way these results are stale.
      if (!activeRef.current || runIdRef.current !== runId) return;
      const pathColors = new Map<string, string>();
      for (const t of tasks) {
        const color = taskColor({ id: t.taskId, colorIndex: t.colorIndex });
        for (const file of t.files) pathColors.set(normalizeWorktreePath(file), color);
      }
      applyRings(pathColors);
    } catch {
      /* fetch failed — leave the graph untouched */
    }
  }, [activeFolder, applyRings, setChangeRingsVisible]);

  const deactivate = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearRings();
    // Restore the git change-rings hidden on activate: lift the suppression flag
    // (future rings build visible again) and re-show the currently-mounted ones.
    setChangeRingsSuppressed(false);
    setChangeRingsVisible(true);
  }, [clearRings, setChangeRingsVisible]);

  // The `W` key only flips the local `held` flag; the effective state below
  // composes it with the pin. Keyup / blur / visibilitychange reset `held` (not
  // the pin) via the shared lifecycle.
  useHoldKeyMode(momentaryLetterMode('w', setHeld));

  const active = held || pinned;

  // Drive the ring side effects off the effective (held || pinned) state.
  // Activate fetches the modified-file snapshot and paints rings; the effect's
  // cleanup strips them. Re-running on an `activeFolder` change (while active)
  // re-fetches for the new project; the cleanup also covers unmount — so this is
  // the only hold-key overlay with live scene state to tear down (the old
  // `resetOnUnmount` is now this cleanup).
  useEffect(() => {
    if (!active) return;
    void activate();
    return () => deactivate();
  }, [active, activate, deactivate]);

  return { worktreeActive: active };
}
