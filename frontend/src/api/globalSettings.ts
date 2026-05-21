// Machine-global settings (not per-project). Backend: src/globalSettings.ts.

import { asJson } from './http';

export type GlobalSettings = {
  // Max agents Lattice runs concurrently — the spawn queue's softCap.
  maxConcurrentAgents: number;
};

export async function fetchGlobalSettings(): Promise<GlobalSettings> {
  return asJson<GlobalSettings>(await fetch('/api/global-settings'));
}

export async function patchGlobalSettings(
  patch: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  return asJson<GlobalSettings>(
    await fetch('/api/global-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}
