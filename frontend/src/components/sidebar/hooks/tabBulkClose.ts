// Pure target computation for the tab context menu's bulk closes (React-free so
// it is unit-testable; `useTabContextMenu` is the wiring).
export type BulkCloseSide = 'left' | 'right' | 'others';

// The ids to close for "close tabs to the left / right / others" relative to
// `termId`, in the currently visible order. `null` when `termId` is no longer
// visible — the menu can outlive its tab (the pty exited and the tab was
// removed, or a search filter hid it), and `findIndex` → -1 used to make
// "to the right" slice(0) EVERY tab and "to the left" all but the last.
export function bulkCloseTargets(
  visibleIds: readonly string[],
  termId: string,
  side: BulkCloseSide,
): string[] | null {
  const idx = visibleIds.indexOf(termId);
  if (idx === -1) return null;
  if (side === 'left') return visibleIds.slice(0, idx);
  if (side === 'right') return visibleIds.slice(idx + 1);
  return visibleIds.filter((id) => id !== termId);
}
