import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  DEFAULT_METRICS_IGNORED_EXTS,
  normalizeIgnoredExt,
} from '../../api';

type Props = {
  active: boolean;
  open: boolean;
  metricsIgnoredExts: string[];
};

export type MetricsIgnoredExtsTabHandle = {
  // The cleaned list to persist on save. Returns `undefined` if the user
  // hasn't touched the tab since the dialog opened (matches the EnvNotes
  // pattern so we don't clobber values we never finished loading).
  getMetricsIgnoredExtsPatch: () => string[] | undefined;
};

type Row = { id: string; value: string };

let rowSeq = 0;
function makeRow(value: string): Row {
  rowSeq += 1;
  return { id: `mie_${rowSeq}`, value };
}

function rowsFromList(list: string[]): Row[] {
  return list.map(makeRow);
}

function cleanRows(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const ext = normalizeIgnoredExt(r.value);
    if (ext) seen.add(ext);
  }
  return [...seen];
}

export const MetricsIgnoredExtsTab = forwardRef<
  MetricsIgnoredExtsTabHandle,
  Props
>(function MetricsIgnoredExtsTab({ active, open, metricsIgnoredExts }, ref) {
  const [rows, setRows] = useState<Row[]>(() => rowsFromList(metricsIgnoredExts));
  const [touched, setTouched] = useState(false);

  // Reset the buffer whenever the dialog opens (or upstream list changes
  // while open — e.g. another tab edited it).
  useEffect(() => {
    if (open) {
      setRows(rowsFromList(metricsIgnoredExts));
      setTouched(false);
    }
  }, [open, metricsIgnoredExts]);

  useImperativeHandle(
    ref,
    () => ({
      getMetricsIgnoredExtsPatch: () => (touched ? cleanRows(rows) : undefined),
    }),
    [touched, rows],
  );

  const addRow = () => {
    setRows((r) => [...r, makeRow('')]);
    setTouched(true);
  };

  const removeRow = (id: string) => {
    setRows((r) => r.filter((row) => row.id !== id));
    setTouched(true);
  };

  const updateRow = (id: string, value: string) => {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, value } : row)));
    setTouched(true);
  };

  const resetToDefault = () => {
    setRows(rowsFromList([...DEFAULT_METRICS_IGNORED_EXTS]));
    setTouched(true);
  };

  if (!active) return null;

  const defaultLabel = DEFAULT_METRICS_IGNORED_EXTS.join(', ');

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">
            Ignored extensions for LOC &amp; Code Health
          </div>
          <div className="settings-section-sub">
            File extensions listed here are skipped by the LOC overlay
            (hold <code>z</code>) and the code-health overlay
            (hold <code>h</code>). Matching files still appear in the
            graph as their normal sprite — they just don't get the colored
            tint or the numeric label that would otherwise drown out
            real source files. Lattice defaults to{' '}
            <code>{defaultLabel}</code>; clear the list to ignore nothing.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn-ghost"
            onClick={resetToDefault}
            title="Reset to Lattice's default list"
          >
            <RotateCcw size={12} />
            Reset
          </button>
          <button
            className="btn-ghost"
            onClick={addRow}
            title="Add an extension"
          >
            <Plus size={12} />
            Add
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="settings-empty">
          No extensions ignored — every file contributes to the LOC and
          code-health overlays.
        </div>
      ) : (
        <div className="startup-list">
          {rows.map((row) => (
            <div key={row.id} className="startup-row">
              <input
                className="text-input startup-command"
                placeholder=".json"
                value={row.value}
                spellCheck={false}
                onChange={(e) => updateRow(row.id, e.target.value)}
              />
              <button
                className="icon-btn sm"
                onClick={() => removeRow(row.id)}
                title="Remove"
                aria-label="Remove ignored extension"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
