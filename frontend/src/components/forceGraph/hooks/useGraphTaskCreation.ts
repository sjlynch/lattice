import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTask, type GraphNode, type ScanResult } from '../../../api';
import { relPath, type MenuItemDef } from '../menu';

type Args = {
  data: ScanResult | null;
  activeFolder: string;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  closeContextMenu: () => void;
};

// Owns the "create task from selection" flow: modal action + prompt
// state, derived list of selected file nodes, plus the toast that
// reports submission outcome. Returns plain values + actions so
// ForceGraphView can hand them straight to GraphTaskModal without
// recomputing anything.
export function useGraphTaskCreation({
  data,
  activeFolder,
  selected,
  setSelected,
  closeContextMenu,
}: Args) {
  const [modalAction, setModalAction] = useState<MenuItemDef | null>(null);
  const [promptText, setPromptText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Auto-dismiss toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Files actually selected (filter out anything no longer in the dataset).
  const selectedFiles = useMemo(() => {
    if (!data || selected.size === 0) return [] as GraphNode[];
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const out: GraphNode[] = [];
    for (const id of selected) {
      const n = byId.get(id);
      if (n) out.push(n);
    }
    return out;
  }, [data, selected]);

  const openMenuItem = useCallback(
    (item: MenuItemDef) => {
      closeContextMenu();
      setPromptText(item.prefill);
      setModalAction(item);
    },
    [closeContextMenu],
  );

  const submitTask = useCallback(async () => {
    if (!modalAction || !activeFolder) return;
    const trimmed = promptText.trim();
    if (!trimmed) return;
    const titleSnippet = trimmed.replace(/\s+/g, ' ').slice(0, 60);
    const title = `${modalAction.verb}: ${titleSnippet}`;
    const root = data?.root || activeFolder;
    const fileLines = selectedFiles
      .map((n) => `- ${relPath(n.path, root)}`)
      .join('\n');
    const description = `${trimmed}\n\n## Files\n${fileLines}`;
    setSubmitting(true);
    try {
      await createTask(activeFolder, title, description);
      setToast('Task created — open the board to run it');
      setSelected(new Set());
      setModalAction(null);
      setPromptText('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast(`Failed to create task: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }, [modalAction, promptText, activeFolder, data, selectedFiles, setSelected]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setModalAction(null);
    setPromptText('');
  }, [submitting]);

  return {
    modalAction,
    promptText,
    setPromptText,
    submitting,
    toast,
    selectedFiles,
    openMenuItem,
    submitTask,
    closeModal,
  };
}
