import { memo, useEffect, useState, type ReactElement } from 'react';
import { RotateCcw } from 'lucide-react';
import { DEFAULT_SETTINGS, type GraphSettings } from './graphSettings';
import {
  LINK_MODES,
  LINK_WIDTH_ROW,
  METRIC_LABEL_MODES,
  NODE_MODES,
  NODE_ROWS,
  PHYSICS_ROWS,
  RENDER_SCALE_ROW,
  REPULSION_MODES,
  SELECTION_GLOW_ROWS,
  SPREAD_ROWS,
  SUBAGENT_LABEL_MODES,
  TABS,
  THETA_ROW,
  TIDY_ONLOAD_MODES,
  TIDY_ROWS,
  type SetField,
  type TabKey,
} from './graphSettingsPanel/config';
import {
  CheckboxRow,
  SliderRowControl,
  SliderRows,
  ToggleGroupRow,
} from './graphSettingsPanel/controls';
import {
  loadActiveGraphSettingsTab,
  saveActiveGraphSettingsTab,
} from './graphSettingsPanel/tabStorage';

// Props each tab body receives: the live settings, the shared field-setter
// factory, and (Spread only) the imperative layout re-run.
type TabProps = {
  settings: GraphSettings;
  set: SetField;
  onRunLayout?: () => void;
};

function SizesTab({ settings, set }: TabProps) {
  return (
    <>
      <SliderRows rows={NODE_ROWS} settings={settings} set={set} />

      <ToggleGroupRow
        label="Metric labels (H/Z)"
        ariaLabel="Metric labels"
        options={METRIC_LABEL_MODES}
        value={settings.metricLabels}
        onSelect={set('metricLabels')}
      />

      <ToggleGroupRow
        label="Subagent labels"
        ariaLabel="Subagent labels"
        options={SUBAGENT_LABEL_MODES}
        value={settings.showSubagentLabels}
        onSelect={set('showSubagentLabels')}
      />
    </>
  );
}

function PhysicsTab({ settings, set }: TabProps) {
  return (
    <>
      <SliderRows rows={PHYSICS_ROWS} settings={settings} set={set} />

      <ToggleGroupRow
        label="Repulsion mode"
        ariaLabel="Repulsion mode"
        options={REPULSION_MODES}
        value={settings.repulsionMode}
        onSelect={set('repulsionMode')}
      />
      {settings.repulsionMode === 'nbody' && (
        <SliderRowControl
          row={THETA_ROW}
          settings={settings}
          onChange={set(THETA_ROW.key)}
        />
      )}
    </>
  );
}

function SpreadTab({ settings, set, onRunLayout }: TabProps) {
  return (
    <>
      <ToggleGroupRow
        label="Untangle (radial tidy tree)"
        ariaLabel="Untangle on load"
        options={TIDY_ONLOAD_MODES}
        value={settings.tidyLayoutOnLoad}
        onSelect={set('tidyLayoutOnLoad')}
      />
      <SliderRows rows={TIDY_ROWS} settings={settings} set={set} />
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

      <SliderRows rows={SPREAD_ROWS} settings={settings} set={set} />
    </>
  );
}

function RenderingTab({ settings, set }: TabProps) {
  return (
    <>
      <SliderRowControl
        row={RENDER_SCALE_ROW}
        settings={settings}
        onChange={set(RENDER_SCALE_ROW.key)}
      />

      <ToggleGroupRow
        label="Link rendering"
        ariaLabel="Link rendering"
        options={LINK_MODES}
        value={settings.batchedLinks}
        onSelect={set('batchedLinks')}
      />
      <CheckboxRow
        label="Show links"
        hint="Uncheck to hide every link and see just the file shapes — clearer on very large codebases"
        checked={settings.showLinks}
        onChange={set('showLinks')}
      />
      {/* Width is meaningless for batched links (always flat) or hidden ones. */}
      {settings.showLinks && !settings.batchedLinks && (
        <SliderRowControl
          row={LINK_WIDTH_ROW}
          settings={settings}
          onChange={set(LINK_WIDTH_ROW.key)}
        />
      )}

      <ToggleGroupRow
        label="Node rendering"
        ariaLabel="Node rendering"
        options={NODE_MODES}
        value={settings.batchedNodes}
        onSelect={set('batchedNodes')}
      />

      {/* Selection-halo glow: how bright/large the pulsing bloom over selected
          nodes is (the ring itself is unaffected). See halo.ts. */}
      <SliderRows rows={SELECTION_GLOW_ROWS} settings={settings} set={set} />
    </>
  );
}

// The four tabs' bodies, keyed by TabKey — the panel's structure at a glance.
const TAB_CONTENT: Record<TabKey, (props: TabProps) => ReactElement> = {
  sizes: SizesTab,
  physics: PhysicsTab,
  spread: SpreadTab,
  rendering: RenderingTab,
};

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

  // Single field-setter factory: bind a settings key, get a value-taking setter
  // that emits the merged GraphSettings. Replaces the former per-field setters.
  const set: SetField = (key) => (value) => onChange({ ...settings, [key]: value });

  const ActiveTabContent = TAB_CONTENT[activeTab];

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
        <ActiveTabContent settings={settings} set={set} onRunLayout={onRunLayout} />
      </div>

      <div className="graph-settings-footer">
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
});
