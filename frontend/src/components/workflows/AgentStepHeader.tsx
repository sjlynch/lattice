import { memo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, GitFork, Split, X } from 'lucide-react';
import { useDismissOnOutside } from '../../hooks/useDismissOnOutside';
import { useEscapeToClose } from '../shared/useEscapeToClose';
import type {
  HarnessAvailability,
  PiMenuEntry,
  WorkflowStep,
} from '../../api';
import {
  buildHarnessOptions,
  decodeHarnessValue,
  encodeHarnessValue,
  normalizeAgentHarness,
  selectedOptionTitle,
  type AgentHarness,
} from '../../harnesses';
import {
  StepFreezeButton,
  StepIndexBadge,
  StepOpengrepBadge,
  type StepRowCallbacks,
} from './StepRowShared';
import type { StepRunStatus } from './stepRunStatus';
import { StepLaunchSelects } from './StepLaunchSelects';

// Per-step harness select ("Pi — X" rows included). Shared by the agent header
// and the Run tests row.
export function StepHarnessSelect({
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
// harness select, and the parallel/freeze/remove actions. Memoized on its own
// and fed only the header-relevant fields of the step (not the whole object) so
// a keystroke in the prompt textarea — which lives in the sibling
// `PromptHighlightTextarea` — doesn't re-render the header.
export const AgentStepHeader = memo(function AgentStepHeader({
  stepId,
  index,
  collapsed,
  title,
  harness,
  piModel,
  model,
  effort,
  frozen,
  parallel = false,
  tools,
  harnessAvail,
  piMenu,
  runStatus,
  onChange,
  onRemove,
  onToggleCollapse,
  onSplit,
}: {
  stepId: string;
  index: number;
  collapsed: boolean;
  title: string;
  harness: WorkflowStep['harness'];
  piModel?: string;
  model?: string;
  effort?: WorkflowStep['effort'];
  frozen: boolean;
  parallel?: boolean;
  tools?: WorkflowStep['tools'];
  harnessAvail: HarnessAvailability;
  piMenu: PiMenuEntry[];
  runStatus?: StepRunStatus;
} & Pick<StepRowCallbacks, 'onChange' | 'onRemove' | 'onToggleCollapse' | 'onSplit'>) {
  const selectedHarness = normalizeAgentHarness(harness);
  const opengrepOn = tools?.includes('opengrep') === true;
  const [splitMenu, setSplitMenu] = useState<{ top: number; left: number } | null>(null);
  const [splitting, setSplitting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(splitMenu !== null, menuRef, () => setSplitMenu(null));
  useEscapeToClose(splitMenu !== null, () => setSplitMenu(null));
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
      <StepHarnessSelect
        harnessAvail={harnessAvail}
        piMenu={piMenu}
        selectedHarness={selectedHarness}
        selectedPiModel={piModel}
        onChange={(h, pm) => onChange(index, { harness: h, piModel: pm })}
      />
      <StepLaunchSelects
        harness={selectedHarness}
        model={model}
        effort={effort}
        onChange={(patch) => onChange(index, patch)}
      />
      <StepOpengrepBadge on={opengrepOn} />
      <button
        type="button"
        className={`icon-btn sm workflows-step-parallel${parallel ? ' on' : ''}`}
        onClick={() => onChange(index, { parallel: parallel ? undefined : true })}
        title="Run with adjacent parallel steps. The workflow waits for the whole group."
        aria-label="Run step in parallel"
        aria-pressed={parallel === true}
      >
        <GitFork size={12} />
      </button>
      <button
        type="button"
        className="icon-btn sm"
        title="Split this step into parallel copies, one per area of the repository"
        aria-label="Split across the repo"
        aria-haspopup="dialog"
        aria-expanded={splitMenu !== null}
        disabled={splitting || !onSplit}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setSplitMenu(splitMenu ? null : {
            top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 270)),
            left: Math.max(8, Math.min(rect.right - 300, window.innerWidth - 308)),
          });
        }}
      >
        <Split size={12} />
      </button>
      {splitMenu && createPortal(
        <div ref={menuRef} className="popover workflows-split-menu" style={splitMenu} role="dialog" aria-label="Split across the repo">
          {[4, 6, 8, 10, 12].map((count) => (
            <button
              key={count}
              type="button"
              className="popover-item"
              autoFocus={count === 10}
              onClick={async () => {
                setSplitMenu(null);
                setSplitting(true);
                try { await onSplit?.(stepId, count); }
                finally { setSplitting(false); }
              }}
            >
              {count} areas{count === 10 ? ' · suggested' : ''}
            </button>
          ))}
          <p>Each copy reviews one area; together they cover the repository. More areas find more but cost more tokens.</p>
        </div>, document.body,
      )}
      <StepFreezeButton
        frozen={frozen}
        onToggle={() => onChange(index, { frozen: !frozen })}
      />
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
