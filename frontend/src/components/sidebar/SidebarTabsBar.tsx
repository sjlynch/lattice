import { ChevronLeft, ChevronRight, GitMerge, Rocket, TerminalSquare, X } from 'lucide-react';
import { memo, useCallback, useRef, useState, type DragEvent, type MouseEvent, type RefObject } from 'react';
import type { TerminalSpec } from '../../TerminalsContext';
import type { TerminalStatus } from '../../terminal/terminalTypes';

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
  reorderTerminal: (draggedId: string, targetId: string) => void;
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

// Tabs only surface a dot for the attention-worthy states; a live or
// still-connecting terminal stays quiet (no extra noise), matching the
// behaviour described in the task.
const STATUS_TOOLTIPS: Record<TerminalStatus, string> = {
  connecting: 'Connecting…',
  live: 'Connected',
  reconnecting: 'Reconnecting…',
  exited: 'Exited',
  dead: 'Disconnected — close and reopen',
};

function statusTooltip(status: TerminalStatus, exitCode?: number): string {
  if (status === 'exited') {
    return exitCode === undefined ? 'Exited' : `Exited (code ${exitCode})`;
  }
  return STATUS_TOOLTIPS[status];
}

type SidebarTabProps = {
  id: string;
  label: string;
  cwd: string;
  kind?: 'merge' | 'startup';
  status?: TerminalStatus;
  exitCode?: number;
  isActive: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  isEditing: boolean;
  activeTabRef: RefObject<HTMLDivElement | null>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onCancelRename: () => void;
  onContextMenu: (e: MouseEvent, id: string) => void;
  onDragStart: (e: DragEvent, id: string) => void;
  onDragOver: (e: DragEvent, id: string) => void;
  onDrop: (e: DragEvent, id: string) => void;
  onDragEnd: () => void;
};

// Memoized so the most populous sidebar list (many concurrent agents → many
// terminals) only re-renders the handful of tabs whose flags actually change
// on a given TerminalsContext update or drag — not every tab. All callbacks
// are id-parameterized and stable, so the shallow prop compare holds.
const SidebarTab = memo(function SidebarTab({
  id,
  label,
  cwd,
  kind,
  status,
  exitCode,
  isActive,
  isDragging,
  isDragOver,
  isEditing,
  activeTabRef,
  onActivate,
  onClose,
  onStartRename,
  onRename,
  onCancelRename,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: SidebarTabProps) {
  return (
    <div
      ref={isActive ? activeTabRef : undefined}
      className={`sidebar-tab ${isActive ? 'active' : ''} ${
        isDragging ? 'dragging' : ''
      } ${isDragOver ? 'drag-over' : ''}`}
      draggable
      onClick={() => onActivate(id)}
      onDoubleClick={(e) => { e.stopPropagation(); onStartRename(id); }}
      onContextMenu={(e) => onContextMenu(e, id)}
      onDragStart={(e) => onDragStart(e, id)}
      onDragOver={(e) => onDragOver(e, id)}
      onDrop={(e) => onDrop(e, id)}
      onDragEnd={onDragEnd}
      title={isEditing ? undefined : `${cwd}\nDouble-click to rename`}
    >
      {kind === 'merge' ? (
        <GitMerge size={12} />
      ) : kind === 'startup' ? (
        <Rocket size={12} />
      ) : (
        <TerminalSquare size={12} />
      )}
      {isEditing ? (
        <RenameInput
          initialLabel={label}
          onCommit={(name) => onRename(id, name)}
          onCancel={onCancelRename}
        />
      ) : (
        <span>{label}</span>
      )}
      {status && status !== 'live' && status !== 'connecting' && (
        <span
          className={`sidebar-tab-status ${status}`}
          title={statusTooltip(status, exitCode)}
          aria-label={statusTooltip(status, exitCode)}
          role="img"
        />
      )}
      <button
        className="sidebar-tab-close"
        onClick={(e) => { e.stopPropagation(); onClose(id); }}
        title="Close"
        aria-label="Close terminal"
      >
        <X size={12} />
      </button>
    </div>
  );
});

// Mounts fresh each time a rename begins, seeding the draft from the current
// label (replacing the parent's old setDraft-on-startRename). The doneRef guard
// keeps the exact rename semantics: Enter or blur commits once, Escape cancels
// without committing — even though unmounting the focused input also fires blur.
function RenameInput({
  initialLabel,
  onCommit,
  onCancel,
}: {
  initialLabel: string;
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialLabel);
  const doneRef = useRef(false);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(draft);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <input
      className="sidebar-tab-rename"
      value={draft}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      aria-label="Rename terminal"
    />
  );
}
