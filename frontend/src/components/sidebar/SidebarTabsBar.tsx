import { ChevronLeft, ChevronRight, GitMerge, Rocket, TerminalSquare, X } from 'lucide-react';
import { useState } from 'react';
import type { MouseEvent, RefObject } from 'react';
import type { TerminalSpec } from '../../TerminalsContext';

type Props = {
  visibleTerminals: TerminalSpec[];
  filter: string;
  activeId: string | null;
  setActiveId: (id: string) => void;
  closeTerminal: (id: string) => void;
  renameTerminal: (id: string, label: string) => void;
  tabsRef: RefObject<HTMLDivElement | null>;
  activeTabRef: RefObject<HTMLDivElement | null>;
  canScrollLeft: boolean;
  canScrollRight: boolean;
  scrollTabs: (dir: 1 | -1) => void;
  handleTabContextMenu: (e: MouseEvent, termId: string) => void;
};

export function SidebarTabsBar({
  visibleTerminals,
  filter,
  activeId,
  setActiveId,
  closeTerminal,
  renameTerminal,
  tabsRef,
  activeTabRef,
  canScrollLeft,
  canScrollRight,
  scrollTabs,
  handleTabContextMenu,
}: Props) {
  // Inline rename: double-click a tab to edit its (searchable) label.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startRename = (t: TerminalSpec) => {
    setEditingId(t.id);
    setDraft(t.label);
  };
  const commitRename = () => {
    if (editingId) renameTerminal(editingId, draft);
    setEditingId(null);
  };
  const cancelRename = () => setEditingId(null);

  return (
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
              onDoubleClick={(e) => { e.stopPropagation(); startRename(t); }}
              onContextMenu={(e) => handleTabContextMenu(e, t.id)}
              title={editingId === t.id ? undefined : `${t.cwd}\nDouble-click to rename`}
            >
              {t.kind === 'merge' ? (
                <GitMerge size={12} />
              ) : t.kind === 'startup' ? (
                <Rocket size={12} />
              ) : (
                <TerminalSquare size={12} />
              )}
              {editingId === t.id ? (
                <input
                  className="sidebar-tab-rename"
                  value={draft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                  }}
                  aria-label="Rename terminal"
                />
              ) : (
                <span>{t.label}</span>
              )}
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
  );
}
