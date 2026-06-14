import { useCallback, useEffect, useState } from 'react';
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
  type EditorState,
} from '../editorState';
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

  const newBlank = useCallback(() => {
    setEditor({
      workflowId: null,
      name: '',
      steps: [
        {
          id: localStepId(),
          title: 'Step 1',
          prompt: '\n\n{{user_instructions}}',
          mode: 'sequential',
          harness: 'claude',
          kind: 'agent',
        },
      ],
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
        setEditor(fromWorkflow(w));
        return w;
      } else {
        const w = await apiCreateWorkflow(activeFolder, name, steps, variables);
        setEditor(fromWorkflow(w));
        return w;
      }
    } catch (err) {
      onError(`Save failed: ${(err as Error).message}`);
      return null;
    }
  }, [activeFolder, editor.workflowId, editor.name, editor.steps, editor.variables, onError]);

  const discardEdits = useCallback(() => {
    if (!editor.workflowId) {
      setEditor(emptyEditor());
      return;
    }
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (fresh) setEditor(fromWorkflow(fresh));
  }, [editor.workflowId, workflows]);

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
        {
          id: localStepId(),
          title: `Step ${cur.steps.length + 1}`,
          // Seed the built-in injection point so new steps follow the same
          // convention as the built-in templates/quick-add prompts.
          prompt: '\n\n{{user_instructions}}',
          mode: 'sequential',
          harness: 'claude',
          kind: 'agent',
        },
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
      steps: [
        ...cur.steps,
        {
          id: localStepId(),
          title: titleByKind[kind],
          prompt: '',
          mode: 'sequential',
          harness: 'claude',
          kind,
        },
      ],
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
          {
            id: localStepId(),
            title: p.title,
            // Built-in quick-add prompts end with {{user_instructions}}.
            prompt: withUserInstructions(p.prompt),
            mode: 'sequential',
            harness: 'claude',
            kind: 'agent',
          },
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
