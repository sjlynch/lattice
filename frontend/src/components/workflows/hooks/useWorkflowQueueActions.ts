import { useCallback } from 'react';
import type { Workflow, WorkflowRunHarnessOverride } from '../../../api';
import type { EditorState } from '../editorState';
import type { QueueAction, QueueMode } from '../queueScheduler';

type Args = {
  editor: EditorState;
  workflowsById: Map<string, Workflow>;
  save: () => Promise<Workflow | null>;
  getWorkflowHarnessOverride: (workflowId: string) => WorkflowRunHarnessOverride;
  getWorkflowPiModelOverride: (workflowId: string) => string | undefined;
  dispatchQueue: (action: QueueAction) => void;
};

function nextQueueEntryId(): string {
  return `wfq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Queue-side callbacks. Enqueueing the editor's draft saves first so the
// engine sees the latest steps; the queued list itself is owned by
// `useWorkflowQueue` and reached through `dispatchQueue`.
export function useWorkflowQueueActions({
  editor,
  workflowsById,
  save,
  getWorkflowHarnessOverride,
  getWorkflowPiModelOverride,
  dispatchQueue,
}: Args) {
  const enqueueWorkflowDefinition = useCallback((
    wf: Workflow,
    harnessOverride: WorkflowRunHarnessOverride = getWorkflowHarnessOverride(wf.id),
    piModelOverride: string | undefined = getWorkflowPiModelOverride(wf.id),
  ) => {
    if (wf.steps.length === 0) return;
    dispatchQueue({
      type: 'enqueue',
      entry: {
        id: nextQueueEntryId(),
        workflowId: wf.id,
        harnessOverride,
        piModelOverride,
      },
    });
  }, [dispatchQueue, getWorkflowHarnessOverride, getWorkflowPiModelOverride]);

  const enqueueWorkflow = useCallback((
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = getWorkflowHarnessOverride(workflowId),
    piModelOverride: string | undefined = getWorkflowPiModelOverride(workflowId),
  ) => {
    const wf = workflowsById.get(workflowId);
    if (wf) enqueueWorkflowDefinition(wf, harnessOverride, piModelOverride);
  }, [enqueueWorkflowDefinition, getWorkflowHarnessOverride, getWorkflowPiModelOverride, workflowsById]);

  const removeQueuedWorkflow = useCallback((entryId: string) => {
    dispatchQueue({ type: 'removeFromQueue', entryId });
  }, [dispatchQueue]);

  const clearQueue = useCallback(() => {
    dispatchQueue({ type: 'clearQueue' });
  }, [dispatchQueue]);

  const stopQueue = useCallback(() => {
    dispatchQueue({ type: 'stopQueue' });
  }, [dispatchQueue]);

  const startQueuedWorkflows = useCallback(() => {
    dispatchQueue({ type: 'startQueue' });
  }, [dispatchQueue]);

  const setQueueMode = useCallback((mode: QueueMode) => {
    dispatchQueue({ type: 'setMode', mode });
  }, [dispatchQueue]);

  const enqueueEditorWorkflow = useCallback(async () => {
    const harnessOverride = editor.workflowId
      ? getWorkflowHarnessOverride(editor.workflowId)
      : null;
    const piModelOverride = editor.workflowId
      ? getWorkflowPiModelOverride(editor.workflowId)
      : undefined;
    if (!editor.workflowId || editor.dirty) {
      const saved = await save();
      if (saved) enqueueWorkflowDefinition(saved, harnessOverride, piModelOverride);
      return;
    }
    enqueueWorkflow(editor.workflowId, harnessOverride, piModelOverride);
  }, [
    editor.dirty,
    editor.workflowId,
    enqueueWorkflow,
    enqueueWorkflowDefinition,
    getWorkflowHarnessOverride,
    getWorkflowPiModelOverride,
    save,
  ]);

  return {
    enqueueWorkflow,
    enqueueEditorWorkflow,
    removeQueuedWorkflow,
    clearQueue,
    stopQueue,
    startQueuedWorkflows,
    setQueueMode,
  };
}
