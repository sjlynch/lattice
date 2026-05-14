import { useLayoutEffect, type MutableRefObject } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import type { GraphNode } from '../../../api';
import { healthLabelRegistry } from '../healthOverlay';
import { labelsRegistry } from '../labelsOverlay';
import { locLabelRegistry } from '../locOverlay';
import {
  buildNodeObject,
  nativeNodeLabel,
  type NodeObjectRefs,
} from '../nodeObjectFactory';
import { configureCameraControls, createResizeObserver } from '../sceneSetup';

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
      .linkWidth(0.7)
      .dagMode('td')
      .dagLevelDistance(nodeRefs.settingsRef.current.dagLevelDistance)
      .showNavInfo(false)
      .onNodeHover((n: object | null) => {
        // Track the hovered file node so HealthTooltip can render its
        // breakdown panel. Directories don't have health metrics, so
        // they never trigger the tooltip even though the listener still
        // fires for them.
        if (!n) {
          onHoverNodeChange(null);
          return;
        }
        const node = n as GraphNode;
        if (node.kind !== 'file' || node.healthDetails == null) {
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
    const teardownResize = createResizeObserver(graph, container);

    return () => {
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
