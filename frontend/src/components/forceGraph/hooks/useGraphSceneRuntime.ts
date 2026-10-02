import { useCallback, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode, ScanResult } from '../../../api';
import { useAgentOverlay } from './useAgentOverlay';
import { useBatchedLinks } from './useBatchedLinks';
import { useCameraPersistence } from './useCameraPersistence';
import { useForceGraphInitialization } from './useForceGraphInitialization';
import { useGraphDataSync } from './useGraphDataSync';
import { useGraphOverlays } from './useGraphOverlays';
import { useInstancedNodes } from './useInstancedNodes';
import { useNodeDragBehavior } from './useNodeDragBehavior';
import { useRadialTidyLayout } from './useRadialTidyLayout';
import { useRefMirror } from './useRefMirror';
import { useWorktreeHighlight } from './useWorktreeHighlight';

type Args = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  activeFolder: string;
  data: ScanResult | null;
  // Structure-only view of `data` (see useStructuralScan) — keys the tidy
  // layout so metric-only saves don't re-seed it.
  structuralData: ScanResult | null;
  hiddenExts: Set<string>;
  healthMode: boolean;
  onHealthModeChange: (mode: boolean) => void;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  // Live mirrors the coordinator owns; passed through (never copied) so the
  // once-mounted init accessors read the same ref objects the rest of the
  // coordinator writes.
  selectedRef: MutableRefObject<Set<string>>;
  dataRef: MutableRefObject<ScanResult | null>;
  metricsIgnoredExtsRef: MutableRefObject<Set<string>>;
  pointerOutsideRef: MutableRefObject<boolean>;
  onHoverNodeChange: (node: GraphNode | null) => void;
  // Identity-stable (init mounts once and captures them).
  onRendererFailure: (error: unknown) => void;
  onContextLost: () => void;
  onContextRestored: () => void;
};

// The graph's scene runtime, extracted from the coordinator: overlay state,
// graph initialization, camera persistence, graphData sync, the tidy layout,
// the batched link/node renderers, drag behavior, and the agent + worktree
// overlays. Everything here wires itself to the graph instance at mount and
// draws into the scene; the calls run in the coordinator's original order
// (the batched renderers and tidy layout depend on the data sync landing
// first). Returns the state the interaction hooks and chrome model read.
export function useGraphSceneRuntime({
  containerRef,
  graphRef,
  activeFolder,
  data,
  structuralData,
  hiddenExts,
  healthMode,
  onHealthModeChange,
  selected,
  setSelected,
  selectedRef,
  dataRef,
  metricsIgnoredExtsRef,
  pointerOutsideRef,
  onHoverNodeChange,
  onRendererFailure,
  onContextLost,
  onContextRestored,
}: Args) {
  const {
    settings,
    setSettings,
    settingsRef,
    history,
    range,
    setRange,
    changeMapRef,
    locMode,
    locModeRef,
    healthModeRef,
    deadMode,
    deadModeRef,
    security,
    securityModeRef,
    securityFilesRef,
    labelMode,
    labelModeRef,
    labelShift,
    labelShiftRef,
    labelLevel,
    labelLevelRef,
    maxDepthRef,
    maxDirDepthRef,
    nodeDepthsRef,
    pinned,
    togglePin,
  } = useGraphOverlays({
    activeFolder,
    graphRef,
    containerRef,
    data,
    hiddenExts,
    metricsIgnoredExtsRef,
    healthMode,
    onHealthModeChange,
    selected,
  });

  // Mirror of the batched-nodes toggle, read live by nodeObjectFactory to hide
  // the per-node base sprite (kept as the raycast pick proxy) — seeded from the
  // persisted setting on first render so init builds sprites at the right
  // visibility, then kept in sync for runtime toggles.
  const batchedNodesRef = useRefMirror(settings.batchedNodes);

  // The `W` worktree overlay's live path→color snapshot (null while inactive).
  // Written by useWorktreeHighlight, read by nodeObjectFactory so any full
  // sprite rebuild while the view is active re-attaches the rings instead of
  // dropping them (see worktreeRingSync).
  const worktreeRingsRef = useRef<Map<string, string> | null>(null);

  useForceGraphInitialization(containerRef, graphRef, {
    settingsRef,
    selectedRef,
    dataRef,
    locModeRef,
    healthModeRef,
    deadModeRef,
    securityModeRef,
    securityFilesRef,
    labelModeRef,
    labelShiftRef,
    labelLevelRef,
    nodeDepthsRef,
    changeMapRef,
    metricsIgnoredExtsRef,
    batchedNodesRef,
    worktreeRingsRef,
    pointerOutsideRef,
    onHoverNodeChange,
    onRendererFailure,
    onContextLost,
    onContextRestored,
  });

  // Save the camera position/orbit target per project and restore it on mount /
  // project switch, so a page refresh keeps the user's vantage point.
  useCameraPersistence(graphRef, activeFolder);

  // True while a recolor view (health/loc/dead) is showing. These views pare the
  // graph down to the metric signal — hiding ghost nodes + metrics-ignored files
  // and suppressing change-rings — so the batched-link buffer must re-capture
  // its visible set when this flips (see useBatchedLinks).
  const metricOverlayActive = security.active || healthMode || locMode || deadMode;

  // `setSelected` is the coordinator's useState setter (identity-stable), so the
  // empty deps match the original in-component callback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resetSelection = useCallback(() => setSelected(new Set()), []);

  // `dataGeneration` bumps on every full graphData() swap (incl. the git-history
  // ghost merge, which doesn't touch `structuralData`). Threaded into the
  // batched renderers below so they re-capture the fresh node/link arrays after
  // a swap instead of rendering the orphaned pre-swap objects.
  const { dataGeneration } = useGraphDataSync({
    graphRef,
    data,
    history,
    onResetSelection: resetSelection,
    healthModeRef,
    locModeRef,
    deadModeRef,
  });

  // Radial tidy-tree untangle: on first load (and via the Spread tab's "Untangle
  // now" button) seed each subtree into its own angular wedge so sibling
  // subtrees don't tangle, then let the physics settle from that seed. On by
  // default. Placed after the data sync so the nodes are in the sim.
  const runLayout = useRadialTidyLayout(
    graphRef,
    structuralData,
    settingsRef,
    activeFolder,
  );

  // Batched link rendering: collapse the library's per-link Line objects into a
  // single LineSegments so orbiting a settled graph isn't E extra draw calls per
  // frame. Keyed off graphData swaps, so identical structural rescans neither
  // rebuild GPU buffers nor wake an otherwise settled scene.
  useBatchedLinks(
    graphRef,
    settings.batchedLinks,
    hiddenExts,
    dataGeneration,
    metricOverlayActive,
    settings.showLinks,
    security.active,
  );

  // Batched node rendering: draw the base node shapes as a few instanced meshes
  // (one per file type) instead of N Sprite-bearing Groups, so orbiting a
  // settled graph isn't ~N node draw calls per frame. The per-node sprite stays
  // mounted-but-invisible as the pick proxy (see nodeObjectFactory); recolor
  // overlays (health/loc/dead) fall back to the per-node path. Like links, the
  // buffers rebuild only when graphData or the visible rendering settings change.
  useInstancedNodes(
    graphRef,
    settings.batchedNodes,
    hiddenExts,
    settings,
    { settingsRef, healthModeRef, locModeRef, deadModeRef, securityModeRef },
    dataGeneration,
    metricOverlayActive,
  );

  // Drag UX: dragging a node carries its descendant subtree along and locks the
  // node to its DAG level (Y) so a drag only slides it within its plane. Rides
  // the shared node-motion driver's drag callback; active regardless of the
  // batched-render toggles.
  useNodeDragBehavior(graphRef);

  // Claude agent nodes + focus beams (in-progress Claude tasks), and the
  // `W`-hold worktree-modified file outline. Both read live task data over
  // their own `/ws/tasks` subscription and draw straight into the scene.
  useAgentOverlay(graphRef, settingsRef, activeFolder);
  const { worktreeActive } = useWorktreeHighlight(
    graphRef,
    settingsRef,
    activeFolder,
    pinned.worktree,
    worktreeRingsRef,
  );

  return {
    settings,
    setSettings,
    history,
    range,
    setRange,
    locMode,
    deadMode,
    security,
    labelMode,
    labelShift,
    labelLevel,
    maxDepthRef,
    maxDirDepthRef,
    pinned,
    togglePin,
    resetSelection,
    dataGeneration,
    runLayout,
    worktreeActive,
  };
}
