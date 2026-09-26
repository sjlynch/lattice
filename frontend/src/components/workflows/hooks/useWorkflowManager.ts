import { useCallback, useMemo } from 'react';
import {
  type ScanResult,
  type Workflow,
  type WorkflowQueueEntry,
} from '../../../api';
import { useTerminals } from '../../../TerminalsContext';
import type { WorkflowTemplate } from '../../../workflowTemplates';
import { useStructuralScan } from '../../../hooks/useStructuralScan';
import { useConfirm } from '../../shared/ConfirmDialog';
import { fromWorkflow } from '../editorState';
import type { QueueState } from '../queueScheduler';
import { guardUnsavedSwitch } from '../unsavedSwitch';
import { useCollapsedSteps } from './useCollapsedSteps';
import { useWorkflowEditor } from './useWorkflowEditor';
import { useWorkflowErrorHandler } from './useWorkflowErrorHandler';
import { useWorkflowHarnessOverrides } from './useWorkflowHarnessOverrides';
import { useWorkflowList } from './useWorkflowList';
import { useWorkflowQueue } from './useWorkflowQueue';
import { useWorkflowQueueActions } from './useWorkflowQueueActions';
import {
  useWorkflowQueueSelectors,
  type WorkflowQueueSelectors,
} from './useWorkflowQueueSelectors';
import { useWorkflowManualRun } from './useWorkflowManualRun';
import { useWorkflowRunActions, type StartOutcome } from './useWorkflowRunActions';
import { useWorkflowRuns } from './useWorkflowRuns';
import { useWorkflowRunViews } from './useWorkflowRunViews';
import { useWorkflowPromptCustomization } from './useWorkflowPromptCustomization';
import { detectProjectPromptProfile } from '../projectPromptVariants';
import { usePostMergeHookConfigured } from './usePostMergeHookConfigured';

// The queue slice the panels render: scheduler state joined with the derived
// selectors. Assembled by `buildQueueView` so the hook body stays declarative.
type QueueView = {
  queuedEntries: WorkflowQueueEntry[];
  queuedWorkflowIds: string[];
  queuedItems: WorkflowQueueSelectors['queuedItems'];
  running: boolean;
  busy: boolean;
  disabled: boolean;
  status: string;
};

function buildQueueView(
  queueState: QueueState,
  selectors: WorkflowQueueSelectors,
  queuedWorkflowIds: string[],
): QueueView {
  return {
    queuedEntries: queueState.queued,
    queuedWorkflowIds,
    queuedItems: selectors.queuedItems,
    running: queueState.running,
    busy: selectors.busy,
    disabled: selectors.disabled,
    status: selectors.status,
  };
}

// Flattens the intent-level actions the panels call into one object. A fresh
// object each render (matching the previous inline literal); the underlying
// callbacks are stable, so this allocation is cheap and identity-irrelevant.
function buildActions(parts: {
  editorState: ReturnType<typeof useWorkflowEditor>;
  promptCustomization: ReturnType<typeof useWorkflowPromptCustomization>;
  harnessState: ReturnType<typeof useWorkflowHarnessOverrides>;
  runActions: ReturnType<typeof useWorkflowRunActions>;
  queueActions: ReturnType<typeof useWorkflowQueueActions>;
  manualRun: ReturnType<typeof useWorkflowManualRun>;
  selectWorkflow: (wf: Workflow) => Promise<void>;
  newBlank: () => Promise<void>;
  newFromTemplate: (template: WorkflowTemplate) => Promise<void>;
  updateEditorName: (name: string) => void;
  dismissRecent: (id: string) => void;
}) {
  const {
    editorState,
    promptCustomization,
    harnessState,
    runActions,
    queueActions,
    manualRun,
    selectWorkflow,
    newBlank,
    newFromTemplate,
    updateEditorName,
    dismissRecent,
  } = parts;
  return {
    setPickingTemplate: editorState.setPickingTemplate,
    newBlank,
    newFromTemplate,
    save: editorState.save,
    discardEdits: editorState.discardEdits,
    deleteCurrent: editorState.deleteCurrent,
    patchStep: editorState.patchStep,
    removeStep: editorState.removeStep,
    addStep: editorState.addStep,
    addControlStep: editorState.addControlStep,
    addDefaultPromptStep: editorState.addDefaultPromptStep,
    reorderSteps: editorState.reorderSteps,
    patchVariable: editorState.patchVariable,
    addVariable: editorState.addVariable,
    removeVariable: editorState.removeVariable,
    selectWorkflow,
    updateEditorName,
    customizeStepPrompt: promptCustomization.customizeStepPrompt,
    setWorkflowHarnessOverride: harnessState.setWorkflowHarnessOverride,
    // The ▶ Run buttons: start now, or queue behind the active run.
    runWorkflow: manualRun.runWorkflowOrQueue,
    runEditorWorkflow: manualRun.runEditorWorkflowOrQueue,
    enqueueWorkflow: queueActions.enqueueWorkflow,
    enqueueEditorWorkflow: queueActions.enqueueEditorWorkflow,
    removeQueuedWorkflow: queueActions.removeQueuedWorkflow,
    startQueuedWorkflows: queueActions.startQueuedWorkflows,
    stopQueue: queueActions.stopQueue,
    clearQueue: queueActions.clearQueue,
    stopRun: runActions.stopRun,
    dismissRecent,
  };
}

// Composes the workflow feature's data hooks into one interface for the UI.
// Components render state from here and dispatch intent-level actions such as
// `runWorkflow(id)` rather than knowing which API/editor hooks must chain.
//
// The composition order matters: harness overrides feed run/queue actions,
// run actions feed the queue scheduler (queued entries fire through the same
// runWorkflow callback), the queue scheduler's state feeds the selectors
// that render the queue panel, and run + queue actions together feed the
// manual ▶ Run wrappers (start now, or queue behind the active run). The derived run views and the queue/actions
// object assembly are split into `useWorkflowRunViews` / `buildQueueView` /
// `buildActions` so this body reads as wiring.
export function useWorkflowManager(activeFolder: string, scanResult: ScanResult | null) {
  const { error, showError, clearError } = useWorkflowErrorHandler();
  const { addTerminal } = useTerminals();
  const harnessState = useWorkflowHarnessOverrides();

  // Stack detection reads only structural fields (names/paths/exts), so key it
  // off the structure-stable scan reference — a metric-only file save no longer
  // re-runs the whole detection pass.
  const structuralScan = useStructuralScan(scanResult);
  const projectProfile = useMemo(
    () => detectProjectPromptProfile(
      activeFolder,
      structuralScan?.root === activeFolder ? structuralScan : null,
    ),
    [activeFolder, structuralScan],
  );

  const collapsedSteps = useCollapsedSteps(activeFolder);
  // For the Run tests row's "a post-merge hook may run the tests too" note.
  const postMergeHookConfigured = usePostMergeHookConfigured(activeFolder);
  const { workflows, sortedWorkflows } = useWorkflowList(activeFolder);
  const {
    activeRuns,
    recentRuns,
    controlProgress,
    addActiveRun,
    getRecentRun,
    dismissRecent,
  } = useWorkflowRuns(activeFolder);
  const editorState = useWorkflowEditor({
    workflows,
    activeFolder,
    onError: showError,
    // New steps land collapsed, so adding several quick-add chips leaves a
    // readable list of headers instead of a wall of prompt textareas.
    onStepsAdded: collapsedSteps.collapseSteps,
  });

  const { editor, setEditor } = editorState;
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

  const runViews = useWorkflowRunViews({
    activeRuns,
    recentRuns,
    controlProgress,
    editorWorkflowId: editor.workflowId,
  });

  const runActions = useWorkflowRunActions({
    activeFolder,
    editor,
    workflowsById,
    save: editorState.save,
    addActiveRun,
    getRecentRun,
    getWorkflowHarnessOverride: harnessState.getWorkflowHarnessOverride,
    getWorkflowPiModelOverride: harnessState.getWorkflowPiModelOverride,
    onError: showError,
  });

  const runQueuedWorkflow = useCallback(
    (wf: Workflow, entry: WorkflowQueueEntry): Promise<StartOutcome> =>
      // Each entry captured its own override at enqueue time — pass both fields
      // through so a queued "Pi — X" run uses the model it was queued with.
      runActions.runWorkflow(wf.id, entry.harnessOverride, entry.piModelOverride),
    [runActions],
  );

  const { state: queueState, dispatch: dispatchQueue } = useWorkflowQueue({
    activeFolder,
    workflowsById,
    runWorkflow: runQueuedWorkflow,
    activeRuns,
    recentRuns,
  });

  const queueActions = useWorkflowQueueActions({
    editor,
    workflowsById,
    save: editorState.save,
    getWorkflowHarnessOverride: harnessState.getWorkflowHarnessOverride,
    getWorkflowPiModelOverride: harnessState.getWorkflowPiModelOverride,
    dispatchQueue,
  });

  const queueSelectors = useWorkflowQueueSelectors({
    queueState,
    workflowsById,
    activeRuns,
  });

  const manualRun = useWorkflowManualRun({
    activeRuns,
    editorWorkflowId: editor.workflowId,
    runWorkflow: runActions.runWorkflow,
    runEditorWorkflow: runActions.runEditorWorkflow,
    enqueueWorkflow: queueActions.enqueueWorkflow,
    enqueueWorkflowDefinition: queueActions.enqueueWorkflowDefinition,
    enqueueEditorWorkflow: queueActions.enqueueEditorWorkflow,
    startQueuedWorkflows: queueActions.startQueuedWorkflows,
    notify: showError,
  });

  // Replacing the editor (picking another saved workflow, starting a blank
  // one) discards whatever is in it, so with unsaved edits ask Save / Discard /
  // Cancel first — the same guard the panel-close path applies.
  const { confirmUnsaved } = useConfirm();
  const {
    save, discardEdits, getEditor, isCurrentEditor,
    newBlank: newBlankEditor, newFromTemplate: newTemplateEditor,
  } = editorState;
  const guardUnsaved = useCallback(
    async (replace: () => void | Promise<void>) => {
      const isCurrent = () => isCurrentEditor(editor.identity);
      let discard = false;
      const allowed = await guardUnsavedSwitch({
        dirty: getEditor().dirty,
        isCurrent,
        confirmUnsaved: () =>
          confirmUnsaved({ message: 'You have unsaved changes to this workflow.' }),
        save,
        // Discard and replacement happen together after the final scope check.
        discardEdits: () => { discard = true; },
      });
      if (!allowed || !isCurrent()) return;
      // A save may succeed while leaving edits typed during the request dirty.
      if (!discard && getEditor().dirty) return;
      if (discard) discardEdits();
      await replace();
    },
    [editor.identity, confirmUnsaved, save, discardEdits, getEditor, isCurrentEditor],
  );

  const selectWorkflow = useCallback(async (wf: Workflow) => {
    // Re-selecting the workflow already being edited is a no-op for its edits.
    if (getEditor().workflowId === wf.id) return;
    await guardUnsaved(() => setEditor(fromWorkflow(wf)));
  }, [getEditor, guardUnsaved, setEditor]);

  const newBlank = useCallback(async () => {
    await guardUnsaved(newBlankEditor);
  }, [guardUnsaved, newBlankEditor]);

  const newFromTemplate = useCallback(async (template: WorkflowTemplate) => {
    await guardUnsaved(() => newTemplateEditor(template));
  }, [guardUnsaved, newTemplateEditor]);

  const updateEditorName = useCallback((name: string) => {
    setEditor((cur) => ({
      ...cur,
      name,
      dirty: true,
    }));
  }, [setEditor]);

  const queuedWorkflowIds = useMemo(
    () => queueState.queued.map((entry) => entry.workflowId),
    [queueState.queued],
  );

  return {
    activeFolder,
    error,
    clearError,
    workflows,
    sortedWorkflows,
    activeRuns,
    activeRunList: runViews.activeRunList,
    recentRuns,
    recentFailedRunList: runViews.recentFailedRunList,
    runForEditor: runViews.runForEditor,
    controlProgressForEditor: runViews.controlProgressForEditor,
    recentForEditor: runViews.recentForEditor,
    editor,
    // In-flight flags that disable Save / Run so a double-click can't create
    // two definitions or start (then queue) the same workflow twice.
    savingEditor: editorState.saving,
    editorRunStarting: manualRun.editorStarting,
    startingWorkflowIds: manualRun.startingWorkflowIds,
    pickingTemplate: editorState.pickingTemplate,
    harnessAvail: harnessState.harnessAvail,
    piMenu: harnessState.piMenu,
    workflowHarnessOverrides: harnessState.workflowHarnessOverrides,
    getWorkflowHarnessOverride: harnessState.getWorkflowHarnessOverride,
    getWorkflowPiModelOverride: harnessState.getWorkflowPiModelOverride,
    projectProfile,
    postMergeHookConfigured,
    customizingSteps: promptCustomization.customizingSteps,
    queue: buildQueueView(queueState, queueSelectors, queuedWorkflowIds),
    collapsedSteps,
    actions: buildActions({
      editorState,
      promptCustomization,
      harnessState,
      runActions,
      queueActions,
      manualRun,
      selectWorkflow,
      newBlank,
      newFromTemplate,
      updateEditorName,
      dismissRecent,
    }),
  };
}

export type WorkflowManager = ReturnType<typeof useWorkflowManager>;
