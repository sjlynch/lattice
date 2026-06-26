// Machine-global settings (not per-project). Backend: src/globalSettings.ts.

import { asJson, patchJson } from './http';
import type { McpServerEntry } from './mcp';

export type PiProviderModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

// A Lattice-managed Pi provider (OpenAI-compatible endpoint, e.g. vLLM).
// Reconciled into ~/.pi/agent/models.json on save. See backend piModels.ts.
export type PiProvider = {
  id: string;
  baseUrl: string;
  api?: string;
  apiKey?: string; // literal | env-var name | "!command" (Pi resolves)
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: PiProviderModel[];
};

export type GlobalSettings = {
  // Max agents Lattice runs concurrently — the spawn queue's softCap.
  maxConcurrentAgents: number;
  // User-added MCP servers (built-ins live in backend code). Definitions only —
  // secret VALUES live in ~/.lattice/mcpSecrets.json, never here.
  mcpCustomServers?: McpServerEntry[];
  // Per-id partial overrides of built-in catalog entries.
  mcpBuiltinOverrides?: Record<string, Partial<McpServerEntry>>;
  // Curated Pi model menu — `provider/model` patterns shown as "Pi — X" rows
  // in the harness dropdowns. Empty/absent → the default menu. See backend
  // piModels.ts.
  piModelMenu?: string[];
  // Lattice-managed Pi providers, reconciled into ~/.pi/agent/models.json.
  piProviders?: PiProvider[];
};

export async function fetchGlobalSettings(): Promise<GlobalSettings> {
  return asJson<GlobalSettings>(await fetch('/api/global-settings'));
}

export async function patchGlobalSettings(
  patch: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  return patchJson<GlobalSettings>('/api/global-settings', patch);
}
