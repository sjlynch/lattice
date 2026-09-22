import { History, RefreshCw, Search, X } from 'lucide-react';
import { RestoreNotice } from './sidebar/RestoreNotice';
import { memo, useCallback, useEffect } from 'react';
import type { StartupTerminal, TerminalLaunchSettings } from '../api';
import { usePiModelMenu } from '../hooks/usePiModelMenu';
import { useTerminals } from '../TerminalsContext';
import type { TerminalStatus } from '../terminal/terminalTypes';
import { createBackendSession } from '../terminal/terminalApi';
import { TerminalPane } from './TerminalPane';
import { createTerminalSpec } from './sidebar/constants';
import { NewTerminalDropdown } from './sidebar/NewTerminalDropdown';
import type { ShellKind } from './sidebar/NewTerminalDropdown';
import { SidebarPanelTabs } from './sidebar/SidebarPanelTabs';
import { SidebarPanes } from './sidebar/SidebarPanes';
import { SidebarTabsBar } from './sidebar/SidebarTabsBar';
import { TabContextMenu } from './sidebar/TabContextMenu';
import { useBusyAgentTerminals } from './sidebar/hooks/useBusyAgentTerminals';
import { useMountedTerminalIds } from './sidebar/hooks/useMountedTerminalIds';
import { usePanelState } from './sidebar/hooks/usePanelState';
import { useStartupTerminals } from './sidebar/hooks/useStartupTerminals';
import { useTabContextMenu } from './sidebar/hooks/useTabContextMenu';
import { useTabScrolling } from './sidebar/hooks/useTabScrolling';
import { useTerminalGroups } from './sidebar/hooks/useTerminalGroups';
import { useTerminalSearch } from './sidebar/hooks/useTerminalSearch';

export type Props = {
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  terminalLaunchSettings: TerminalLaunchSettings;
};

function defaultShellKind(settings: TerminalLaunchSettings): ShellKind {
  if (settings.terminalDefaultHarness === 'claude') {
    return settings.terminalClaudeSkipPermissions ? 'claude-yolo' : 'claude';
  }
  return settings.terminalDefaultHarness;
}

// Memoized: Sidebar receives no scanResult — its props (activeFolder,
// startupTerminals, terminalLaunchSettings) are all reference-stable across the
// metric-only HealthUpdates that re-render App on every file save. Without the
// memo its whole hook fan-out (useTerminalGroups, usePanelState,
// useTerminalSearch, …) re-runs on each save for an unchanged result.
export const Sidebar = memo(function Sidebar({
  activeFolder,
  startupTerminals,
  terminalLaunchSettings,
}: Props) {
  const {
    terminals,
    activeId,
    setActiveId,
    addTerminal,
    closeTerminal,
    closeTerminals,
    setServerId,
    setStatus,
    renameTerminal,
    reorderTerminal,
    restoreTabs,
    lastRestore,
    dismissRestoreNotice,
    restorePrompt,
  } = useTerminals();

  // Curated "Pi — X" model menu for the new-terminal dropdown, from the shared
  // store so it refetches when Settings → Pi saves; an empty menu just means
  // only bare "Pi" shows.
  const piMenu = usePiModelMenu();

  const {
    projectTerminals,
    regularTerminals,
    mergeTerminals,
    startupTerminalsList,
  } = useTerminalGroups(terminals, activeFolder);
  const mountedIds = useMountedTerminalIds(activeId, startupTerminalsList, projectTerminals);
  // Which tabs are running an agent that's still working, for the tab spinner.
  // Keyed by backend session id, so it covers tabs whose pane was never mounted.
  const busyServerIds = useBusyAgentTerminals(activeFolder);

  // When the active folder changes, the currently-active terminal may
  // belong to a different project. Pick a terminal from the new project
  // if available, otherwise clear the selection.
  useEffect(() => {
    if (!activeId) return;
    const current = projectTerminals.find((t) => t.id === activeId);
    if (current) return;
    if (projectTerminals.length > 0) {
      setActiveId(projectTerminals[projectTerminals.length - 1].id);
    } else {
      setActiveId(null);
    }
  }, [activeFolder, projectTerminals, activeId, setActiveId]);

  const {
    activePanel,
    panelTerminals,
    switchPanel: switchPanelWithoutSearchReset,
  } = usePanelState({
    activeId,
    setActiveId,
    projectTerminals,
    regularTerminals,
    mergeTerminals,
    startupTerminalsList,
  });

  const {
    filter,
    searchInputRef,
    visibleTerminals,
    onKeyDown: onSearchKeyDown,
    setFilter,
    reset: resetSearch,
  } = useTerminalSearch(panelTerminals);

  const switchPanel = useCallback(
    (panel: Parameters<typeof switchPanelWithoutSearchReset>[0]) => {
      resetSearch();
      switchPanelWithoutSearchReset(panel);
    },
    [resetSearch, switchPanelWithoutSearchReset],
  );

  // Catch-all: clear the search filter on ANY panel change, including the
  // automatic switches usePanelState performs internally (a merge/startup
  // panel emptying, or the active terminal pointing at another panel's tab).
  // Those call setActivePanel directly, bypassing switchPanel above, so a
  // stale query (e.g. typed on the Merging panel) would otherwise survive the
  // switch and hide the newly-shown panel's terminals. resetSearch is a no-op
  // when the filter is already empty, so the redundant call after a manual
  // switchPanel doesn't cause an extra render.
  useEffect(() => {
    resetSearch();
  }, [activePanel, resetSearch]);

  const { restartStartupTerminals } = useStartupTerminals({
    activeFolder,
    startupTerminals,
    projectTerminals,
    addTerminal,
    closeTerminals,
  });

  const newTerminal = useCallback(
    async (kind: ShellKind, piModel?: string) => {
      const spec = createTerminalSpec(
        kind,
        activeFolder,
        projectTerminals.length + 1,
        piModel,
        terminalLaunchSettings.codexYolo,
      );
      // A harness terminal (claude/pi/codex — anything with an initialCommand)
      // must resolve its MCP config at the backend spawn chokepoint. Pre-create
      // the pty via POST /api/terminals and attach by the returned serverId, so
      // Codex `-c` MCP args + Pi `.pi/mcp.json` are applied before the shell
      // starts. A serverless connect bypasses that (only Claude survives, via
      // the persistent ~/.claude.json reconcile). A plain terminal (no
      // initialCommand) or a pre-create failure falls back to the serverless
      // connect, which addTerminal's WS wiring already handles.
      // Every kind — plain shells included — pre-creates through the backend
      // now, so the tab lands in the durable registry (and comes back after a
      // restart / reboot). A pre-create failure still falls back to the
      // serverless connect, which just isn't restorable.
      const created = await createBackendSession({
        cwd: spec.cwd,
        initialCommand: spec.initialCommand,
        projectPath: spec.projectPath,
        label: spec.label,
        owner: 'user',
        ...(piModel && kind === 'pi' ? { piModel } : {}),
      });
      addTerminal({
        ...spec,
        id: created?.terminalId,
        serverId: created?.serverId,
        registered: !!created?.terminalId,
      });
    },
    [addTerminal, activeFolder, projectTerminals.length, terminalLaunchSettings.codexYolo],
  );

  const handleServerId = useCallback(
    (localId: string, srv: string) => setServerId(localId, srv),
    [setServerId],
  );

  const handleStatus = useCallback(
    (localId: string, status: TerminalStatus, exitCode?: number) =>
      setStatus(localId, status, exitCode),
    [setStatus],
  );

  const {
    tabsRef,
    activeTabRef,
    canScrollLeft,
    canScrollRight,
    scrollTabs,
  } = useTabScrolling({ activeId, visibleTerminals });

  const {
    tabContextMenu,
    tabContextMenuRef,
    handleTabContextMenu,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
  } = useTabContextMenu({ activePanel, visibleTerminals, closeTerminals });

  return (
    <>
      <div className="sidebar-header">
        <SidebarPanelTabs
          activePanel={activePanel}
          mergeCount={mergeTerminals.length}
          startupCount={startupTerminalsList.length}
          switchPanel={switchPanel}
        />

        {panelTerminals.length > 0 && (
          <div className="sidebar-search">
            <Search size={12} className="sidebar-search-icon" />
            <input
              ref={searchInputRef}
              className="sidebar-search-input"
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search terminals…"
              aria-label="Search terminals"
            />
            {filter && (
              <button
                className="icon-btn sm sidebar-search-clear"
                onClick={() => setFilter('')}
                title="Clear search"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <div className="sidebar-header-actions">
          {activePanel === 'startup' && (
            <button
              className="icon-btn sm sidebar-startup-refresh"
              onClick={restartStartupTerminals}
              title="Stop and restart all startup terminals"
              aria-label="Stop and restart all startup terminals"
              disabled={startupTerminalsList.length === 0}
            >
              <RefreshCw size={12} />
            </button>
          )}

          {activePanel === 'terminals' && (
            <>
              <button
                className="icon-btn sm sidebar-restore-btn"
                onClick={() => { void restoreTabs({ retry: true }); }}
                title="Restore terminal tabs (re-attach live sessions, relaunch dead ones, retry failed ones)"
                aria-label="Restore terminal tabs"
              >
                <History size={12} />
              </button>
              <NewTerminalDropdown
                defaultKind={defaultShellKind(terminalLaunchSettings)}
                piMenu={piMenu}
                onNewTerminal={newTerminal}
              />
            </>
          )}
        </div>
      </div>

      <RestoreNotice
        activeFolder={activeFolder}
        prompt={restorePrompt}
        notice={lastRestore}
        onRestore={() => { void restoreTabs({ retry: true }); }}
        onDismiss={dismissRestoreNotice}
      />

      {panelTerminals.length > 0 && (
        <SidebarTabsBar
          visibleTerminals={visibleTerminals}
          filter={filter}
          busyServerIds={busyServerIds}
          activeId={activeId}
          setActiveId={setActiveId}
          closeTerminal={closeTerminal}
          renameTerminal={renameTerminal}
          tabsRef={tabsRef}
          activeTabRef={activeTabRef}
          canScrollLeft={canScrollLeft}
          canScrollRight={canScrollRight}
          scrollTabs={scrollTabs}
          handleTabContextMenu={handleTabContextMenu}
          reorderTerminal={reorderTerminal}
        />
      )}

      {/* Every pane of the project stays in the tree whichever panel is
          viewed (see SidebarPanes) — an empty viewed panel must never unmount
          the force-mounted startup panes behind another panel. */}
      <SidebarPanes
        activePanel={activePanel}
        activeFolder={activeFolder}
        projectTerminals={projectTerminals}
        panelTerminals={panelTerminals}
        activeId={activeId}
        mountedIds={mountedIds}
        renderPane={(t) => (
          <TerminalPane
            // Keyed on the relaunch nonce (NOT serverId): a pane that
            // gave up on a dead pty must be recreated against the one
            // restore put behind the tab, while a serverless pane
            // capturing its own id keeps its Terminal intact.
            key={`${t.id}:${t.relaunchNonce ?? 0}`}
            cwd={t.cwd}
            active={t.id === activeId}
            initialCommand={t.initialCommand}
            serverId={t.serverId}
            projectPath={t.projectPath}
            onServerId={(srv) => handleServerId(t.id, srv)}
            onStatus={(status, exitCode) => handleStatus(t.id, status, exitCode)}
          />
        )}
      />

      <TabContextMenu
        menu={tabContextMenu}
        menuRef={tabContextMenuRef}
        visibleTerminals={visibleTerminals}
        onCloseTabsToLeft={handleCloseTabsToLeft}
        onCloseTabsToRight={handleCloseTabsToRight}
        onCloseOtherTabs={handleCloseOtherTabs}
      />
    </>
  );
});

export default Sidebar;
