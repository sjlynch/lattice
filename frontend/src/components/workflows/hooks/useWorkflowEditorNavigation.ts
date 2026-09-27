import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { Workflow } from '../../../api';
import type { WorkflowTemplate } from '../../../workflowTemplates';
import { useConfirm } from '../../shared/ConfirmDialog';
import { fromWorkflow, type EditorState } from '../editorState';
import { guardUnsavedSwitch } from '../unsavedSwitch';

type EditorNavigationSlice = {
  identity: EditorState['identity'];
  getEditor: () => EditorState;
  isCurrentEditor: (identity: EditorState['identity']) => boolean;
  save: () => Promise<Workflow | null>;
  discardEdits: () => void;
  setEditor: Dispatch<SetStateAction<EditorState>>;
  newBlank: () => void;
  newFromTemplate: (template: WorkflowTemplate) => Promise<void>;
};

// Replacing the editor (picking another saved workflow, starting a blank
// one) discards whatever is in it, so with unsaved edits ask Save / Discard /
// Cancel first — the same guard the panel-close path applies.
export function useWorkflowEditorNavigation({
  identity, getEditor, isCurrentEditor, save, discardEdits, setEditor,
  newBlank: newBlankEditor, newFromTemplate: newTemplateEditor,
}: EditorNavigationSlice) {
  const { confirmUnsaved } = useConfirm();
  const guardUnsaved = useCallback(
    async (replace: () => void | Promise<void>) => {
      const isCurrent = () => isCurrentEditor(identity);
      let discard = false;
      const allowed = await guardUnsavedSwitch({
        dirty: getEditor().dirty,
        isCurrent,
        confirmUnsaved: () =>
          confirmUnsaved({ message: 'You have unsaved changes to this workflow.' }),
        save,
        // Discard and replacement happen together after the final scope check.
        discardEdits: () => { discard = true; },
      });
      if (!allowed || !isCurrent()) return;
      // A save may succeed while leaving edits typed during the request dirty.
      if (!discard && getEditor().dirty) return;
      if (discard) discardEdits();
      await replace();
    },
    [identity, confirmUnsaved, save, discardEdits, getEditor, isCurrentEditor],
  );

  const selectWorkflow = useCallback(async (wf: Workflow) => {
    // Re-selecting the workflow already being edited is a no-op for its edits.
    if (getEditor().workflowId === wf.id) return;
    await guardUnsaved(() => setEditor(fromWorkflow(wf)));
  }, [getEditor, guardUnsaved, setEditor]);

  const newBlank = useCallback(async () => {
    await guardUnsaved(newBlankEditor);
  }, [guardUnsaved, newBlankEditor]);

  const newFromTemplate = useCallback(async (template: WorkflowTemplate) => {
    await guardUnsaved(() => newTemplateEditor(template));
  }, [guardUnsaved, newTemplateEditor]);

  return { selectWorkflow, newBlank, newFromTemplate };
}
