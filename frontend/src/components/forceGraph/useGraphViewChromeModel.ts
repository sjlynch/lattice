import { useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { GitHistoryResult, ScanResult } from '../../api';
import { useGraphCounts } from './hooks/useGraphCounts';
import { useOverlayActive } from './hooks/useOverlayActive';
import type { OverlayPinKey, OverlayPins } from './hooks/useOverlayPins';
import type { GraphSettings } from './graphSettings';
import type { GraphViewChromeProps } from './GraphViewChrome';
import type { GraphViewOverlaysProps } from './GraphViewOverlays';

type TimelineRange = { left: number; right: number };

type HudSearchProps = Pick<
  GraphViewOverlaysProps['hud'],
  | 'searchQuery'
  | 'onSearchQueryChange'
  | 'searchRegex'
  | 'onSearchRegexToggle'
  | 'searchContents'
  | 'onSearchContentsToggle'
  | 'searchStatus'
  | 'searchMatchPosition'
  | 'onSearchPrevMatch'
  | 'onSearchNextMatch'
>;

type OverlayModeState = {
  healthMode: boolean;
  locMode: boolean;
  deadMode: boolean;
  labelMode: boolean;
  labelLevel: number;
  labelShift: boolean;
  worktreeActive: boolean;
};

type UseGraphViewChromeModelArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  data: ScanResult | null;
  structuralData: ScanResult | null;
  hiddenExts: Set<string>;
  activeFolder: string;
  history: GitHistoryResult | null;
  range: TimelineRange;
  setRange: Dispatch<SetStateAction<TimelineRange>>;
  modes: OverlayModeState;
  maxDepthRef: MutableRefObject<number>;
  maxDirDepthRef: MutableRefObject<number>;
  selected: Set<string>;
  resetSelection: () => void;
  hoverNode: GraphViewOverlaysProps['hud']['hoverNode'];
  contextMenu: GraphViewOverlaysProps['contextMenu']['position'];
  search: HudSearchProps;
  pinned: OverlayPins;
  security: GraphViewOverlaysProps['overlayKey']['security'];
  togglePin: (key: OverlayPinKey) => void;
  dragRect: GraphViewOverlaysProps['drag']['dragRect'];
  openMenuItem: GraphViewOverlaysProps['contextMenu']['onPick'];
  taskModal: Omit<GraphViewOverlaysProps['taskModal'], 'rootPath'>;
  toast: string | null;
  settings: GraphSettings;
  setSettings: Dispatch<SetStateAction<GraphSettings>>;
  runLayout: () => void;
};

// Shapes the coordinator's state into render-only chrome props. Keeping this
// assembly next to the chrome types lets ForceGraphView stay focused on graph
// lifecycle hooks, refs, and runtime scene orchestration.
export function useGraphViewChromeModel({
  containerRef,
  loading,
  data,
  structuralData,
  hiddenExts,
  activeFolder,
  history,
  range,
  setRange,
  modes,
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
}: UseGraphViewChromeModelArgs): GraphViewChromeProps {
  // File/dir/hidden counts for the HUD chip — keyed off the structure-stable
  // scan reference so it skips the O(N) recount on every metric-only save.
  const counts = useGraphCounts(structuralData, hiddenExts);

  // Stable range handler so the memoized timeline doesn't re-render needlessly.
  const handleRangeChange = useCallback(
    (l: number, r: number) =>
      setRange((cur) =>
        cur.left === l && cur.right === r ? cur : { left: l, right: r },
      ),
    [setRange],
  );

  // Which overlay views are currently *showing* (held OR pinned), for the
  // overlay-key chips' lit "active" state.
  const overlayActive = useOverlayActive({
    health: modes.healthMode,
    loc: modes.locMode,
    dead: modes.deadMode,
    worktree: modes.worktreeActive,
    labels: modes.labelMode,
  });

  // The bottom-anchored counts chip and gear FAB shift up when the timeline is
  // visible so the timeline can claim the entire viewport bottom edge. Any git
  // repo gets the bar — a repo with no commits yet (a freshly created project)
  // shows the scrubber's "No commits yet" state rather than nothing at all,
  // which read as "the timeline is broken" for exactly the projects a user had
  // just created.
  const hasTimeline = !!history && history.isRepo;

  return {
    hasTimeline,
    containerRef,
    overlays: {
      hud: {
        loading,
        hasData: !!data,
        counts,
        healthMode: modes.healthMode && !security.active,
        locMode: modes.locMode && !security.active,
        deadMode: modes.deadMode && !security.active,
        labelMode: modes.labelMode && !security.active,
        labelLevel: modes.labelLevel,
        maxDepth: modes.labelShift ? maxDepthRef.current : maxDirDepthRef.current,
        selectionCount: selected.size,
        // Suppress the file hover tooltip while the right-click menu is open
        // so it doesn't sit over the menu. Gating (rather than a one-shot
        // clear) also keeps it from flickering back if the raycaster re-hovers
        // the still-under-cursor node while the menu is up.
        hoverNode: contextMenu || security.active ? null : hoverNode,
        ...search,
      },
      overlayKey: {
        show: !!data,
        pinned,
        active: overlayActive,
        onTogglePin: togglePin,
        security,
      },
      timeline: {
        show: hasTimeline,
        commits: history?.commits ?? [],
        left: range.left,
        right: range.right,
        onChange: handleRangeChange,
        hasUncommitted: (history?.uncommitted.changes.length ?? 0) > 0,
      },
      drag: { dragRect },
      selection: { count: selected.size, onClear: resetSelection },
      contextMenu: { position: contextMenu, onPick: openMenuItem },
      taskModal: {
        ...taskModal,
        rootPath: data?.root || activeFolder,
      },
      toast: { toast },
      settings: {
        settings,
        onChange: setSettings,
        project: activeFolder,
        onRunLayout: runLayout,
      },
    },
  };
}
