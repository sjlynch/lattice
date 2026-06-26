import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
  WorkflowStep,
  WorkflowStepKind,
  WorkflowVariable,
} from '../../../api';
import {
  makeAgentStep,
  makeControlStep,
  type EditorState,
} from '../editorState';
import {
  makeVariable,
  USER_INSTRUCTIONS_VAR,
  withUserInstructions,
} from '../promptVariables';
import type { DefaultPrompt } from '../defaultPrompts';

export type EditorMutationActions = {
  patchStep: (idx: number, patch: Partial<WorkflowStep>) => void;
  removeStep: (idx: number) => void;
  addStep: () => void;
  addControlStep: (kind: WorkflowStepKind) => void;
  addDefaultPromptStep: (p: DefaultPrompt) => void;
  reorderSteps: (fromIdx: number, toIdx: number) => void;
  patchVariable: (idx: number, patch: Partial<WorkflowVariable>) => void;
  addVariable: () => void;
  removeVariable: (idx: number) => void;
};

// The editor's step/variable mutation actions, split out of useWorkflowEditor.
// Every action is a pure `setEditor` updater (and so depends only on the stable
// setter) — they carry no API/draft-lifecycle concerns, which keeps the parent
// hook focused on draft restore/persist and the save/delete/template flows.
export function useEditorMutationActions(
  setEditor: Dispatch<SetStateAction<EditorState>>,
): EditorMutationActions {
  const patchStep = useCallback((idx: number, patch: Partial<WorkflowStep>) => {
    setEditor((cur) => ({
      ...cur,
      steps: cur.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
      dirty: true,
    }));
  }, [setEditor]);

  const removeStep = useCallback((idx: number) => {
    setEditor((cur) => ({
      ...cur,
      steps: cur.steps.filter((_, i) => i !== idx),
      dirty: true,
    }));
  }, [setEditor]);

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
  }, [setEditor]);

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
  }, [setEditor]);

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
  }, [setEditor]);

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
  }, [setEditor]);

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
    [setEditor],
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
  }, [setEditor]);

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
  }, [setEditor]);

  return {
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
