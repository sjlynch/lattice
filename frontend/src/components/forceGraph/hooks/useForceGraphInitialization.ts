import { useLayoutEffect, type MutableRefObject } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
import type { GraphNode, ScanResult } from '../../../api';
import { deletedSprite, withChangeRing, type ChangeKind } from '../changeRing';
import type { GraphSettings } from '../graphSettings';
import { withHalo } from '../halo';
import { healthLabelRegistry, spriteForHealth } from '../healthOverlay';
import { labelsRegistry, spriteForLabels } from '../labelsOverlay';
import { locLabelRegistry, spriteForLoc } from '../locOverlay';
import { spriteFor } from '../sprites';
import { isGhost, relForward } from '../timelineDiff';

export type ForceGraphInitializationSettings = {
  settingsRef: MutableRefObject<GraphSettings>;
  selectedRef: MutableRefObject<Set<string>>;
  dataRef: MutableRefObject<ScanResult | null>;
  locModeRef: MutableRefObject<boolean>;
  healthModeRef: MutableRefObject<boolean>;
  labelModeRef: MutableRefObject<boolean>;
  labelLevelRef: MutableRefObject<number>;
  nodeDepthsRef: MutableRefObject<Map<string, number>>;
  changeMapRef: MutableRefObject<Map<string, ChangeKind>>;
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
  const {
    settingsRef,
    selectedRef,
    dataRef,
    locModeRef,
    healthModeRef,
    labelModeRef,
    labelLevelRef,
    nodeDepthsRef,
    changeMapRef,
    onHoverNodeChange,
  } = settings;

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const graph = new ForceGraph3D(containerRef.current, {
      controlType: 'orbit',
    })
      .backgroundColor('#1a1d22')
      .nodeId('id')
      .nodeLabel((n: object) => {
        const node = n as GraphNode;
        // For files we always show our richer HealthTooltip on hover
        // (regardless of whether the `h` key is held), so suppress the
        // library's native label here to avoid stacking two tooltips
        // on top of each other. Directories don't have health data,
        // so they keep the simple library tooltip.
        if (node.kind === 'file') return '';
        return `📁 ${node.name}`;
      })
      .nodeThreeObject((n: object) => {
        const node = n as GraphNode;
        const s = settingsRef.current;
        const baseSize = node.kind === 'dir' ? s.dirNodeSize : s.fileNodeSize;

        // Ghost nodes (deleted files surfaced from git history) only
        // exist in the graph because the scrubber range picks up a
        // delete event somewhere — render them as a small grey disc
        // with a red ring instead of running spriteFor on a path that
        // has no real file behind it.
        if (isGhost(node)) {
          let obj: THREE.Object3D = deletedSprite(s.fileNodeSize);
          if (selectedRef.current.has(node.id)) {
            obj = withHalo(obj, s.fileNodeSize);
          }
          return obj;
        }

        let obj: THREE.Object3D;
        if (healthModeRef.current) {
          obj = spriteForHealth(node, s);
        } else if (locModeRef.current) {
          obj = spriteForLoc(node, s);
        } else if (labelModeRef.current) {
          const d = nodeDepthsRef.current.get(node.id) ?? 0;
          obj = spriteForLabels(node, s, labelLevelRef.current, d);
        } else {
          obj = spriteFor(node, s);
        }
        // Apply change ring before halo so the selection halo always
        // wraps the outermost layer.
        const root = dataRef.current?.root || '';
        const rel = node.kind === 'file' ? relForward(node.path, root) : '';
        const kind = rel ? changeMapRef.current.get(rel) : undefined;
        if (kind && kind !== 'deleted') {
          obj = withChangeRing(obj, baseSize, kind);
        }
        if (selectedRef.current.has(node.id)) {
          return withHalo(obj, baseSize);
        }
        return obj;
      })
      .nodeRelSize(1)
      .linkColor(() => 'rgba(220,228,240,0.55)')
      .linkOpacity(0.85)
      .linkWidth(0.7)
      .dagMode('td')
      .dagLevelDistance(settingsRef.current.dagLevelDistance)
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

    // Lock the world up vector so the camera and any look-at animation
    // (computeLookAtQuaternion etc.) treat +Y as up — prevents 180° flips.
    graph.camera().up.set(0, 1, 0);

    const controls = graph.controls() as {
      minPolarAngle: number;
      maxPolarAngle: number;
      enableRotate?: boolean;
      update?: () => void;
    };
    if (controls) {
      // Camera can swing from straight overhead all the way down to ~45°
      // below horizon (PI * 0.75 ≈ 135° from +Y), enough to peek up at the
      // graph from underneath without ever flipping the root to the bottom.
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI * 0.75;
      controls.update?.();
    }

    const onResize = () => {
      if (!containerRef.current) return;
      graph.width(containerRef.current.clientWidth);
      graph.height(containerRef.current.clientHeight);
    };
    onResize();
    // Debounce so a sidebar drag (60+ events/sec) only triggers one Three.js
    // resize per settled frame rather than thrashing the GPU every pixel.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(onResize, 150);
    });
    ro.observe(containerRef.current);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      locLabelRegistry.clear();
      labelsRegistry.clear();
      healthLabelRegistry.clear();
      graph._destructor?.();
      graphRef.current = null;
    };
  }, [
    containerRef,
    graphRef,
    settingsRef,
    selectedRef,
    dataRef,
    locModeRef,
    healthModeRef,
    labelModeRef,
    labelLevelRef,
    nodeDepthsRef,
    changeMapRef,
    onHoverNodeChange,
  ]);
}
