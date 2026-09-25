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
  // The save in flight, handed to any caller that arrives before it settles. On
  // a never-saved draft both clicks of a double-clicked Create (or Run / Queue,
  // which save first) would otherwise see `workflowId: null` and each POST a
  // new workflow — two identical definitions. `saving` disables the button.
  const savingRef = useRef<Promise<Workflow | null> | null>(null);
  const [saving, setSaving] = useState(false);

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

  const saveNow = useCallback(async (): Promise<Workflow | null> => {
    if (!activeFolder) return null;
    // Snapshot the editor as it stands when the save begins. If the user edits
    // a step while the request is in flight, the committed state becomes a new
    // object; reseeding from the server echo unconditionally would overwrite
    // that edit and clear `dirty`, silently losing the change (data-loss bug).
    // `nextEditorAfterSave` reseeds only when nothing changed mid-flight.
    //
    // Read from the ref, not the render closure: a follow-up save chained onto
    // a pending one (see `save`) runs before React re-renders, and the ref is
    // the one place the previous save's outcome is already visible.
    const editor = editorRef.current;
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
        // Mirror the outcome into the ref now so a chained save sees whether an
        // edit is still unsaved without waiting for the re-render.
        editorRef.current = nextEditorAfterSave(atSaveStart, editorRef.current, w).editor;
        return w;
      } else {
        const w = await apiCreateWorkflow(activeFolder, name, steps, variables);
        // Read the live editor from the ref — not from a flag mutated inside the
        // setEditor updater, which may not have run yet at this point (React
        // batches it in this promise continuation). A superseded create still
        // adopts the new workflow's id (and stays dirty), so the next save
        // PATCHes it rather than POSTing a duplicate definition.
        const { editor: next } = nextEditorAfterSave(atSaveStart, editorRef.current, w);
        setEditor(next);
        editorRef.current = next;
        // The workflow exists server-side now, so the never-saved stash is
        // obsolete either way — a mid-save edit is carried by the editor (which
        // now has a workflowId and is no longer stashed), and leaving the stash
        // would restore it as a new draft after a reload and create a third copy.
        clearWorkflowDraft(activeFolder);
        return w;
      }
    } catch (err) {
      onError(`Save failed: ${(err as Error).message}`);
      return null;
    }
  }, [activeFolder, onError]);

  const startSave = useCallback((): Promise<Workflow | null> => {
    const pending = saveNow().finally(() => {
      if (savingRef.current === pending) savingRef.current = null;
      setSaving(false);
    });
    savingRef.current = pending;
    setSaving(true);
    return pending;
  }, [saveNow]);
  const startSaveRef = useRef(startSave);
  startSaveRef.current = startSave;

  // Single-flight: a call while a save is pending joins it instead of POSTing
  // again. But the pending save carries the editor as it stood when it began —
  // an edit made since then isn't in it. A caller that joined (▶ Run clicked
  // after an edit during a pending Save) must act on what the editor shows, so
  // once the pending save settles, save again if the editor is still dirty.
  // The recursive call re-checks `savingRef`, so when several joiners resolve
  // together the first starts the follow-up save and the rest join it.
  const save = useCallback(function save(): Promise<Workflow | null> {
    const inFlight = savingRef.current;
    if (!inFlight) return startSaveRef.current();
    return inFlight.then((result) =>
      result && editorRef.current.dirty ? save() : result,
    );
  }, []);

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
    saving,
    discardEdits,
    deleteCurrent,
    ...mutations,
  };
}
