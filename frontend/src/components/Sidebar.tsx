import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitMerge,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import { TerminalPane } from './TerminalPane';
import { useTerminals } from '../TerminalsContext';
import type { StartupTerminal } from '../api';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Props = {
  activeFolder: string;
  startupTerminals: StartupTerminal[];
};

type ShellKind = 'claude' | 'claude-yolo' | 'terminal';
type Panel = 'terminals' | 'merging' | 'startup';

const KIND_INITIAL_COMMAND: Record<ShellKind, string | undefined> = {
  claude: 'claude',
  'claude-yolo': 'claude --dangerously-skip-permissions',
  terminal: undefined,
};

const KIND_LABEL_PREFIX: Record<ShellKind, string> = {
  claude: 'claude',
  'claude-yolo': 'claude!',
  terminal: 'terminal',
};

const SCROLL_STEP = 160;

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

  const [activePanel, setActivePanel] = useState<Panel>('terminals');
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    termId: string;
  } | null>(null);

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

  const menuRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);

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

  // Auto-switch to Merging panel when a new merge terminal is added.
  const prevMergeCountRef = useRef(mergeTerminals.length);
  useEffect(() => {
    if (mergeTerminals.length > prevMergeCountRef.current) {
      setActivePanel('merging');
      const newest = mergeTerminals[mergeTerminals.length - 1];
      if (newest) setActiveId(newest.id);
    }
    prevMergeCountRef.current = mergeTerminals.length;
  }, [mergeTerminals, setActiveId]);

  // When the Merging panel disappears (all merge terminals closed), fall back.
  useEffect(() => {
    if (mergeTerminals.length === 0 && activePanel === 'merging') {
      setActivePanel('terminals');
    }
    if (startupTerminalsList.length === 0 && activePanel === 'startup') {
      setActivePanel('terminals');
    }
  }, [mergeTerminals.length, startupTerminalsList.length, activePanel]);

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

  // If activeId points to a terminal that belongs to the panel we're
  // not currently viewing (e.g. user clicked the focus-terminal button on
  // a conflict task while on the regular Terminals panel), switch panels
  // so its tab is visible.
  useEffect(() => {
    if (!activeId) return;
    const t = projectTerminals.find((p) => p.id === activeId);
    if (!t) return;
    const target: Panel =
      t.kind === 'merge' ? 'merging' : t.kind === 'startup' ? 'startup' : 'terminals';
    if (target !== activePanel) setActivePanel(target);
  }, [activeId, projectTerminals, activePanel]);

  const panelTerminals =
    activePanel === 'merging'
      ? mergeTerminals
      : activePanel === 'startup'
        ? startupTerminalsList
        : regularTerminals;

  const switchPanel = useCallback(
    (panel: Panel) => {
      setActivePanel(panel);
      setFilter('');
      setSearchOpen(false);
      const list =
        panel === 'merging'
          ? mergeTerminals
          : panel === 'startup'
            ? startupTerminalsList
            : regularTerminals;
      if (list.length > 0 && !list.find((t) => t.id === activeId)) {
        setActiveId(list[list.length - 1].id);
      }
    },
    [mergeTerminals, regularTerminals, startupTerminalsList, activeId, setActiveId],
  );

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

  // Mirror the latest projectTerminals into a ref so the seeding effect
  // can detect already-running startup terminals after a page refresh
  // without re-running every time the terminals list changes.
  const projectTerminalsRef = useRef(projectTerminals);
  useEffect(() => {
    projectTerminalsRef.current = projectTerminals;
  }, [projectTerminals]);

  // Auto-spawn configured startup terminals on first mount / project change.
  // Skip ones that are already present (matched by startupId + projectPath)
  // so a page refresh — which keeps sessionStorage and the backend pty alive
  // via serverId — doesn't double-spawn them.
  useEffect(() => {
    if (!activeFolder) return;
    const existing = projectTerminalsRef.current;
    for (const cfg of startupTerminals) {
      if (!cfg.command.trim()) continue;
      const already = existing.some(
        (t) =>
          t.kind === 'startup' &&
          t.startupId === cfg.id &&
          t.projectPath === activeFolder,
      );
      if (already) continue;
      addTerminal(
        {
          label: cfg.label || 'startup',
          cwd: activeFolder,
          initialCommand: cfg.command,
          projectPath: activeFolder,
          kind: 'startup',
          startupId: cfg.id,
        },
        false, // don't steal focus
      );
    }
  }, [activeFolder, startupTerminals, addTerminal]);

  // Stop and restart every startup terminal for the active project. We
  // explicitly re-add here rather than waiting for the seeding effect: the
  // effect's deps (activeFolder, startupTerminals) haven't changed, so it
  // wouldn't fire again on its own.
  const restartStartupTerminals = useCallback(() => {
    if (!activeFolder) return;
    const ids = projectTerminalsRef.current
      .filter((t) => t.kind === 'startup' && t.projectPath === activeFolder)
      .map((t) => t.id);
    if (ids.length > 0) closeTerminals(ids);
    for (const cfg of startupTerminals) {
      if (!cfg.command.trim()) continue;
      addTerminal(
        {
          label: cfg.label || 'startup',
          cwd: activeFolder,
          initialCommand: cfg.command,
          projectPath: activeFolder,
          kind: 'startup',
          startupId: cfg.id,
        },
        false,
      );
    }
  }, [activeFolder, closeTerminals, addTerminal, startupTerminals]);

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

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!tabContextMenu) return;
    function onPointerDown(e: PointerEvent) {
      if (tabContextMenuRef.current && !tabContextMenuRef.current.contains(e.target as Node)) {
        setTabContextMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setTabContextMenu(null);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    setTabContextMenu(null);
  }, [activePanel]);

  const handleServerId = useCallback(
    (localId: string, srv: string) => setServerId(localId, srv),
    [setServerId],
  );

  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent, termId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setTabContextMenu({ x: e.clientX, y: e.clientY, termId });
    },
    [],
  );

  const trimmedFilter = filter.trim().toLowerCase();
  const visibleTerminals = useMemo(() => {
    if (!trimmedFilter) return panelTerminals;
    return panelTerminals.filter((t) => {
      const haystack = `${t.label} ${t.cwd}`.toLowerCase();
      return haystack.includes(trimmedFilter);
    });
  }, [panelTerminals, trimmedFilter]);

  const handleCloseTabsToLeft = useCallback(
    (termId: string) => {
      const idx = visibleTerminals.findIndex((t) => t.id === termId);
      const toClose = visibleTerminals.slice(0, idx).map((t) => t.id);
      if (toClose.length > 0) closeTerminals(toClose);
      setTabContextMenu(null);
    },
    [visibleTerminals, closeTerminals],
  );

  const handleCloseTabsToRight = useCallback(
    (termId: string) => {
      const idx = visibleTerminals.findIndex((t) => t.id === termId);
      const toClose = visibleTerminals.slice(idx + 1).map((t) => t.id);
      if (toClose.length > 0) closeTerminals(toClose);
      setTabContextMenu(null);
    },
    [visibleTerminals, closeTerminals],
  );

  const handleCloseOtherTabs = useCallback(
    (termId: string) => {
      const toClose = visibleTerminals.filter((t) => t.id !== termId).map((t) => t.id);
      if (toClose.length > 0) closeTerminals(toClose);
      setTabContextMenu(null);
    },
    [visibleTerminals, closeTerminals],
  );

  const updateScrollState = useCallback(() => {
    const el = tabsRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
  }, [visibleTerminals, updateScrollState]);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onScroll = () => updateScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(updateScrollState, 150);
    });
    ro.observe(el);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [updateScrollState]);

  useEffect(() => {
    const el = activeTabRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const scrollTabs = useCallback((dir: 1 | -1) => {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * SCROLL_STEP, behavior: 'smooth' });
  }, []);

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
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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
        <div className="sidebar-panel-tabs">
          <button
            className={`sidebar-panel-tab ${activePanel === 'terminals' ? 'active' : ''}`}
            onClick={() => switchPanel('terminals')}
          >
            <TerminalSquare size={11} />
            Terminals
          </button>
          {mergeTerminals.length > 0 && (
            <button
              className={`sidebar-panel-tab merge ${activePanel === 'merging' ? 'active' : ''}`}
              onClick={() => switchPanel('merging')}
            >
              <GitMerge size={11} />
              Merging
              {activePanel !== 'merging' && mergeTerminals.length > 0 && (
                <span className="sidebar-panel-tab-badge">
                  {mergeTerminals.length}
                </span>
              )}
            </button>
          )}
          {startupTerminalsList.length > 0 && (
            <button
              className={`sidebar-panel-tab startup ${activePanel === 'startup' ? 'active' : ''}`}
              onClick={() => switchPanel('startup')}
            >
              <Rocket size={11} />
              Startup
            </button>
          )}
        </div>

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
            <div className="sidebar-new" ref={menuRef}>
              <button
                className="icon-btn sm"
                onClick={() => newTerminal('claude')}
                title="New Claude terminal"
                aria-label="New Claude terminal"
              >
                <Plus size={14} />
              </button>
              <button
                className="icon-btn sm sidebar-new-chevron"
                onClick={() => setMenuOpen((v) => !v)}
                title="Choose terminal type"
                aria-label="Choose terminal type"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <ChevronDown size={12} />
              </button>
              {menuOpen && (
                <div className="popover sidebar-new-menu" role="menu">
                  <div
                    className="popover-item"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); newTerminal('claude'); }}
                  >
                    Claude
                  </div>
                  <div
                    className="popover-item"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); newTerminal('claude-yolo'); }}
                  >
                    Dangerous Claude
                  </div>
                  <div
                    className="popover-item"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); newTerminal('terminal'); }}
                  >
                    Terminal
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {panelTerminals.length > 0 && (
        <div className="sidebar-tabs-row">
          <button
            className="sidebar-tabs-scroll left"
            onClick={() => scrollTabs(-1)}
            disabled={!canScrollLeft}
            title="Scroll tabs left"
            aria-label="Scroll tabs left"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="sidebar-tabs" ref={tabsRef}>
            {visibleTerminals.length === 0 ? (
              <div className="sidebar-tabs-empty">
                No terminals match "{filter}"
              </div>
            ) : (
              visibleTerminals.map((t) => (
                <div
                  key={t.id}
                  ref={t.id === activeId ? activeTabRef : undefined}
                  className={`sidebar-tab ${t.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(t.id)}
                  onContextMenu={(e) => handleTabContextMenu(e, t.id)}
                  title={t.cwd}
                >
                  {t.kind === 'merge' ? (
                    <GitMerge size={12} />
                  ) : t.kind === 'startup' ? (
                    <Rocket size={12} />
                  ) : (
                    <TerminalSquare size={12} />
                  )}
                  <span>{t.label}</span>
                  <button
                    className="sidebar-tab-close"
                    onClick={(e) => { e.stopPropagation(); closeTerminal(t.id); }}
                    title="Close"
                    aria-label="Close terminal"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
          <button
            className="sidebar-tabs-scroll right"
            onClick={() => scrollTabs(1)}
            disabled={!canScrollRight}
            title="Scroll tabs right"
            aria-label="Scroll tabs right"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      <div className="sidebar-content">
        {panelTerminals.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              {activePanel === 'merging' ? (
                <GitMerge size={22} />
              ) : activePanel === 'startup' ? (
                <Rocket size={22} />
              ) : (
                <TerminalSquare size={22} />
              )}
            </div>
            <div className="sidebar-empty-title">
              {activePanel === 'merging'
                ? 'No merge resolvers'
                : activePanel === 'startup'
                  ? 'No startup terminals'
                  : 'No terminals yet'}
            </div>
            {activePanel === 'terminals' && (
              <div className="sidebar-empty-sub">
                Click <Plus size={11} style={{ verticalAlign: -1 }} /> above to
                start a Claude Code shell rooted at <code>{activeFolder}</code>,
                or hit ▶ on a task to spawn one in a worktree.
              </div>
            )}
            {activePanel === 'startup' && (
              <div className="sidebar-empty-sub">
                Configure commands that auto-run on page load via the gear
                icon in the top bar.
              </div>
            )}
          </div>
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
