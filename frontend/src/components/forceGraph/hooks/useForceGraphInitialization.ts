import { useLayoutEffect, useRef, type MutableRefObject } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../../../api';
import { healthLabelRegistry } from '../healthOverlay';
import { labelsRegistry } from '../labelsOverlay';
import { locLabelRegistry } from '../locOverlay';
import { attachIdleController, createIdleController } from '../idleController';
import {
  buildNodeObject,
  nativeNodeLabel,
  type NodeObjectRefs,
} from '../nodeObjectFactory';
import {
  configureCameraControls,
  configureRenderer,
  createResizeObserver,
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

  // The graph (and its `nodeThreeObject` closure) is created once, below.
  // Capturing the `nodeRefs` *object* directly would freeze the set of refs
  // to that first render — fine in production (the inner refs are stable),
  // but under HMR a newly-added ref (e.g. `labelShiftRef`) is absent from the
  // stale captured bundle, so a later `graph.refresh()` runs the new
  // `buildNodeObject` against an old bundle and throws on `…Ref.current`.
  // Hold the latest bundle in a stable ref and read it inside the closure so
  // the accessor always sees the current set, present and future refs alike.
  const nodeRefsRef = useRef(nodeRefs);
  nodeRefsRef.current = nodeRefs;

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const graph = new ForceGraph3D(container, { controlType: 'orbit' })
      .backgroundColor('#1a1d22')
      .nodeId('id')
      .nodeLabel((n: object) => nativeNodeLabel(n as GraphNode))
      .nodeThreeObject((n: object) =>
        buildNodeObject(n as GraphNode, nodeRefsRef.current),
      )
      .nodeRelSize(1)
      .linkColor(() => 'rgba(220,228,240,0.55)')
      .linkOpacity(0.85)
      .linkWidth(0.7)
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
    configureRenderer(graph);
    const teardownResize = createResizeObserver(graph, container);

    // Render-on-demand: 3d-force-graph runs a perpetual RAF render loop by
    // default. We pause it whenever the physics engine has settled AND the
    // user isn't interacting AND no overlay RAF is active. See
    // `idleController.ts` for the full reason set.
    const idle = createIdleController(graph, container);
    attachIdleController(graph, idle);
    // The engine warms up immediately on first data load; hold the reason
    // until `onEngineStop` fires (also fires after each later reheat).
    idle.engineStarted();
    graph.onEngineStop(() => idle.engineStopped());

    return () => {
      idle.destroy();
      teardownResize();
      locLabelRegistry.clear();
      labelsRegistry.clear();
      healthLabelRegistry.clear();
      graph._destructor?.();
      graphRef.current = null;
    };
    // The accessor closures only ever read from the supplied refs, so
    // their identity is stable for the lifetime of the component and we
    // intentionally mount/teardown exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
