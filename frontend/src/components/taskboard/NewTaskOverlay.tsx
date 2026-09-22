import { useEffect, useRef, useState } from 'react';
import type { Lane } from './lanes';
import { useEscapeToClose } from '../shared/useEscapeToClose';

// Modal-ish overlay for creating a new task in a specific lane. Cmd/Ctrl+Enter
// in the description submits; Enter in the title submits; Escape cancels.
// `onSubmit` may be async (it creates the task); the overlay shows an "Adding…"
// in-flight state and guards against a double-submit until it resolves. The
// parent dismisses the overlay on success.
export function NewTaskOverlay({
  lane,
  onSubmit,
  onCancel,
}: {
  lane: Lane;
  onSubmit: (title: string, desc?: string) => void | Promise<unknown>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  // Innermost-wins: Escape cancels just this overlay, not the board panel.
  useEscapeToClose(true, onCancel);

  async function submit() {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(title, desc || undefined);
    } finally {
      // If the create succeeded the parent unmounts this overlay; otherwise the
      // error toast is shown and the user can retry, so re-enable the button.
      setSubmitting(false);
    }
  }

  return (
    <div className="taskboard-overlay" onMouseDown={onCancel}>
      <div className="taskboard-newform" onMouseDown={(e) => e.stopPropagation()}>
        <div className="taskboard-newform-head">
          <span
            className="taskboard-lane-dot"
            style={{ background: lane.color }}
          />
          New task in {lane.label}
        </div>
        <div className="taskboard-newform-body">
          <input
            ref={titleRef}
            className="task-card-form-input"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <textarea
            className="task-card-form-input task-card-form-textarea"
            placeholder="Description (optional)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={4}
          />
        </div>
        <div className="taskboard-newform-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={!title.trim() || submitting}
          >
            {submitting && <span className="spinner" />}
            {submitting ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </div>
    </div>
  );
}
