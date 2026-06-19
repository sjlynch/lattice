// "Import from existing tools": scan the user's OTHER agent configs for MCP
// servers already set up, normalize them into Lattice's catalog shape, and pull
// in their keys — so anyone already on MCP re-enters nothing.
//
// This file is the thin orchestrator (scan/apply + dedupe). The concerns it
// composes live in ./import/:
//   - import/normalize.ts — `normalizeServer` + secret classification (`Normalized`/`RawServer`)
//   - import/codexToml.ts — the minimal Codex `[mcp_servers.*]` TOML reader
//   - import/sources.ts   — the five per-tool `collect*` config readers
//
// Secret handling (MCP plan §8) lives in import/normalize.ts: a LITERAL value in
// env (whose var name looks secret) is stored in ~/.lattice/mcpSecrets.json and
// kept out of the entry; a REFERENCE (`${input:…}`, `${env:…}`, Codex
// `bearer_token_env_var`) is recorded as a secret env var with NO stored value.

import { mergeMcpSecrets, type McpSecrets } from './secrets.js';
import { getGlobalSettings, updateGlobalSettings } from '../globalSettings.js';
import { BUILTIN_MCP_SERVERS, type McpServerEntry } from './catalog.js';
import { type Normalized } from './import/normalize.js';
import {
  collectClaude,
  collectCursor,
  collectCodex,
  collectVsCode,
  collectWindsurf,
} from './import/sources.js';

// Re-export the public surface so no caller import path changes. `normalizeServer`
// and `parseCodexMcpServers` are also test-pinned via this path (mcp.test.ts).
export { normalizeServer, type Normalized, type RawServer } from './import/normalize.js';
export { parseCodexMcpServers } from './import/codexToml.js';

const BUILTIN_IDS = new Set(BUILTIN_MCP_SERVERS.map((s) => s.id));

// ---- public types (browser-facing scan is redacted: no secret values) -------

export type ImportedSecretVar = { envVar: string; stored: boolean };

export type ImportedServerInfo = {
  id: string;
  label: string;
  source: string;
  transport: 'stdio' | 'http';
  summary: string; // e.g. "npx -y @scope/pkg" or the URL
  secretVars: ImportedSecretVar[];
  collides: boolean; // id already a built-in / existing custom — would be skipped
};

export type ImportScanResult = { servers: ImportedServerInfo[] };

export type ImportApplyResult = {
  imported: string[];
  skipped: string[];
};

// ---- scan + apply -----------------------------------------------------------

// Dedupe by id, first source wins. Tags whether an id collides with a built-in
// or an already-imported custom server (those would be skipped on apply).
async function collectAll(projectPath?: string): Promise<Normalized[]> {
  const groups = await Promise.all([
    collectClaude(projectPath),
    collectCursor(projectPath),
    collectCodex(),
    collectVsCode(projectPath),
    collectWindsurf(),
  ]);
  const seen = new Set<string>();
  const out: Normalized[] = [];
  for (const n of groups.flat()) {
    if (seen.has(n.entry.id)) continue;
    seen.add(n.entry.id);
    out.push(n);
  }
  return out;
}

export async function scanImportableServers(projectPath?: string): Promise<ImportScanResult> {
  const [normalized, global] = await Promise.all([
    collectAll(projectPath),
    getGlobalSettings(),
  ]);
  const existingCustom = new Set((global.mcpCustomServers ?? []).map((s) => s.id));

  const servers: ImportedServerInfo[] = normalized.map((n) => {
    const secretVars: ImportedSecretVar[] = (n.entry.secretEnvVars ?? []).map((envVar) => ({
      envVar,
      stored: envVar in n.secrets,
    }));
    return {
      id: n.entry.id,
      label: n.entry.label,
      source: n.source,
      transport: n.entry.transport,
      summary:
        n.entry.transport === 'http'
          ? n.entry.url ?? ''
          : [n.entry.command, ...(n.entry.args ?? [])].join(' ').trim(),
      secretVars,
      collides: BUILTIN_IDS.has(n.entry.id) || existingCustom.has(n.entry.id),
    };
  });
  return { servers };
}

export async function applyImport(
  selectedIds: string[],
  projectPath?: string,
): Promise<ImportApplyResult> {
  const selected = new Set(selectedIds);
  const [normalized, global] = await Promise.all([
    collectAll(projectPath),
    getGlobalSettings(),
  ]);
  const existing = global.mcpCustomServers ?? [];
  const existingIds = new Set(existing.map((s) => s.id));

  const toAdd: McpServerEntry[] = [];
  const secrets: McpSecrets = {};
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const n of normalized) {
    if (!selected.has(n.entry.id)) continue;
    if (BUILTIN_IDS.has(n.entry.id) || existingIds.has(n.entry.id)) {
      skipped.push(n.entry.id);
      continue;
    }
    toAdd.push(n.entry);
    existingIds.add(n.entry.id);
    if (Object.keys(n.secrets).length > 0) secrets[n.entry.id] = n.secrets;
    imported.push(n.entry.id);
  }

  if (toAdd.length > 0) {
    await updateGlobalSettings({ mcpCustomServers: [...existing, ...toAdd] });
  }
  if (Object.keys(secrets).length > 0) {
    await mergeMcpSecrets(secrets);
  }

  return { imported, skipped };
}
