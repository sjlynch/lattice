import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical, X } from 'lucide-react';
import type { HarnessAvailability, WorkflowStep, WorkflowStepHarness, WorkflowStepMode } from '../../api';

export const STEP_DRAG_MIME = 'application/x-lattice-workflow-step';

// Minimum textarea height when expanded — keeps a freshly-added step from
// rendering as a 1-line strip before the user types anything.
const PROMPT_MIN_HEIGHT_PX = 64;

// One row in the step editor. Drag-and-drop reorders by index using a
// custom MIME so generic text drags onto the editor don't trigger reorders.
export function StepRow({
  step,
  index,
  collapsed,
  harnessAvail,
  onChange,
  onRemove,
  onReorder,
  onToggleCollapse,
}: {
  step: WorkflowStep;
  index: number;
  collapsed: boolean;
  harnessAvail: HarnessAvailability;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onRemove: () => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onToggleCollapse: () => void;
}) {
  const [dragOver, setDragOver] = useState<'top' | 'bottom' | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Auto-fit the textarea to its content. Keeping the prompt fully visible
  // by default removes the need for the native resize handle (which Chrome
  // renders as a stark white square in the bottom-right corner against
  // the dark theme whenever the text doesn't fill the box).
  useLayoutEffect(() => {
    const ta = promptRef.current;
    if (!ta || collapsed) return;
    ta.style.height = 'auto';
    const next = Math.max(PROMPT_MIN_HEIGHT_PX, ta.scrollHeight);
    ta.style.height = `${next}px`;
  }, [step.prompt, collapsed]);

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

  const selectedHarness = step.harness ?? 'claude';
  const showHarnessSelect = harnessAvail.pi || harnessAvail.codex || selectedHarness !== 'claude';

  return (
    <div
      className={`workflows-step ${dragOver ? `drop-${dragOver}` : ''} ${collapsed ? 'collapsed' : ''}`}
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
          <button
            type="button"
            className="icon-btn sm workflows-step-collapse"
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand step' : 'Collapse step'}
            aria-label={collapsed ? 'Expand step' : 'Collapse step'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
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
          {showHarnessSelect && (
            <select
              className="workflows-step-harness"
              value={selectedHarness}
              onChange={(e) => onChange({ harness: e.target.value as WorkflowStepHarness })}
              title="Agent harness for this workflow step"
            >
              <option value="claude">Claude</option>
              {(harnessAvail.pi || selectedHarness === 'pi') && <option value="pi">Pi</option>}
              {(harnessAvail.codex || selectedHarness === 'codex') && <option value="codex">Codex</option>}
            </select>
          )}
          <button
            className="icon-btn sm"
            onClick={onRemove}
            title="Remove step"
            aria-label="Remove step"
          >
            <X size={12} />
          </button>
        </div>
        {!collapsed && (
          <textarea
            ref={promptRef}
            className="task-card-form-input task-card-form-textarea workflows-step-prompt"
            placeholder="Prompt — written into LATTICE_TASK.md as the task description."
            value={step.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}
