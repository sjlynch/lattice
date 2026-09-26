import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Workflow } from '../../../api';
import { emptyEditor, fromWorkflow, type EditorState } from '../editorState';
import { loadWorkflowDraft, saveWorkflowDraft } from '../workflowDraftStorage';
import { draftForFolder, reconcileDraftPersist } from '../workflowDraftPersist';

type Args = {
  editor: EditorState;
  setEditor: Dispatch<SetStateAction<EditorState>>;
  workflows: Workflow[];
  activeFolder: string;
};

// Restore before paint; the persist effect still sees the outgoing render's
// editor and flushes it under its original project before persisting the new one.
export function useEditorDraftLifecycle({ editor, setEditor, workflows, activeFolder }: Args): void {
  const restoredFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (restoredFor.current === activeFolder) return;
    restoredFor.current = activeFolder;
    setEditor((cur) => draftForFolder(cur, loadWorkflowDraft(activeFolder)));
  }, [activeFolder, setEditor]);

  // Only a workflow seen in THIS project's list can be considered deleted.
  // A create response can arrive before its first list/WS entry.
  const seen = useRef({ folder: activeFolder, ids: new Set<string>() });
  useEffect(() => {
    if (seen.current.folder !== activeFolder) {
      seen.current = { folder: activeFolder, ids: new Set<string>() };
    }
    for (const w of workflows) seen.current.ids.add(w.id);
    if (!editor.workflowId) return;
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (!fresh && !seen.current.ids.has(editor.workflowId)) return;
    setEditor((cur) => {
      // A layout restore or another replacement may already have retired the
      // editor this passive effect was rendered for.
      if (cur.identity !== editor.identity) return cur;
      if (!fresh) return emptyEditor();
      return cur.dirty ? cur : fromWorkflow(fresh, cur.identity);
    });
  }, [activeFolder, workflows, editor.workflowId, editor.dirty, editor.identity, setEditor]);

  // A carried-over draft is flushed to its original folder; genuine edits are
  // debounced. Identity is in-memory only and is renewed when a draft restores.
  const lastPersistFolder = useRef<string | null>(null);
  const lastPersistEditor = useRef<EditorState | null>(null);
  useEffect(() => {
    const { decision, nextFolder, nextEditor } = reconcileDraftPersist(
      activeFolder, editor, lastPersistFolder.current, lastPersistEditor.current,
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
