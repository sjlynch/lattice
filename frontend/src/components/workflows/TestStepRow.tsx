import { memo, useRef } from 'react';
import { FlaskConical, GripVertical, Info, X } from 'lucide-react';
import {
  RUN_TESTS_DEFAULT_TIMEOUT_MINUTES,
  RUN_TESTS_MAX_TIMEOUT_MINUTES,
  RUN_TESTS_MIN_TIMEOUT_MINUTES,
  type HarnessAvailability,
  type PiMenuEntry,
  type WorkflowStep,
} from '../../api';
import { normalizeAgentHarness } from '../../harnesses';
import { StepHarnessSelect } from './AgentStepHeader';
import {
  useScrollRunningIntoView,
  useWorkflowStepDragDrop,
} from './StepRowHooks';
import {
  StepFreezeButton,
  StepIndexBadge,
  type StepRowCallbacks,
} from './StepRowShared';
import type { StepRunStatus } from './stepRunStatus';

export const RUN_TESTS_STEP_HINT =
  "Usually right before Push. Runs the project's tests on the main checkout and commits fixes.";

const RUN_TESTS_STEP_DETAIL =
  "The agent finds and runs the project's tests, fixes what it reasonably can and commits only the files it " +
  'changed — your uncommitted files are left alone. It never stops the workflow: failures it cannot fix, a ' +
  'timeout, or a skip (nothing merged since the last Run tests) are reported in the run summary instead.';

// A typed timeout. Empty / non-numeric → absent (the 60-minute default), so
// clearing the box resets it. `clamp` applies the backend's range — done on
// blur, not per keystroke, so typing "10" doesn't snap the "1" up to 5 first.
export function parseTimeoutMinutesInput(raw: string, clamp = false): number | undefined {
  if (!raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  return clamp
    ? Math.min(RUN_TESTS_MAX_TIMEOUT_MINUTES, Math.max(RUN_TESTS_MIN_TIMEOUT_MINUTES, rounded))
    : rounded;
}

// The Run tests ('test') step row: compact like a control step (no prompt — the
// brief is fixed), but it spawns an agent, so it carries the harness picker
// plus a timeout. When the project also has a post-merge hook configured, a
// note says the two may run the same tests twice.
export const TestStepRow = memo(function TestStepRow({
  step,
  index,
  harnessAvail,
  piMenu,
  runStatus,
  postMergeHookConfigured,
  onChange,
  onRemove,
  onReorder,
}: {
  step: WorkflowStep;
  index: number;
  harnessAvail: HarnessAvailability;
  piMenu: PiMenuEntry[];
  runStatus?: StepRunStatus;
  postMergeHookConfigured: boolean;
} & Pick<StepRowCallbacks, 'onChange' | 'onRemove' | 'onReorder'>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { dragOver, onDragStart, onDragOver, onDragLeave, onDrop } =
    useWorkflowStepDragDrop(index, onReorder);
  useScrollRunningIntoView(rootRef, runStatus === 'running');
  const frozen = step.frozen === true;
  const hint = `${RUN_TESTS_STEP_HINT} ${RUN_TESTS_STEP_DETAIL}`;
  return (
    <div
      ref={rootRef}
      className={`workflows-step workflows-step-control workflows-step-control-test ${dragOver ? `drop-${dragOver}` : ''} collapsed${runStatus ? ` run-${runStatus}` : ''}${frozen ? ' frozen' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="workflows-step-grip" aria-hidden title="Drag to reorder">
        <GripVertical size={12} />
      </span>
      <div className="workflows-step-body">
        <div className="workflows-step-row">
          <span className="workflows-step-control-icon" aria-hidden title={hint}>
            <FlaskConical size={12} />
          </span>
          <StepIndexBadge index={index} runStatus={runStatus} />
          <input
            className="task-card-form-input workflows-step-title"
            placeholder="Run tests"
            value={step.title}
            onChange={(e) => onChange(index, { title: e.target.value })}
            title={hint}
          />
          <StepHarnessSelect
            harnessAvail={harnessAvail}
            piMenu={piMenu}
            selectedHarness={normalizeAgentHarness(step.harness)}
            selectedPiModel={step.piModel}
            onChange={(h, pm) => onChange(index, { harness: h, piModel: pm })}
          />
          <label
            className="workflows-step-timeout"
            title={`Stop the agent after this many minutes of running (queue time doesn't count) and move on. ${RUN_TESTS_MIN_TIMEOUT_MINUTES}–${RUN_TESTS_MAX_TIMEOUT_MINUTES}.`}
          >
            <input
              type="number"
              className="task-card-form-input workflows-step-timeout-input"
              min={RUN_TESTS_MIN_TIMEOUT_MINUTES}
              max={RUN_TESTS_MAX_TIMEOUT_MINUTES}
              step={5}
              placeholder={String(RUN_TESTS_DEFAULT_TIMEOUT_MINUTES)}
              value={step.timeoutMinutes ?? ''}
              onChange={(e) => onChange(index, { timeoutMinutes: parseTimeoutMinutesInput(e.target.value) })}
              onBlur={(e) => {
                const clamped = parseTimeoutMinutesInput(e.target.value, true);
                if (clamped !== step.timeoutMinutes) onChange(index, { timeoutMinutes: clamped });
              }}
              aria-label="Timeout in minutes"
            />
            <span>min</span>
          </label>
          <span className="workflows-step-control-tag" title={hint}>
            tests
          </span>
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
        <div className="workflows-step-hint">
          {RUN_TESTS_STEP_HINT}
          {postMergeHookConfigured && (
            <span className="workflows-step-hint-note">
              <Info size={11} aria-hidden /> This project also has a post-merge hook — if it runs the tests too,
              they may run twice.
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
