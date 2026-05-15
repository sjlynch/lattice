import { useRef } from 'react';
import { ChevronDown, ChevronRight, GripVertical, Wand2, X } from 'lucide-react';
import type { HarnessAvailability, WorkflowStep, WorkflowStepMode } from '../../api';
import {
  availableAgentHarnesses,
  harnessLabel,
  normalizeAgentHarness,
  type AgentHarness,
} from '../../harnesses';
import {
  useAutosizedTextarea,
  useWorkflowStepDragDrop,
} from './StepRowHooks';

export { PROMPT_MIN_HEIGHT_PX, STEP_DRAG_MIME } from './StepRowHooks';

function StepHarnessSelect({
  harnessAvail,
  selectedHarness,
  onChange,
}: {
  harnessAvail: HarnessAvailability;
  selectedHarness: AgentHarness;
  onChange: (harness: AgentHarness) => void;
}) {
  const harnessOptions = availableAgentHarnesses(harnessAvail, selectedHarness);
  const showHarnessSelect = harnessOptions.length > 1 || selectedHarness !== 'claude';
  if (!showHarnessSelect) return null;

  return (
    <select
      className="workflows-step-harness"
      value={selectedHarness}
      onChange={(e) => onChange(normalizeAgentHarness(e.target.value))}
      title="Agent harness for this workflow step"
    >
      {harnessOptions.map((harness) => (
        <option key={harness} value={harness}>
          {harnessLabel(harness)}
        </option>
      ))}
    </select>
  );
}

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
  onCustomize,
  customizing,
}: {
  step: WorkflowStep;
  index: number;
  collapsed: boolean;
  harnessAvail: HarnessAvailability;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onRemove: () => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onToggleCollapse: () => void;
  onCustomize: () => void;
  customizing: boolean;
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { dragOver, onDragStart, onDragOver, onDragLeave, onDrop } =
    useWorkflowStepDragDrop(index, onReorder);
  useAutosizedTextarea(promptRef, step.prompt, collapsed);

  const selectedHarness = normalizeAgentHarness(step.harness);

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
          <StepHarnessSelect
            harnessAvail={harnessAvail}
            selectedHarness={selectedHarness}
            onChange={(harness) => onChange({ harness })}
          />
          <button
            className="icon-btn sm"
            onClick={onCustomize}
            disabled={customizing}
            title={`Customize this prompt for the active project using ${harnessLabel(selectedHarness)}`}
            aria-label="Customize prompt for active project"
          >
            <Wand2 size={12} />
          </button>
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
