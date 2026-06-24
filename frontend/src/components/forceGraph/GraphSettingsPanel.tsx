import { memo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  type GraphSettings,
  type RepulsionMode,
} from './graphSettings';

// Horizontal tabs replacing the old flat section dividers — one group of
// controls visible at a time so the panel can't grow taller than the viewport
// (paired with the body's max-height/overflow guard in graph.css).
type TabKey = 'sizes' | 'physics' | 'rendering';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'sizes', label: 'Sizes' },
  { key: 'physics', label: 'Physics' },
  { key: 'rendering', label: 'Rendering' },
];

// Persist the active tab per project, matching the `lattice.<thing>.<projectPath>`
// localStorage convention (alongside `lattice.graphSettings.<project>`).
const TAB_STORAGE_PREFIX = 'lattice.graphSettingsTab.';

function loadActiveTab(project: string): TabKey {
  if (!project) return 'sizes';
  try {
    const raw = localStorage.getItem(TAB_STORAGE_PREFIX + project);
    if (raw && TABS.some((t) => t.key === raw)) return raw as TabKey;
  } catch {
    /* ignore quota / disabled storage */
  }
  return 'sizes';
}

// SliderRow only drives the numeric settings; non-numeric settings (e.g.
// repulsionMode) get bespoke controls below.
type NumericKey = {
  [K in keyof GraphSettings]: GraphSettings[K] extends number ? K : never;
}[keyof GraphSettings];

type SliderRow = {
  key: NumericKey;
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

// Only meaningful in n-body mode; shown right under the mode toggle.
const THETA_ROW: SliderRow = {
  key: 'chargeTheta',
  label: 'N-body accuracy (θ)',
  min: 0.5,
  max: 2.5,
  step: 0.1,
  format: (v) => `${v.toFixed(1)} (${v <= 1 ? 'precise' : v >= 1.8 ? 'fastest' : 'fast'})`,
};

const LINK_WIDTH_ROW: SliderRow = {
  key: 'linkWidth',
  label: 'Link width',
  min: 0,
  max: 3,
  step: 0.1,
  format: (v) => (v === 0 ? 'flat lines' : `${v.toFixed(1)} (tubes)`),
};

// Renderer pixel-ratio cap. The big lever when the browser is software-rendering
// (no GPU hardware acceleration) — lower it to render fewer pixels per frame.
const RENDER_SCALE_ROW: SliderRow = {
  key: 'pixelRatio',
  label: 'Render scale',
  min: 0.25,
  max: 2,
  step: 0.05,
  format: (v) => `${v.toFixed(2)}×${v < 1 ? ' (faster)' : ''}`,
};

const REPULSION_MODES: { value: RepulsionMode; label: string; hint: string }[] = [
  { value: 'nbody', label: 'N-body', hint: 'd3 forceManyBody (global, default)' },
  { value: 'local', label: 'Local (fast)', hint: 'O(N) tree-aware repulsion' },
];

const LINK_MODES: { value: boolean; label: string; hint: string }[] = [
  { value: false, label: 'Per-link', hint: 'one Line/tube per link' },
  {
    value: true,
    label: 'Batched (fast)',
    hint: 'all links in one LineSegments — 1 draw call when orbiting (default)',
  },
];

const NODE_MODES: { value: boolean; label: string; hint: string }[] = [
  { value: false, label: 'Per-node', hint: 'one Sprite per node' },
  {
    value: true,
    label: 'Batched (fast)',
    hint: 'instanced shapes — ~1 draw call per file type when orbiting (default)',
  },
];

// Floating panel that mutates the GraphSettings object in the parent. Pure
// UI — it doesn't talk to the graph directly; the parent's effects react
// to settings changes and re-render sprites or reheat the d3 simulation.
export const GraphSettingsPanel = memo(function GraphSettingsPanel({
  settings,
  onChange,
  onClose,
  project,
}: {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onClose: () => void;
  project: string;
}) {
  const [activeTab, setActiveTab] = useState<TabKey>(() => loadActiveTab(project));

  const selectTab = (tab: TabKey) => {
    setActiveTab(tab);
    if (!project) return;
    try {
      localStorage.setItem(TAB_STORAGE_PREFIX + project, tab);
    } catch {
      /* ignore quota / disabled storage */
    }
  };

  const setField = (key: NumericKey, value: number) =>
    onChange({ ...settings, [key]: value });

  const setMode = (mode: RepulsionMode) =>
    onChange({ ...settings, repulsionMode: mode });

  const setBatchedLinks = (on: boolean) =>
    onChange({ ...settings, batchedLinks: on });

  const setBatchedNodes = (on: boolean) =>
    onChange({ ...settings, batchedNodes: on });

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

      <div
        className="graph-settings-toggle graph-settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={
              activeTab === t.key
                ? 'graph-settings-toggle-btn is-active'
                : 'graph-settings-toggle-btn'
            }
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="graph-settings-body">
        {activeTab === 'sizes' && NODE_ROWS.map(renderRow)}

        {activeTab === 'physics' && (
          <>
            {PHYSICS_ROWS.map(renderRow)}

            <div className="graph-settings-row">
              <div className="graph-settings-label">
                <span>Repulsion mode</span>
              </div>
              <div className="graph-settings-toggle" role="group" aria-label="Repulsion mode">
                {REPULSION_MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    title={m.hint}
                    className={
                      settings.repulsionMode === m.value
                        ? 'graph-settings-toggle-btn is-active'
                        : 'graph-settings-toggle-btn'
                    }
                    onClick={() => setMode(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            {settings.repulsionMode === 'nbody' && renderRow(THETA_ROW)}
          </>
        )}

        {activeTab === 'rendering' && (
          <>
            {renderRow(RENDER_SCALE_ROW)}

            <div className="graph-settings-row">
              <div className="graph-settings-label">
                <span>Link rendering</span>
              </div>
              <div className="graph-settings-toggle" role="group" aria-label="Link rendering">
                {LINK_MODES.map((m) => (
                  <button
                    key={String(m.value)}
                    type="button"
                    title={m.hint}
                    className={
                      settings.batchedLinks === m.value
                        ? 'graph-settings-toggle-btn is-active'
                        : 'graph-settings-toggle-btn'
                    }
                    onClick={() => setBatchedLinks(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Width is meaningless for batched links (always flat). */}
            {!settings.batchedLinks && renderRow(LINK_WIDTH_ROW)}

            <div className="graph-settings-row">
              <div className="graph-settings-label">
                <span>Node rendering</span>
              </div>
              <div className="graph-settings-toggle" role="group" aria-label="Node rendering">
                {NODE_MODES.map((m) => (
                  <button
                    key={String(m.value)}
                    type="button"
                    title={m.hint}
                    className={
                      settings.batchedNodes === m.value
                        ? 'graph-settings-toggle-btn is-active'
                        : 'graph-settings-toggle-btn'
                    }
                    onClick={() => setBatchedNodes(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="graph-settings-footer">
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
});
