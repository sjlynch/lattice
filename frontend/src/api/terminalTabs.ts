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

// `retry` (the explicit "Restore tabs" click) also retries tabs whose earlier
// relaunch failed or whose cwd was missing; the on-open pass leaves those alone.
export async function restoreTerminalTabs(
  project: string,
  opts: { retry?: boolean } = {},
): Promise<RestoreSummary> {
  const retry = opts.retry ? '&retry=1' : '';
  return postJson<RestoreSummary>(
    `/api/terminal-tabs/restore?project=${encodeURIComponent(project)}${retry}`,
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

// Keep the existing void command contract; callers owning tab state can
// observe confirmation/failure without putting IO in a React updater.
export function closeTerminalTab(
  project: string,
  id: string,
  callbacks?: { onClosed: () => void; onError: (error: unknown) => void },
): void {
  const request = async () => {
    const res = await fetch(
      `/api/terminal-tabs/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`,
      { method: 'DELETE' },
    );
    // A retry after a lost successful response may find the tab already gone.
    if (res.status === 404) return;
    const result = await asJson<{ ok: boolean }>(res);
    if (result.ok !== true) throw new Error('Terminal close could not be confirmed. Retry closing this tab.');
  };
  void request().then(
    () => callbacks?.onClosed(),
    (error: unknown) => {
      if (callbacks) callbacks.onError(error);
      else console.warn('[lattice] terminal close failed:', error);
    },
  );
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
