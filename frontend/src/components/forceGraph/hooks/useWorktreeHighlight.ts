import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type * as THREE from 'three';
import { fetchWorktreeModified, type GraphNode } from '../../../api';
import { taskColor } from '../../../taskColors';
import { setNodeChangeRingsVisible } from '../changeRing';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { setNodeWorktreeRing } from '../worktreeRing';
import { isTextInput } from './refresh';

// `W` (hold) outlines every file changed by a not-yet-merged task
// (in_progress + ready_to_merge), ringed in that task's color. Same chord
// pattern as `h`/`z`: keyup / blur / visibilitychange all clear it so the
// rings can't get stuck on if the user alt-tabs while holding the key.
//
// The modified-file set comes from a git-backed snapshot fetched once on
// press (`GET /api/tasks/worktree-modified`). Momentary by design — release
// and re-press to refresh.

type SimNode = GraphNode & { __threeObj?: THREE.Object3D };

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function baseSizeFor(node: GraphNode, settings: GraphSettings): number {
  return node.kind === 'dir' ? settings.dirNodeSize : settings.fileNodeSize;
}

function graphNodes(graph: ForceGraph3DInstance): SimNode[] {
  const getData = graph.graphData as unknown as () => { nodes?: object[] };
  return (getData.call(graph)?.nodes ?? []) as SimNode[];
}

export function useWorktreeHighlight(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  activeFolder: string,
) {
  // Node ids currently wearing a worktree ring, so we can strip exactly
  // those on release.
  const appliedRef = useRef<Set<string>>(new Set());
  // Guards against a stale fetch (key released before it resolved) painting
  // rings after the fact.
  const activeRef = useRef(false);

  // Toggle every timeline change-ring across the graph. While `W` is held we
  // hide them so they don't stack with the worktree rings (the two ring
  // styles are too hard to tell apart side by side).
  const setChangeRingsVisible = useCallback(
    (visible: boolean) => {
      const graph = graphRef.current;
      if (!graph) return;
      for (const node of graphNodes(graph)) {
        const root = node.__threeObj;
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
    for (const node of graphNodes(graph)) {
      if (typeof node.id !== 'string' || !appliedRef.current.has(node.id)) continue;
      const root = node.__threeObj;
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
      for (const node of graphNodes(graph)) {
        if (typeof node.id !== 'string' || typeof node.path !== 'string') continue;
        const color = pathColors.get(normalizePath(node.path));
        const root = node.__threeObj;
        if (!root) continue;
        if (color) {
          setNodeWorktreeRing(root, true, color, baseSizeFor(node, settings));
          next.add(node.id);
        }
      }
      // Strip any previously-ringed node that's no longer in the set.
      for (const node of graphNodes(graph)) {
        if (typeof node.id !== 'string') continue;
        if (appliedRef.current.has(node.id) && !next.has(node.id)) {
          const root = node.__threeObj;
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
  }, [activeFolder, applyRings]);

  const deactivate = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearRings();
    // Restore the git change-rings hidden on activate.
    setChangeRingsVisible(true);
  }, [clearRings, setChangeRingsVisible]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'w' && e.key !== 'W') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      if (e.repeat) return;
      void activate();
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'w' || e.key === 'W') deactivate();
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', deactivate);
    document.addEventListener('visibilitychange', deactivate);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', deactivate);
      document.removeEventListener('visibilitychange', deactivate);
      deactivate();
    };
  }, [activate, deactivate]);
}
