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
// A secret embedded in a `url` or `args` (no env slot to move it to) is redacted
// at normalize time and the server is REFUSED on apply (`embeddedSecrets`).

import { mergeMcpSecrets, type McpSecrets } from './secrets.js';
import { getGlobalSettings, updateGlobalSettingsWith } from '../globalSettings.js';
import { BUILTIN_MCP_SERVERS, type McpServerEntry } from './catalog.js';
import { RETIRED_BUILTIN_MCP_IDS } from './retiredServers.js';
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
  // Secrets found embedded in the url/args (descriptions, no values; `summary`
  // shows them redacted). Non-empty → the server is refused on apply.
  embeddedSecrets: string[];
};

export type ImportScanResult = { servers: ImportedServerInfo[] };

export type ImportApplyResult = {
  imported: string[];
  skipped: string[];
  // Selected but not imported because a secret is embedded in its url/args.
  refused: Array<{ id: string; reason: string }>;
};

function embeddedSecretRefusal(findings: string[]): string {
  return (
    `A secret is embedded in this server's URL or arguments (${findings.join('; ')}). Lattice won't ` +
    'store it in globalSettings.json or put it on a command line — move it into an ' +
    'env var or HTTP header in the source config and re-import, or add the server by hand.'
  );
}

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
  for (const raw of groups.flat()) {
    const n = withoutRetiredId(raw);
    if (seen.has(n.entry.id)) continue;
    seen.add(n.entry.id);
    out.push(n);
  }
  return out;
}

// An imported server named like a REMOVED built-in (`context7`, …) is moved to
// `<id>-imported`: the settings layer strips those ids from every toggle map on
// read (see retiredServers.ts), so under its own name it could never be
// switched on. Renaming here — before scan and apply both see it — keeps the
// scan's ids, the selection, and the stored secrets' key consistent.
function withoutRetiredId(n: Normalized): Normalized {
  if (!RETIRED_BUILTIN_MCP_IDS.has(n.entry.id)) return n;
  return { ...n, entry: { ...n.entry, id: `${n.entry.id}-imported` } };
}

export async function scanImportableServers(projectPath?: string): Promise<ImportScanResult> {
  const [normalized, global] = await Promise.all([
    collectAll(projectPath),
    getGlobalSettings(),
  ]);
  const existingCustom = new Set((global.mcpCustomServers ?? []).map((s) => s.id));

  const servers: ImportedServerInfo[] = normalized.map((n) => {
    // Both stdio env secrets and HTTP header secrets need surfacing so the import
    // UI shows which keys were captured. A given server is stdio xor http, so the
    // two name lists never overlap; dedupe defensively all the same.
    const secretNames = [
      ...new Set([...(n.entry.secretEnvVars ?? []), ...(n.entry.secretHeaders ?? [])]),
    ];
    const secretVars: ImportedSecretVar[] = secretNames.map((envVar) => ({
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
      embeddedSecrets: n.embeddedSecrets,
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
  const refused: ImportApplyResult['refused'] = [];

  for (const n of normalized) {
    if (!selected.has(n.entry.id)) continue;
    if (BUILTIN_IDS.has(n.entry.id) || existingIds.has(n.entry.id)) {
      skipped.push(n.entry.id);
      continue;
    }
    // Never write an entry whose url/args carried a secret (even redacted — it
    // would be a broken server), nor any of its other captured secrets.
    if (n.embeddedSecrets.length > 0) {
      refused.push({ id: n.entry.id, reason: embeddedSecretRefusal(n.embeddedSecrets) });
      continue;
    }
    toAdd.push(n.entry);
    existingIds.add(n.entry.id);
    if (Object.keys(n.secrets).length > 0) secrets[n.entry.id] = n.secrets;
    imported.push(n.entry.id);
  }

  if (toAdd.length > 0) {
    // Append against the list as it is INSIDE the settings lock, not the
    // lenient snapshot above: that read falls back to defaults on a transient
    // lock/parse error (so `[...existing, ...toAdd]` replaced every stored
    // custom server with just the imports), and a save landing between the two
    // reads was overwritten. The strict in-lock read refuses instead.
    await updateGlobalSettingsWith((current) => {
      const cur = current.mcpCustomServers ?? [];
      const curIds = new Set(cur.map((s) => s.id));
      return { mcpCustomServers: [...cur, ...toAdd.filter((s) => !curIds.has(s.id))] };
    });
  }
  if (Object.keys(secrets).length > 0) {
    await mergeMcpSecrets(secrets);
  }

  return { imported, skipped, refused };
}
