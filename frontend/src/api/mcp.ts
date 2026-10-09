// MCP control-plane bindings. Backend: src/routes/mcp.ts + src/mcp/*.
// Raw secret values never cross this boundary — the secrets endpoints return
// presence booleans + last-4 hints only.

import { patchJson, postJson } from './http';
import type { McpServerEntry } from '../../../backend/src/shared/wireTypes';

// The backend's own server-entry types (backend/src/mcp/types.ts, re-exported
// through backend/src/shared/wireTypes.ts). The MCP tab's switches read
// `overrides[id] ?? !!defaultEnabled` — `defaultEnabled` is first-party only.
export type {
  McpHarnessSupport,
  McpRuntime,
  McpSecretRequirement,
  McpServerEntry,
} from '../../../backend/src/shared/wireTypes';

// { [serverId]: { [envVar]: present } } — presence/hints only, never the value.
export type RedactedMcpSecrets = Record<string, Record<string, boolean>>;
export type McpSecretHints = Record<string, Record<string, string>>;
export type McpEnvPresence = Record<string, Record<string, boolean>>;

export type McpValidationResult = { ok: boolean; error?: string };

export type ImportedSecretVar = { envVar: string; stored: boolean };
export type ImportedServerInfo = {
  id: string;
  label: string;
  source: string;
  transport: 'stdio' | 'http';
  summary: string;
  secretVars: ImportedSecretVar[];
  collides: boolean;
  // Secrets found in the url/args (descriptions only; `summary` is redacted).
  // Non-empty → the backend refuses to import the server.
  embeddedSecrets?: string[];
};
export type ImportScanResult = { servers: ImportedServerInfo[] };
export type ImportApplyResult = {
  imported: string[];
  skipped: string[];
  refused?: Array<{ id: string; reason: string }>;
};

export async function fetchMcpCatalog(): Promise<{ servers: McpServerEntry[] }> {
  try {
    const r = await fetch('/api/mcp-catalog');
    if (!r.ok) return { servers: [] };
    return r.json();
  } catch {
    return { servers: [] };
  }
}

export async function fetchMcpSecrets(): Promise<{
  redacted: RedactedMcpSecrets;
  hints: McpSecretHints;
}> {
  try {
    const r = await fetch('/api/mcp-secrets');
    if (!r.ok) return { redacted: {}, hints: {} };
    return r.json();
  } catch {
    return { redacted: {}, hints: {} };
  }
}

export async function setMcpSecret(
  serverId: string,
  envVar: string,
  value: string | null,
): Promise<{ redacted: RedactedMcpSecrets }> {
  return patchJson<{ redacted: RedactedMcpSecrets }>('/api/mcp-secrets', {
    serverId,
    envVar,
    value,
  });
}

export async function fetchMcpEnvPresence(): Promise<{ presence: McpEnvPresence }> {
  try {
    const r = await fetch('/api/mcp-env-presence');
    if (!r.ok) return { presence: {} };
    return r.json();
  } catch {
    return { presence: {} };
  }
}

export async function validateMcpServer(serverId: string): Promise<McpValidationResult> {
  return postJson<McpValidationResult>('/api/mcp/validate', { serverId });
}

export async function scanMcpImport(project?: string): Promise<ImportScanResult> {
  try {
    const q = project ? `?project=${encodeURIComponent(project)}` : '';
    const r = await fetch(`/api/mcp-import/scan${q}`);
    if (!r.ok) return { servers: [] };
    return r.json();
  } catch {
    return { servers: [] };
  }
}

export async function applyMcpImport(
  ids: string[],
  project?: string,
): Promise<ImportApplyResult> {
  return postJson<ImportApplyResult>('/api/mcp-import', { ids, project });
}
