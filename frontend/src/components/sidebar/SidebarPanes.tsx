import type { ReactNode } from 'react';
import type { TerminalSpec } from '../../terminal/terminalTypes';
import { SidebarEmptyState } from './SidebarEmptyState';
import type { Panel } from './hooks/usePanelState';

type Props = {
  activePanel: Panel;
  activeFolder: string;
  // EVERY terminal of the project, across all three panels.
  projectTerminals: TerminalSpec[];
  // The viewed panel's tabs; only its emptiness matters here.
  panelTerminals: TerminalSpec[];
  activeId: string | null;
  // Tabs whose pane may be mounted (`hooks/useMountedTerminalIds`).
  mountedIds: ReadonlySet<string>;
  // Builds the pane element for one tab (Sidebar passes a `TerminalPane`).
  renderPane: (t: TerminalSpec) => ReactNode;
};

// The pane list under the tab strip. The list is rendered UNCONDITIONALLY
// from `projectTerminals`: the empty-panel message is a sibling, never a
// replacement. Swapping the whole list out for the message when the VIEWED
// panel was empty (Terminals panel with only startup tabs, say) unmounted
// every mounted pane in the project — including the force-mounted startup
// panes, whose WS closed and xterm was disposed, costing a ~2 MB scrollback
// replay on return, and a serverless pane that had not yet received its
// `attached` frame reconnected as a SECOND pty. Hidden panes are already
// `position: absolute; visibility: hidden` (`.sidebar-pane.hidden`), so they
// cost nothing to keep in the tree.
export function SidebarPanes({
  activePanel,
  activeFolder,
  projectTerminals,
  panelTerminals,
  activeId,
  mountedIds,
  renderPane,
}: Props) {
  return (
    <div className="sidebar-content">
      {panelTerminals.length === 0 && (
        <SidebarEmptyState activePanel={activePanel} activeFolder={activeFolder} />
      )}
      {projectTerminals.map((t) => (
        <div
          key={t.id}
          className={`sidebar-pane ${t.id === activeId ? '' : 'hidden'}`}
        >
          {/* A tab whose pty is being relaunched (or whose relaunch failed)
              has no session to attach to; mounting it would open a
              serverless connect that re-runs the launch command. */}
          {mountedIds.has(t.id) && !t.restore && renderPane(t)}
        </div>
      ))}
    </div>
  );
}
