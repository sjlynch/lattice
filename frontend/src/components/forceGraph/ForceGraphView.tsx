import { useCallback, useMemo, useRef, useState } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../api';
import { GraphViewChrome } from './GraphViewChrome';
import { GraphRendererNotice } from './GraphRendererNotice';
import { describeRendererFailure, type RendererStatus } from './rendererStatus';
import { useGraphViewChromeModel } from './useGraphViewChromeModel';
import { useStructuralScan } from '../../hooks/useStructuralScan';
import { useGraphSceneRuntime } from './hooks/useGraphSceneRuntime';
import { useGraphInteraction } from './hooks/useGraphInteraction';
import { useHoverNodeDebounce } from './hooks/useHoverNodeDebounce';
import { useCanvasDragTracking } from './hooks/useCanvasDragTracking';
import { usePointerLeaveTooltipDismiss } from './hooks/usePointerLeaveTooltipDismiss';
import { useRefMirror } from './hooks/useRefMirror';

type Props = {
  data: ScanResult | null;
  loading: boolean;
  hiddenExts: Set<string>;
  // Extensions (leading dot, lowercase) skipped by the LOC and code-health
  // overlays. Files with a matching extension fall back to their normal
  // sprite — no colored tint, no numeric label.
  metricsIgnoredExts: string[];
  activeFolder: string;
  // Code-health overlay state. Lifted to App so the Legend can swap to
  // a health breakdown panel while `h` is held; the keydown listener
  // still lives in this component and pushes changes back via the
  // callback below.
  healthMode: boolean;
  onHealthModeChange: (mode: boolean) => void;
};

type RendererCallbacks = {
  onRendererFailure: (error: unknown) => void;
  onContextLost: () => void;
  onContextRestored: () => void;
};

// A WebGL fault is the one mount failure the graph is expected to survive (the
// browser can refuse a context outright — see ./rendererStatus), so the
// exported component is a thin retry shell around the coordinator. Retry
// *remounts* it rather than re-running init alone: every hook below wires
// itself to the graph instance at mount, so a graph that appeared later would
// have nothing attached to it.
export function ForceGraphView(props: Props) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<RendererStatus>({ kind: 'ok' });

  const onRendererFailure = useCallback((error: unknown) => {
    console.error('[graph] renderer unavailable:', error);
    setStatus(describeRendererFailure(error));
  }, []);
  const onContextLost = useCallback(() => setStatus({ kind: 'lost' }), []);
  const onContextRestored = useCallback(() => setStatus({ kind: 'ok' }), []);
  const retry = useCallback(() => {
    setStatus({ kind: 'ok' });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <div className="graph-view-root">
      <ForceGraphViewCoordinator
        key={attempt}
        {...props}
        onRendererFailure={onRendererFailure}
        onContextLost={onContextLost}
        onContextRestored={onContextRestored}
      />
      {status.kind !== 'ok' && (
        <GraphRendererNotice status={status} onRetry={retry} />
      )}
    </div>
  );
}

// Hosts the 3d-force-graph instance and stitches together the per-concern
// hooks under ./hooks/ in phases: shared refs + hover state here, then the
// scene runtime (`useGraphSceneRuntime` — init, camera, data sync, layout,
// batched renderers, drag, agents, worktree rings), then the interaction layer
// (`useGraphInteraction` — search, menus, box select, task creation, halos,
// keyboard), then the chrome model. Hook order is load-bearing: the phases run
// in exactly this order, and refs are passed through, never copied.
// Render-only chrome lives in the Graph*.tsx siblings.
function ForceGraphViewCoordinator({
  data,
  loading,
  hiddenExts,
  metricsIgnoredExts,
  activeFolder,
  healthMode,
  onHealthModeChange,
  onRendererFailure,
  onContextLost,
  onContextRestored,
}: Props & RendererCallbacks) {
  // ----- Phase 1: shared refs and overlay state -----
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Hover tooltip state + its null-transition debounce (see the hook). Hover is
  // gated off while a pointer is dragging the canvas: the shared
  // `pointerDraggingRef` is read by the debounce and driven by the drag tracker,
  // which also calls `cancelPendingHoverClear` at drag start to hide the tooltip.
  // Likewise gated off while the cursor is outside the canvas (navbar, terminal
  // panel, a HUD panel): `pointerOutsideRef` is driven by the pointer-leave
  // dismiss, which hides any open tooltip on the way out.
  const pointerDraggingRef = useRef(false);
  const pointerOutsideRef = useRef(false);
  const { hoverNode, debouncedSetHoverNode, cancelPendingHoverClear } =
    useHoverNodeDebounce(pointerDraggingRef, pointerOutsideRef);
  useCanvasDragTracking(
    containerRef,
    graphRef,
    pointerDraggingRef,
    cancelPendingHoverClear,
  );
  usePointerLeaveTooltipDismiss(
    containerRef,
    graphRef,
    pointerOutsideRef,
    pointerDraggingRef,
    cancelPendingHoverClear,
  );

  const selectedRef = useRefMirror(selected);
  const hiddenExtsRef = useRefMirror(hiddenExts);
  const dataRef = useRefMirror(data);
  // Structure-only view of the scan: a reference that's stable across the
  // metric-only HealthUpdates that churn `data` on every file save, changing
  // only when files are added/removed/renamed. The file/dir counts read only
  // structural fields (kind/ext), so keying their memo off this skips the O(N)
  // recount + HUD re-render on every save.
  const structuralData = useStructuralScan(data);

  // Build a Set once per change so the lookup is O(1) per node. Lowercased
  // for case-insensitive matching against `node.ext`.
  const metricsIgnoredExtsSet = useMemo(
    () => new Set(metricsIgnoredExts.map((e) => e.toLowerCase())),
    [metricsIgnoredExts],
  );
  const metricsIgnoredExtsRef = useRefMirror(metricsIgnoredExtsSet);

  // ----- Phase 2: scene runtime (init, camera, data sync, layout, renderers) -----
  const {
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
  } = useGraphSceneRuntime({
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
    onHoverNodeChange: debouncedSetHoverNode,
    onRendererFailure,
    onContextLost,
    onContextRestored,
  });

  // ----- Phase 3: interaction (search, menus, box select, tasks, halos, keys) -----
  const { contextMenu, dragRect, openMenuItem, search, taskModal, toast } =
    useGraphInteraction({
      containerRef,
      graphRef,
      activeFolder,
      data,
      dataGeneration,
      settings,
      selected,
      setSelected,
      selectedRef,
      hiddenExtsRef,
      metricsIgnoredExtsSet,
      locMode,
      healthMode,
      cancelPendingHoverClear,
    });

  // ----- Phase 4: render data + JSX overlays -----
  const chrome = useGraphViewChromeModel({
    containerRef,
    loading,
    data,
    structuralData,
    hiddenExts,
    activeFolder,
    history,
    range,
    setRange,
    modes: {
      healthMode,
      locMode,
      deadMode,
      labelMode,
      labelLevel,
      labelShift,
      worktreeActive,
    },
    maxDepthRef,
    maxDirDepthRef,
    selected,
    resetSelection,
    hoverNode,
    contextMenu,
    search,
    pinned,
    security,
    togglePin,
    dragRect,
    openMenuItem,
    taskModal,
    toast,
    settings,
    setSettings,
    runLayout,
  });

  return <GraphViewChrome {...chrome} />;
}
