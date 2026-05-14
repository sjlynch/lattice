import { useCallback, useMemo, useState } from 'react';
import {
  getWorkflowPromptCustomization,
  startWorkflowPromptCustomization,
  type ScanResult,
  type Workflow,
  type WorkflowPromptTemplateId,
  type WorkflowQueueEntry,
  type WorkflowRun,
} from '../../../api';
import { useTerminals } from '../../../TerminalsContext';
import { normalizeAgentHarness } from '../../../harnesses';
import { fromWorkflow } from '../editorState';
import { useCollapsedSteps } from './useCollapsedSteps';
import { useWorkflowEditor } from './useWorkflowEditor';
import { useWorkflowErrorHandler } from './useWorkflowErrorHandler';
import { useWorkflowHarnessOverrides } from './useWorkflowHarnessOverrides';
import { useWorkflowList } from './useWorkflowList';
import { useWorkflowQueue } from './useWorkflowQueue';
import { useWorkflowQueueActions } from './useWorkflowQueueActions';
import { useWorkflowQueueSelectors } from './useWorkflowQueueSelectors';
import { useWorkflowRunActions } from './useWorkflowRunActions';
import { useWorkflowRuns } from './useWorkflowRuns';
import {
  detectProjectPromptProfile,
  inferPromptTemplateId,
  promptTemplateTitle,
} from '../projectPromptVariants';

export type { QueueMode } from '../queueScheduler';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Composes the workflow feature's data hooks into one interface for the UI.
// Components render state from here and dispatch intent-level actions such as
// `runWorkflow(id)` rather than knowing which API/editor hooks must chain.
//
// The composition order matters: harness overrides feed run/queue actions,
// run actions feed the queue scheduler (queued entries fire through the same
// runWorkflow callback), and the queue scheduler's state feeds the selectors
// that render the queue panel.
export function useWorkflowManager(activeFolder: string, scanResult: ScanResult | null) {
  const { error, showError, clearError } = useWorkflowErrorHandler();
  const { addTerminal } = useTerminals();
  const harnessState = useWorkflowHarnessOverrides();
  const [customizingSteps, setCustomizingSteps] = useState<Record<string, string>>({});

  const projectProfile = useMemo(
    () => detectProjectPromptProfile(
      activeFolder,
      scanResult?.root === activeFolder ? scanResult : null,
    ),
    [activeFolder, scanResult],
  );

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

  const runActions = useWorkflowRunActions({
    editor,
    workflowsById,
    save,
    addActiveRun,
    getWorkflowHarnessOverride: harnessState.getWorkflowHarnessOverride,
    onError: showError,
  });

  const runQueuedWorkflow = useCallback(
    (wf: Workflow, entry: WorkflowQueueEntry): Promise<WorkflowRun | null> =>
      runActions.runWorkflow(wf.id, entry.harnessOverride),
    [runActions],
  );

  const { state: queueState, dispatch: dispatchQueue } = useWorkflowQueue({
    workflowsById,
    runWorkflow: runQueuedWorkflow,
    activeRuns,
  });

  const queueActions = useWorkflowQueueActions({
    editor,
    workflowsById,
    save,
    getWorkflowHarnessOverride: harnessState.getWorkflowHarnessOverride,
    dispatchQueue,
  });

  const queueSelectors = useWorkflowQueueSelectors({
    queueState,
    workflowsById,
    activeRuns,
  });

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
    harnessAvail: harnessState.harnessAvail,
    workflowHarnessOverrides: harnessState.workflowHarnessOverrides,
    getWorkflowHarnessOverride: harnessState.getWorkflowHarnessOverride,
    projectProfile,
    customizingSteps,
    queue: {
      mode: queueState.mode,
      queuedEntries: queueState.queued,
      queuedWorkflowIds: queueState.queued.map((entry) => entry.workflowId),
      queuedItems: queueSelectors.queuedItems,
      running: queueState.running,
      busy: queueSelectors.busy,
      disabled: queueSelectors.disabled,
      status: queueSelectors.status,
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
      setWorkflowHarnessOverride: harnessState.setWorkflowHarnessOverride,
      runWorkflow: runActions.runWorkflow,
      runEditorWorkflow: runActions.runEditorWorkflow,
      enqueueWorkflow: queueActions.enqueueWorkflow,
      enqueueEditorWorkflow: queueActions.enqueueEditorWorkflow,
      removeQueuedWorkflow: queueActions.removeQueuedWorkflow,
      startQueuedWorkflows: queueActions.startQueuedWorkflows,
      setQueueMode: queueActions.setQueueMode,
      stopQueue: queueActions.stopQueue,
      clearQueue: queueActions.clearQueue,
      stopRun: runActions.stopRun,
      dismissRecent,
    },
  };
}

export type WorkflowManager = ReturnType<typeof useWorkflowManager>;
