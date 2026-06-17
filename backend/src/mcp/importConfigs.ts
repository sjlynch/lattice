// "Import from existing tools": scan the user's OTHER agent configs for MCP
// servers already set up, normalize them into Lattice's catalog shape, and pull
// in their keys — so anyone already on MCP re-enters nothing.
//
// Sources (all read-only, all best-effort — a missing/unparseable file is
// silently skipped):
//   Claude Code — ~/.claude.json (global + projects[*]), ~/.claude/settings.json,
//                 project .mcp.json
//   Cursor      — ~/.cursor/mcp.json, project .cursor/mcp.json
//   Codex       — ~/.codex/config.toml  [mcp_servers.*]  (minimal TOML reader)
//   VS Code     — project .vscode/mcp.json + user mcp.json  (servers + inputs)
//   Windsurf    — ~/.codeium/windsurf/mcp_config.json
//
// Secret handling (MCP plan §8): a LITERAL value in env (whose var name looks
// secret) is stored in ~/.lattice/mcpSecrets.json and kept out of the entry; a
// REFERENCE (`${input:…}`, `${env:…}`, Codex `bearer_token_env_var`) is recorded
// as a secret env var with NO stored value, so it resolves from the ambient env.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeMcpSecrets, type McpSecrets } from './secrets.js';
import { getGlobalSettings, updateGlobalSettings } from '../globalSettings.js';
import { BUILTIN_MCP_SERVERS, type McpServerEntry } from './catalog.js';
import { MANAGED_MCP_MARKER } from './claudeInject.js';

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

// ---- internal normalized form (keeps literal secret values for apply) -------

export type Normalized = {
  entry: McpServerEntry;
  secrets: Record<string, string>; // envVar -> literal value to store
  source: string;
};

type RawServer = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  type?: unknown;
  bearer_token_env_var?: unknown;
};

const SECRET_NAME_RE = /(key|token|secret|password|passwd|auth|credential|apikey)/i;
const REFERENCE_RE = /\$\{[^}]+\}|^\$[A-Z_][A-Z0-9_]*$/;

function looksSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}
function isReference(value: string): boolean {
  return REFERENCE_RE.test(value.trim());
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function detectRuntime(command: string | undefined): McpServerEntry['runtime'] {
  const c = (command ?? '').toLowerCase();
  if (c === 'uvx' || c === 'uv') return 'uv';
  if (c === 'docker') return 'docker';
  return 'node';
}

// Exported for unit testing — the secret-classification rules here are
// security-relevant (a literal key must land in the secrets file, not inline in
// globalSettings; a reference must stay unstored for ambient resolution).
export function normalizeServer(
  name: string,
  raw: RawServer,
  source: string,
): Normalized | null {
  if (!raw || typeof raw !== 'object') return null;
  const isHttp = typeof raw.url === 'string' && raw.url.length > 0;
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  if (!isHttp && !command) return null; // nothing runnable

  const entry: McpServerEntry = {
    id: name,
    label: name,
    description: `Imported from ${source}.`,
    transport: isHttp ? 'http' : 'stdio',
    runtime: isHttp ? 'remote' : detectRuntime(command),
    harnessSupport: { claude: true, codex: true, pi: false },
    builtin: false,
  };

  const secrets: Record<string, string> = {};
  const secretEnvVars: string[] = [];

  if (isHttp) {
    entry.url = String(raw.url);
    // Headers are kept inline for v1 (no env-var indirection for HTTP headers
    // in the harness config). A Codex bearer_token_env_var is an ambient ref.
    if (raw.headers && typeof raw.headers === 'object') {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
      if (Object.keys(headers).length > 0) entry.headers = headers;
    }
    if (typeof raw.bearer_token_env_var === 'string' && raw.bearer_token_env_var) {
      secretEnvVars.push(raw.bearer_token_env_var); // reference; no value stored
    }
  } else {
    entry.command = command;
    entry.args = asStringArray(raw.args);
    const inlineEnv: Record<string, string> = {};
    if (raw.env && typeof raw.env === 'object') {
      for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
        if (typeof v !== 'string') continue;
        if (isReference(v)) {
          // ${input:…} / ${env:…} / $VAR → ambient reference, no stored value.
          secretEnvVars.push(k);
        } else if (looksSecret(k)) {
          // Literal secret → store in the secrets file, keep out of the entry.
          secrets[k] = v;
          secretEnvVars.push(k);
        } else {
          inlineEnv[k] = v; // plain config, fine to keep inline
        }
      }
    }
    if (Object.keys(inlineEnv).length > 0) entry.env = inlineEnv;
  }

  if (secretEnvVars.length > 0) entry.secretEnvVars = [...new Set(secretEnvVars)];
  return { entry, secrets, source };
}

// ---- source readers ---------------------------------------------------------

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function serversFromMap(
  map: unknown,
  source: string,
  skip: (name: string) => boolean = () => false,
): Normalized[] {
  if (!map || typeof map !== 'object') return [];
  const out: Normalized[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (skip(name)) continue;
    const n = normalizeServer(name, raw as RawServer, source);
    if (n) out.push(n);
  }
  return out;
}

async function collectClaude(projectPath?: string): Promise<Normalized[]> {
  const out: Normalized[] = [];
  const home = os.homedir();

  const claudeJson = await readJson(path.join(home, '.claude.json'));
  if (claudeJson) {
    out.push(...serversFromMap(claudeJson.mcpServers, 'Claude Code (~/.claude.json)'));
    // Per-project entries — but skip servers Lattice itself manages there.
    const projects = claudeJson.projects;
    if (projects && typeof projects === 'object') {
      for (const entry of Object.values(projects as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const managed = new Set(asStringArray(e[MANAGED_MCP_MARKER]));
        out.push(
          ...serversFromMap(
            e.mcpServers,
            'Claude Code (project config)',
            (name) => managed.has(name),
          ),
        );
      }
    }
  }

  const settingsJson = await readJson(path.join(home, '.claude', 'settings.json'));
  if (settingsJson) {
    out.push(...serversFromMap(settingsJson.mcpServers, 'Claude Code (settings.json)'));
  }

  if (projectPath) {
    const mcpJson = await readJson(path.join(projectPath, '.mcp.json'));
    if (mcpJson) out.push(...serversFromMap(mcpJson.mcpServers, 'Claude Code (.mcp.json)'));
  }

  return out;
}

async function collectCursor(projectPath?: string): Promise<Normalized[]> {
  const out: Normalized[] = [];
  const global = await readJson(path.join(os.homedir(), '.cursor', 'mcp.json'));
  if (global) out.push(...serversFromMap(global.mcpServers, 'Cursor (~/.cursor/mcp.json)'));
  if (projectPath) {
    const proj = await readJson(path.join(projectPath, '.cursor', 'mcp.json'));
    if (proj) out.push(...serversFromMap(proj.mcpServers, 'Cursor (project)'));
  }
  return out;
}

async function collectWindsurf(): Promise<Normalized[]> {
  const file = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  const json = await readJson(file);
  return json ? serversFromMap(json.mcpServers, 'Windsurf') : [];
}

async function collectVsCode(projectPath?: string): Promise<Normalized[]> {
  const out: Normalized[] = [];
  // VS Code uses `servers` (not `mcpServers`) and `${input:…}` references.
  const userMcp = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Code', 'User', 'mcp.json')
    : path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
  const user = await readJson(userMcp);
  if (user) out.push(...serversFromMap(user.servers, 'VS Code (user)'));
  if (projectPath) {
    const proj = await readJson(path.join(projectPath, '.vscode', 'mcp.json'));
    if (proj) out.push(...serversFromMap(proj.servers, 'VS Code (.vscode/mcp.json)'));
  }
  return out;
}

async function collectCodex(): Promise<Normalized[]> {
  try {
    const text = await fs.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const map = parseCodexMcpServers(text);
    return serversFromMap(map, 'Codex (~/.codex/config.toml)');
  } catch {
    return [];
  }
}

// Minimal TOML reader for `[mcp_servers.<name>]` tables only. Handles single-line
// strings, string arrays, and inline `{ K = "v" }` tables (for env). Anything
// fancier (multi-line arrays, nested tables) is ignored — best-effort by design.
export function parseCodexMcpServers(text: string): Record<string, RawServer> {
  const out: Record<string, RawServer> = {};
  let current: RawServer | null = null;
  const header = /^\[mcp_servers\.("?)([^"\].]+)\1\]\s*$/;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const h = header.exec(line);
    if (h) {
      current = {};
      out[h[2]] = current;
      continue;
    }
    if (line.startsWith('[')) {
      current = null; // left the mcp_servers section
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (current as Record<string, unknown>)[key] = parseTomlValue(value);
  }
  return out;
}

function stripTomlComment(line: string): string {
  // Drop a trailing `#` comment that isn't inside a quoted string.
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inStr = !inStr;
    else if (ch === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(value: string): unknown {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const obj: Record<string, string> = {};
    for (const pair of value.slice(1, -1).split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim();
      let v = pair.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (k) obj[k] = v;
    }
    return obj;
  }
  return value;
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
