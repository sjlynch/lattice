import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import {
  EXT_STYLES,
  DEFAULT_STYLE,
  type ExtStyle,
} from '../extensionStyles';
import type { ScanResult } from '../api';
import { ShapePreview } from './legend/ShapePreview';
import { HealthLegendPanel } from './legend/HealthLegendPanel';

type Props = {
  data: ScanResult | null;
  hiddenExts: Set<string>;
  onToggleExt: (ext: string) => void;
  // While `h` is held in the graph, the legend swaps to a static
  // breakdown of what the health score is composed of. Per-file
  // breakdowns appear in the on-graph hover tooltip instead.
  healthMode?: boolean;
};

type Row = {
  key: string; // canonical ext (lowercased) — '*' for unknown
  style: ExtStyle;
  label: string;
  count: number;
};

const STORAGE_OPEN = 'lattice.legend.open';
const STORAGE_ALL = 'lattice.legend.all';

export function Legend({ data, hiddenExts, onToggleExt, healthMode }: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_OPEN) === '1';
    } catch {
      return false;
    }
  });
  const [allOpen, setAllOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_ALL) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN, open ? '1' : '0');
    } catch {
      // ignore
    }
  }, [open]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_ALL, allOpen ? '1' : '0');
    } catch {
      // ignore
    }
  }, [allOpen]);

  // Tally extensions present in the current scan.
  const visibleRows: Row[] = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    const customStyles = new Map<string, ExtStyle>();
    for (const n of data.nodes) {
      if (n.kind !== 'file') continue;
      const key = (n.ext ?? '').toLowerCase() || '*';
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (key !== '*' && !EXT_STYLES[key] && !customStyles.has(key)) {
        customStyles.set(key, { ...DEFAULT_STYLE, ext: key, label: key });
      }
    }
    const rows: Row[] = [];
    for (const [key, count] of counts) {
      const style =
        EXT_STYLES[key] ??
        customStyles.get(key) ??
        { ...DEFAULT_STYLE, ext: key, label: key === '*' ? 'Other' : key };
      rows.push({ key, style, label: style.label, count });
    }
    rows.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.key.localeCompare(b.key);
    });
    return rows;
  }, [data]);

  // All known styles not present in the current scan.
  const allOtherRows: Row[] = useMemo(() => {
    const visibleKeys = new Set(visibleRows.map((r) => r.key));
    const rows: Row[] = [];
    for (const key of Object.keys(EXT_STYLES)) {
      if (visibleKeys.has(key)) continue;
      rows.push({ key, style: EXT_STYLES[key], label: EXT_STYLES[key].label, count: 0 });
    }
    rows.sort((a, b) => a.style.label.localeCompare(b.style.label));
    return rows;
  }, [visibleRows]);

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
        onClick={() => setOpen((v) => !v)}
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
                  onToggle={() => onToggleExt(r.key)}
                />
              ))
            )}
          </div>

          <button
            className="legend-section-head clickable"
            onClick={() => setAllOpen((v) => !v)}
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
                  onToggle={() => onToggleExt(r.key)}
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

function LegendRow({
  row,
  hidden,
  onToggle,
  muted,
}: {
  row: Row;
  hidden: boolean;
  onToggle: () => void;
  muted?: boolean;
}) {
  return (
    <button
      className={`legend-row ${hidden ? 'hidden' : ''} ${muted ? 'muted' : ''}`}
      onClick={onToggle}
      title={hidden ? 'Click to show' : 'Click to hide'}
    >
      <ShapePreview style={row.style} size={14} />
      <span className="legend-row-ext">{row.style.ext}</span>
      <span className="legend-row-label">{row.label}</span>
      <span className="legend-row-count">{row.count > 0 ? row.count : ''}</span>
      <span className="legend-row-eye">
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </span>
    </button>
  );
}
