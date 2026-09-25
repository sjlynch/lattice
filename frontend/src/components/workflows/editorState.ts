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
// default harness/kind live here.
//
// `id` is injectable so a caller that must know the id *before* the step lands
// in state (the add actions, which mark the new step collapsed) can mint it
// outside the `setEditor` updater — an updater may run more than once, so an id
// generated inside it isn't stable.
export function makeAgentStep({
  id = localStepId(),
  title,
  prompt,
  tools,
}: {
  id?: string;
  title: string;
  prompt: string;
  // Pre-run tools (e.g. the Opengrep chip's `['opengrep']`). Left out of the
  // step when empty so the field stays absent for the common case.
  tools?: WorkflowStep['tools'];
}): WorkflowStep {
  return {
    id,
    title,
    prompt,
    harness: 'claude',
    kind: 'agent',
    ...(tools?.length ? { tools: [...tools] } : {}),
  };
}

// A headless control-flow step (start/merge/push): no prompt, no real harness.
// Also seeds a Run tests step (`test`): no prompt either (its brief is fixed),
// and the `claude` harness here is a real default the row lets the user change.
export function makeControlStep(
  kind: WorkflowStepKind,
  title: string,
): WorkflowStep {
  return {
    id: localStepId(),
    title,
    prompt: '',
    harness: 'claude',
    kind,
  };
}

// The ids of the steps that have a collapse toggle — agent steps only. Control
// rows (start/merge/push) render no prompt body, so marking them collapsed
// would just add dead ids to the persisted collapse map. Used by the editor to
// start every newly added step collapsed.
export function collapsibleStepIds(steps: WorkflowStep[]): string[] {
  return steps.filter((s) => (s.kind ?? 'agent') === 'agent').map((s) => s.id);
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

// Decide the editor's next state once a save's request resolves. `atSaveStart`
// is the editor object as it stood when the save began; `current` is the
// committed state now (read inside a functional `setEditor` updater). Every
// edit produces a fresh editor object, so reference-identity tells us whether
// the user typed during the in-flight request:
//   - unchanged  → adopt the server echo (`fromWorkflow`), clearing `dirty`.
//   - superseded → keep `current` so the mid-save edit (and its `dirty` flag)
//     survives instead of being silently overwritten by the stale echo. On the
//     create path `current` still has `workflowId: null` although the server
//     has already created `saved.id`: adopt that id (staying dirty) so the next
//     save PATCHes it instead of POSTing a duplicate definition.
export function nextEditorAfterSave(
  atSaveStart: EditorState,
  current: EditorState,
  saved: Workflow,
): { editor: EditorState; superseded: boolean } {
  if (current !== atSaveStart) {
    if (current.workflowId === null) {
      return { editor: { ...current, workflowId: saved.id, dirty: true }, superseded: true };
    }
    return { editor: current, superseded: true };
  }
  return { editor: fromWorkflow(saved), superseded: false };
}
