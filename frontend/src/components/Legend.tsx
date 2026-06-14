import { ChevronDown, ChevronRight } from 'lucide-react';
import { DEFAULT_STYLE } from '../extensionStyles';
import type { ScanResult } from '../api';
import { ShapePreview } from './legend/ShapePreview';
import { HealthLegendPanel } from './legend/HealthLegendPanel';
import { LegendRow } from './legend/LegendRow';
import { useLegendRows } from './legend/useLegendRows';
import { usePersistedToggle } from '../hooks/usePersistedToggle';

type Props = {
  data: ScanResult | null;
  hiddenExts: Set<string>;
  onToggleExt: (ext: string) => void;
  // While `h` is held in the graph, the legend swaps to a static
  // breakdown of what the health score is composed of. Per-file
  // breakdowns appear in the on-graph hover tooltip instead.
  healthMode?: boolean;
};

const STORAGE_OPEN = 'lattice.legend.open';
const STORAGE_ALL = 'lattice.legend.all';

export function Legend({ data, hiddenExts, onToggleExt, healthMode }: Props) {
  const [open, toggleOpen] = usePersistedToggle(STORAGE_OPEN, false);
  const [allOpen, toggleAllOpen] = usePersistedToggle(STORAGE_ALL, false);
  const { visibleRows, allOtherRows } = useLegendRows(data);

  // While the user holds `h`, swap the entire legend body for a health
  // breakdown panel. Hooks above must run unconditionally to satisfy the
  // rules of hooks; the swap happens here in render.
  if (healthMode) {
    return <HealthLegendPanel />;
  }

  return (
    <div className={`legend ${open ? 'open' : ''}`}>
      <button
        className="legend-toggle"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label="Legend"
      >
        <ShapePreview style={DEFAULT_STYLE} size={11} />
        <span>Legend</span>
        <ChevronDown
          size={13}
          className={`legend-caret ${open ? 'flip' : ''}`}
        />
      </button>

      {open && (
        <div className="legend-body">
          <div className="legend-section-head">
            <span className="legend-section-title">In this project</span>
            <span className="legend-section-count">
              {visibleRows.length}
            </span>
          </div>
          <div className="legend-rows">
            {visibleRows.length === 0 ? (
              <div className="legend-empty">No files yet.</div>
            ) : (
              visibleRows.map((r) => (
                <LegendRow
                  key={r.key}
                  row={r}
                  hidden={hiddenExts.has(r.key)}
                  onToggle={onToggleExt}
                />
              ))
            )}
          </div>

          <button
            className="legend-section-head clickable"
            onClick={toggleAllOpen}
          >
            {allOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="legend-section-title">All known types</span>
            <span className="legend-section-count">{allOtherRows.length}</span>
          </button>
          {allOpen && (
            <div className="legend-rows">
              {allOtherRows.map((r) => (
                <LegendRow
                  key={r.key}
                  row={r}
                  hidden={hiddenExts.has(r.key)}
                  onToggle={onToggleExt}
                  muted
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
