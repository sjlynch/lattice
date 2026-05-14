import { Modal } from '../Modal';
import type { GraphNode } from '../../api';
import { relPath, type MenuItemDef } from './menu';

type Props = {
  action: MenuItemDef | null;
  promptText: string;
  onPromptChange: (value: string) => void;
  submitting: boolean;
  selectedFiles: GraphNode[];
  rootPath: string;
  onSubmit: () => void;
  onClose: () => void;
};

// Modal launched from the right-click menu. Pure render — all state
// and async work lives in useGraphTaskCreation.
export function GraphTaskModal({
  action,
  promptText,
  onPromptChange,
  submitting,
  selectedFiles,
  rootPath,
  onSubmit,
  onClose,
}: Props) {
  return (
    <Modal open={!!action} onClose={onClose}>
      <div className="modal-header">
        {action?.label.replace(/…$/, '')} ({selectedFiles.length}{' '}
        {selectedFiles.length === 1 ? 'file' : 'files'})
      </div>
      <div className="modal-body">
        <textarea
          className="task-card-form-textarea"
          value={promptText}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="Describe what Claude should do…"
          rows={6}
          autoFocus
        />
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          Files (relative to project root):
        </div>
        <div
          style={{
            maxHeight: 160,
            overflow: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 8px',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            background: '#15181d',
          }}
        >
          {selectedFiles.length === 0 ? (
            <em>No files selected.</em>
          ) : (
            selectedFiles.map((n) => (
              <div key={n.id}>{relPath(n.path, rootPath)}</div>
            ))
          )}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn-ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={onSubmit}
          disabled={submitting || !promptText.trim() || selectedFiles.length === 0}
        >
          {submitting ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </Modal>
  );
}
