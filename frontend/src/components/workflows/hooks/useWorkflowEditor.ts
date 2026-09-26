import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  makeAgentStep,
  nextEditorAfterSave,
  type EditorState,
} from '../editorState';
import { clearWorkflowDraft } from '../workflowDraftStorage';
import { useEditorDraftLifecycle } from './useEditorDraftLifecycle';
import { useEditorMutationActions } from './useEditorMutationActions';

type Args = {
  workflows: Workflow[];
  activeFolder: string;
  onError: (msg: string) => void;
  // Newly added agent steps start collapsed.
  onStepsAdded: (stepIds: string[]) => void;
};

// Owns editor lifetimes and API mutations. Draft persistence/reconciliation and
// pure step/variable edits live in the two helper hooks below.
export function useWorkflowEditor({ workflows, activeFolder, onError, onStepsAdded }: Args) {
  const [editor, setEditorState] = useState<EditorState>(emptyEditor);
  const [pickingTemplate, setPickingTemplate] = useState(false);
  const editorRef = useRef(editor);
  // A fresh object on EVERY project change also rejects A -> B -> A responses.
  const projectRef = useRef({ folder: activeFolder });
  if (projectRef.current.folder !== activeFolder) projectRef.current = { folder: activeFolder };
  const project = projectRef.current;
  const editorProject = useRef(project);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Write through synchronously: a queued replacement or edit must be visible
  // to async continuations and joined saves even before React renders again.
  // Updaters remain pure; no ref mutation happens inside React's state updater.
  const setEditor = useCallback<Dispatch<SetStateAction<EditorState>>>((value) => {
    if (!mounted.current || projectRef.current !== project) return;
    const next = typeof value === 'function' ? value(editorRef.current) : value;
    editorProject.current = project;
    editorRef.current = next;
    setEditorState(next);
  }, [project]);
  const getEditor = useCallback(() => editorRef.current, []);
  const isCurrentEditor = useCallback((identity: symbol) =>
    mounted.current && projectRef.current === project && editorProject.current === project
      && editorRef.current.identity === identity,
  [project]);

  useEditorDraftLifecycle({ editor, setEditor, workflows, activeFolder });

  const savingRef = useRef<{
    project: typeof project;
    identity: symbol;
    promise: Promise<Workflow | null>;
  } | null>(null);
  const [savingIdentity, setSavingIdentity] = useState<symbol | null>(null);

  const saveNow = useCallback(async (identity: symbol, errorPrefix: string): Promise<Workflow | null> => {
    if (!activeFolder || !isCurrentEditor(identity)) return null;
    const atSaveStart = editorRef.current;
    const name = atSaveStart.name.trim() || 'Untitled workflow';
    const steps = atSaveStart.steps.map((s) => ({
      ...s,
      title: s.title.trim(),
      harness: s.harness ?? 'claude',
    }));
    const variables = atSaveStart.variables;
    try {
      const saved = atSaveStart.workflowId
        ? await apiUpdateWorkflow(activeFolder, atSaveStart.workflowId, { name, steps, variables })
        : await apiCreateWorkflow(activeFolder, name, steps, variables);
      // The server operation may finish after leaving this editor. Its result
      // must neither adopt an id nor clear another draft's localStorage stash.
      if (!isCurrentEditor(identity)) return null;
      setEditor(nextEditorAfterSave(atSaveStart, editorRef.current, saved).editor);
      if (!atSaveStart.workflowId) clearWorkflowDraft(activeFolder);
      return saved;
    } catch (err) {
      if (isCurrentEditor(identity)) onError(`${errorPrefix}: ${(err as Error).message}`);
      return null;
    }
  }, [activeFolder, isCurrentEditor, onError, setEditor]);

  // Single-flight within ONE editor lifetime. A joiner saves mid-flight edits
  // before resolving, but never chains onto the latest project's save callback.
  const saveDraft = useCallback(function saveDraft(
    identity: symbol,
    errorPrefix = 'Save failed',
  ): Promise<Workflow | null> {
    if (!isCurrentEditor(identity)) return Promise.resolve(null);
    const inFlight = savingRef.current;
    if (inFlight?.project === project && inFlight.identity === identity) {
      return inFlight.promise.then((result) => {
        if (!isCurrentEditor(identity)) return null;
        return result && editorRef.current.dirty ? saveDraft(identity, errorPrefix) : result;
      });
    }
    const promise = saveNow(identity, errorPrefix).finally(() => {
      if (savingRef.current?.promise !== promise) return;
      savingRef.current = null;
      if (isCurrentEditor(identity)) setSavingIdentity(null);
    }).then((result) => isCurrentEditor(identity) ? result : null);
    savingRef.current = { project, identity, promise };
    setSavingIdentity(identity);
    return promise;
  }, [isCurrentEditor, project, saveNow]);
  const save = useCallback(() => saveDraft(editor.identity), [editor.identity, saveDraft]);

  const newBlank = useCallback(() => {
    const seed = makeAgentStep({ title: 'Step 1', prompt: '\n\n{{user_instructions}}' });
    setEditor({ ...emptyEditor(), steps: [seed], dirty: true });
    onStepsAdded([seed.id]);
    setPickingTemplate(false);
  }, [onStepsAdded, setEditor]);

  const newFromTemplate = useCallback(async (t: WorkflowTemplate) => {
    // Start a distinct draft immediately, then use the same scoped create path
    // as Save. Failure leaves it editable; success retains any mid-save edits.
    const draft = fromTemplate(t);
    setEditor(draft);
    onStepsAdded(collapsibleStepIds(draft.steps));
    setPickingTemplate(false);
    if (activeFolder) await saveDraft(draft.identity, 'Could not create from template');
  }, [activeFolder, onStepsAdded, saveDraft, setEditor]);

  const discardEdits = useCallback(() => {
    if (!isCurrentEditor(editor.identity)) return;
    clearWorkflowDraft(activeFolder);
    const id = editorRef.current.workflowId;
    const fresh = workflows.find((w) => w.id === id);
    setEditor(fresh ? fromWorkflow(fresh) : emptyEditor());
  }, [activeFolder, editor.identity, isCurrentEditor, setEditor, workflows]);

  const deleteCurrent = useCallback(async () => {
    const identity = editor.identity;
    if (!isCurrentEditor(identity)) return;
    const id = editorRef.current.workflowId;
    if (!id) return;
    try {
      await apiDeleteWorkflow(activeFolder, id);
      if (isCurrentEditor(identity)) setEditor(emptyEditor());
    } catch (err) {
      if (isCurrentEditor(identity)) onError(`Delete failed: ${(err as Error).message}`);
    }
  }, [activeFolder, editor.identity, isCurrentEditor, onError, setEditor]);

  const mutations = useEditorMutationActions(setEditor, onStepsAdded);
  return {
    editor,
    setEditor,
    getEditor,
    isCurrentEditor,
    pickingTemplate,
    setPickingTemplate,
    newBlank,
    newFromTemplate,
    save,
    saving: savingIdentity === editor.identity && isCurrentEditor(editor.identity),
    discardEdits,
    deleteCurrent,
    ...mutations,
  };
}
