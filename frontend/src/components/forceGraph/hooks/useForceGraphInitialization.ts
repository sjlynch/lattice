import { useLayoutEffect, type MutableRefObject } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../../../api';
import { attachNodeMotionDriver } from '../nodeMotionDriver';
import { attachIdleController, createIdleController } from '../idleController';
import { attachFrameDriver, onFrame } from '../sceneFrameDriver';
import { clearAllLabelRegistries } from './refresh';
import {
  buildNodeObject,
  nativeNodeLabel,
  type NodeObjectRefs,
} from '../nodeObjectFactory';
import {
  configureCameraControls,
  configureRenderer,
  createResizeObserver,
  guardNodeRightClickCrash,
} from '../sceneSetup';

export type ForceGraphInitializationSettings = NodeObjectRefs & {
  onHoverNodeChange: (node: GraphNode | null) => void;
};

// Mounts and configures the ForceGraph3D/THREE scene exactly once. The graph's
// accessors intentionally read from refs so overlay/settings/selection changes
// can refresh sprites without tearing down the expensive WebGL scene.
export function useForceGraphInitialization(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settings: ForceGraphInitializationSettings,
) {
  const { onHoverNodeChange, ...nodeRefs } = settings;

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const graph = new ForceGraph3D(container, { controlType: 'orbit' })
      .backgroundColor('#1a1d22')
      .nodeId('id')
      .nodeLabel((n: object) => nativeNodeLabel(n as GraphNode))
      .nodeThreeObject((n: object) => buildNodeObject(n as GraphNode, nodeRefs))
      .nodeRelSize(1)
      .linkColor(() => 'rgba(220,228,240,0.55)')
      .linkOpacity(0.85)
      .linkWidth(nodeRefs.settingsRef.current.linkWidth)
      .dagMode('td')
      .dagLevelDistance(nodeRefs.settingsRef.current.dagLevelDistance)
      // Engine settle bounds. The library defaults to
      // `cooldownTime: 15000`, `cooldownTicks: Infinity`, `d3AlphaMin: 0`
      // — which means the *only* stop condition is 15 s of wall clock
      // from the last graphData()/reheat. On a busy dev box (vite HMR,
      // tsc emit, AV scans) ScanResult re-pushes arrive faster than 15 s
      // and the engine never settles, defeating the idle controller.
      // We bound by ticks AND alpha so a reheat reliably ends in 2–4 s
      // of real motion regardless of wall-clock interruptions.
      .cooldownTicks(400)
      .cooldownTime(8000)
      .d3AlphaMin(0.005)
      .showNavInfo(false)
      .onNodeHover((n: object | null) => {
        // Track the hovered file node so HealthTooltip can render its
        // breakdown panel. Directories never anchor the tooltip; for
        // files we forward the node unconditionally and let the tooltip
        // null-guard handle "no health data" — checking healthDetails
        // here was racing with `graph.refresh()` after the `h` keydown
        // and silently dropping legitimate hovers.
        if (!n) {
          onHoverNodeChange(null);
          return;
        }
        const node = n as GraphNode;
        if (node.kind !== 'file') {
          onHoverNodeChange(null);
          return;
        }
        onHoverNodeChange(node);
      })
      .onNodeRightClick((_n: object, ev: MouseEvent) => {
        // The container-level contextmenu listener already opens the menu;
        // just suppress the browser's native menu here too in case the
        // canvas event bubbles differently.
        ev.preventDefault();
      });

    graphRef.current = graph;
    configureCameraControls(graph);
    // Must run before the first pointer interaction (see fn doc) — wrap the
    // controls' pointerup handler so a right-click on a node can't crash the
    // library's drag→camera handoff.
    guardNodeRightClickCrash(graph);
    configureRenderer(graph, nodeRefs.settingsRef.current.pixelRatio);
    const teardownResize = createResizeObserver(graph, container);

    // Render-on-demand: 3d-force-graph runs a perpetual RAF render loop by
    // default. We pause it whenever the physics engine has settled AND the
    // user isn't interacting AND no overlay RAF is active. See
    // `idleController.ts` for the full reason set.
    const idle = createIdleController(graph, container);
    attachIdleController(graph, idle);
    // Single per-frame dispatcher over scene.onBeforeRender, shared by the
    // Agent Presence Layer + the label-repulsion overlays (see sceneFrameDriver).
    attachFrameDriver(graph);
    // Single fan-out over the library's one-slot node-motion callbacks
    // (`onEngineTick` + `onNodeDrag`/`onNodeDragEnd`), shared by the batched-link
    // + batched-node position sync (see nodeMotionDriver).
    attachNodeMotionDriver(graph);
    // Feed each rendered frame to the idle controller so it can duty-cycle the
    // loop down to ~30fps while only slow self-animations are driving it.
    const offThrottleFrame = onFrame(graph, () => idle.notifyFrameRendered());
    // The engine warms up immediately on first data load; hold the reason
    // until `onEngineStop` fires (also fires after each later reheat).
    idle.engineStarted();
    graph.onEngineStop(() => idle.engineStopped());

    return () => {
      offThrottleFrame();
      idle.destroy();
      teardownResize();
      clearAllLabelRegistries();
      graph._destructor?.();
      graphRef.current = null;
    };
    // The accessor closures only ever read from the supplied refs, so
    // their identity is stable for the lifetime of the component and we
    // intentionally mount/teardown exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
