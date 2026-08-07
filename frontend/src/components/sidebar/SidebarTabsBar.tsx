import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useRef, useState, type DragEvent, type MouseEvent, type RefObject } from 'react';
import type { TerminalSpec } from '../../TerminalsContext';
import { SidebarTab } from './SidebarTab';

type Props = {
  visibleTerminals: TerminalSpec[];
  filter: string;
  // Backend session ids whose harness is still working (see
  // `hooks/useBusyAgentTerminals`) — those tabs render a spinner for an icon.
  busyServerIds: ReadonlySet<string>;
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
  reorderTerminal: (draggedId: string, targetId: string) => void;
};

export function SidebarTabsBar({
  visibleTerminals,
  filter,
  busyServerIds,
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
  reorderTerminal,
}: Props) {
  // Inline rename: double-click a tab to edit its (searchable) label. Only the
  // id of the tab being edited lives here; the draft text is owned by the
  // <RenameInput> leaf so per-keystroke churn never reaches the other tabs.
  const [editingId, setEditingId] = useState<string | null>(null);

  const startRename = useCallback((id: string) => setEditingId(id), []);
  const commitRename = useCallback(
    (id: string, label: string) => {
      renameTerminal(id, label);
      setEditingId(null);
    },
    [renameTerminal],
  );
  const cancelRename = useCallback(() => setEditingId(null), []);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Mirror the dragged id into a ref so the drag callbacks stay referentially
  // stable across the state changes they trigger — otherwise every memoized
  // tab would re-render on each dragover as the closures changed identity.
  const draggingIdRef = useRef<string | null>(null);

  const onDragStart = useCallback((e: DragEvent, id: string) => {
    draggingIdRef.current = id;
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set for the drag to start.
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const onDragOver = useCallback((e: DragEvent, id: string) => {
    const dragging = draggingIdRef.current;
    if (dragging === null || dragging === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId((prev) => (prev === id ? prev : id));
  }, []);

  const onDrop = useCallback(
    (e: DragEvent, id: string) => {
      e.preventDefault();
      const dragging = draggingIdRef.current;
      if (dragging !== null && dragging !== id) {
        reorderTerminal(dragging, id);
      }
      draggingIdRef.current = null;
      setDraggingId(null);
      setDragOverId(null);
    },
    [reorderTerminal],
  );

  const onDragEnd = useCallback(() => {
    draggingIdRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  }, []);

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
            <SidebarTab
              key={t.id}
              id={t.id}
              label={t.label}
              cwd={t.cwd}
              kind={t.kind}
              status={t.status}
              exitCode={t.exitCode}
              busy={t.serverId !== undefined && busyServerIds.has(t.serverId)}
              isActive={t.id === activeId}
              isDragging={t.id === draggingId}
              isDragOver={t.id === dragOverId}
              isEditing={editingId === t.id}
              activeTabRef={activeTabRef}
              onActivate={setActiveId}
              onClose={closeTerminal}
              onStartRename={startRename}
              onRename={commitRename}
              onCancelRename={cancelRename}
              onContextMenu={handleTabContextMenu}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
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
