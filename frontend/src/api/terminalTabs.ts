// The durable terminal-tab registry (`/api/terminal-tabs`, `/ws/terminal-tabs`).
// Records are CREATED by the backend at pty creation; the frontend reads them
// to rebuild the sidebar, asks for a restore on project open, and patches
// decorations (label, order) per record.

import { asJson, patchJson, postJson } from './http';
import type { RestoreSummary, TerminalRecord, TerminalTabsEvent } from './types';
import { subscribeWs } from './ws';

export async function fetchTerminalTabs(project: string): Promise<TerminalRecord[]> {
  const r = await fetch(`/api/terminal-tabs?project=${encodeURIComponent(project)}`);
  const data = await asJson<{ tabs: TerminalRecord[] }>(r);
  return Array.isArray(data.tabs) ? data.tabs : [];
}

export async function restoreTerminalTabs(project: string): Promise<RestoreSummary> {
  return postJson<RestoreSummary>(
    `/api/terminal-tabs/restore?project=${encodeURIComponent(project)}`,
  );
}

export async function patchTerminalTabLabel(
  project: string,
  id: string,
  label: string,
): Promise<void> {
  await patchJson(
    `/api/terminal-tabs/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`,
    { label },
  );
}

export async function patchTerminalTabOrder(project: string, order: string[]): Promise<void> {
  await patchJson(`/api/terminal-tabs?project=${encodeURIComponent(project)}`, { order });
}

// Close a registered tab: the backend ends the record (so restore never
// resurrects it) and kills its pty if one is alive. Fire-and-forget like
// `deleteBackendSession`; kept out of any setState updater.
export function closeTerminalTab(project: string, id: string): void {
  void fetch(
    `/api/terminal-tabs/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`,
    { method: 'DELETE' },
  ).catch(() => {
    /* ignore */
  });
}

export function subscribeTerminalTabs(
  project: string,
  onEvent: (event: TerminalTabsEvent) => void,
): () => void {
  return subscribeWs<TerminalTabsEvent>(
    `/ws/terminal-tabs?project=${encodeURIComponent(project)}`,
    (msg) => {
      if (msg && typeof msg === 'object' && typeof msg.type === 'string') onEvent(msg);
    },
  );
}
