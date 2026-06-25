import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createWorkflow as apiCreateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  updateWorkflow as apiUpdateWorkflow,
  type Workflow,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowVariable,
} from '../../../api';
import type { WorkflowTemplate } from '../../../workflowTemplates';
import {
  emptyEditor,
  fromTemplate,
  fromWorkflow,
  localStepId,
  makeAgentStep,
  makeControlStep,
  nextEditorAfterSave,
  type EditorState,
} from '../editorState';
import {
  clearWorkflowDraft,
  loadWorkflowDraft,
  saveWorkflowDraft,
} from '../workflowDraftStorage';
import {
  defaultVariables,
  makeVariable,
  USER_INSTRUCTIONS_VAR,
  withUserInstructions,
} from '../promptVariables';
import type { DefaultPrompt } from '../defaultPrompts';

type Args = {
  workflows: Workflow[];
  activeFolder: string;
  onError: (msg: string) => void;
};

// Owns the workflow-editor mutable state and all save/discard/delete/template
// flows. The launcher composes this with run state to wire the Run button
// (which needs to persist edits before kicking off a run).
export function useWorkflowEditor({ workflows, activeFolder, onError }: Args) {
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

  // If the loaded workflow is edited from elsewhere (or deleted), refresh the
  // editor — but never clobber an in-progress edit.
  useEffect(() => {
    if (!editor.workflowId) return;
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (!fresh) {
      setEditor(emptyEditor());
      return;
    }
    if (!editor.dirty) {
      setEditor(fromWorkflow(fresh));
    }
  }, [workflows, editor.workflowId, editor.dirty]);

  // Restore a never-saved draft once per project, so a reload/close while
  // mid-edit on a brand-new workflow doesn't lose it. Guarded so it never
  // stomps an edit already in progress in this session.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFolder || restoredFor.current === activeFolder) return;
    restoredFor.current = activeFolder;
    setEditor((cur) => {
      if (cur.workflowId !== null || cur.steps.length > 0 || cur.name.trim()) {
        return cur;
      }
      return loadWorkflowDraft(activeFolder) ?? cur;
    });
  }, [activeFolder]);

  // Debounced persist of the in-progress draft. Only never-saved drafts with
  // content are stashed (a saved workflow is reloaded from the server, and an
  // empty draft is noise); see workflowDraftStorage.
  useEffect(() => {
    if (!activeFolder) return;
    const persistable =
      editor.dirty &&
      editor.workflowId === null &&
      (editor.steps.length > 0 || editor.name.trim() !== '');
    if (!persistable) return;
    const t = setTimeout(() => saveWorkflowDraft(activeFolder, editor), 500);
    return () => clearTimeout(t);
  }, [activeFolder, editor]);

  const newBlank = useCallback(() => {
    setEditor({
      workflowId: null,
      name: '',
      steps: [makeAgentStep({ title: 'Step 1', prompt: '\n\n{{user_instructions}}' })],
      variables: defaultVariables(),
      dirty: true,
    });
    setPickingTemplate(false);
  }, []);

  const newFromTemplate = useCallback(async (t: WorkflowTemplate) => {
    setPickingTemplate(false);
    if (!activeFolder) {
      // No project to attach to — fall back to a draft in the editor.
      setEditor(fromTemplate(t));
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
      setEditor(fromWorkflow(created));
    } catch (err) {
      onError(`Could not create from template: ${(err as Error).message}`);
      setEditor(fromTemplate(t));
    }
  }, [activeFolder, onError]);

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
        const w = await apiUpdateWorkflow(editor.workflowId, { name, steps, variables });
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
      await apiDeleteWorkflow(editor.workflowId);
      setEditor(emptyEditor());
    } catch (err) {
      onError(`Delete failed: ${(err as Error).message}`);
    }
  }, [editor.workflowId, onError]);

  const patchStep = useCallback((idx: number, patch: Partial<WorkflowStep>) => {
    setEditor((cur) => ({
      ...cur,
      steps: cur.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
      dirty: true,
    }));
  }, []);

  const removeStep = useCallback((idx: number) => {
    setEditor((cur) => ({
      ...cur,
      steps: cur.steps.filter((_, i) => i !== idx),
      dirty: true,
    }));
  }, []);

  const addStep = useCallback(() => {
    setEditor((cur) => ({
      ...cur,
      steps: [
        ...cur.steps,
        // Seed the built-in injection point so new steps follow the same
        // convention as the built-in templates/quick-add prompts.
        makeAgentStep({
          title: `Step ${cur.steps.length + 1}`,
          prompt: '\n\n{{user_instructions}}',
        }),
      ],
      dirty: true,
    }));
  }, []);

  // Variable actions. The built-in `user_instructions` variable can't be
  // removed (ensureUserInstructions would re-add it anyway); custom variables
  // are free-form. patchVariable handles both name and value edits.
  const patchVariable = useCallback(
    (idx: number, patch: Partial<WorkflowVariable>) => {
      setEditor((cur) => ({
        ...cur,
        variables: cur.variables.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
        dirty: true,
      }));
    },
    [],
  );

  const addVariable = useCallback(() => {
    setEditor((cur) => {
      const taken = new Set(cur.variables.map((v) => v.name));
      let name = 'custom_var';
      let n = 2;
      while (taken.has(name)) name = `custom_var_${n++}`;
      return {
        ...cur,
        variables: [...cur.variables, makeVariable(name, '')],
        dirty: true,
      };
    });
  }, []);

  const removeVariable = useCallback((idx: number) => {
    setEditor((cur) => {
      const target = cur.variables[idx];
      if (!target || target.name === USER_INSTRUCTIONS_VAR) return cur;
      return {
        ...cur,
        variables: cur.variables.filter((_, i) => i !== idx),
        dirty: true,
      };
    });
  }, []);

  // Append a headless control-flow step (Start/Merge/Push). These have no
  // prompt or harness — they drive Lattice's own task pipeline server-side
  // and are the building blocks for highly autonomous workflows.
  const addControlStep = useCallback((kind: WorkflowStepKind) => {
    const titleByKind: Record<WorkflowStepKind, string> = {
      agent: 'Step',
      start: 'Start all open tasks',
      merge: 'Merge all tasks',
      push: 'Push to remote',
    };
    setEditor((cur) => ({
      ...cur,
      steps: [...cur.steps, makeControlStep(kind, titleByKind[kind])],
      dirty: true,
    }));
  }, []);

  // Append a step seeded from a default-prompt chip. If the editor is empty
  // (no workflow loaded, no steps), bootstrap a draft so clicking a chip from
  // the empty state immediately produces something runnable.
  const addDefaultPromptStep = useCallback((p: DefaultPrompt) => {
    setEditor((cur) => {
      const base: EditorState =
        cur.workflowId === null && cur.steps.length === 0 && cur.name === ''
          ? { workflowId: null, name: p.title, steps: [], variables: cur.variables, dirty: true }
          : cur;
      return {
        ...base,
        steps: [
          ...base.steps,
          // Built-in quick-add prompts end with {{user_instructions}}.
          makeAgentStep({ title: p.title, prompt: withUserInstructions(p.prompt) }),
        ],
        dirty: true,
      };
    });
  }, []);

  const reorderSteps = useCallback((fromIdx: number, toIdx: number) => {
    setEditor((cur) => {
      if (fromIdx === toIdx) return cur;
      const steps = [...cur.steps];
      const [moved] = steps.splice(fromIdx, 1);
      let insertAt = toIdx;
      if (fromIdx < toIdx) insertAt -= 1;
      steps.splice(insertAt, 0, moved);
      return { ...cur, steps, dirty: true };
    });
  }, []);

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
    patchStep,
    removeStep,
    addStep,
    addControlStep,
    addDefaultPromptStep,
    reorderSteps,
    patchVariable,
    addVariable,
    removeVariable,
  };
}
