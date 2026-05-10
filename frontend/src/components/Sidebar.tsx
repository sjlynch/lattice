import { RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { StartupTerminal } from '../api';
import { useTerminals } from '../TerminalsContext';
import { TerminalPane } from './TerminalPane';
import { NewTerminalDropdown } from './sidebar/NewTerminalDropdown';
import type { ShellKind } from './sidebar/NewTerminalDropdown';
import { SidebarEmptyState } from './sidebar/SidebarEmptyState';
import { SidebarPanelTabs } from './sidebar/SidebarPanelTabs';
import { SidebarTabsBar } from './sidebar/SidebarTabsBar';
import { usePanelState } from './sidebar/hooks/usePanelState';
import { useStartupTerminals } from './sidebar/hooks/useStartupTerminals';
import { useTabContextMenu } from './sidebar/hooks/useTabContextMenu';
import { useTabScrolling } from './sidebar/hooks/useTabScrolling';

export type Props = {
  activeFolder: string;
  startupTerminals: StartupTerminal[];
};

const KIND_INITIAL_COMMAND: Record<ShellKind, string | undefined> = {
  claude: 'claude',
  'claude-yolo': 'claude --dangerously-skip-permissions',
  pi: 'pi',
  terminal: undefined,
};

const KIND_LABEL_PREFIX: Record<ShellKind, string> = {
  claude: 'claude',
  'claude-yolo': 'claude!',
  pi: 'pi',
  terminal: 'terminal',
};

export function Sidebar({ activeFolder, startupTerminals }: Props) {
  const {
    terminals,
    activeId,
    setActiveId,
    addTerminal,
    closeTerminal,
    closeTerminals,
    setServerId,
  } = useTerminals();

  const [filter, setFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Track which terminal IDs have ever been the active tab. We only mount
  // <TerminalPane> once a terminal is first viewed — the backend pre-spawns
  // the pty (so initialCommand runs immediately) and keeps it alive via
  // serverId, so the session is intact when we first attach. Each mounted
  // pane allocates its own WebGL context (xterm WebglAddon); deferring mount
  // until activation is what keeps Run-All from blowing past Chrome's
  // per-page WebGL context cap.
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    if (activeId) initial.add(activeId);
    return initial;
  });
  useEffect(() => {
    setMountedIds((prev) => {
      if (!activeId || prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.add(activeId);
      return next;
    });
  }, [activeId]);

  // Per-project scoping: terminals are only listed when their projectPath
  // matches the current activeFolder. Legacy terminals saved without a
  // projectPath still show (treated as belonging to whatever's active).
  const projectTerminals = useMemo(
    () =>
      terminals.filter((t) => !t.projectPath || t.projectPath === activeFolder),
    [terminals, activeFolder],
  );
  const regularTerminals = useMemo(
    () => projectTerminals.filter((t) => t.kind !== 'merge' && t.kind !== 'startup'),
    [projectTerminals],
  );
  const mergeTerminals = useMemo(
    () => projectTerminals.filter((t) => t.kind === 'merge'),
    [projectTerminals],
  );
  const startupTerminalsList = useMemo(
    () => projectTerminals.filter((t) => t.kind === 'startup'),
    [projectTerminals],
  );

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

  const { activePanel, panelTerminals, switchPanel } = usePanelState({
    activeId,
    setActiveId,
    projectTerminals,
    regularTerminals,
    mergeTerminals,
    startupTerminalsList,
    setFilter,
    setSearchOpen,
  });

  const { restartStartupTerminals } = useStartupTerminals({
    activeFolder,
    startupTerminals,
    projectTerminals,
    addTerminal,
    closeTerminals,
  });

  // Force-mount startup terminals as soon as they're added, even if they're
  // not the active tab. The whole point of "Startup Terminals" is that the
  // configured commands run on page load — without this, the pty would only
  // boot the first time the user clicked into the tab. The WebGL context is
  // still only allocated while a pane is the active tab (TerminalPane gates
  // that internally), so this doesn't burn through Chrome's context cap.
  useEffect(() => {
    if (startupTerminalsList.length === 0) return;
    setMountedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const t of startupTerminalsList) {
        if (!next.has(t.id)) {
          next.add(t.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [startupTerminalsList]);

  const newTerminal = useCallback(
    (kind: ShellKind) => {
      addTerminal({
        label: `${KIND_LABEL_PREFIX[kind]} ${projectTerminals.length + 1}`,
        cwd: activeFolder,
        initialCommand: KIND_INITIAL_COMMAND[kind],
        projectPath: activeFolder,
      });
    },
    [addTerminal, activeFolder, projectTerminals.length],
  );

  const handleServerId = useCallback(
    (localId: string, srv: string) => setServerId(localId, srv),
    [setServerId],
  );

  const trimmedFilter = filter.trim().toLowerCase();
  const visibleTerminals = useMemo(() => {
    if (!trimmedFilter) return panelTerminals;
    return panelTerminals.filter((t) => {
      const haystack = `${t.label} ${t.cwd}`.toLowerCase();
      return haystack.includes(trimmedFilter);
    });
  }, [panelTerminals, trimmedFilter]);

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

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      const next = !open;
      if (!next) setFilter('');
      return next;
    });
  }, []);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const onSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setFilter('');
        setSearchOpen(false);
      }
    },
    [],
  );

  return (
    <>
      <div className="sidebar-header">
        <SidebarPanelTabs
          activePanel={activePanel}
          mergeCount={mergeTerminals.length}
          startupCount={startupTerminalsList.length}
          switchPanel={switchPanel}
        />

        <div className="sidebar-header-actions">
          {activePanel === 'terminals' && panelTerminals.length > 0 && (
            <div className={`sidebar-search ${searchOpen ? 'open' : ''}`}>
              <button
                className={`icon-btn sm ${searchOpen || filter ? 'active' : ''}`}
                onClick={toggleSearch}
                title={searchOpen ? 'Close filter' : 'Filter terminals'}
                aria-label="Filter terminals"
                aria-expanded={searchOpen}
              >
                <Search size={12} />
              </button>
              {searchOpen && (
                <>
                  <input
                    ref={searchInputRef}
                    className="sidebar-search-input"
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={onSearchKeyDown}
                    placeholder="Filter…"
                    aria-label="Filter terminals"
                  />
                  <button
                    className="icon-btn sm"
                    onClick={toggleSearch}
                    title="Clear filter"
                    aria-label="Clear filter"
                  >
                    <X size={12} />
                  </button>
                </>
              )}
            </div>
          )}

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
            <NewTerminalDropdown onNewTerminal={newTerminal} />
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

      {tabContextMenu && (() => {
        const idx = visibleTerminals.findIndex((t) => t.id === tabContextMenu.termId);
        const hasLeft = idx > 0;
        const hasRight = idx >= 0 && idx < visibleTerminals.length - 1;
        const hasOthers = visibleTerminals.length > 1 && idx >= 0;
        return (
          <div
            ref={tabContextMenuRef}
            className="popover"
            style={{ position: 'fixed', left: tabContextMenu.x, top: tabContextMenu.y }}
            role="menu"
          >
            <div
              className={`popover-item${!hasLeft ? ' disabled' : ''}`}
              role="menuitem"
              onClick={hasLeft ? () => handleCloseTabsToLeft(tabContextMenu.termId) : undefined}
            >
              Close Tabs to the Left
            </div>
            <div
              className={`popover-item${!hasRight ? ' disabled' : ''}`}
              role="menuitem"
              onClick={hasRight ? () => handleCloseTabsToRight(tabContextMenu.termId) : undefined}
            >
              Close Tabs to the Right
            </div>
            <div
              className={`popover-item${!hasOthers ? ' disabled' : ''}`}
              role="menuitem"
              onClick={hasOthers ? () => handleCloseOtherTabs(tabContextMenu.termId) : undefined}
            >
              Close All Other Tabs
            </div>
          </div>
        );
      })()}
    </>
  );
}

export default Sidebar;
