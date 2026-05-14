import type { GraphNode, ScanResult } from '../../api';
import { HealthTooltip } from './HealthTooltip';

type Counts = { files: number; dirs: number; hidden: number };

type Props = {
  loading: boolean;
  data: ScanResult | null;
  counts: Counts;
  healthMode: boolean;
  locMode: boolean;
  labelMode: boolean;
  labelLevel: number;
  maxDepth: number;
  hoverNode: GraphNode | null;
  hoverPos: { x: number; y: number } | null;
};

// Render-only overlays: scan spinner (top-left), the active-view chip
// (top-center-ish), the file/dir counts chip (bottom-left), and the
// hover tooltip that anchors to the cursor.
export function GraphHud({
  loading,
  data,
  counts,
  healthMode,
  locMode,
  labelMode,
  labelLevel,
  maxDepth,
  hoverNode,
  hoverPos,
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
      {labelMode && !locMode && !healthMode && (
        <div className="loc-view-chip">
          View: Labels · depth {labelLevel}
          {maxDepth > 0 && ` / ${maxDepth}`}
          <span style={{ opacity: 0.7, marginLeft: 8 }}>
            (alt+wheel to scroll)
          </span>
        </div>
      )}
      {hoverNode && hoverPos && (
        <HealthTooltip node={hoverNode} x={hoverPos.x} y={hoverPos.y} />
      )}
      {!loading && data && (
        <div className="graph-overlay bottom-left">
          <span>
            {counts.files} files · {counts.dirs} dirs
            {counts.hidden > 0 && (
              <span style={{ color: 'var(--text-tertiary)' }}>
                {' '}
                · {counts.hidden} hidden
              </span>
            )}
          </span>
        </div>
      )}
    </>
  );
}
