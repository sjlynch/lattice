import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelWorkflowRun as apiCancelWorkflowRun,
  startWorkflow as apiStartWorkflow,
  type Workflow,
  type WorkflowRun,
} from '../../../api';
import { fromWorkflow } from '../editorState';
import { useCollapsedSteps } from './useCollapsedSteps';
import { useWorkflowEditor } from './useWorkflowEditor';
import { useWorkflowErrorHandler } from './useWorkflowErrorHandler';
import { useWorkflowList } from './useWorkflowList';
import { useWorkflowRuns } from './useWorkflowRuns';

export type QueueMode = 'sequential' | 'parallel';

// Composes the workflow feature's data hooks into one interface for the UI.
// Components render state from here and dispatch intent-level actions such as
// `runWorkflow(id)` rather than knowing which API/editor hooks must chain.
export function useWorkflowManager(activeFolder: string) {
  const { error, showError, clearError } = useWorkflowErrorHandler();
  const [queueMode, setQueueMode] = useState<QueueMode>('sequential');
  const [queuedWorkflowIds, setQueuedWorkflowIds] = useState<string[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueActiveRunId, setQueueActiveRunId] = useState<string | null>(null);
  const queueStartingRef = useRef(false);

  const collapsedSteps = useCollapsedSteps(activeFolder);
  const { workflows, sortedWorkflows } = useWorkflowList(activeFolder);
  const { activeRuns, recentRuns, addActiveRun, dismissRecent } =
    useWorkflowRuns(activeFolder);
  const editorState = useWorkflowEditor({
    workflows,
    activeFolder,
    onError: showError,
  });

  const { editor, setEditor, save } = editorState;

  const workflowsById = useMemo(() => {
    const map = new Map<string, Workflow>();
    for (const wf of workflows) map.set(wf.id, wf);
    return map;
  }, [workflows]);

  const activeRunList = useMemo(
    () => Object.values(activeRuns).sort((a, b) => a.startedAt - b.startedAt),
    [activeRuns],
  );

  const queuedWorkflows = useMemo(
    () =>
      queuedWorkflowIds
        .map((id) => workflowsById.get(id))
        .filter((wf): wf is Workflow => Boolean(wf)),
    [queuedWorkflowIds, workflowsById],
  );

  const startWorkflowDefinition = useCallback(async (workflowId: string): Promise<WorkflowRun | null> => {
    try {
      const res = await apiStartWorkflow(workflowId);
      addActiveRun(res.run);
      return res.run;
    } catch (err) {
      showError(`Run failed: ${(err as Error).message}`);
      return null;
    }
  }, [addActiveRun, showError]);

  const runWorkflow = useCallback(async (workflowId: string): Promise<WorkflowRun | null> => {
    const wf = workflowsById.get(workflowId);
    if (!wf) return null;

    let targetId = wf.id;
    if (editor.dirty && editor.workflowId === wf.id) {
      // Persist before run so the engine sees the latest steps.
      const saved = await save();
      if (!saved) return null;
      targetId = saved.id;
    }
    return startWorkflowDefinition(targetId);
  }, [editor.dirty, editor.workflowId, save, startWorkflowDefinition, workflowsById]);

  const enqueueWorkflowDefinition = useCallback((wf: Workflow) => {
    if (wf.steps.length === 0) return;
    setQueuedWorkflowIds((cur) => (cur.includes(wf.id) ? cur : [...cur, wf.id]));
  }, []);

  const enqueueWorkflow = useCallback((workflowId: string) => {
    const wf = workflowsById.get(workflowId);
    if (wf) enqueueWorkflowDefinition(wf);
  }, [enqueueWorkflowDefinition, workflowsById]);

  const removeQueuedWorkflow = useCallback((workflowId: string) => {
    setQueuedWorkflowIds((cur) => cur.filter((id) => id !== workflowId));
  }, []);

  const clearQueue = useCallback(() => {
    setQueuedWorkflowIds([]);
  }, []);

  const stopQueue = useCallback(() => {
    setQueueRunning(false);
  }, []);

  const startQueuedWorkflows = useCallback(async () => {
    if (queuedWorkflowIds.length === 0 || queueBusy) return;
    if (queueMode === 'sequential') {
      setQueueRunning(true);
      return;
    }

    const ids = [...queuedWorkflowIds];
    setQueueBusy(true);
    setQueuedWorkflowIds([]);
    const results = await Promise.all(
      ids.map(async (id) => {
        if (!workflowsById.has(id)) return { id, ok: true };
        const run = await runWorkflow(id);
        return { id, ok: Boolean(run) };
      }),
    );
    const failedIds = results.filter((r) => !r.ok).map((r) => r.id);
    if (failedIds.length > 0) {
      setQueuedWorkflowIds((cur) => [...failedIds, ...cur]);
    }
    setQueueBusy(false);
  }, [queueBusy, queueMode, queuedWorkflowIds, runWorkflow, workflowsById]);

  useEffect(() => {
    if (
      !queueRunning ||
      queueMode !== 'sequential' ||
      queueBusy ||
      queueStartingRef.current
    ) {
      return;
    }

    queueStartingRef.current = true;
    void (async () => {
      let markedBusy = false;
      try {
        // Defer state updates out of the effect's synchronous phase; this keeps
        // React's lint rule happy while still letting active-run updates drive
        // the sequential queue forward.
        await Promise.resolve();
        if (queueActiveRunId && activeRuns[queueActiveRunId]) return;

        const nextId = queuedWorkflowIds[0];
        if (!nextId) {
          setQueueRunning(false);
          setQueueActiveRunId(null);
          return;
        }

        const wf = workflowsById.get(nextId);
        if (!wf) {
          setQueuedWorkflowIds((cur) => cur.filter((id) => id !== nextId));
          return;
        }

        setQueueBusy(true);
        markedBusy = true;
        setQueuedWorkflowIds((cur) => (cur[0] === nextId ? cur.slice(1) : cur.filter((id) => id !== nextId)));
        const run = await runWorkflow(wf.id);
        setQueueActiveRunId(run?.id ?? null);
      } finally {
        if (markedBusy) setQueueBusy(false);
        queueStartingRef.current = false;
      }
    })();
  }, [
    activeRuns,
    queueActiveRunId,
    queueBusy,
    queueMode,
    queueRunning,
    queuedWorkflowIds,
    runWorkflow,
    workflowsById,
  ]);

  const stopRun = useCallback(async (runId: string) => {
    try {
      await apiCancelWorkflowRun(runId);
    } catch (err) {
      showError(`Stop failed: ${(err as Error).message}`);
    }
  }, [showError]);

  const runEditorWorkflow = useCallback(async () => {
    if (!editor.workflowId || editor.dirty) {
      const saved = await save();
      if (saved) await startWorkflowDefinition(saved.id);
      return;
    }
    await runWorkflow(editor.workflowId);
  }, [editor.dirty, editor.workflowId, runWorkflow, save, startWorkflowDefinition]);

  const enqueueEditorWorkflow = useCallback(async () => {
    if (!editor.workflowId || editor.dirty) {
      const saved = await save();
      if (saved) enqueueWorkflowDefinition(saved);
      return;
    }
    enqueueWorkflow(editor.workflowId);
  }, [editor.dirty, editor.workflowId, enqueueWorkflow, enqueueWorkflowDefinition, save]);

  const selectWorkflow = useCallback((wf: Workflow) => {
    setEditor(fromWorkflow(wf));
  }, [setEditor]);

  const updateEditorName = useCallback((name: string) => {
    setEditor((cur) => ({
      ...cur,
      name,
      dirty: true,
    }));
  }, [setEditor]);

  // Find any active/recent run for the currently-edited workflow so the
  // strip in the editor head reflects the right run.
  const runForEditor = editor.workflowId
    ? activeRuns[
        Object.keys(activeRuns).find(
          (k) => activeRuns[k].workflowId === editor.workflowId,
        ) ?? ''
      ]
    : undefined;
  const recentForEditor = editor.workflowId
    ? recentRuns[
        Object.keys(recentRuns).find(
          (k) => recentRuns[k].workflowId === editor.workflowId,
        ) ?? ''
      ]
    : undefined;

  const queueDisabled = queuedWorkflowIds.length === 0 || queueBusy;
  const queueStatus = queueRunning
    ? queueActiveRunId && activeRuns[queueActiveRunId]
      ? 'Running current workflow; next queued item starts when it finishes.'
      : queueBusy
        ? 'Starting next queued workflow…'
        : 'Waiting to start next queued workflow…'
    : queuedWorkflowIds.length > 0
      ? `${queuedWorkflowIds.length} workflow${queuedWorkflowIds.length === 1 ? '' : 's'} queued.`
      : 'Queue saved workflows, then choose sequential or parallel start.';

  return {
    activeFolder,
    error,
    clearError,
    workflows,
    sortedWorkflows,
    activeRuns,
    activeRunList,
    recentRuns,
    runForEditor,
    recentForEditor,
    editor,
    pickingTemplate: editorState.pickingTemplate,
    queue: {
      mode: queueMode,
      queuedWorkflowIds,
      queuedWorkflows,
      running: queueRunning,
      busy: queueBusy,
      disabled: queueDisabled,
      status: queueStatus,
    },
    collapsedSteps,
    actions: {
      setPickingTemplate: editorState.setPickingTemplate,
      newBlank: editorState.newBlank,
      newFromTemplate: editorState.newFromTemplate,
      save,
      discardEdits: editorState.discardEdits,
      deleteCurrent: editorState.deleteCurrent,
      patchStep: editorState.patchStep,
      removeStep: editorState.removeStep,
      addStep: editorState.addStep,
      addDefaultPromptStep: editorState.addDefaultPromptStep,
      reorderSteps: editorState.reorderSteps,
      selectWorkflow,
      updateEditorName,
      runWorkflow,
      runEditorWorkflow,
      enqueueWorkflow,
      enqueueEditorWorkflow,
      removeQueuedWorkflow,
      startQueuedWorkflows,
      setQueueMode,
      stopQueue,
      clearQueue,
      stopRun,
      dismissRecent,
    },
  };
}

export type WorkflowManager = ReturnType<typeof useWorkflowManager>;
