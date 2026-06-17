// Machine-global settings — distinct from per-project userSettings.ts.
//
// Stored at ~/.lattice/globalSettings.json. Currently just the spawn queue's
// softCap (`maxConcurrentAgents`): one backend, one terminal-server, one
// machine's RAM/CPU, so concurrency is a machine fact, not a per-project one.

import fs from 'node:fs/promises';
import path from 'node:path';
import { latticeHomeDir } from './projectPath.js';
import type { McpServerEntry } from './mcp/catalog.js';

export type GlobalSettings = {
  // Max agents Lattice runs concurrently — the spawn queue's softCap. Spawns
  // above this are deferred in the queue, never dropped.
  maxConcurrentAgents: number;
  // User-added MCP servers (the built-in catalog stays in code). Definitions
  // only — secret VALUES live in `~/.lattice/mcpSecrets.json`, never here.
  mcpCustomServers?: McpServerEntry[];
  // Per-id partial overrides of built-in catalog entries (e.g. edited args).
  mcpBuiltinOverrides?: Record<string, Partial<McpServerEntry>>;
};

// Bounds for maxConcurrentAgents. The upper bound stays well under the
// terminal-server hard cap (200) so the priority/interactive reserve band
// and un-queued manual terminals still have room.
export const MIN_MAX_CONCURRENT_AGENTS = 1;
export const MAX_MAX_CONCURRENT_AGENTS = 150;

function envDefaultMaxAgents(): number {
  const n = Number(process.env.LATTICE_MAX_CONCURRENT_AGENTS);
  return Number.isInteger(n) && n > 0 ? n : 24;
}

export const GLOBAL_SETTINGS_DEFAULTS: GlobalSettings = {
  maxConcurrentAgents: clampMaxConcurrentAgents(envDefaultMaxAgents()),
};

export function clampMaxConcurrentAgents(n: number): number {
  return Math.min(
    MAX_MAX_CONCURRENT_AGENTS,
    Math.max(MIN_MAX_CONCURRENT_AGENTS, Math.floor(n)),
  );
}

function globalSettingsFile(): string {
  return path.join(latticeHomeDir(), 'globalSettings.json');
}

function sanitize(raw: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const out: Partial<GlobalSettings> = {};
  if (
    typeof raw.maxConcurrentAgents === 'number' &&
    Number.isFinite(raw.maxConcurrentAgents) &&
    raw.maxConcurrentAgents > 0
  ) {
    out.maxConcurrentAgents = clampMaxConcurrentAgents(raw.maxConcurrentAgents);
  }
  // Only touch the MCP fields when present so a partial PATCH (e.g. just the
  // agent cap) never wipes them.
  if (raw.mcpCustomServers !== undefined) {
    out.mcpCustomServers = sanitizeCustomServers(raw.mcpCustomServers);
  }
  if (raw.mcpBuiltinOverrides !== undefined) {
    out.mcpBuiltinOverrides = sanitizeBuiltinOverrides(raw.mcpBuiltinOverrides);
  }
  return out;
}

// Defensive shape validation for user-supplied custom MCP servers. Keeps only
// well-formed entries with the fields the resolver reads; unknown junk is
// dropped rather than trusted. Exported for unit testing.
export function sanitizeCustomServers(raw: unknown): McpServerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    const transport = e.transport === 'http' ? 'http' : 'stdio';
    const support = (e.harnessSupport ?? {}) as Record<string, unknown>;
    const entry: McpServerEntry = {
      id: e.id,
      label: typeof e.label === 'string' ? e.label : e.id,
      description: typeof e.description === 'string' ? e.description : '',
      transport,
      runtime:
        e.runtime === 'uv' || e.runtime === 'docker' || e.runtime === 'remote'
          ? e.runtime
          : 'node',
      harnessSupport: {
        claude: support.claude !== false,
        codex: support.codex === true,
        pi: support.pi === true,
      },
      builtin: false,
    };
    if (typeof e.command === 'string') entry.command = e.command;
    if (Array.isArray(e.args)) entry.args = e.args.filter((a) => typeof a === 'string');
    if (e.env && typeof e.env === 'object') entry.env = stringRecord(e.env);
    if (typeof e.url === 'string') entry.url = e.url;
    if (e.headers && typeof e.headers === 'object') entry.headers = stringRecord(e.headers);
    if (Array.isArray(e.secretEnvVars)) {
      entry.secretEnvVars = e.secretEnvVars.filter((v) => typeof v === 'string');
    }
    if (typeof e.runtimeNote === 'string') entry.runtimeNote = e.runtimeNote;
    if (e.requiresSecret && typeof e.requiresSecret === 'object') {
      const rs = e.requiresSecret as Record<string, unknown>;
      if (typeof rs.envVar === 'string') {
        entry.requiresSecret = {
          envVar: rs.envVar,
          label: typeof rs.label === 'string' ? rs.label : rs.envVar,
          ...(typeof rs.getKeyUrl === 'string' ? { getKeyUrl: rs.getKeyUrl } : {}),
        };
      }
    }
    out.push(entry);
  }
  return out;
}

export function sanitizeBuiltinOverrides(
  raw: unknown,
): Record<string, Partial<McpServerEntry>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Partial<McpServerEntry>> = {};
  for (const [id, ov] of Object.entries(raw as Record<string, unknown>)) {
    if (!ov || typeof ov !== 'object') continue;
    const o = ov as Record<string, unknown>;
    const partial: Partial<McpServerEntry> = {};
    if (typeof o.command === 'string') partial.command = o.command;
    if (Array.isArray(o.args)) partial.args = o.args.filter((a) => typeof a === 'string');
    if (o.env && typeof o.env === 'object') partial.env = stringRecord(o.env);
    if (typeof o.url === 'string') partial.url = o.url;
    if (o.headers && typeof o.headers === 'object') partial.headers = stringRecord(o.headers);
    if (Object.keys(partial).length > 0) out[id] = partial;
  }
  return out;
}

function stringRecord(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// Read global settings, falling back to defaults for a missing/corrupt file.
export async function getGlobalSettings(): Promise<GlobalSettings> {
  try {
    const raw = await fs.readFile(globalSettingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
    return { ...GLOBAL_SETTINGS_DEFAULTS, ...sanitize(parsed) };
  } catch {
    return { ...GLOBAL_SETTINGS_DEFAULTS };
  }
}

// Merge-update and persist global settings; returns the full updated record.
export async function updateGlobalSettings(
  patch: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  const current = await getGlobalSettings();
  const updated: GlobalSettings = { ...current, ...sanitize(patch) };
  await fs.mkdir(latticeHomeDir(), { recursive: true });
  await fs.writeFile(
    globalSettingsFile(),
    JSON.stringify(updated, null, 2),
    'utf8',
  );
  return updated;
}
