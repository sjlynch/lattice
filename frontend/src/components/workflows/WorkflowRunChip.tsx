import { workflowRunProgress } from './parallelSteps';
import type { WorkflowRun } from '../../api';

type Props = {
  activeRunList: WorkflowRun[];
  onOpen: () => void;
};

export function WorkflowRunChip({ activeRunList, onOpen }: Props) {
  if (activeRunList.length === 0) return null;

  return (
    <button
      className="wf-run-chip"
      onClick={onOpen}
      title="Open workflow editor"
      aria-label="Workflow runs in progress"
    >
      <span className="wf-run-chip-spinner" />
      <span className="wf-run-chip-text">
        {activeRunList.length === 1
          ? (() => {
              const run = activeRunList[0];
              return `${run.workflowName} · ${workflowRunProgress(run).text}`;
            })()
          : `${activeRunList.length} workflows running`}
      </span>
    </button>
  );
}
