import { useCallback, useRef, useState } from 'react';
import {
  createWorkflow as apiCreateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  updateWorkflow as apiUpdateWorkflow,
  type Workflow,
} from '../../../api';
import type { WorkflowTemplate } from '../../../workflowTemplates';
import {
  collapsibleStepIds,
  emptyEditor,
  fromTemplate,
  fromWorkflow,
  localStepId,
  makeAgentStep,
  nextEditorAfterSave,
  type EditorState,
} from '../editorState';
import { clearWorkflowDraft } from '../workflowDraftStorage';
import { defaultVariables, withUserInstructions } from '../promptVariables';
import { useEditorDraftLifecycle } from './useEditorDraftLifecycle';
import { useEditorMutationActions } from './useEditorMutationActions';

type Args = {
  workflows: Workflow[];
  activeFolder: string;
  onError: (msg: string) => void;
  // Ids of the agent steps an action just created, so the caller can start them
  // collapsed (see `useCollapsedSteps`).
  onStepsAdded: (stepIds: string[]) => void;
};

// Owns the workflow-editor mutable state and all save/discard/delete/template
// flows. The launcher composes this with run state to wire the Run button
// (which needs to persist edits before kicking off a run).
//
// Two focused helpers split out the bulk: `useEditorDraftLifecycle` runs the
// reconcile/restore/persist effects (and their cross-project guards), and
// `useEditorMutationActions` provides the pure step/variable `setEditor`
// updaters. What stays here is the draft state itself plus the flows that touch
// the API or per-project draft storage.
export function useWorkflowEditor({
  workflows,
  activeFolder,
  onError,
  onStepsAdded,
}: Args) {
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [pickingTemplate, setPickingTemplate] = useState(false);

  // Render-tracked snapshot of the live editor. An awaited save needs to read
  // the *current* editor (to detect a mid-save edit) without depending on a
  // `setEditor` updater running synchronously — React batches the updater in a
  // promise continuation, so a flag mutated inside it can still be stale when
  // the code after `setEditor` inspects it. Writing the ref during render keeps
  // it in sync with the committed editor before any later save resolves.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Reconcile / restore / persist effects and their cross-project guards.
  useEditorDraftLifecycle({ editor, setEditor, workflows, activeFolder });

  const newBlank = useCallback(() => {
    const seed = makeAgentStep({ title: 'Step 1', prompt: '\n\n{{user_instructions}}' });
    setEditor({
      workflowId: null,
      name: '',
      steps: [seed],
      variables: defaultVariables(),
      dirty: true,
    });
    onStepsAdded([seed.id]);
    setPickingTemplate(false);
  }, [onStepsAdded]);

  const newFromTemplate = useCallback(async (t: WorkflowTemplate) => {
    setPickingTemplate(false);
    if (!activeFolder) {
      // No project to attach to — fall back to a draft in the editor.
      const draft = fromTemplate(t);
      setEditor(draft);
      onStepsAdded(collapsibleStepIds(draft.steps));
      return;
    }
    try {
      const created = await apiCreateWorkflow(
        activeFolder,
        t.name,
        t.steps.map((s) => {
          const kind = s.kind ?? 'agent';
          return {
            ...s,
            id: localStepId(),
            // Built-in agent steps end with {{user_instructions}} by default.
            prompt: kind === 'agent' ? withUserInstructions(s.prompt) : s.prompt,
            harness: s.harness ?? 'claude',
          };
        }),
        defaultVariables(),
      );
      const next = fromWorkflow(created);
      setEditor(next);
      onStepsAdded(collapsibleStepIds(next.steps));
    } catch (err) {
      onError(`Could not create from template: ${(err as Error).message}`);
      const draft = fromTemplate(t);
      setEditor(draft);
      onStepsAdded(collapsibleStepIds(draft.steps));
    }
  }, [activeFolder, onError, onStepsAdded]);

  const save = useCallback(async (): Promise<Workflow | null> => {
    if (!activeFolder) return null;
    // Snapshot the editor as it stands when the save begins. If the user edits
    // a step while the request is in flight, the committed state becomes a new
    // object; reseeding from the server echo unconditionally would overwrite
    // that edit and clear `dirty`, silently losing the change (data-loss bug).
    // `nextEditorAfterSave` reseeds only when nothing changed mid-flight.
    const atSaveStart = editor;
    const name = editor.name.trim() || 'Untitled workflow';
    const steps = editor.steps.map((s) => ({
      ...s,
      title: s.title.trim(),
      prompt: s.prompt,
      harness: s.harness ?? 'claude',
    }));
    const variables = editor.variables;
    try {
      if (editor.workflowId) {
        const w = await apiUpdateWorkflow(activeFolder, editor.workflowId, { name, steps, variables });
        setEditor((cur) => nextEditorAfterSave(atSaveStart, cur, w).editor);
        return w;
      } else {
        const w = await apiCreateWorkflow(activeFolder, name, steps, variables);
        // Read the live editor from the ref — not from a flag mutated inside the
        // setEditor updater, which may not have run yet at this point (React
        // batches it in this promise continuation). Deriving `superseded` from
        // the ref keeps the editor we commit and the clear decision in sync with
        // the actual current state.
        const { editor: next, superseded } = nextEditorAfterSave(
          atSaveStart,
          editorRef.current,
          w,
        );
        setEditor(next);
        // The never-saved draft is now persisted server-side; drop the stash —
        // unless a mid-save edit superseded it, in which case that edit is still
        // a live unsaved draft and the debounced persist must keep stashing it.
        if (!superseded) clearWorkflowDraft(activeFolder);
        return w;
      }
    } catch (err) {
      onError(`Save failed: ${(err as Error).message}`);
      return null;
    }
  }, [activeFolder, editor, onError]);

  const discardEdits = useCallback(() => {
    clearWorkflowDraft(activeFolder);
    if (!editor.workflowId) {
      setEditor(emptyEditor());
      return;
    }
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (fresh) setEditor(fromWorkflow(fresh));
  }, [activeFolder, editor.workflowId, workflows]);

  const deleteCurrent = useCallback(async () => {
    if (!editor.workflowId) return;
    try {
      // Pinned to the active project: the backend 404s a workflow from another
      // project instead of deleting it.
      await apiDeleteWorkflow(activeFolder, editor.workflowId);
      setEditor(emptyEditor());
    } catch (err) {
      onError(`Delete failed: ${(err as Error).message}`);
    }
  }, [activeFolder, editor.workflowId, onError]);

  const mutations = useEditorMutationActions(setEditor, onStepsAdded);

  return {
    editor,
    setEditor,
    pickingTemplate,
    setPickingTemplate,
    newBlank,
    newFromTemplate,
    save,
    discardEdits,
    deleteCurrent,
    ...mutations,
  };
}
