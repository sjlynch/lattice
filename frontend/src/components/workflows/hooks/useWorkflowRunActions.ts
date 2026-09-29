import { useCallback, useRef } from 'react';
import {
  cancelWorkflowRun as apiCancelWorkflowRun,
  HttpError,
  mayHaveBeenApplied,
  retryTransient,
  startWorkflow as apiStartWorkflow,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunHarnessOverride,
} from '../../../api';
import { sameProjectPath } from '../../../terminal/terminalScope';
import type { EditorState } from '../editorState';

// Outcome of a run-start attempt. `busy` (backend 409: another run is active
// for the project) is distinct from `failed` so the queue can requeue-and-retry
// — and a manual ▶ Run can enqueue — rather than drop the start.
export type StartOutcome =
  | { status: 'started'; run: WorkflowRun }
  // A terminal response or WS completion beat acceptance. The queue must
  // consume the final status instead of attaching a dead run id and stalling.
  | { status: 'finished'; run: WorkflowRun }
  | { status: 'busy' }
  // A lost acknowledgement has no run identity. Stop the queue without
  // replaying or guessing ownership from a workflow id / timestamp.
  | { status: 'uncertain' }
  | { status: 'failed' };

// What `runEditorWorkflow` attempted: the (possibly just-saved) workflow and
// the start outcome, or null when it bailed before any start (save failed,
// project switched mid-save, workflow gone).
export type EditorRunResult = { workflow: Workflow; outcome: StartOutcome } | null;

type Args = {
  activeFolder: string;
  editor: EditorState;
  workflowsById: Map<string, Workflow>;
  save: () => Promise<Workflow | null>;
  addActiveRun: (run: WorkflowRun) => void;
  getRecentRun: (runId: string) => WorkflowRun | null;
  getWorkflowHarnessOverride: (workflowId: string) => WorkflowRunHarnessOverride;
  getWorkflowPiModelOverride: (workflowId: string) => string | undefined;
  onError: (msg: string) => void;
};

// Run-side callbacks: starting a workflow from its stored definition, running
// a workflow (auto-saving dirty editor state first), running whatever's in
// the editor, and cancelling an active run. A start while another run is
// active comes back `busy`; the manual ▶ Run wrappers in
// `useWorkflowManualRun` turn that into an enqueue.
export function useWorkflowRunActions({
  activeFolder,
  editor,
  workflowsById,
  save,
  addActiveRun,
  getRecentRun,
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
  ): Promise<StartOutcome> => {
    const requestedProject = activeFolderRef.current;
    const requestedGeneration = activeFolderGenerationRef.current;
    if (!requestedProject) return { status: 'failed' };
    const projectChanged = () =>
      activeFolderRef.current !== requestedProject ||
      activeFolderGenerationRef.current !== requestedGeneration;
    const accept = (run: WorkflowRun): StartOutcome => {
      if (projectChanged() || !sameProjectPath(run.projectPath, requestedProject)) {
        return { status: 'failed' };
      }
      const alreadyFinished = getRecentRun(run.id);
      if (alreadyFinished) {
        return { status: 'finished', run: alreadyFinished };
      }
      if (run.status !== 'running') {
        return { status: 'finished', run };
      }
      addActiveRun(run);
      return { status: 'started', run };
    };
    try {
      // A backend restart (Lattice merging a backend change into itself) or
      // its post-boot workflow recovery (503 `workflow-recovering`) is waited
      // out with backoff: the queue entry stays dispatched instead of being
      // dropped as `failed`.
      const res = await retryTransient(
        () => apiStartWorkflow(workflowId, { harnessOverride, piModelOverride }),
        {
          isCancelled: projectChanged,
          // Once a run finishes or is cancelled the active-run guard no
          // longer dedupes a replay. Retry only a definitely unaccepted start.
          retryIf: (err) => !mayHaveBeenApplied(err),
        },
      );
      return accept(res.run);
    } catch (err) {
      if (projectChanged()) return { status: 'failed' };
      // 409 = the backend's one-run-per-project guard rejected this start
      // because a run is already active. Not a user-facing error — the queue
      // requeues, a manual ▶ Run enqueues.
      if (err instanceof HttpError && err.status === 409) {
        return { status: 'busy' };
      }
      if (mayHaveBeenApplied(err)) {
        onError('Workflow start could not be confirmed and may already have run. Check workflow status before starting it again.');
        return { status: 'uncertain' };
      }
      onError(`Run failed: ${(err as Error).message}`);
      return { status: 'failed' };
    }
  }, [addActiveRun, getRecentRun, onError]);

  const runWorkflow = useCallback(async (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = getWorkflowHarnessOverride(workflowId),
    piModelOverride: string | undefined = getWorkflowPiModelOverride(workflowId),
  ): Promise<StartOutcome> => {
    const requestedProject = activeFolderRef.current;
    const requestedGeneration = activeFolderGenerationRef.current;
    const wf = workflowsById.get(workflowId);
    if (!requestedProject || !wf || !sameProjectPath(wf.projectPath, requestedProject)) {
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
        !sameProjectPath(saved.projectPath, requestedProject)
      ) {
        return { status: 'failed' };
      }
      targetId = saved.id;
    }
    return startWorkflowDefinition(targetId, harnessOverride, piModelOverride);
  }, [
    editor.dirty,
    editor.workflowId,
    getWorkflowHarnessOverride,
    getWorkflowPiModelOverride,
    save,
    startWorkflowDefinition,
    workflowsById,
  ]);

  const runEditorWorkflow = useCallback(async (): Promise<EditorRunResult> => {
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
        (!loadedWorkflow || !sameProjectPath(loadedWorkflow.projectPath, activeFolderRef.current))
      ) {
        return null;
      }
      const requestedProject = activeFolderRef.current;
      const requestedGeneration = activeFolderGenerationRef.current;
      const saved = await save();
      if (
        saved &&
        requestedProject &&
        activeFolderRef.current === requestedProject &&
        activeFolderGenerationRef.current === requestedGeneration &&
        sameProjectPath(saved.projectPath, requestedProject)
      ) {
        return {
          workflow: saved,
          outcome: await startWorkflowDefinition(saved.id, harnessOverride, piModelOverride),
        };
      }
      return null;
    }
    const wf = workflowsById.get(editor.workflowId);
    if (!wf) return null;
    return {
      workflow: wf,
      outcome: await runWorkflow(editor.workflowId, harnessOverride, piModelOverride),
    };
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
      // Pinned to the active project (404 for another project's run).
      await apiCancelWorkflowRun(activeFolderRef.current, runId);
    } catch (err) {
      onError(`Stop failed: ${(err as Error).message}`);
    }
  }, [onError]);

  return { startWorkflowDefinition, runWorkflow, runEditorWorkflow, stopRun };
}
