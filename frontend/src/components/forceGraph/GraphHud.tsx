import { memo } from 'react';
import type { GraphNode } from '../../api';
import { GraphSearchBar } from './GraphSearchBar';
import { HealthTooltip } from './HealthTooltip';
import type { SearchStatus } from './hooks/useGraphSearch';

type Counts = { files: number; dirs: number; hidden: number; loc: number };

type Props = {
  loading: boolean;
  // Only whether a scan has loaded — the HUD reads no field of the scan
  // (counts arrive via the stable `counts` memo). Passing a boolean instead of
  // the full ScanResult keeps this memo'd component off the per-save render
  // path: `data` gets a fresh reference on every metric-only HealthUpdate, so
  // the old `data` prop made the memo bail on every file save.
  hasData: boolean;
  counts: Counts;
  healthMode: boolean;
  locMode: boolean;
  deadMode: boolean;
  labelMode: boolean;
  labelLevel: number;
  maxDepth: number;
  // Number of nodes the user has selected. While Alt is held a non-zero count
  // narrows the label overlay to just those nodes (depth scrolling disabled).
  selectionCount: number;
  hoverNode: GraphNode | null;
  // Search bar (bottom-left, inline with the counts chip).
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  searchRegex: boolean;
  onSearchRegexToggle: () => void;
  searchContents: boolean;
  onSearchContentsToggle: () => void;
  searchStatus: SearchStatus;
  // Match navigation (prev/next stepping through the search matches).
  searchMatchPosition: number;
  onSearchPrevMatch: () => void;
  onSearchNextMatch: () => void;
};

// Render-only overlays: scan spinner (top-left), the active-view chip
// (top-center-ish), the file/dir counts chip (bottom-left), and the
// hover tooltip that anchors to the cursor.
export const GraphHud = memo(function GraphHud({
  loading,
  hasData,
  counts,
  healthMode,
  locMode,
  deadMode,
  labelMode,
  labelLevel,
  maxDepth,
  selectionCount,
  hoverNode,
  searchQuery,
  onSearchQueryChange,
  searchRegex,
  onSearchRegexToggle,
  searchContents,
  onSearchContentsToggle,
  searchStatus,
  searchMatchPosition,
  onSearchPrevMatch,
  onSearchNextMatch,
}: Props) {
  return (
    <>
      {loading && (
        <div className="graph-overlay top-left">
          <span className="spinner" />
          <span>Scanning…</span>
        </div>
      )}
      {healthMode && <div className="loc-view-chip">View: Code Health</div>}
      {locMode && !healthMode && (
        <div className="loc-view-chip">View: Lines of Code</div>
      )}
      {deadMode && !locMode && !healthMode && (
        <div className="loc-view-chip">
          View: Dead Code
          <span style={{ opacity: 0.7, marginLeft: 8 }}>
            (green reachable · red dead · grey entry/uncertain)
          </span>
        </div>
      )}
      {labelMode && !deadMode && !locMode && !healthMode && (
        <div className="loc-view-chip">
          {selectionCount > 0 ? (
            <>
              View: Labels · {selectionCount} selected
              <span style={{ opacity: 0.7, marginLeft: 8 }}>
                (showing selected nodes)
              </span>
            </>
          ) : (
            <>
              View: Labels · depth {labelLevel}
              {maxDepth > 0 && ` / ${maxDepth}`}
              <span style={{ opacity: 0.7, marginLeft: 8 }}>
                (alt+wheel to scroll)
              </span>
            </>
          )}
        </div>
      )}
      {hoverNode && <HealthTooltip node={hoverNode} />}
      {hasData && (
        <div className="graph-bottom-left">
          <GraphSearchBar
            query={searchQuery}
            onQueryChange={onSearchQueryChange}
            regex={searchRegex}
            onRegexToggle={onSearchRegexToggle}
            contents={searchContents}
            onContentsToggle={onSearchContentsToggle}
            status={searchStatus}
            matchPosition={searchMatchPosition}
            onPrevMatch={onSearchPrevMatch}
            onNextMatch={onSearchNextMatch}
          />
          <div className="graph-overlay graph-counts">
            <span>
              {counts.files} files · {counts.dirs} dirs ·{' '}
              {counts.loc.toLocaleString()} LOC
              {counts.hidden > 0 && (
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {' '}
                  · {counts.hidden} hidden
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    </>
  );
});
