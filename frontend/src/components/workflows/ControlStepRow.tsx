import { memo, useRef } from 'react';
import { GitMerge, GripVertical, Play, UploadCloud, X } from 'lucide-react';
import type { WorkflowStep, WorkflowStepKind } from '../../api';
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

// The headless kinds this row renders. `agent` and `test` (Run tests) spawn
// an agent and have their own rows.
export type ControlStepKind = Exclude<WorkflowStepKind, 'agent' | 'test'>;

// Per-kind copy for the compact control-step row. Title is what shows in the
// editor row label; hint is the tooltip explaining behavior.
const CONTROL_STEP_META: Record<
  ControlStepKind,
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
      'Waits for Ready-to-Merge to drain, then pushes the commits already on the branch. It never stages or commits — uncommitted files are left alone and listed in its report (unlike the Task Board cloud icon, which commits everything first).',
  },
};

// The compact, fixed-behavior row for a control step (start/merge/push): title
// plus an info tooltip explaining what the step does. No prompt or harness, but
// it still reorders, collapses (no-op), and can be removed.
export const ControlStepRow = memo(function ControlStepRow({
  step,
  index,
  kind,
  runStatus,
  onChange,
  onRemove,
  onReorder,
}: {
  step: WorkflowStep;
  index: number;
  kind: ControlStepKind;
  runStatus?: StepRunStatus;
} & Pick<StepRowCallbacks, 'onChange' | 'onRemove' | 'onReorder'>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { dragOver, onDragStart, onDragOver, onDragLeave, onDrop } =
    useWorkflowStepDragDrop(index, onReorder);
  useScrollRunningIntoView(rootRef, runStatus === 'running');
  const meta = CONTROL_STEP_META[kind];
  const Icon = meta.icon;
  const frozen = step.frozen === true;
  return (
    <div
      ref={rootRef}
      className={`workflows-step workflows-step-control workflows-step-control-${kind} ${dragOver ? `drop-${dragOver}` : ''} collapsed${runStatus ? ` run-${runStatus}` : ''}${frozen ? ' frozen' : ''}`}
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
          <span
            className="workflows-step-control-icon"
            aria-hidden
            title={meta.hint}
          >
            <Icon size={12} />
          </span>
          <StepIndexBadge index={index} runStatus={runStatus} />
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
      </div>
    </div>
  );
});
