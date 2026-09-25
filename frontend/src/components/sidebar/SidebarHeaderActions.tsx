import { History, RefreshCw } from 'lucide-react';
import type { PiMenuEntry } from '../../api';
import { HEADER_ICON_SIZE } from './constants';
import { NewTerminalDropdown } from './NewTerminalDropdown';
import type { ShellKind } from './NewTerminalDropdown';
import type { Panel } from './hooks/usePanelState';

type Props = {
  activePanel: Panel;
  startupCount: number;
  onRestartStartup: () => void;
  onRestoreTabs: () => void;
  defaultKind: ShellKind;
  piMenu: PiMenuEntry[];
  onNewTerminal: (kind: ShellKind, piModel?: string) => void;
};

// Right-hand header buttons: restart-all on the Startup panel; restore-tabs +
// the new-terminal dropdown on the Terminals panel.
export function SidebarHeaderActions({
  activePanel,
  startupCount,
  onRestartStartup,
  onRestoreTabs,
  defaultKind,
  piMenu,
  onNewTerminal,
}: Props) {
  return (
    <div className="sidebar-header-actions">
      {activePanel === 'startup' && (
        <button
          className="icon-btn sm sidebar-startup-refresh"
          onClick={onRestartStartup}
          title="Stop and restart all startup terminals"
          aria-label="Stop and restart all startup terminals"
          disabled={startupCount === 0}
        >
          <RefreshCw size={HEADER_ICON_SIZE} />
        </button>
      )}

      {activePanel === 'terminals' && (
        <>
          <button
            className="icon-btn sm sidebar-restore-btn"
            onClick={onRestoreTabs}
            title="Restore terminal tabs (re-attach live sessions, relaunch dead ones, retry failed ones)"
            aria-label="Restore terminal tabs"
          >
            <History size={HEADER_ICON_SIZE} />
          </button>
          <NewTerminalDropdown
            defaultKind={defaultKind}
            piMenu={piMenu}
            onNewTerminal={onNewTerminal}
          />
        </>
      )}
    </div>
  );
}
