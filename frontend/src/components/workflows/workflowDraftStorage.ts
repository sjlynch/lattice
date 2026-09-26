// Per-project persistence for an in-progress, never-saved workflow draft.
// Saved/loaded workflows already auto-persist on run/queue (those go through
// the backend keyed by editor.workflowId); the gap is a brand-new draft the
// user hasn't saved yet. We stash that draft in localStorage under the same
// `lattice.<thing>.<projectPath>` convention so a reload/close doesn't lose it.

import type { EditorState } from './editorState';
import { ensureUserInstructions } from './promptVariables';

const PREFIX = 'lattice.workflowEditorDraft.';

function keyFor(projectPath: string): string {
  return `${PREFIX}${projectPath}`;
}

// Restore a stored draft, but only a never-saved one with real content — a
// saved workflow is reloaded from the server, and an empty draft is noise.
export function loadWorkflowDraft(projectPath: string): EditorState | null {
  if (!projectPath) return null;
  try {
    const raw = localStorage.getItem(keyFor(projectPath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EditorState;
    if (!parsed || parsed.workflowId !== null || !Array.isArray(parsed.steps)) {
      return null;
    }
    if (parsed.steps.length === 0 && !parsed.name?.trim()) return null;
    // A draft stashed before workflows had variables (or a hand-mangled one)
    // has no `variables` array; the editor maps over it unconditionally, so a
    // missing/invalid list would throw and wedge the panel. Normalize to the
    // shape the editor expects (always including the built-in variable).
    const variables = ensureUserInstructions(
      Array.isArray(parsed.variables) ? parsed.variables : [],
    );
    // A restored draft is, by definition, unsaved.
    return { ...parsed, identity: Symbol(), variables, dirty: true };
  } catch {
    return null;
  }
}

export function saveWorkflowDraft(projectPath: string, editor: EditorState): void {
  if (!projectPath) return;
  try {
    localStorage.setItem(keyFor(projectPath), JSON.stringify(editor));
  } catch {
    /* quota / serialization failures are non-fatal — the draft just won't survive reload */
  }
}

export function clearWorkflowDraft(projectPath: string): void {
  if (!projectPath) return;
  try {
    localStorage.removeItem(keyFor(projectPath));
  } catch {
    /* ignore */
  }
}
