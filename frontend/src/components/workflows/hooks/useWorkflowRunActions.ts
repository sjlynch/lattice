import { useCallback, useRef } from 'react';
import {
  cancelWorkflowRun as apiCancelWorkflowRun,
  HttpError,
  startWorkflow as apiStartWorkflow,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunHarnessOverride,
} from '../../../api';
import type { EditorState } from '../editorState';

// Options threaded from the sequential queue into a run start.
export type StartRunOptions = {
  // Ask the backend to 409 if a run is already active for the project. Set by
  // the sequential queue; a resulting 409 surfaces as `{ status: 'busy' }` (the
  // queue requeues), never an error toast.
  requireNoActiveRun?: boolean;
};

// Outcome of a run-start attempt. `busy` (backend 409) is distinct from
// `failed` so the queue can requeue-and-retry rather than drop the entry.
export type StartOutcome =
  | { status: 'started'; run: WorkflowRun }
  | { status: 'busy' }
  | { status: 'failed' };

type Args = {
  activeFolder: string;
  editor: EditorState;
  workflowsById: Map<string, Workflow>;
  save: () => Promise<Workflow | null>;
  addActiveRun: (run: WorkflowRun) => void;
  getWorkflowHarnessOverride: (workflowId: string) => WorkflowRunHarnessOverride;
  getWorkflowPiModelOverride: (workflowId: string) => string | undefined;
  onError: (msg: string) => void;
};

// Run-side callbacks: starting a workflow from its stored definition, running
// a workflow (auto-saving dirty editor state first), running whatever's in
// the editor, and cancelling an active run.
export function useWorkflowRunActions({
  activeFolder,
  editor,
  workflowsById,
  save,
  addActiveRun,
  getWorkflowHarnessOverride,
  getWorkflowPiModelOverride,
  onError,
}: Args) {
  const activeFolderRef = useRef(activeFolder);
  const activeFolderGenerationRef = useRef(0);
  if (activeFolderRef.current !== activeFolder) {
    activeFolderRef.current = activeFolder;
    activeFolderGenerationRef.current += 1;
  }

  const startWorkflowDefinition = useCallback(async (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = null,
    piModelOverride?: string,
    opts?: StartRunOptions,
  ): Promise<StartOutcome> => {
    const requestedProject = activeFolderRef.current;
    const requestedGeneration = activeFolderGenerationRef.current;
    if (!requestedProject) return { status: 'failed' };
    try {
      const res = await apiStartWorkflow(workflowId, {
        harnessOverride,
        piModelOverride,
        requireNoActiveRun: opts?.requireNoActiveRun,
      });
      if (
        activeFolderRef.current !== requestedProject ||
        activeFolderGenerationRef.current !== requestedGeneration ||
        res.run.projectPath !== requestedProject
      ) {
        return { status: 'failed' };
      }
      addActiveRun(res.run);
      return { status: 'started', run: res.run };
    } catch (err) {
      // 409 = the backend's sequential guard rejected this start because a run
      // is already active. Not a user-facing error — the queue requeues.
      if (err instanceof HttpError && err.status === 409) return { status: 'busy' };
      onError(`Run failed: ${(err as Error).message}`);
      return { status: 'failed' };
    }
  }, [addActiveRun, onError]);

  const runWorkflow = useCallback(async (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = getWorkflowHarnessOverride(workflowId),
    piModelOverride: string | undefined = getWorkflowPiModelOverride(workflowId),
    opts?: StartRunOptions,
  ): Promise<StartOutcome> => {
    const requestedProject = activeFolderRef.current;
    const requestedGeneration = activeFolderGenerationRef.current;
    const wf = workflowsById.get(workflowId);
    if (!requestedProject || !wf || wf.projectPath !== requestedProject) {
      return { status: 'failed' };
    }

    let targetId = wf.id;
    if (editor.dirty && editor.workflowId === wf.id) {
      // Persist before run so the engine sees the latest steps.
      const saved = await save();
      if (
        !saved ||
        activeFolderRef.current !== requestedProject ||
        activeFolderGenerationRef.current !== requestedGeneration ||
        saved.projectPath !== requestedProject
      ) {
        return { status: 'failed' };
      }
      targetId = saved.id;
    }
    return startWorkflowDefinition(targetId, harnessOverride, piModelOverride, opts);
  }, [
    editor.dirty,
    editor.workflowId,
    getWorkflowHarnessOverride,
    getWorkflowPiModelOverride,
    save,
    startWorkflowDefinition,
    workflowsById,
  ]);

  const runEditorWorkflow = useCallback(async () => {
    const harnessOverride = editor.workflowId
      ? getWorkflowHarnessOverride(editor.workflowId)
      : null;
    const piModelOverride = editor.workflowId
      ? getWorkflowPiModelOverride(editor.workflowId)
      : undefined;
    if (!editor.workflowId || editor.dirty) {
      const loadedWorkflow = editor.workflowId
        ? workflowsById.get(editor.workflowId)
        : null;
      if (
        editor.workflowId &&
        (!loadedWorkflow || loadedWorkflow.projectPath !== activeFolderRef.current)
      ) {
        return;
      }
      const requestedProject = activeFolderRef.current;
      const requestedGeneration = activeFolderGenerationRef.current;
      const saved = await save();
      if (
        saved &&
        requestedProject &&
        activeFolderRef.current === requestedProject &&
        activeFolderGenerationRef.current === requestedGeneration &&
        saved.projectPath === requestedProject
      ) {
        await startWorkflowDefinition(saved.id, harnessOverride, piModelOverride);
      }
      return;
    }
    await runWorkflow(editor.workflowId, harnessOverride, piModelOverride);
  }, [
    editor.dirty,
    editor.workflowId,
    getWorkflowHarnessOverride,
    getWorkflowPiModelOverride,
    runWorkflow,
    save,
    startWorkflowDefinition,
    workflowsById,
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
