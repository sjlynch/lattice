import { memo, useMemo, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  GitMerge,
  GripVertical,
  Play,
  UploadCloud,
  Wand2,
  X,
} from 'lucide-react';
import type {
  HarnessAvailability,
  PiMenuEntry,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowStepMode,
} from '../../api';
import {
  buildHarnessOptions,
  decodeHarnessValue,
  encodeHarnessValue,
  harnessLabel,
  normalizeAgentHarness,
  selectedOptionTitle,
  type AgentHarness,
} from '../../harnesses';
import {
  useAutosizedTextarea,
  useWorkflowStepDragDrop,
} from './StepRowHooks';
import { splitPromptSegments } from './promptVariables';

export { PROMPT_MIN_HEIGHT_PX, STEP_DRAG_MIME } from './StepRowHooks';

// Per-kind copy for the compact control-step row. Title is what shows in the
// editor row label; hint is the tooltip explaining behavior.
const CONTROL_STEP_META: Record<
  Exclude<WorkflowStepKind, 'agent'>,
  { icon: typeof Play; defaultTitle: string; hint: string }
> = {
  start: {
    icon: Play,
    defaultTitle: 'Start all open tasks',
    hint:
      'Moves every Open task to In Progress and spawns its worktree agent. Skips silently if Open is empty.',
  },
  merge: {
    icon: GitMerge,
    defaultTitle: 'Merge all tasks',
    hint:
      'Waits for In Progress to drain, then merges every Ready-to-Merge task into main (resolving conflicts via resolver agents as needed).',
  },
  push: {
    icon: UploadCloud,
    defaultTitle: 'Push to remote',
    hint:
      'Waits for Ready-to-Merge to drain, then spawns a push session — same as the cloud icon on the Task Board.',
  },
};

function StepHarnessSelect({
  harnessAvail,
  piMenu,
  selectedHarness,
  selectedPiModel,
  onChange,
}: {
  harnessAvail: HarnessAvailability;
  piMenu: PiMenuEntry[];
  selectedHarness: AgentHarness;
  selectedPiModel?: string;
  onChange: (harness: AgentHarness, piModel?: string) => void;
}) {
  const harnessOptions = buildHarnessOptions({
    harnessAvail,
    piMenu,
    selected: { harness: selectedHarness, piModel: selectedPiModel },
    includeInterleave: false,
  });
  const showHarnessSelect = harnessOptions.length > 1 || selectedHarness !== 'claude';
  if (!showHarnessSelect) return null;

  const value = encodeHarnessValue(selectedHarness, selectedPiModel);
  return (
    <select
      className="workflows-step-harness"
      value={value}
      onChange={(e) => {
        const sel = decodeHarnessValue(e.target.value);
        onChange(normalizeAgentHarness(sel.harness), sel.piModel);
      }}
      title={`Agent harness for this workflow step: ${selectedOptionTitle(harnessOptions, value)}`}
    >
      {harnessOptions.map((option) => (
        <option key={option.value} value={option.value} title={option.title}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// One row in the step editor. Drag-and-drop reorders by index using a
// custom MIME so generic text drags onto the editor don't trigger reorders.
//
// Agent steps render the full title/mode/harness/prompt editor. Control
// steps (start/merge/push) render a compact, fixed-behavior row: title plus
// an info tooltip explaining what the step does. They don't have a prompt or
// a harness, but they still reorder, collapse (no-op), and can be removed.
// Row callback props are id/index-parameterized so the parent can hand down a
// single stable handler per concern (one `useCallback`, not one closure per
// row). Combined with `React.memo`, typing in one step only re-renders that
// row — siblings keep their memoized output because every prop they receive is
// referentially stable.
type StepRowCallbacks = {
  onChange: (index: number, patch: Partial<WorkflowStep>) => void;
  onRemove: (index: number) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onToggleCollapse: (stepId: string) => void;
  onCustomize: (index: number) => void;
};

export const StepRow = memo(function StepRow({
  step,
  index,
  collapsed,
  harnessAvail,
  piMenu,
  definedNames,
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
  piMenu: PiMenuEntry[];
  definedNames: ReadonlySet<string>;
  customizing: boolean;
} & StepRowCallbacks) {
  const kind = step.kind ?? 'agent';
  if (kind !== 'agent') {
    return (
      <ControlStepRow
        step={step}
        index={index}
        kind={kind}
        onChange={onChange}
        onRemove={onRemove}
        onReorder={onReorder}
      />
    );
  }
  return (
    <AgentStepRow
      step={step}
      index={index}
      collapsed={collapsed}
      harnessAvail={harnessAvail}
      piMenu={piMenu}
      definedNames={definedNames}
      onChange={onChange}
      onRemove={onRemove}
      onReorder={onReorder}
      onToggleCollapse={onToggleCollapse}
      onCustomize={onCustomize}
      customizing={customizing}
    />
  );
});

const AgentStepRow = memo(function AgentStepRow({
  step,
  index,
  collapsed,
  harnessAvail,
  piMenu,
  definedNames,
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
  piMenu: PiMenuEntry[];
  definedNames: ReadonlySet<string>;
  customizing: boolean;
} & StepRowCallbacks) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const { dragOver, onDragStart, onDragOver, onDragLeave, onDrop } =
    useWorkflowStepDragDrop(index, onReorder);
  useAutosizedTextarea(promptRef, step.prompt, collapsed);

  const selectedHarness = normalizeAgentHarness(step.harness);
  // Tokenizing the prompt is the per-row hot path; only redo it when the prompt
  // text or the set of defined variable names actually changes.
  const segments = useMemo(
    () => splitPromptSegments(step.prompt, definedNames),
    [step.prompt, definedNames],
  );

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
            onClick={() => onToggleCollapse(step.id)}
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
            onChange={(e) => onChange(index, { title: e.target.value })}
          />
          <select
            className="workflows-step-mode"
            value={step.mode}
            onChange={(e) => onChange(index, { mode: e.target.value as WorkflowStepMode })}
            title="Sequential runs after the prior step finishes; parallel is reserved for the upcoming fan-out executor"
          >
            <option value="sequential">sequential</option>
            <option value="parallel">parallel</option>
          </select>
          <StepHarnessSelect
            harnessAvail={harnessAvail}
            piMenu={piMenu}
            selectedHarness={selectedHarness}
            selectedPiModel={step.piModel}
            onChange={(harness, piModel) => onChange(index, { harness, piModel })}
          />
          <button
            className="icon-btn sm"
            onClick={() => onCustomize(index)}
            disabled={customizing}
            title={`Customize this prompt for the active project using ${harnessLabel(selectedHarness)}`}
            aria-label="Customize prompt for active project"
          >
            <Wand2 size={12} />
          </button>
          <button
            className="icon-btn sm"
            onClick={() => onRemove(index)}
            title="Remove step"
            aria-label="Remove step"
          >
            <X size={12} />
          </button>
        </div>
        {!collapsed && (
          <div className="workflows-step-prompt-wrap">
            {/* Colorized overlay rendered behind the transparent-text
                textarea so `{{variable}}` references stand out. Mirrors the
                textarea's box model exactly (see steps.css) so the glyphs
                line up. aria-hidden — the textarea is the real control. */}
            <div className="workflows-step-prompt-highlight" aria-hidden>
              {segments.map((seg, i) =>
                seg.token ? (
                  <mark
                    key={i}
                    className={`workflows-step-prompt-token${seg.known ? '' : ' unknown'}`}
                  >
                    {seg.text}
                  </mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
              {'\n'}
            </div>
            <textarea
              ref={promptRef}
              className="task-card-form-input task-card-form-textarea workflows-step-prompt"
              placeholder="Prompt — written into LATTICE_TASK.md as the task description."
              value={step.prompt}
              onChange={(e) => onChange(index, { prompt: e.target.value })}
              spellCheck={false}
            />
          </div>
        )}
      </div>
    </div>
  );
});

const ControlStepRow = memo(function ControlStepRow({
  step,
  index,
  kind,
  onChange,
  onRemove,
  onReorder,
}: {
  step: WorkflowStep;
  index: number;
  kind: Exclude<WorkflowStepKind, 'agent'>;
} & Pick<StepRowCallbacks, 'onChange' | 'onRemove' | 'onReorder'>) {
  const { dragOver, onDragStart, onDragOver, onDragLeave, onDrop } =
    useWorkflowStepDragDrop(index, onReorder);
  const meta = CONTROL_STEP_META[kind];
  const Icon = meta.icon;
  return (
    <div
      className={`workflows-step workflows-step-control workflows-step-control-${kind} ${dragOver ? `drop-${dragOver}` : ''} collapsed`}
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
          <span
            className="workflows-step-control-icon"
            aria-hidden
            title={meta.hint}
          >
            <Icon size={12} />
          </span>
          <span className="workflows-step-index">#{index + 1}</span>
          <input
            className="task-card-form-input workflows-step-title"
            placeholder={meta.defaultTitle}
            value={step.title}
            onChange={(e) => onChange(index, { title: e.target.value })}
            title={meta.hint}
          />
          <span className="workflows-step-control-tag" title={meta.hint}>
            {kind}
          </span>
          <button
            className="icon-btn sm"
            onClick={() => onRemove(index)}
            title="Remove step"
            aria-label="Remove step"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    </div>
  );
});
