import { useCallback, useRef, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { ErrorToast } from '../shared/ErrorToast';
import { useConfirm } from '../shared/ConfirmDialog';
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
  const { confirmUnsaved } = useConfirm();
  // Prevents a second close attempt (e.g. a stray Escape) from stacking another
  // confirm while one is already in flight.
  const closingRef = useRef(false);

  // The panel's titlebar ✕ and Escape both route here. If the editor has
  // unsaved edits, ask Save / Discard / Cancel before actually closing.
  const requestClose = useCallback(async () => {
    if (closingRef.current) return;
    if (!manager.editor.dirty) {
      setOpen(false);
      return;
    }
    closingRef.current = true;
    try {
      const choice = await confirmUnsaved({
        message: 'You have unsaved changes to this workflow.',
      });
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const saved = await manager.actions.save();
        if (!saved) return; // save failed — keep the panel open (error toast shown)
        setOpen(false);
        return;
      }
      // discard
      manager.actions.discardEdits();
      setOpen(false);
    } finally {
      closingRef.current = false;
    }
  }, [manager.editor.dirty, manager.actions, confirmUnsaved]);

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
        onClose={requestClose}
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
