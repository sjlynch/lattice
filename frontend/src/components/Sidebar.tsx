import { RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import type { StartupTerminal, TerminalLaunchSettings } from '../api';
import { useTerminals } from '../TerminalsContext';
import { TerminalPane } from './TerminalPane';
import { createTerminalSpec } from './sidebar/constants';
import { NewTerminalDropdown } from './sidebar/NewTerminalDropdown';
import type { ShellKind } from './sidebar/NewTerminalDropdown';
import { SidebarEmptyState } from './sidebar/SidebarEmptyState';
import { SidebarPanelTabs } from './sidebar/SidebarPanelTabs';
import { SidebarTabsBar } from './sidebar/SidebarTabsBar';
import { TabContextMenu } from './sidebar/TabContextMenu';
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

export function Sidebar({
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
    renameTerminal,
  } = useTerminals();

  const {
    projectTerminals,
    regularTerminals,
    mergeTerminals,
    startupTerminalsList,
  } = useTerminalGroups(terminals, activeFolder);
  const mountedIds = useMountedTerminalIds(activeId, startupTerminalsList, projectTerminals);

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

  const { restartStartupTerminals } = useStartupTerminals({
    activeFolder,
    startupTerminals,
    projectTerminals,
    addTerminal,
    closeTerminals,
  });

  const newTerminal = useCallback(
    (kind: ShellKind) => {
      addTerminal(createTerminalSpec(kind, activeFolder, projectTerminals.length + 1));
    },
    [addTerminal, activeFolder, projectTerminals.length],
  );

  const handleServerId = useCallback(
    (localId: string, srv: string) => setServerId(localId, srv),
    [setServerId],
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
            <NewTerminalDropdown
              defaultKind={defaultShellKind(terminalLaunchSettings)}
              onNewTerminal={newTerminal}
            />
          )}
        </div>
      </div>

      {panelTerminals.length > 0 && (
        <SidebarTabsBar
          visibleTerminals={visibleTerminals}
          filter={filter}
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
        />
      )}

      <div className="sidebar-content">
        {panelTerminals.length === 0 ? (
          <SidebarEmptyState activePanel={activePanel} activeFolder={activeFolder} />
        ) : (
          projectTerminals.map((t) => (
            <div
              key={t.id}
              className={`sidebar-pane ${t.id === activeId ? '' : 'hidden'}`}
            >
              {mountedIds.has(t.id) && (
                <TerminalPane
                  cwd={t.cwd}
                  active={t.id === activeId}
                  initialCommand={t.initialCommand}
                  serverId={t.serverId}
                  projectPath={t.projectPath}
                  onServerId={(srv) => handleServerId(t.id, srv)}
                />
              )}
            </div>
          ))
        )}
      </div>

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
}

export default Sidebar;
