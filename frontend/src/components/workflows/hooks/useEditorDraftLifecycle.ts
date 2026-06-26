import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Workflow } from '../../../api';
import { emptyEditor, fromWorkflow, type EditorState } from '../editorState';
import {
  loadWorkflowDraft,
  saveWorkflowDraft,
} from '../workflowDraftStorage';
import { draftForFolder, reconcileDraftPersist } from '../workflowDraftPersist';

type Args = {
  editor: EditorState;
  setEditor: Dispatch<SetStateAction<EditorState>>;
  workflows: Workflow[];
  activeFolder: string;
};

// The editor's draft lifecycle, split out of useWorkflowEditor: keeping the
// loaded workflow reconciled against the live list, restoring/persisting the
// per-project never-saved draft, and the cross-project-switch guards that keep
// one project's draft from leaking onto another's storage key. Pure side-effect
// wiring — it owns no returned state.
export function useEditorDraftLifecycle({
  editor,
  setEditor,
  workflows,
  activeFolder,
}: Args): void {
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
  }, [workflows, editor.workflowId, editor.dirty, setEditor]);

  // Load the active project's own never-saved draft. Runs once per project
  // (restoredFor guard) so a reload/close while mid-edit on a brand-new workflow
  // doesn't lose it. It ALSO fires on a project switch: WorkflowsLauncher takes
  // activeFolder as a prop, so the editor isn't remounted and still holds the
  // PREVIOUS project's never-saved draft. That draft belongs to the project it
  // was authored in (the persist effect below flushes it back there), so we
  // replace it with THIS project's stored draft rather than carrying it across —
  // otherwise the new project would show, and persist, the old project's draft.
  // A loaded (saved) workflow is reconciled by the sync effect above, so it's
  // left untouched (see draftForFolder).
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFolder || restoredFor.current === activeFolder) return;
    restoredFor.current = activeFolder;
    setEditor((cur) => draftForFolder(cur, loadWorkflowDraft(activeFolder)));
  }, [activeFolder, setEditor]);

  // Debounced persist of the in-progress draft. Only never-saved drafts with
  // content are stashed (a saved workflow is reloaded from the server, and an
  // empty draft is noise); see workflowDraftStorage. The reconcile guard keeps a
  // draft carried across a project switch from being stamped onto the new
  // project's key — it's flushed back under the project it was authored in
  // instead (see workflowDraftPersist).
  const lastPersistFolder = useRef<string | null>(null);
  const lastPersistEditor = useRef<EditorState | null>(null);
  useEffect(() => {
    const { decision, nextFolder, nextEditor } = reconcileDraftPersist(
      activeFolder,
      editor,
      lastPersistFolder.current,
      lastPersistEditor.current,
    );
    lastPersistFolder.current = nextFolder;
    lastPersistEditor.current = nextEditor;
    if (decision.kind === 'idle') return;
    if (decision.kind === 'flush') {
      saveWorkflowDraft(decision.folder, editor);
      return;
    }
    const t = setTimeout(() => saveWorkflowDraft(decision.folder, editor), 500);
    return () => clearTimeout(t);
  }, [activeFolder, editor]);
}
