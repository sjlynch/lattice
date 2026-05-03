import { useEffect, useRef, useState } from 'react';
import type { Lane } from './lanes';

// Modal-ish overlay for creating a new task in a specific lane. Cmd/Ctrl+Enter
// in the description submits; Enter in the title submits; Escape cancels.
export function NewTaskOverlay({
  lane,
  onSubmit,
  onCancel,
}: {
  lane: Lane;
  onSubmit: (title: string, desc?: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function submit() {
    if (!title.trim()) return;
    onSubmit(title, desc || undefined);
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
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={!title.trim()}
          >
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}
