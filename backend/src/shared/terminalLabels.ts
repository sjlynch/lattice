// Terminal-tab label shortening, shared so a backend-minted registry record
// (terminalRegistry/labels.ts) reads exactly like the tab the UI would have
// labelled itself (taskboard/lanes.ts) — a restored tab looks unchanged.
export function shortLabel(title: string): string {
  const t = title.trim();
  return t.length > 18 ? t.slice(0, 17) + '…' : t;
}
