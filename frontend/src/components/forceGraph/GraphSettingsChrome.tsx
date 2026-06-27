import { useCallback, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { GraphSettingsPanel } from './GraphSettingsPanel';
import type { GraphSettings } from './graphSettings';

type Props = {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  // Active project — used by the panel for per-project tab persistence.
  project: string;
  // Imperatively re-apply the radial tidy-tree untangle (Spread tab button).
  onRunLayout?: () => void;
};

// The graph settings panel plus its bottom-right gear FAB. Owns the local
// open/close state (nothing outside this pair reads it): the FAB toggles the
// panel and the panel's close button / FAB closes it. Rendered as a sibling
// fragment so the DOM order (panel before FAB) is unchanged from when this lived
// inline in ForceGraphView.
export function GraphSettingsChrome({
  settings,
  onChange,
  project,
  onRunLayout,
}: Props) {
  const [showSettings, setShowSettings] = useState(false);
  const toggleSettings = useCallback(() => setShowSettings((v) => !v), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);

  return (
    <>
      {showSettings && (
        <GraphSettingsPanel
          settings={settings}
          onChange={onChange}
          onClose={closeSettings}
          project={project}
          onRunLayout={onRunLayout}
        />
      )}

      <button
        className={`graph-settings-fab${showSettings ? ' active' : ''}`}
        onClick={toggleSettings}
        aria-label="Graph settings"
        title="Graph settings"
      >
        <SettingsIcon size={16} />
      </button>
    </>
  );
}
