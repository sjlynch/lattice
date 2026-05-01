import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import { TerminalPane } from './TerminalPane';
import { useTerminals } from '../TerminalsContext';
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
};

type ShellKind = 'claude' | 'claude-yolo' | 'terminal';

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

export function Sidebar({ activeFolder }: Props) {
  const {
    terminals,
    activeId,
    setActiveId,
    addTerminal,
    closeTerminal,
    setServerId,
  } = useTerminals();

  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);

  const newTerminal = useCallback(
    (kind: ShellKind) => {
      addTerminal({
        label: `${KIND_LABEL_PREFIX[kind]} ${terminals.length + 1}`,
        cwd: activeFolder,
        initialCommand: KIND_INITIAL_COMMAND[kind],
      });
    },
    [addTerminal, activeFolder, terminals.length],
  );

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
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

  const handleServerId = useCallback(
    (localId: string, srv: string) => setServerId(localId, srv),
    [setServerId],
  );

  const trimmedFilter = filter.trim().toLowerCase();
  const visibleTerminals = useMemo(() => {
    if (!trimmedFilter) return terminals;
    return terminals.filter((t) => {
      const haystack = `${t.label} ${t.cwd}`.toLowerCase();
      return haystack.includes(trimmedFilter);
    });
  }, [terminals, trimmedFilter]);

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
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [updateScrollState]);

  // Keep the active tab visible when it changes (e.g. clicking it, or
  // switching via Run on a task). Use 'nearest' so we only nudge when
  // it's actually offscreen.
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
        <div className="sidebar-header-left">
          <span className="sidebar-title">Terminals</span>
          {terminals.length > 0 && (
            <div
              className={`sidebar-search ${searchOpen ? 'open' : ''}`}
            >
              <button
                className={`icon-btn sm ${
                  searchOpen || filter ? 'active' : ''
                }`}
                onClick={toggleSearch}
                title={searchOpen ? 'Close filter' : 'Filter terminals'}
                aria-label="Filter terminals"
                aria-expanded={searchOpen}
              >
                <Search size={12} />
              </button>
              {searchOpen && (
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
              )}
            </div>
          )}
        </div>
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
                onClick={() => {
                  setMenuOpen(false);
                  newTerminal('claude');
                }}
              >
                Claude
              </div>
              <div
                className="popover-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  newTerminal('claude-yolo');
                }}
              >
                Dangerous Claude
              </div>
              <div
                className="popover-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  newTerminal('terminal');
                }}
              >
                Terminal
              </div>
            </div>
          )}
        </div>
      </div>

      {terminals.length > 0 && (
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
                No terminals match “{filter}”
              </div>
            ) : (
              visibleTerminals.map((t) => (
                <div
                  key={t.id}
                  ref={t.id === activeId ? activeTabRef : undefined}
                  className={`sidebar-tab ${t.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(t.id)}
                  title={t.cwd}
                >
                  <TerminalSquare size={12} />
                  <span>{t.label}</span>
                  <button
                    className="sidebar-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(t.id);
                    }}
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
        {terminals.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              <TerminalSquare size={22} />
            </div>
            <div className="sidebar-empty-title">No terminals yet</div>
            <div className="sidebar-empty-sub">
              Click <Plus size={11} style={{ verticalAlign: -1 }} /> above to
              start a Claude Code shell rooted at <code>{activeFolder}</code>,
              or hit ▶ on a task to spawn one in a worktree.
            </div>
          </div>
        ) : (
          terminals.map((t) => (
            <div
              key={t.id}
              className={`sidebar-pane ${t.id === activeId ? '' : 'hidden'}`}
            >
              <TerminalPane
                cwd={t.cwd}
                active={t.id === activeId}
                initialCommand={t.initialCommand}
                serverId={t.serverId}
                onServerId={(srv) => handleServerId(t.id, srv)}
              />
            </div>
          ))
        )}
      </div>
    </>
  );
}
