import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cancelWorkflowRun as apiCancelWorkflowRun,
  fetchHarnessAvailability,
  getWorkflowPromptCustomization,
  startWorkflow as apiStartWorkflow,
  startWorkflowPromptCustomization,
  type HarnessAvailability,
  type ScanResult,
  type Workflow,
  type WorkflowPromptTemplateId,
  type WorkflowQueueEntry,
  type WorkflowRun,
  type WorkflowRunHarnessOverride,
} from '../../../api';
import { useTerminals } from '../../../TerminalsContext';
import { normalizeAgentHarness } from '../../../harnesses';
import { fromWorkflow } from '../editorState';
import { useCollapsedSteps } from './useCollapsedSteps';
import { useWorkflowEditor } from './useWorkflowEditor';
import { useWorkflowErrorHandler } from './useWorkflowErrorHandler';
import { useWorkflowList } from './useWorkflowList';
import { useWorkflowQueue } from './useWorkflowQueue';
import { useWorkflowRuns } from './useWorkflowRuns';
import {
  detectProjectPromptProfile,
  inferPromptTemplateId,
  promptTemplateTitle,
} from '../projectPromptVariants';

export type QueueMode = 'sequential' | 'parallel';

function nextQueueEntryId(): string {
  return `wfq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Composes the workflow feature's data hooks into one interface for the UI.
// Components render state from here and dispatch intent-level actions such as
// `runWorkflow(id)` rather than knowing which API/editor hooks must chain.
export function useWorkflowManager(activeFolder: string, scanResult: ScanResult | null) {
  const { error, showError, clearError } = useWorkflowErrorHandler();
  const { addTerminal } = useTerminals();
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });
  const [workflowHarnessOverrides, setWorkflowHarnessOverrides] = useState<
    Record<string, WorkflowRunHarnessOverride>
  >({});
  const [customizingSteps, setCustomizingSteps] = useState<Record<string, string>>({});

  const projectProfile = useMemo(
    () => detectProjectPromptProfile(
      activeFolder,
      scanResult?.root === activeFolder ? scanResult : null,
    ),
    [activeFolder, scanResult],
  );

  useEffect(() => {
    let cancelled = false;
    fetchHarnessAvailability().then((avail) => {
      if (!cancelled) setHarnessAvail(avail);
    });
    return () => { cancelled = true; };
  }, []);

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

  const getWorkflowHarnessOverride = useCallback(
    (workflowId: string): WorkflowRunHarnessOverride =>
      workflowHarnessOverrides[workflowId] ?? null,
    [workflowHarnessOverrides],
  );

  const setWorkflowHarnessOverride = useCallback(
    (workflowId: string, harnessOverride: WorkflowRunHarnessOverride) => {
      setWorkflowHarnessOverrides((cur) => ({
        ...cur,
        [workflowId]: harnessOverride,
      }));
    },
    [],
  );

  const startWorkflowDefinition = useCallback(async (
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = null,
  ): Promise<WorkflowRun | null> => {
    try {
      const res = await apiStartWorkflow(workflowId, { harnessOverride });
      addActiveRun(res.run);
      return res.run;
    } catch (err) {
      showError(`Run failed: ${(err as Error).message}`);
      return null;
    }
  }, [addActiveRun, showError]);

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

  const runQueuedWorkflow = useCallback(
    (wf: Workflow, entry: WorkflowQueueEntry): Promise<WorkflowRun | null> =>
      runWorkflow(wf.id, entry.harnessOverride),
    [runWorkflow],
  );

  const { state: queueState, dispatch: dispatchQueue } = useWorkflowQueue({
    workflowsById,
    runWorkflow: runQueuedWorkflow,
    activeRuns,
  });

  const queuedItems = useMemo(
    () =>
      queueState.queued
        .map((entry) => ({ entry, workflow: workflowsById.get(entry.workflowId) }))
        .filter(
          (item): item is { entry: WorkflowQueueEntry; workflow: Workflow } =>
            Boolean(item.workflow),
        ),
    [queueState.queued, workflowsById],
  );

  const enqueueWorkflowDefinition = useCallback((
    wf: Workflow,
    harnessOverride: WorkflowRunHarnessOverride = getWorkflowHarnessOverride(wf.id),
  ) => {
    if (wf.steps.length === 0) return;
    dispatchQueue({
      type: 'enqueue',
      entry: {
        id: nextQueueEntryId(),
        workflowId: wf.id,
        harnessOverride,
      },
    });
  }, [dispatchQueue, getWorkflowHarnessOverride]);

  const enqueueWorkflow = useCallback((
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = getWorkflowHarnessOverride(workflowId),
  ) => {
    const wf = workflowsById.get(workflowId);
    if (wf) enqueueWorkflowDefinition(wf, harnessOverride);
  }, [enqueueWorkflowDefinition, getWorkflowHarnessOverride, workflowsById]);

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

  const stopRun = useCallback(async (runId: string) => {
    try {
      await apiCancelWorkflowRun(runId);
    } catch (err) {
      showError(`Stop failed: ${(err as Error).message}`);
    }
  }, [showError]);

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

  const enqueueEditorWorkflow = useCallback(async () => {
    const harnessOverride = editor.workflowId
      ? getWorkflowHarnessOverride(editor.workflowId)
      : null;
    if (!editor.workflowId || editor.dirty) {
      const saved = await save();
      if (saved) enqueueWorkflowDefinition(saved, harnessOverride);
      return;
    }
    enqueueWorkflow(editor.workflowId, harnessOverride);
  }, [
    editor.dirty,
    editor.workflowId,
    enqueueWorkflow,
    enqueueWorkflowDefinition,
    getWorkflowHarnessOverride,
    save,
  ]);

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

  const customizeStepPrompt = useCallback(async (index: number) => {
    if (!activeFolder) {
      showError('Choose an active project before customizing a workflow prompt.');
      return;
    }
    const step = editor.steps[index];
    if (!step) return;

    const inferredTemplateId = step.prompt.trim()
      ? (inferPromptTemplateId(step) as WorkflowPromptTemplateId | null)
      : null;
    let customInstructions: string | undefined;
    if (!inferredTemplateId) {
      const response = window.prompt(
        'How should this custom workflow step be tailored to the active project?',
      );
      if (response === null) return;
      customInstructions = response.trim();
      if (!customInstructions) {
        showError('Customization instructions are required for non-template steps.');
        return;
      }
    }

    const harness = normalizeAgentHarness(step.harness);
    setCustomizingSteps((cur) => ({ ...cur, [step.id]: 'starting' }));
    try {
      const request = await startWorkflowPromptCustomization({
        project: activeFolder,
        stepTitle: step.title.trim() || `Step ${index + 1}`,
        prompt: step.prompt,
        ...(inferredTemplateId ? { templateId: inferredTemplateId } : {}),
        ...(promptTemplateTitle(inferredTemplateId)
          ? { templateTitle: promptTemplateTitle(inferredTemplateId) }
          : {}),
        ...(customInstructions ? { customInstructions } : {}),
        harness,
      });
      setCustomizingSteps((cur) => ({ ...cur, [step.id]: request.id }));
      addTerminal({
        label: `customize:${step.title.trim() || index + 1}`,
        cwd: request.cwd,
        initialCommand: request.command,
        projectPath: activeFolder,
        serverId: request.serverId,
      });

      void (async () => {
        try {
          for (let attempt = 0; attempt < 180; attempt += 1) {
            await sleep(2000);
            const latest = await getWorkflowPromptCustomization(request.id);
            if (latest.status === 'completed' && latest.resultPrompt) {
              setEditor((cur) => {
                const idx = cur.steps.findIndex((candidate) => candidate.id === step.id);
                if (idx === -1) return cur;
                const steps = cur.steps.map((candidate, i) =>
                  i === idx ? { ...candidate, prompt: latest.resultPrompt! } : candidate,
                );
                return { ...cur, steps, dirty: true };
              });
              return;
            }
            if (latest.status === 'errored') {
              showError(`Prompt customization failed: ${latest.error ?? 'unknown error'}`);
              return;
            }
          }
          showError('Prompt customization is still running; check the customization terminal.');
        } catch (err) {
          showError(`Prompt customization polling failed: ${(err as Error).message}`);
        } finally {
          setCustomizingSteps((cur) => {
            const next = { ...cur };
            delete next[step.id];
            return next;
          });
        }
      })();
    } catch (err) {
      setCustomizingSteps((cur) => {
        const next = { ...cur };
        delete next[step.id];
        return next;
      });
      showError(`Prompt customization failed: ${(err as Error).message}`);
    }
  }, [activeFolder, addTerminal, editor.steps, setEditor, showError]);

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

  // Match the original semantics: `busy` reflects an HTTP /run in flight, not
  // "queue is processing a long-running workflow". Once the backend returns a
  // run id, queued controls like Clear / Remove-from-queue stay interactive.
  const queueBusy = queueState.started.some((entry) => entry.runId === null);
  const queueActive = queueState.started.find((entry) => {
    const runId = entry.runId;
    return runId !== null && activeRuns[runId];
  });
  const queueDisabled = queueState.queued.length === 0 || queueBusy;
  const queueStatus = queueState.running
    ? queueActive
      ? 'Running current workflow; next queued item starts when it finishes.'
      : queueBusy
        ? 'Starting next queued workflow…'
        : 'Waiting to start next queued workflow…'
    : queueState.queued.length > 0
      ? `${queueState.queued.length} workflow${queueState.queued.length === 1 ? '' : 's'} queued.`
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
    harnessAvail,
    workflowHarnessOverrides,
    getWorkflowHarnessOverride,
    projectProfile,
    customizingSteps,
    queue: {
      mode: queueState.mode,
      queuedEntries: queueState.queued,
      queuedWorkflowIds: queueState.queued.map((entry) => entry.workflowId),
      queuedItems,
      running: queueState.running,
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
      customizeStepPrompt,
      setWorkflowHarnessOverride,
      runWorkflow,
      runEditorWorkflow,
      enqueueWorkflow,
      enqueueEditorWorkflow,
      removeQueuedWorkflow,
      startQueuedWorkflows,
      setQueueMode: (mode: QueueMode) => dispatchQueue({ type: 'setMode', mode }),
      stopQueue,
      clearQueue,
      stopRun,
      dismissRecent,
    },
  };
}

export type WorkflowManager = ReturnType<typeof useWorkflowManager>;
