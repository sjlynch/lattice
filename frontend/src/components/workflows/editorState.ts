// Editor state shape + helpers for converting between server Workflow
// objects and the editor's local mutable state. The editor keeps `dirty`
// alongside the data so unsaved changes are visible in the UI and so
// runs can persist before executing.

import type { Workflow, WorkflowStep } from '../../api';
import type { WorkflowTemplate } from '../../workflowTemplates';

export type EditorState = {
  workflowId: string | null;
  name: string;
  steps: WorkflowStep[];
  dirty: boolean;
};

export function emptyEditor(): EditorState {
  return { workflowId: null, name: '', steps: [], dirty: false };
}

export function localStepId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function fromTemplate(t: WorkflowTemplate): EditorState {
  return {
    workflowId: null,
    name: t.name,
    steps: t.steps.map((s) => ({ ...s, id: localStepId(), harness: s.harness ?? 'claude' })),
    dirty: true,
  };
}

export function fromWorkflow(w: Workflow): EditorState {
  return {
    workflowId: w.id,
    name: w.name,
    steps: w.steps.map((s) => ({ ...s, harness: s.harness ?? 'claude' })),
    dirty: false,
  };
}
