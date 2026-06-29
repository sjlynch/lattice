import { useEffect, useRef } from 'react';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { applyRenderPixelRatio } from '../sceneSetup';
import { type GraphRef, hasMountedNodes } from './graphSettingsEffectUtils';

export function useRenderPixelRatioSetting(
  settings: Pick<GraphSettings, 'pixelRatio'>,
  graphRef: GraphRef,
): void {
  // Render scale (pixelRatio): re-size the WebGL drawing buffer to the new cap.
  const appliedPixelRatioRef = useRef(settings.pixelRatio);
  useEffect(() => {
    const prev = appliedPixelRatioRef.current;
    const changed = prev !== settings.pixelRatio;
    appliedPixelRatioRef.current = settings.pixelRatio;
    const g = graphRef.current;
    if (!changed || !g) return;
    applyRenderPixelRatio(g, settings.pixelRatio);
    getIdleController(g)?.wakeForRefresh();
  }, [settings.pixelRatio, graphRef]);
}

export function useLinkWidthSetting(
  settings: Pick<GraphSettings, 'linkWidth'>,
  graphRef: GraphRef,
): void {
  // Link width is a render-only prop (no physics reheat). Changing it rebuilds
  // the link objects, so wake the loop a few frames to paint them.
  const appliedLinkWidthRef = useRef(settings.linkWidth);
  useEffect(() => {
    const prev = appliedLinkWidthRef.current;
    const changed = prev !== settings.linkWidth;
    appliedLinkWidthRef.current = settings.linkWidth;
    const g = graphRef.current;
    if (!changed || !g || !hasMountedNodes(g)) return;
    g.linkWidth(settings.linkWidth);
    getIdleController(g)?.wakeForRefresh();
  }, [settings.linkWidth, graphRef]);
}
