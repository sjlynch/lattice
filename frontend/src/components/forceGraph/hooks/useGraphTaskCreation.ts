import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTask, type GraphNode, type ScanResult } from '../../../api';
import { useGitSetup } from '../../gitSetup/GitSetupProvider';
import { useStructuralScan } from '../../../hooks/useStructuralScan';
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
  const { ensureGitRepo } = useGitSetup();

  // Auto-dismiss toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Files actually selected (filter out anything no longer in the dataset).
  // Keyed off the structural ref, not live `data`: only `id`/`path` are read,
  // and `data` gets a fresh reference on every metric-only HealthUpdate (one
  // per file save) — which rebuilt this O(N) map per save while a selection
  // existed. The structural ref only changes when files are added/removed.
  const structuralData = useStructuralScan(data);
  const selectedFiles = useMemo(() => {
    if (!structuralData || selected.size === 0) return [] as GraphNode[];
    const byId = new Map(structuralData.nodes.map((n) => [n.id, n]));
    const out: GraphNode[] = [];
    for (const id of selected) {
      const n = byId.get(id);
      if (n) out.push(n);
    }
    return out;
  }, [structuralData, selected]);

  const openMenuItem = useCallback(
    (item: MenuItemDef) => {
      closeContextMenu();
      setPromptText(item.prefill);
      setModalAction(item);
    },
    [closeContextMenu],
  );

  const submitTask = useCallback(async () => {
    if (!modalAction || !activeFolder || !data) return;
    const trimmed = promptText.trim();
    if (!trimmed) return;
    const titleSnippet = trimmed.replace(/\s+/g, ' ').slice(0, 60);
    const title = `${modalAction.verb}: ${titleSnippet}`;
    const root = data.root;
    const fileLines = selectedFiles
      .map((n) => `- ${relPath(n.path, root)}`)
      .join('\n');
    const description = `${trimmed}\n\n## Files\n${fileLines}`;
    // A task only ever runs in a git worktree, so createTask 400s in a non-repo
    // project. Offer setup first, then carry on with the create the user was
    // already making — this modal holds typed prose and a file selection that
    // would be tedious to rebuild. Guarding before `setSubmitting` keeps the
    // modal interactive if they cancel the dialog.
    if (!(await ensureGitRepo(activeFolder))) return;
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
  }, [
    modalAction,
    promptText,
    activeFolder,
    data,
    selectedFiles,
    setSelected,
    ensureGitRepo,
  ]);

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
