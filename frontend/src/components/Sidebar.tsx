import { RestoreNotice } from './sidebar/RestoreNotice';
import { memo, useCallback, useEffect, useRef } from 'react';
import type { StartupTerminal, TerminalLaunchSettings } from '../api';
import { usePiModelMenu } from '../hooks/usePiModelMenu';
import { useTerminals } from '../TerminalsContext';
import { pickActiveAfterDisappear } from '../terminal/terminalActivePolicy';
import { TerminalPane } from './TerminalPane';
import { SidebarHeaderActions } from './sidebar/SidebarHeaderActions';
import { SidebarPanelTabs } from './sidebar/SidebarPanelTabs';
import { SidebarPanes } from './sidebar/SidebarPanes';
import { SidebarTabsBar } from './sidebar/SidebarTabsBar';
import { TabContextMenu } from './sidebar/TabContextMenu';
import { useBusyAgentTerminals } from './sidebar/hooks/useBusyAgentTerminals';
import { useMountedTerminalIds } from './sidebar/hooks/useMountedTerminalIds';
import { useNewTerminal } from './sidebar/hooks/useNewTerminal';
import { usePanelState } from './sidebar/hooks/usePanelState';
import { useStartupTerminals } from './sidebar/hooks/useStartupTerminals';
import { useTabContextMenu } from './sidebar/hooks/useTabContextMenu';
import { useTabScrolling } from './sidebar/hooks/useTabScrolling';
import { useTerminalGroups } from './sidebar/hooks/useTerminalGroups';
import { useTerminalSearch } from './sidebar/hooks/useTerminalSearch';
import { SidebarSearchBox } from './sidebar/SidebarSearchBox';

export type Props = {
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  terminalLaunchSettings: TerminalLaunchSettings;
};

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

  // The active terminal left this project's list: either the folder changed
  // (it belongs to another project) or the tab was removed — typically the
  // registry's `ended` event for a close, which lands before the DELETE
  // response and so before closeTerminal's own neighbour fallback. The
  // previous list tells the two apart; see pickActiveAfterDisappear.
  const prevProjectRef = useRef({ folder: activeFolder, list: projectTerminals });
  useEffect(() => {
    const prev = prevProjectRef.current;
    prevProjectRef.current = { folder: activeFolder, list: projectTerminals };
    if (!activeId) return;
    if (projectTerminals.some((t) => t.id === activeId)) return;
    setActiveId(pickActiveAfterDisappear(
      prev.list,
      projectTerminals,
      activeId,
      prev.folder === activeFolder,
    ));
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

  const { restartStartupTerminals, restartPending } = useStartupTerminals({
    activeFolder,
    startupTerminals,
    projectTerminals,
    addTerminal,
    closeTerminals,
  });

  const { newTerminal, defaultKind } = useNewTerminal({
    activeFolder,
    projectTerminalCount: projectTerminals.length,
    addTerminal,
    terminalLaunchSettings,
  });

  const restoreWithRetry = useCallback(() => {
    void restoreTabs({ retry: true });
  }, [restoreTabs]);

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
          <SidebarSearchBox
            filter={filter}
            setFilter={setFilter}
            searchInputRef={searchInputRef}
            onKeyDown={onSearchKeyDown}
          />
        )}

        <SidebarHeaderActions
          activePanel={activePanel}
          startupCount={startupTerminalsList.length}
          restartPending={restartPending}
          onRestartStartup={restartStartupTerminals}
          onRestoreTabs={restoreWithRetry}
          defaultKind={defaultKind}
          piMenu={piMenu}
          onNewTerminal={newTerminal}
        />
      </div>

      <RestoreNotice
        activeFolder={activeFolder}
        prompt={restorePrompt}
        notice={lastRestore}
        onRestore={restoreWithRetry}
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
            onServerId={(srv) => setServerId(t.id, srv)}
            onStatus={(status, exitCode) => setStatus(t.id, status, exitCode)}
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
