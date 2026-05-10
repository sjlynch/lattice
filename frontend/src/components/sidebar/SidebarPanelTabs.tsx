import { GitMerge, Rocket, TerminalSquare } from 'lucide-react';
import type { Panel } from './hooks/usePanelState';

type Props = {
  activePanel: Panel;
  mergeCount: number;
  startupCount: number;
  switchPanel: (panel: Panel) => void;
};

export function SidebarPanelTabs({
  activePanel,
  mergeCount,
  startupCount,
  switchPanel,
}: Props) {
  return (
    <div className="sidebar-panel-tabs">
      <button
        className={`sidebar-panel-tab ${activePanel === 'terminals' ? 'active' : ''}`}
        onClick={() => switchPanel('terminals')}
      >
        <TerminalSquare size={11} />
        Terminals
      </button>
      {mergeCount > 0 && (
        <button
          className={`sidebar-panel-tab merge ${activePanel === 'merging' ? 'active' : ''}`}
          onClick={() => switchPanel('merging')}
        >
          <GitMerge size={11} />
          Merging
          {activePanel !== 'merging' && mergeCount > 0 && (
            <span className="sidebar-panel-tab-badge">
              {mergeCount}
            </span>
          )}
        </button>
      )}
      {startupCount > 0 && (
        <button
          className={`sidebar-panel-tab startup ${activePanel === 'startup' ? 'active' : ''}`}
          onClick={() => switchPanel('startup')}
        >
          <Rocket size={11} />
          Startup
        </button>
      )}
    </div>
  );
}
