import { memo, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  type GraphSettings,
  type RepulsionMode,
} from './graphSettings';
import {
  LINK_MODES,
  LINK_WIDTH_ROW,
  METRIC_LABEL_MODES,
  NODE_MODES,
  NODE_ROWS,
  PHYSICS_ROWS,
  RENDER_SCALE_ROW,
  REPULSION_MODES,
  SPREAD_ROWS,
  TABS,
  THETA_ROW,
  TIDY_ONLOAD_MODES,
  TIDY_ROWS,
  type NumericKey,
  type SliderRow,
  type TabKey,
} from './graphSettingsPanel/config';
import { SliderRowControl, ToggleGroupRow } from './graphSettingsPanel/controls';
import {
  loadActiveGraphSettingsTab,
  saveActiveGraphSettingsTab,
} from './graphSettingsPanel/tabStorage';

// Floating panel that mutates the GraphSettings object in the parent. Pure
// UI — it doesn't talk to the graph directly; the parent's effects react
// to settings changes and re-render sprites or reheat the d3 simulation.
export const GraphSettingsPanel = memo(function GraphSettingsPanel({
  settings,
  onChange,
  onClose,
  project,
  onRunLayout,
}: {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onClose: () => void;
  project: string;
  // Imperatively re-apply the radial tidy-tree untangle with the current settings.
  onRunLayout?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    loadActiveGraphSettingsTab(project),
  );

  useEffect(() => {
    setActiveTab(loadActiveGraphSettingsTab(project));
  }, [project]);

  const selectTab = (tab: TabKey) => {
    setActiveTab(tab);
    saveActiveGraphSettingsTab(project, tab);
  };

  const setField = (key: NumericKey, value: number) =>
    onChange({ ...settings, [key]: value });

  const setMode = (mode: RepulsionMode) =>
    onChange({ ...settings, repulsionMode: mode });

  const setBatchedLinks = (on: boolean) =>
    onChange({ ...settings, batchedLinks: on });

  const setBatchedNodes = (on: boolean) =>
    onChange({ ...settings, batchedNodes: on });

  const setMetricLabels = (on: boolean) =>
    onChange({ ...settings, metricLabels: on });

  const setTidyLayoutOnLoad = (on: boolean) =>
    onChange({ ...settings, tidyLayoutOnLoad: on });

  const renderRow = (row: SliderRow) => (
    <SliderRowControl
      key={row.key}
      row={row}
      settings={settings}
      onChange={setField}
    />
  );

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
        {activeTab === 'sizes' && (
          <>
            {NODE_ROWS.map(renderRow)}

            <ToggleGroupRow
              label="Metric labels (H/Z)"
              ariaLabel="Metric labels"
              options={METRIC_LABEL_MODES}
              value={settings.metricLabels}
              onSelect={setMetricLabels}
            />
          </>
        )}

        {activeTab === 'physics' && (
          <>
            {PHYSICS_ROWS.map(renderRow)}

            <ToggleGroupRow
              label="Repulsion mode"
              ariaLabel="Repulsion mode"
              options={REPULSION_MODES}
              value={settings.repulsionMode}
              onSelect={setMode}
            />
            {settings.repulsionMode === 'nbody' && renderRow(THETA_ROW)}
          </>
        )}

        {activeTab === 'spread' && (
          <>
            <ToggleGroupRow
              label="Untangle (radial tidy tree)"
              ariaLabel="Untangle on load"
              options={TIDY_ONLOAD_MODES}
              value={settings.tidyLayoutOnLoad}
              onSelect={setTidyLayoutOnLoad}
            />
            {TIDY_ROWS.map(renderRow)}
            <div className="graph-settings-row">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => onRunLayout?.()}
                title="Re-seed the graph as a radial tidy tree and settle"
              >
                Untangle now
              </button>
            </div>

            {SPREAD_ROWS.map(renderRow)}
          </>
        )}

        {activeTab === 'rendering' && (
          <>
            {renderRow(RENDER_SCALE_ROW)}

            <ToggleGroupRow
              label="Link rendering"
              ariaLabel="Link rendering"
              options={LINK_MODES}
              value={settings.batchedLinks}
              onSelect={setBatchedLinks}
            />
            {/* Width is meaningless for batched links (always flat). */}
            {!settings.batchedLinks && renderRow(LINK_WIDTH_ROW)}

            <ToggleGroupRow
              label="Node rendering"
              ariaLabel="Node rendering"
              options={NODE_MODES}
              value={settings.batchedNodes}
              onSelect={setBatchedNodes}
            />
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
