import type { MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { useLayoutShapeSettings } from './useGraphSettingsLayoutShape';
import { usePhysicsAndRepulsionSettings } from './useGraphSettingsPhysics';
import {
  useLinkWidthSetting,
  useRenderPixelRatioSetting,
} from './useGraphSettingsRendering';
import { useSpriteAndMetricLabelRefresh } from './useGraphSettingsSprites';
import { usePerProjectGraphSettings } from './usePerProjectGraphSettings';

// Owns the GraphSettings state, mirrored ref, and per-project localStorage
// persistence. Focused hooks below drive sprite-size refreshes, physics reheats,
// layout-shape forces, and renderer settings when the user tweaks values from
// the panel.
//
// The ref keeps the latest value visible to THREE callbacks (nodeThreeObject is
// wired once at mount) while the state drives the panel UI.
export function useGraphSettings(
  activeFolder: string,
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
) {
  const graphSettings = usePerProjectGraphSettings(activeFolder);
  const { settings } = graphSettings;

  useSpriteAndMetricLabelRefresh(settings, graphRef);

  // labelSpread doesn't need its own effect: the overlay RAFs run continuously
  // while their key is held and read `settingsRef.current.labelSpread` fresh
  // every tick, so the new minDist takes effect on the next frame after the
  // slider moves.

  usePhysicsAndRepulsionSettings(settings, graphRef);
  useLayoutShapeSettings(settings, graphRef);
  useRenderPixelRatioSetting(settings, graphRef);
  useLinkWidthSetting(settings, graphRef);

  return graphSettings;
}
