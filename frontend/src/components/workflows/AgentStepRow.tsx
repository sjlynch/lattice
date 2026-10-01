import { memo, useRef } from 'react';
import { GripVertical } from 'lucide-react';
import type { HarnessAvailability, PiMenuEntry, WorkflowStep } from '../../api';
import {
  useScrollRunningIntoView,
  useWorkflowStepDragDrop,
} from './StepRowHooks';
import { AgentStepHeader } from './AgentStepHeader';
import { PromptHighlightTextarea } from './PromptHighlightTextarea';
import type { StepRowCallbacks } from './StepRowShared';
import type { StepRunStatus } from './stepRunStatus';

// A full agent step: the draggable shell + grip, composing the memoized
// `AgentStepHeader` (title/mode/harness/actions) and `PromptHighlightTextarea`
// (the `{{variable}}`-highlighting prompt editor). The shell owns the drag/drop
// state and the scroll-into-view-when-running behavior; the header and prompt
// each memoize independently so editing one doesn't re-render the other.
export const AgentStepRow = memo(function AgentStepRow({
  step,
  index,
  collapsed,
  harnessAvail,
  piMenu,
  definedNames,
  runStatus,
  autoScroll = true,
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
  autoScroll?: boolean;
  customizing: boolean;
} & StepRowCallbacks) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { dragOver, onDragStart, onDragOver, onDragLeave, onDrop } =
    useWorkflowStepDragDrop(index, onReorder);
  useScrollRunningIntoView(rootRef, autoScroll && (runStatus === 'running' || runStatus === 'queued'));
  const frozen = step.frozen === true;

  return (
    <div
      ref={rootRef}
      className={`workflows-step ${dragOver ? `drop-${dragOver}` : ''} ${collapsed ? 'collapsed' : ''}${runStatus ? ` run-${runStatus}` : ''}${frozen ? ' frozen' : ''}`}
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
        <AgentStepHeader
          stepId={step.id}
          index={index}
          collapsed={collapsed}
          title={step.title}
          harness={step.harness}
          piModel={step.piModel}
          frozen={frozen}
          parallel={step.parallel === true}
          tools={step.tools}
          harnessAvail={harnessAvail}
          piMenu={piMenu}
          runStatus={runStatus}
          customizing={customizing}
          onChange={onChange}
          onRemove={onRemove}
          onToggleCollapse={onToggleCollapse}
          onCustomize={onCustomize}
        />
        <PromptHighlightTextarea
          index={index}
          prompt={step.prompt}
          definedNames={definedNames}
          collapsed={collapsed}
          onChange={onChange}
        />
      </div>
    </div>
  );
});
