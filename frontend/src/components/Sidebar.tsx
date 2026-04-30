import { Plus, X, TerminalSquare } from 'lucide-react';
import { TerminalPane } from './TerminalPane';
import { useTerminals } from '../TerminalsContext';

type Props = {
  activeFolder: string;
};

export function Sidebar({ activeFolder }: Props) {
  const { terminals, activeId, setActiveId, addTerminal, closeTerminal } =
    useTerminals();

  function newTerminal() {
    addTerminal({
      label: `claude ${terminals.length + 1}`,
      cwd: activeFolder,
    });
  }

  return (
    <>
      <div className="sidebar-header">
        <span className="sidebar-title">Terminals</span>
        <button
          className="icon-btn sm"
          onClick={newTerminal}
          title="New Claude terminal"
          aria-label="New Claude terminal"
        >
          <Plus size={14} />
        </button>
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
              />
            </div>
          ))
        )}
      </div>
    </>
  );
}
