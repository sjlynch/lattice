import { GitMerge, Rocket, TerminalSquare, X } from 'lucide-react';
import { memo, type DragEvent, type MouseEvent, type RefObject } from 'react';
import type { TerminalStatus } from '../../terminal/terminalTypes';
import { RenameInput } from './RenameInput';

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
export const SidebarTab = memo(function SidebarTab({
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
