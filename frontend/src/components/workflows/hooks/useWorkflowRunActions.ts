import { useCallback } from 'react';
import {
  cancelWorkflowRun as apiCancelWorkflowRun,
  startWorkflow as apiStartWorkflow,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunHarnessOverride,
} from '../../../api';
import type { EditorState } from '../editorState';

type Args = {
  editor: EditorState;
  workflowsById: Map<string, Workflow>;
  save: () => Promise<Workflow | null>;
  addActiveRun: (run: WorkflowRun) => void;
  getWorkflowHarnessOverride: (workflowId: string) => WorkflowRunHarnessOverride;
  onError: (msg: string) => void;
};

// Run-side callbacks: starting a workflow from its stored definition, running
// a workflow (auto-saving dirty editor state first), running whatever's in
// the editor, and cancelling an active run.
export function useWorkflowRunActions({
  editor,
  workflowsById,
  save,
  addActiveRun,
  getWorkflowHarnessOverride,
  onError,
}: Args) {
  const startWorkflowDefinition = useCallback(async (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = null,
  ): Promise<WorkflowRun | null> => {
    try {
      const res = await apiStartWorkflow(workflowId, { harnessOverride });
      addActiveRun(res.run);
      return res.run;
    } catch (err) {
      onError(`Run failed: ${(err as Error).message}`);
      return null;
    }
  }, [addActiveRun, onError]);

  const runWorkflow = useCallback(async (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = getWorkflowHarnessOverride(workflowId),
  ): Promise<WorkflowRun | null> => {
    const wf = workflowsById.get(workflowId);
    if (!wf) return null;

    let targetId = wf.id;
    if (editor.dirty && editor.workflowId === wf.id) {
      // Persist before run so the engine sees the latest steps.
      const saved = await save();
      if (!saved) return null;
      targetId = saved.id;
    }
    return startWorkflowDefinition(targetId, harnessOverride);
  }, [
    editor.dirty,
    editor.workflowId,
    getWorkflowHarnessOverride,
    save,
    startWorkflowDefinition,
    workflowsById,
  ]);

  const runEditorWorkflow = useCallback(async () => {
    const harnessOverride = editor.workflowId
      ? getWorkflowHarnessOverride(editor.workflowId)
      : null;
    if (!editor.workflowId || editor.dirty) {
      const saved = await save();
      if (saved) await startWorkflowDefinition(saved.id, harnessOverride);
      return;
    }
    await runWorkflow(editor.workflowId, harnessOverride);
  }, [
    editor.dirty,
    editor.workflowId,
    getWorkflowHarnessOverride,
    runWorkflow,
    save,
    startWorkflowDefinition,
  ]);

  const stopRun = useCallback(async (runId: string) => {
    try {
      await apiCancelWorkflowRun(runId);
    } catch (err) {
      onError(`Stop failed: ${(err as Error).message}`);
    }
  }, [onError]);

  return { startWorkflowDefinition, runWorkflow, runEditorWorkflow, stopRun };
}
