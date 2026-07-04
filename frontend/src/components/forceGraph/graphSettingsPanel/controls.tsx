import type { GraphSettings } from '../graphSettings';
import type { SetField, SliderRow, ToggleOption } from './config';

export function SliderRowControl({
  row,
  settings,
  onChange,
}: {
  row: SliderRow;
  settings: GraphSettings;
  onChange: (value: number) => void;
}) {
  const v = settings[row.key];
  const formatted = row.format ? row.format(v) : String(v);
  return (
    <div className="graph-settings-row">
      <div className="graph-settings-label">
        <span>{row.label}</span>
        <span className="graph-settings-value">{formatted}</span>
      </div>
      <input
        type="range"
        min={row.min}
        max={row.max}
        step={row.step}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// A run of slider rows, each bound to the shared field-setter factory. Keeps
// the per-tab bodies declarative (`<SliderRows rows={NODE_ROWS} … />`).
export function SliderRows({
  rows,
  settings,
  set,
}: {
  rows: SliderRow[];
  settings: GraphSettings;
  set: SetField;
}) {
  return (
    <>
      {rows.map((row) => (
        <SliderRowControl
          key={row.key}
          row={row}
          settings={settings}
          onChange={set(row.key)}
        />
      ))}
    </>
  );
}

// A labeled segmented button group (the `.graph-settings-toggle` look), one
// active option. Collapses structurally-identical mode rows (repulsion / link
// rendering / node rendering / etc.) into a single component.
export function ToggleGroupRow<T>({
  label,
  ariaLabel,
  options,
  value,
  onSelect,
}: {
  label: string;
  ariaLabel: string;
  options: ToggleOption<T>[];
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="graph-settings-row">
      <div className="graph-settings-label">
        <span>{label}</span>
      </div>
      <div className="graph-settings-toggle" role="group" aria-label={ariaLabel}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            title={o.hint}
            className={
              value === o.value
                ? 'graph-settings-toggle-btn is-active'
                : 'graph-settings-toggle-btn'
            }
            onClick={() => onSelect(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
