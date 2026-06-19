import { useMemo } from 'react';
import type { ScanResult } from '../../api';
import {
  DEFAULT_STYLE,
  EXT_STYLES,
  type ExtStyle,
} from '../../extensionStyles';
import { useStructuralScan } from '../../hooks/useStructuralScan';

export type LegendRowData = {
  key: string; // canonical ext (lowercased) — '*' for unknown
  style: ExtStyle;
  label: string;
  count: number;
};

function visibleRowsFor(data: ScanResult | null): LegendRowData[] {
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

  const rows: LegendRowData[] = [];
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
}

function allOtherRowsFor(visibleRows: readonly LegendRowData[]): LegendRowData[] {
  const visibleKeys = new Set(visibleRows.map((r) => r.key));
  const rows: LegendRowData[] = [];
  for (const key of Object.keys(EXT_STYLES)) {
    if (visibleKeys.has(key)) continue;
    rows.push({
      key,
      style: EXT_STYLES[key],
      label: EXT_STYLES[key].label,
      count: 0,
    });
  }
  rows.sort((a, b) => a.style.label.localeCompare(b.style.label));
  return rows;
}

export function useLegendRows(data: ScanResult | null): {
  visibleRows: LegendRowData[];
  allOtherRows: LegendRowData[];
} {
  // The legend tallies by extension only (structural), so key off the
  // structure-stable reference rather than `data` — which churns on every
  // metric-only file save — to skip the O(N) re-tally + re-render per save.
  const structuralData = useStructuralScan(data);
  const visibleRows = useMemo(() => visibleRowsFor(structuralData), [structuralData]);
  const allOtherRows = useMemo(
    () => allOtherRowsFor(visibleRows),
    [visibleRows],
  );
  return { visibleRows, allOtherRows };
}
