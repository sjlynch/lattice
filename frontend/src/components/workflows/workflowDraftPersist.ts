// Pure decision helpers for the workflow-editor draft lifecycle, factored out of
// useWorkflowEditor so the project-switch guard is unit-testable without a React
// renderer (mirrors hooks/hiddenExtsPersist.ts).
//
// The bug these guard against: WorkflowsLauncher takes `activeFolder` as a prop
// (not a key), so it does NOT remount on a project switch — the editor (and any
// never-saved draft) is retained. Two effects then misbehave:
//   - the debounced persist effect re-runs with the NEW folder but the SAME
//     draft object that was authored under the OLD folder, and would stamp the
//     previous project's draft onto the new project's localStorage key; and
//   - the restore effect, seeing the editor already has content, would keep the
//     carried-over draft instead of loading the new project's own stored draft.

import { emptyEditor, type EditorState } from './editorState';

export type DraftPersistDecision =
  | { kind: 'idle' } // nothing persistable in the editor
  | { kind: 'persist'; folder: string } // debounce-save the current draft under `folder`
  | { kind: 'flush'; folder: string }; // carried across a switch: save under the OLD folder now

// Decide what the debounced persist effect should do for the (folder, editor)
// pair it currently sees, given the (folder, editor) it last reconciled.
//
// A genuine edit always mints a new editor object, so when the SAME editor
// object reappears under a DIFFERENT folder we know it rode along a project
// switch. Rather than write it under the new folder's key, we flush it under the
// folder it was authored in (immediately — a debounced flush would be cleared by
// the next render's cleanup once the restore effect swaps in the new project's
// draft), so a switch within the 500ms debounce window doesn't lose it.
export function reconcileDraftPersist(
  activeFolder: string,
  editor: EditorState,
  lastFolder: string | null,
  lastEditor: EditorState | null,
): {
  decision: DraftPersistDecision;
  nextFolder: string | null;
  nextEditor: EditorState;
} {
  const persistable =
    !!activeFolder &&
    editor.dirty &&
    editor.workflowId === null &&
    (editor.steps.length > 0 || editor.name.trim() !== '');
  const nextFolder = activeFolder || null;
  if (!persistable) {
    return { decision: { kind: 'idle' }, nextFolder, nextEditor: editor };
  }
  if (lastEditor === editor && lastFolder && lastFolder !== activeFolder) {
    return {
      decision: { kind: 'flush', folder: lastFolder },
      nextFolder,
      nextEditor: editor,
    };
  }
  return {
    decision: { kind: 'persist', folder: activeFolder },
    nextFolder,
    nextEditor: editor,
  };
}

// Decide the editor state to show for a project, given the editor currently held
// and that project's stored draft. The restore effect only runs on a genuine
// project change, so a never-saved draft held now was authored under the project
// we're leaving — replace it with this project's own draft (or an empty editor)
// rather than carrying it across. A loaded (saved) workflow is reconciled by the
// sync effect, so leave it untouched.
export function draftForFolder(
  current: EditorState,
  stored: EditorState | null,
): EditorState {
  if (current.workflowId !== null) return current;
  return stored ?? emptyEditor();
}
