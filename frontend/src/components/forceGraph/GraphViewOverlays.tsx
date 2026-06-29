import type { ComponentProps } from 'react';
import { GraphContextMenu } from './GraphContextMenu';
import { GraphHud } from './GraphHud';
import { GraphOverlayKey } from './GraphOverlayKey';
import { GraphSelectionChip } from './GraphSelectionChip';
import { GraphSettingsChrome } from './GraphSettingsChrome';
import { GraphTaskModal } from './GraphTaskModal';
import { TimelineScrubber } from './TimelineScrubber';

type HudChromeProps = ComponentProps<typeof GraphHud>;
type OverlayKeyChromeProps = ComponentProps<typeof GraphOverlayKey> & {
  show: boolean;
};
type TimelineChromeProps = ComponentProps<typeof TimelineScrubber> & {
  show: boolean;
};
type DragRectChromeProps = {
  dragRect: { x1: number; y1: number; x2: number; y2: number } | null;
};
type SelectionChipChromeProps = ComponentProps<typeof GraphSelectionChip>;
type ContextMenuChromeProps = ComponentProps<typeof GraphContextMenu>;
type TaskModalChromeProps = ComponentProps<typeof GraphTaskModal>;
type ToastChromeProps = { toast: string | null };
type SettingsChromeProps = ComponentProps<typeof GraphSettingsChrome>;

export type GraphViewOverlaysProps = {
  hud: HudChromeProps;
  overlayKey: OverlayKeyChromeProps;
  timeline: TimelineChromeProps;
  drag: DragRectChromeProps;
  selection: SelectionChipChromeProps;
  contextMenu: ContextMenuChromeProps;
  taskModal: TaskModalChromeProps;
  toast: ToastChromeProps;
  settings: SettingsChromeProps;
};

export function GraphViewOverlays({
  hud,
  overlayKey,
  timeline,
  drag,
  selection,
  contextMenu,
  taskModal,
  toast,
  settings,
}: GraphViewOverlaysProps) {
  const { show: showOverlayKey, ...overlayKeyProps } = overlayKey;
  const { show: showTimeline, ...timelineProps } = timeline;

  return (
    <>
      <GraphHud {...hud} />

      {/* Always-visible key for the hold-key overlays (top-left). Each chip
          documents a view + shortcut and pins it on click. Gated on loaded data
          so it never overlaps the top-left scan spinner (loading is true only
          while data is null). */}
      {showOverlayKey && <GraphOverlayKey {...overlayKeyProps} />}

      {showTimeline && (
        <div className="timeline-bar">
          <TimelineScrubber {...timelineProps} />
        </div>
      )}

      {drag.dragRect && (
        <div
          className="graph-select-rect"
          style={{
            left: Math.min(drag.dragRect.x1, drag.dragRect.x2),
            top: Math.min(drag.dragRect.y1, drag.dragRect.y2),
            width: Math.abs(drag.dragRect.x2 - drag.dragRect.x1),
            height: Math.abs(drag.dragRect.y2 - drag.dragRect.y1),
          }}
        />
      )}

      <GraphSelectionChip {...selection} />
      <GraphContextMenu {...contextMenu} />
      <GraphTaskModal {...taskModal} />

      {toast.toast && (
        <div className="graph-toast" role="status">
          {toast.toast}
        </div>
      )}

      <GraphSettingsChrome {...settings} />
    </>
  );
}
