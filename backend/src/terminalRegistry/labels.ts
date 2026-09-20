// Tab-label helpers mirrored from the frontend's `taskboard/lanes.ts`
// `shortLabel`, so a backend-minted record carries the same label the UI would
// have generated — a restored tab reads identically to the original.

export function shortLabel(title: string): string {
  const t = title.trim();
  return t.length > 18 ? t.slice(0, 17) + '…' : t;
}

export function taskTerminalLabel(title: string): string {
  return shortLabel(title);
}

export function mergeTerminalLabel(title: string | undefined, taskId: string): string {
  return title ? `merge:${shortLabel(title)}` : `merge:${taskId.slice(-6)}`;
}
