import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { ErrorToast } from '../shared/ErrorToast';
import { WorkflowEditorPanel } from './WorkflowEditorPanel';
import { WorkflowRecentFailureChip } from './WorkflowRecentFailureChip';
import { WorkflowRunChip } from './WorkflowRunChip';
import { WorkflowRunsAside } from './WorkflowRunsAside';
import { WorkflowsSavedList } from './WorkflowsSavedList';
import { useWorkflowManager } from './hooks/useWorkflowManager';
import type { ScanResult } from '../../api';

type Props = {
  activeFolder: string;
  scanResult: ScanResult | null;
};

// Top-level Workflows panel. Owns panel visibility and composes the saved-list,
// editor, queue, and runs sub-panels; workflow state and actions live in
// `useWorkflowManager`.
export function WorkflowsLauncher({ activeFolder, scanResult }: Props) {
  const [open, setOpen] = useState(false);
  const manager = useWorkflowManager(activeFolder, scanResult);

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
        {manager.workflows.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 2 }}>
            · {manager.workflows.length}
          </span>
        )}
      </button>

      <WorkflowRunChip
        activeRunList={manager.activeRunList}
        onOpen={() => setOpen(true)}
      />

      <WorkflowRecentFailureChip
        failedRuns={manager.recentFailedRunList}
        onOpen={() => setOpen(true)}
      />

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
          <WorkflowsSavedList manager={manager} />
          <WorkflowEditorPanel manager={manager} />
          <WorkflowRunsAside manager={manager} />
        </div>
        {manager.error && (
          <ErrorToast message={manager.error} onDismiss={manager.clearError} />
        )}
      </FloatingPanel>
    </>
  );
}
