import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { ErrorToast } from '../shared/ErrorToast';
import { WorkflowEditorPanel } from './WorkflowEditorPanel';
import { WorkflowListPanel } from './WorkflowListPanel';
import { WorkflowRunsPanel } from './WorkflowRunsPanel';
import { useWorkflowManager } from './hooks/useWorkflowManager';

type Props = {
  activeFolder: string;
};

// Top-level Workflows panel shell. Workflow data flow, run orchestration, queue
// handling, and editor mutations live in `useWorkflowManager`; the shell only
// controls panel visibility and composes the focused sub-panels.
export function WorkflowsLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const manager = useWorkflowManager(activeFolder);
  const { activeRunList, workflows, error, clearError } = manager;

  return (
    <>
      <button
        className="fab"
        onClick={() => setOpen(true)}
        title="Open workflow editor"
        aria-label="Open workflow editor"
      >
        <ListChecks size={15} />
        <span>Workflows</span>
        {workflows.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 2 }}>
            · {workflows.length}
          </span>
        )}
      </button>

      {activeRunList.length > 0 && (
        <button
          className="wf-run-chip"
          onClick={() => setOpen(true)}
          title="Open workflow editor"
          aria-label="Workflow runs in progress"
        >
          <span className="wf-run-chip-spinner" />
          <span className="wf-run-chip-text">
            {activeRunList.length === 1
              ? (() => {
                  const run = activeRunList[0];
                  const pos = Math.min(run.currentStepIndex + 1, run.totalSteps);
                  return `${run.workflowName} · Step ${pos}/${run.totalSteps}`;
                })()
              : `${activeRunList.length} workflows running`}
          </span>
        </button>
      )}

      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        title={
          <>
            <ListChecks size={13} />
            Workflows
          </>
        }
        defaultSize={{ width: 1080, height: 620 }}
        minSize={{ width: 760, height: 420 }}
        storageKey="lattice.workflows.window"
      >
        <div className="workflows-body">
          <WorkflowListPanel manager={manager} />
          <WorkflowEditorPanel manager={manager} />
          <WorkflowRunsPanel manager={manager} />
        </div>
        {error && <ErrorToast message={error} onDismiss={clearError} />}
      </FloatingPanel>
    </>
  );
}
