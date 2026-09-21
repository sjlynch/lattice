import { memo } from 'react';
import { ChevronDown, ChevronRight, Wand2, X } from 'lucide-react';
import type {
  HarnessAvailability,
  PiMenuEntry,
  WorkflowStep,
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
  StepFreezeButton,
  StepIndexBadge,
  StepOpengrepButton,
  type StepRowCallbacks,
} from './StepRowShared';
import type { StepRunStatus } from './stepRunStatus';

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

// The top row of an agent step: collapse toggle, status badge, title input,
// mode + harness selects, and the customize/remove actions. Memoized on its own
// and fed only the header-relevant fields of the step (not the whole object) so
// a keystroke in the prompt textarea — which lives in the sibling
// `PromptHighlightTextarea` — doesn't re-render the header.
export const AgentStepHeader = memo(function AgentStepHeader({
  stepId,
  index,
  collapsed,
  title,
  mode,
  harness,
  piModel,
  frozen,
  tools,
  harnessAvail,
  piMenu,
  runStatus,
  customizing,
  onChange,
  onRemove,
  onToggleCollapse,
  onCustomize,
}: {
  stepId: string;
  index: number;
  collapsed: boolean;
  title: string;
  mode: WorkflowStepMode;
  harness: WorkflowStep['harness'];
  piModel?: string;
  frozen: boolean;
  tools?: WorkflowStep['tools'];
  harnessAvail: HarnessAvailability;
  piMenu: PiMenuEntry[];
  runStatus?: StepRunStatus;
  customizing: boolean;
} & Pick<
  StepRowCallbacks,
  'onChange' | 'onRemove' | 'onToggleCollapse' | 'onCustomize'
>) {
  const selectedHarness = normalizeAgentHarness(harness);
  const opengrepOn = tools?.includes('opengrep') === true;
  return (
    <div className="workflows-step-row">
      <button
        type="button"
        className="icon-btn sm workflows-step-collapse"
        onClick={() => onToggleCollapse(stepId)}
        title={collapsed ? 'Expand step' : 'Collapse step'}
        aria-label={collapsed ? 'Expand step' : 'Collapse step'}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      </button>
      <StepIndexBadge index={index} runStatus={runStatus} />
      <input
        className="task-card-form-input workflows-step-title"
        placeholder="Step title"
        value={title}
        onChange={(e) => onChange(index, { title: e.target.value })}
      />
      <select
        className="workflows-step-mode"
        value={mode}
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
        selectedPiModel={piModel}
        onChange={(h, pm) => onChange(index, { harness: h, piModel: pm })}
      />
      <StepOpengrepButton
        on={opengrepOn}
        onToggle={() =>
          onChange(index, {
            tools: opengrepOn
              ? (tools ?? []).filter((t) => t !== 'opengrep')
              : [...(tools ?? []).filter((t) => t !== 'opengrep'), 'opengrep'],
          })
        }
      />
      <StepFreezeButton
        frozen={frozen}
        onToggle={() => onChange(index, { frozen: !frozen })}
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
  );
});
