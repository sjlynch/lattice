import { useEffect, useState } from 'react';
import type { GraphNode } from '../../../api';
import type { MenuItemDef } from '../menu';

// Local UI state for graph overlays and dialogs. Keeping these together makes
// ForceGraphView's body read as graph setup first and JSX rendering last,
// rather than interleaving several unrelated useState calls with graph wiring.
export function useGraphOverlayState() {
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
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

  return {
    hoverNode,
    setHoverNode,
    modalAction,
    setModalAction,
    promptText,
    setPromptText,
    submitting,
    setSubmitting,
    toast,
    setToast,
  };
}
