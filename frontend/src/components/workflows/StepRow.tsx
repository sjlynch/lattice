import { memo } from 'react';
import type {
  HarnessAvailability,
  PiMenuEntry,
  WorkflowStep,
} from '../../api';
import { AgentStepRow } from './AgentStepRow';
import { ControlStepRow } from './ControlStepRow';
import { TestStepRow } from './TestStepRow';
import type { StepRowCallbacks } from './StepRowShared';
import type { StepRunStatus } from './stepRunStatus';

export { PROMPT_MIN_HEIGHT_PX, STEP_DRAG_MIME } from './StepRowHooks';

// One row in the step editor. Drag-and-drop reorders by index using a
// custom MIME so generic text drags onto the editor don't trigger reorders.
//
// Agent steps render the full title/mode/harness/prompt editor (`AgentStepRow`,
// itself split into a memoized `AgentStepHeader` + `PromptHighlightTextarea`).
// Control steps (start/merge/push) render the compact, fixed-behavior
// `ControlStepRow`: title plus an info tooltip explaining what the step does.
// They don't have a prompt or a harness, but they still reorder, collapse
// (no-op), and can be removed. A Run tests step (`test`) renders
// `TestStepRow`: compact too (its brief is fixed), but it spawns an agent, so
// it keeps the harness picker and adds a timeout.
//
// This is a thin dispatcher: `React.memo` keeps a keystroke in one step from
// re-rendering its siblings, and the id/index-parameterized callbacks
// (`StepRowCallbacks`) stay referentially stable so that memoization holds.
export const StepRow = memo(function StepRow({
  step,
  index,
  collapsed,
  harnessAvail,
  piMenu,
  definedNames,
  runStatus,
  postMergeHookConfigured = false,
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
  runStatus?: StepRunStatus;
  // The project has a post-merge hook prompt (the Run tests row notes the
  // possible overlap).
  postMergeHookConfigured?: boolean;
  customizing: boolean;
} & StepRowCallbacks) {
  const kind = step.kind ?? 'agent';
  if (kind === 'test') {
    return (
      <TestStepRow
        step={step}
        index={index}
        harnessAvail={harnessAvail}
        piMenu={piMenu}
        runStatus={runStatus}
        postMergeHookConfigured={postMergeHookConfigured}
        onChange={onChange}
        onRemove={onRemove}
        onReorder={onReorder}
      />
    );
  }
  if (kind !== 'agent') {
    return (
      <ControlStepRow
        step={step}
        index={index}
        kind={kind}
        runStatus={runStatus}
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
      runStatus={runStatus}
      onChange={onChange}
      onRemove={onRemove}
      onReorder={onReorder}
      onToggleCollapse={onToggleCollapse}
      onCustomize={onCustomize}
      customizing={customizing}
    />
  );
});
