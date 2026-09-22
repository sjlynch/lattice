import type { UnsavedChoice } from '../shared/ConfirmDialog';

export type UnsavedSwitchDeps = {
  // Whether the editor currently holds unsaved edits.
  dirty: boolean;
  // Ask Save / Discard / Cancel (the shared ConfirmDialog flow).
  confirmUnsaved: () => Promise<UnsavedChoice>;
  // Persist the editor; resolves null when the save failed (error already toasted).
  save: () => Promise<unknown | null>;
  // Drop the unsaved edits (reload the saved copy / clear the draft).
  discardEdits: () => void;
};

// Gate for any action that would REPLACE the editor's contents (select another
// saved workflow, start a blank one). Mirrors the panel-close guard in
// `WorkflowsLauncher`: with unsaved edits, ask first — Save then proceed,
// Discard then proceed, Cancel leaves the editor exactly as it was. Resolves
// true when the caller may go ahead and replace the editor.
export async function guardUnsavedSwitch(deps: UnsavedSwitchDeps): Promise<boolean> {
  if (!deps.dirty) return true;
  const choice = await deps.confirmUnsaved();
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    // A failed save keeps the editor (the error toast is already showing).
    return (await deps.save()) !== null;
  }
  deps.discardEdits();
  return true;
}
