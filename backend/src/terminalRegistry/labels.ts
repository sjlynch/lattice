// Tab-label helpers. `shortLabel` is shared with the frontend
// (`taskboard/lanes.ts`) so a backend-minted record carries the same label the
// UI would have generated — a restored tab reads identically to the original.
import { shortLabel } from '../shared/terminalLabels.js';

export { shortLabel };

export function taskTerminalLabel(title: string): string {
  return shortLabel(title);
}

export function mergeTerminalLabel(title: string | undefined, taskId: string): string {
  return title ? `merge:${shortLabel(title)}` : `merge:${taskId.slice(-6)}`;
}
