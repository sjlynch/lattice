import { useCallback, useMemo } from 'react';
import {
  type ScanResult,
  type Workflow,
  type WorkflowQueueEntry,
  type WorkflowRun,
} from '../../../api';
import { useTerminals } from '../../../TerminalsContext';
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
import { useWorkflowPromptCustomization } from './useWorkflowPromptCustomization';
import { detectProjectPromptProfile } from '../projectPromptVariants';

export type { QueueMode } from '../queueScheduler';

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

  const projectProfile = useMemo(
    () => detectProjectPromptProfile(
      activeFolder,
      scanResult?.root === activeFolder ? scanResult : null,
    ),
    [activeFolder, scanResult],
  );

  const collapsedSteps = useCollapsedSteps(activeFolder);
  const { workflows, sortedWorkflows } = useWorkflowList(activeFolder);
  const { activeRuns, recentRuns, controlProgress, addActiveRun, dismissRecent } =
    useWorkflowRuns(activeFolder);
  const editorState = useWorkflowEditor({
    workflows,
    activeFolder,
    onError: showError,
  });

  const { editor, setEditor, save } = editorState;
  const promptCustomization = useWorkflowPromptCustomization({
    activeFolder,
    steps: editor.steps,
    setEditor,
    addTerminal,
    showError,
  });

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
    recentRuns,
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

  // Find any active/recent run for the currently-edited workflow so the
  // strip in the editor head reflects the right run.
  const runForEditor = editor.workflowId
    ? activeRuns[
        Object.keys(activeRuns).find(
          (k) => activeRuns[k].workflowId === editor.workflowId,
        ) ?? ''
      ]
    : undefined;
  const controlProgressForEditor = runForEditor
    ? controlProgress[runForEditor.id]
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
    controlProgressForEditor,
    recentForEditor,
    editor,
    pickingTemplate: editorState.pickingTemplate,
    harnessAvail: harnessState.harnessAvail,
    workflowHarnessOverrides: harnessState.workflowHarnessOverrides,
    getWorkflowHarnessOverride: harnessState.getWorkflowHarnessOverride,
    projectProfile,
    customizingSteps: promptCustomization.customizingSteps,
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
      addControlStep: editorState.addControlStep,
      addDefaultPromptStep: editorState.addDefaultPromptStep,
      reorderSteps: editorState.reorderSteps,
      selectWorkflow,
      updateEditorName,
      customizeStepPrompt: promptCustomization.customizeStepPrompt,
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
