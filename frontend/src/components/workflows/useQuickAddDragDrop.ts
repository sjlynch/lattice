import { useEffect, useState, type DragEvent } from 'react';
import type { WorkflowStepKind } from '../../api';
import { usePanelWindow } from '../../hooks/usePanelDocument';

// Separate from the row-reorder MIME: dropping a chip copies a new step.
export const QUICK_ADD_DRAG_MIME = 'application/x-lattice-workflow-quick-add';

export type QuickAddDragItem =
  | { kind: 'control'; stepKind: Exclude<WorkflowStepKind, 'agent'> }
  | { kind: 'prompt'; promptId: string };

export function startQuickAddDrag(event: DragEvent<HTMLElement>, item: QuickAddDragItem) {
  event.dataTransfer.setData(QUICK_ADD_DRAG_MIME, JSON.stringify(item));
  event.dataTransfer.effectAllowed = 'copy';
}

function readQuickAddDrag(data: string): QuickAddDragItem | null {
  try {
    const item = JSON.parse(data);
    if (item?.kind === 'prompt' && typeof item.promptId === 'string') return item;
    if (item?.kind === 'control' && ['start', 'merge', 'test', 'push'].includes(item.stepKind)) return item;
  } catch { /* Unrelated or malformed drops never add steps. */ }
  return null;
}

// Row midpoints also cover the gaps between cards, the empty list and the
// append area. Recompute on drop so scrolling or a last pointer move cannot
// leave the insertion at a stale hover position.
function insertionIndex(event: DragEvent<HTMLDivElement>): number {
  const slots = event.currentTarget.querySelectorAll('.workflows-step-slot');
  for (let index = 0; index < slots.length; index++) {
    const row = slots[index].querySelector('.workflows-step')!;
    const rect = row.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) return index;
  }
  return slots.length;
}

export function useQuickAddDragDrop(onInsert: (item: QuickAddDragItem, index: number) => void) {
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // A popped-out Workflows panel's drags end in the pop-out's window.
  const win = usePanelWindow();

  useEffect(() => {
    const clear = () => setDropIndex(null);
    win.addEventListener('dragend', clear);
    win.addEventListener('drop', clear);
    return () => {
      win.removeEventListener('dragend', clear);
      win.removeEventListener('drop', clear);
    };
  }, [win]);

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(QUICK_ADD_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropIndex(insertionIndex(event));
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    // Not `instanceof Node`: a pop-out's nodes come from the pop-out's realm.
    const related = event.relatedTarget as Node | null;
    if (related && typeof related === 'object' && 'nodeType' in related && event.currentTarget.contains(related)) return;
    setDropIndex(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(QUICK_ADD_DRAG_MIME)) return;
    event.preventDefault();
    setDropIndex(null);
    const item = readQuickAddDrag(event.dataTransfer.getData(QUICK_ADD_DRAG_MIME));
    if (item) onInsert(item, insertionIndex(event));
  }

  return { dropIndex, onDragOver, onDragLeave, onDrop };
}
