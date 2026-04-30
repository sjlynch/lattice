import { ChevronDown, Plus, X, TerminalSquare } from 'lucide-react';
import { TerminalPane } from './TerminalPane';
import { useTerminals } from '../TerminalsContext';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <div className="sidebar-header">
        <span className="sidebar-title">Terminals</span>
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
        <div className="sidebar-tabs">
          {terminals.map((t) => (
            <div
              key={t.id}
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
          ))}
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
