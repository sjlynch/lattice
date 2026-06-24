// Editor state shape + helpers for converting between server Workflow
// objects and the editor's local mutable state. The editor keeps `dirty`
// alongside the data so unsaved changes are visible in the UI and so
// runs can persist before executing.

import type {
  Workflow,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowVariable,
} from '../../api';
import type { WorkflowTemplate } from '../../workflowTemplates';
import {
  defaultVariables,
  ensureUserInstructions,
  withUserInstructions,
} from './promptVariables';

export type EditorState = {
  workflowId: string | null;
  name: string;
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
  dirty: boolean;
};

export function emptyEditor(): EditorState {
  return {
    workflowId: null,
    name: '',
    steps: [],
    variables: defaultVariables(),
    dirty: false,
  };
}

export function localStepId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// Single source of truth for a fresh agent step. The editor hand-wrote this
// literal in four places (newBlank / addStep / addDefaultPromptStep, plus the
// control variant) — callers pass only what differs (title + prompt); the
// default mode/harness/kind live here. Output is byte-identical to the old
// inline literals.
export function makeAgentStep({
  title,
  prompt,
}: {
  title: string;
  prompt: string;
}): WorkflowStep {
  return {
    id: localStepId(),
    title,
    prompt,
    mode: 'sequential',
    harness: 'claude',
    kind: 'agent',
  };
}

// A headless control-flow step (start/merge/push): no prompt, no real harness.
export function makeControlStep(
  kind: WorkflowStepKind,
  title: string,
): WorkflowStep {
  return {
    id: localStepId(),
    title,
    prompt: '',
    mode: 'sequential',
    harness: 'claude',
    kind,
  };
}

export function fromTemplate(t: WorkflowTemplate): EditorState {
  return {
    workflowId: null,
    name: t.name,
    steps: t.steps.map((s) => {
      const kind = s.kind ?? 'agent';
      return {
        ...s,
        id: localStepId(),
        // Built-in agent steps end with {{user_instructions}} by default;
        // headless control steps (start/merge/push) have no prompt.
        prompt: kind === 'agent' ? withUserInstructions(s.prompt) : s.prompt,
        harness: s.harness ?? 'claude',
        kind,
      };
    }),
    variables: defaultVariables(),
    dirty: true,
  };
}

export function fromWorkflow(w: Workflow): EditorState {
  return {
    workflowId: w.id,
    name: w.name,
    steps: w.steps.map((s) => ({
      ...s,
      harness: s.harness ?? 'claude',
      kind: s.kind ?? 'agent',
    })),
    variables: ensureUserInstructions(w.variables ?? []),
    dirty: false,
  };
}
