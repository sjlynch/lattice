import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { fetchWorktreeModified } from '../../../api';
import { taskColor } from '../../../taskColors';
import { setNodeChangeRingsVisible } from '../changeRing';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { baseSizeFor, mountedNodes, mountedRoot } from '../mountedNodes';
import { setNodeWorktreeRing } from '../worktreeRing';
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

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

export function useWorktreeHighlight(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  activeFolder: string,
  pinned: boolean,
) {
  // Node ids currently wearing a worktree ring, so we can strip exactly
  // those on release.
  const appliedRef = useRef<Set<string>>(new Set());
  // Guards against a stale fetch (key released before it resolved) painting
  // rings after the fact.
  const activeRef = useRef(false);
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

  const clearRings = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || appliedRef.current.size === 0) {
      appliedRef.current.clear();
      return;
    }
    for (const node of mountedNodes(graph)) {
      if (typeof node.id !== 'string' || !appliedRef.current.has(node.id)) continue;
      const root = mountedRoot(node);
      if (root) setNodeWorktreeRing(root, false, '', 0);
    }
    appliedRef.current.clear();
    getIdleController(graph)?.wakeForRefresh();
  }, [graphRef]);

  const applyRings = useCallback(
    (pathColors: Map<string, string>) => {
      const graph = graphRef.current;
      if (!graph) return;
      const settings = settingsRef.current;
      const next = new Set<string>();
      for (const node of mountedNodes(graph)) {
        if (typeof node.id !== 'string' || typeof node.path !== 'string') continue;
        const color = pathColors.get(normalizePath(node.path));
        const root = mountedRoot(node);
        if (!root) continue;
        if (color) {
          setNodeWorktreeRing(root, true, color, baseSizeFor(node, settings));
          next.add(node.id);
        }
      }
      // Strip any previously-ringed node that's no longer in the set.
      for (const node of mountedNodes(graph)) {
        if (typeof node.id !== 'string') continue;
        if (appliedRef.current.has(node.id) && !next.has(node.id)) {
          const root = mountedRoot(node);
          if (root) setNodeWorktreeRing(root, false, '', 0);
        }
      }
      appliedRef.current = next;
      getIdleController(graph)?.wakeForRefresh();
    },
    [graphRef, settingsRef],
  );

  const activate = useCallback(async () => {
    if (activeRef.current || !activeFolder) return;
    activeRef.current = true;
    // Suppress the git change-rings immediately (before the fetch resolves)
    // so the worktree rings are the only rings on screen while `W` is held.
    setChangeRingsVisible(false);
    try {
      const tasks = await fetchWorktreeModified(activeFolder);
      if (!activeRef.current) return; // released while fetching
      const pathColors = new Map<string, string>();
      for (const t of tasks) {
        const color = taskColor({ id: t.taskId, colorIndex: t.colorIndex });
        for (const file of t.files) pathColors.set(normalizePath(file), color);
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
    // Restore the git change-rings hidden on activate.
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
