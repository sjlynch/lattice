// Machine-global settings (not per-project). Backend: src/globalSettings.ts.

import { asJson } from './http';
import type { McpServerEntry } from './mcp';

export type GlobalSettings = {
  // Max agents Lattice runs concurrently — the spawn queue's softCap.
  maxConcurrentAgents: number;
  // User-added MCP servers (built-ins live in backend code). Definitions only —
  // secret VALUES live in ~/.lattice/mcpSecrets.json, never here.
  mcpCustomServers?: McpServerEntry[];
  // Per-id partial overrides of built-in catalog entries.
  mcpBuiltinOverrides?: Record<string, Partial<McpServerEntry>>;
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
