import { useLayoutEffect, useState, type DragEvent, type RefObject } from 'react';

export const STEP_DRAG_MIME = 'application/x-lattice-workflow-step';

// Minimum textarea height when expanded — keeps a freshly-added step from
// rendering as a 1-line strip before the user types anything.
export const PROMPT_MIN_HEIGHT_PX = 64;

export function useWorkflowStepDragDrop(
  index: number,
  onReorder: (fromIdx: number, toIdx: number) => void,
) {
  const [dragOver, setDragOver] = useState<'top' | 'bottom' | null>(null);

  function onDragStart(e: DragEvent<HTMLElement>) {
    e.dataTransfer.setData(STEP_DRAG_MIME, String(index));
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (!e.dataTransfer.types.includes(STEP_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const half = rect.top + rect.height / 2;
    setDragOver(e.clientY < half ? 'top' : 'bottom');
  }

  function onDragLeave() {
    setDragOver(null);
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    const fromStr = e.dataTransfer.getData(STEP_DRAG_MIME);
    setDragOver(null);
    if (!fromStr) return;
    e.preventDefault();
    const fromIdx = Number(fromStr);
    if (Number.isNaN(fromIdx)) return;
    const toIdx = dragOver === 'bottom' ? index + 1 : index;
    onReorder(fromIdx, toIdx);
  }

  return { dragOver, onDragStart, onDragOver, onDragLeave, onDrop };
}

export function useAutosizedTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  disabled: boolean,
): void {
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta || disabled) return;
    ta.style.height = 'auto';
    const next = Math.max(PROMPT_MIN_HEIGHT_PX, ta.scrollHeight);
    ta.style.height = `${next}px`;
  }, [ref, value, disabled]);
}
