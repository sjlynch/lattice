import { useState } from 'react';
import { GripVertical, X } from 'lucide-react';
import type { WorkflowStep, WorkflowStepMode } from '../../api';

export const STEP_DRAG_MIME = 'application/x-lattice-workflow-step';

// One row in the step editor. Drag-and-drop reorders by index using a
// custom MIME so generic text drags onto the editor don't trigger reorders.
export function StepRow({
  step,
  index,
  onChange,
  onRemove,
  onReorder,
}: {
  step: WorkflowStep;
  index: number;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onRemove: () => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
}) {
  const [dragOver, setDragOver] = useState<'top' | 'bottom' | null>(null);

  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(STEP_DRAG_MIME, String(index));
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(STEP_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const half = rect.top + rect.height / 2;
    setDragOver(e.clientY < half ? 'top' : 'bottom');
  }
  function onDragLeave() { setDragOver(null); }
  function onDrop(e: React.DragEvent) {
    const fromStr = e.dataTransfer.getData(STEP_DRAG_MIME);
    setDragOver(null);
    if (!fromStr) return;
    e.preventDefault();
    const fromIdx = Number(fromStr);
    if (Number.isNaN(fromIdx)) return;
    const toIdx = dragOver === 'bottom' ? index + 1 : index;
    onReorder(fromIdx, toIdx);
  }

  return (
    <div
      className={`workflows-step ${dragOver ? `drop-${dragOver}` : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="workflows-step-grip" aria-hidden>
        <GripVertical size={12} />
      </span>
      <div className="workflows-step-body">
        <div className="workflows-step-row">
          <span className="workflows-step-index">#{index + 1}</span>
          <input
            className="task-card-form-input workflows-step-title"
            placeholder="Step title"
            value={step.title}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          <select
            className="workflows-step-mode"
            value={step.mode}
            onChange={(e) => onChange({ mode: e.target.value as WorkflowStepMode })}
            title="Sequential runs after the prior step finishes; parallel is reserved for the upcoming fan-out executor"
          >
            <option value="sequential">sequential</option>
            <option value="parallel">parallel</option>
          </select>
          <button
            className="icon-btn sm"
            onClick={onRemove}
            title="Remove step"
            aria-label="Remove step"
          >
            <X size={12} />
          </button>
        </div>
        <textarea
          className="task-card-form-input task-card-form-textarea workflows-step-prompt"
          placeholder="Prompt — written into LATTICE_TASK.md as the task description."
          value={step.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={4}
        />
      </div>
    </div>
  );
}
