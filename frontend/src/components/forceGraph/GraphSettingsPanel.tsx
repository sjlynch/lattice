import { memo } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  type GraphSettings,
} from './graphSettings';

type SliderRow = {
  key: keyof GraphSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
};

const NODE_ROWS: SliderRow[] = [
  { key: 'fileNodeSize', label: 'File node size', min: 2, max: 30, step: 0.5 },
  { key: 'dirNodeSize', label: 'Folder node size', min: 2, max: 30, step: 0.5 },
  { key: 'labelSize', label: 'Label size', min: 3, max: 24, step: 0.5 },
  {
    key: 'labelSpread',
    label: 'Label spread',
    min: 0.5,
    max: 25,
    step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
  },
];

const PHYSICS_ROWS: SliderRow[] = [
  { key: 'dagLevelDistance', label: 'DAG level distance', min: 10, max: 200, step: 1 },
  { key: 'chargeStrength', label: 'Repulsion (charge)', min: -300, max: 0, step: 5 },
  { key: 'linkDistance', label: 'Link distance', min: 5, max: 200, step: 1 },
  {
    key: 'velocityDecay',
    label: 'Velocity decay',
    min: 0.05,
    max: 0.95,
    step: 0.01,
    format: (v) => v.toFixed(2),
  },
];

// Floating panel that mutates the GraphSettings object in the parent. Pure
// UI — it doesn't talk to the graph directly; the parent's effects react
// to settings changes and re-render sprites or reheat the d3 simulation.
export const GraphSettingsPanel = memo(function GraphSettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onClose: () => void;
}) {
  const setField = (key: keyof GraphSettings, value: number) =>
    onChange({ ...settings, [key]: value });

  const renderRow = (row: SliderRow) => {
    const v = settings[row.key];
    const formatted = row.format ? row.format(v) : String(v);
    return (
      <div className="graph-settings-row" key={row.key}>
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
          onChange={(e) => setField(row.key, Number(e.target.value))}
        />
      </div>
    );
  };

  return (
    <div className="graph-settings-panel" role="dialog" aria-label="Graph settings">
      <div className="graph-settings-header">
        <span>Graph settings</span>
        <button
          className="link-btn"
          onClick={() => onChange({ ...DEFAULT_SETTINGS })}
          title="Reset to defaults"
        >
          <RotateCcw size={11} />
          <span>Reset</span>
        </button>
      </div>
      <div className="graph-settings-section-title">Sizes</div>
      {NODE_ROWS.map(renderRow)}
      <div className="graph-settings-section-title">Physics</div>
      {PHYSICS_ROWS.map(renderRow)}
      <div className="graph-settings-footer">
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
});
