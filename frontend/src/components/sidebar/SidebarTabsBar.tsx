import { ChevronLeft, ChevronRight, GitMerge, Rocket, TerminalSquare, X } from 'lucide-react';
import { useState, type DragEvent, type MouseEvent, type RefObject } from 'react';
import type { TerminalSpec } from '../../TerminalsContext';

type Props = {
  visibleTerminals: TerminalSpec[];
  filter: string;
  activeId: string | null;
  setActiveId: (id: string) => void;
  closeTerminal: (id: string) => void;
  tabsRef: RefObject<HTMLDivElement | null>;
  activeTabRef: RefObject<HTMLDivElement | null>;
  canScrollLeft: boolean;
  canScrollRight: boolean;
  scrollTabs: (dir: 1 | -1) => void;
  handleTabContextMenu: (e: MouseEvent, termId: string) => void;
  reorderTerminal: (draggedId: string, targetId: string) => void;
};

export function SidebarTabsBar({
  visibleTerminals,
  filter,
  activeId,
  setActiveId,
  closeTerminal,
  tabsRef,
  activeTabRef,
  canScrollLeft,
  canScrollRight,
  scrollTabs,
  handleTabContextMenu,
  reorderTerminal,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const onDragStart = (e: DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set for the drag to start.
    e.dataTransfer.setData('text/plain', id);
  };

  const onDragOver = (e: DragEvent, id: string) => {
    if (draggingId === null || draggingId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== id) setDragOverId(id);
  };

  const onDrop = (e: DragEvent, id: string) => {
    e.preventDefault();
    if (draggingId !== null && draggingId !== id) {
      reorderTerminal(draggingId, id);
    }
    setDraggingId(null);
    setDragOverId(null);
  };

  const onDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

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
              className={`sidebar-tab ${t.id === activeId ? 'active' : ''} ${
                t.id === draggingId ? 'dragging' : ''
              } ${t.id === dragOverId ? 'drag-over' : ''}`}
              draggable
              onClick={() => setActiveId(t.id)}
              onContextMenu={(e) => handleTabContextMenu(e, t.id)}
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragOver={(e) => onDragOver(e, t.id)}
              onDrop={(e) => onDrop(e, t.id)}
              onDragEnd={onDragEnd}
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
  );
}
