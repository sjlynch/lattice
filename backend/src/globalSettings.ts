// Machine-global settings — distinct from per-project userSettings.ts.
//
// Stored at ~/.lattice/globalSettings.json: the spawn queue's softCap
// (`maxConcurrentAgents`), MCP custom-server defs / built-in overrides, the
// curated Pi model menu, and Lattice-managed Pi providers. One backend, one
// terminal-server, one machine's RAM/CPU/Pi config — these are machine facts,
// not per-project ones.
//
// This module is the read/write facade. Each non-trivial field has its
// validation in a focused module next to the shape it produces; this file just
// orchestrates them (see ./globalSettings/CLAUDE.md):
//   - maxConcurrentAgents → clampMaxConcurrentAgents below
//   - mcpCustomServers / mcpBuiltinOverrides → ./mcp/settingsValidation.ts
//   - piProviders → ./piProviderValidation.ts

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './claudeTrust/configFile.js';
import { latticeHomeDir } from './projectPath.js';
import { runExclusive } from './serializeWrites.js';
import type { McpServerEntry } from './mcp/catalog.js';
import {
  sanitizeCustomServers,
  sanitizeBuiltinOverrides,
} from './mcp/settingsValidation.js';
import {
  sanitizePiProviders,
  type PiProvider,
  type PiProviderModel,
} from './piProviderValidation.js';
import {
  sanitizeOpengrepGlobalSettings,
  type OpengrepGlobalSettings,
} from './opengrep/settings.js';

// Re-exported so the historical `import { ... } from './globalSettings.js'`
// surface (piModels.ts + the unit tests) keeps working after the split.
export { sanitizeCustomServers, sanitizeBuiltinOverrides };
export { sanitizePiProviders };
export type { PiProvider, PiProviderModel };

export type GlobalSettings = {
  // Max agents Lattice runs concurrently — the spawn queue's softCap. Spawns
  // above this are deferred in the queue, never dropped.
  maxConcurrentAgents: number;
  // User-added MCP servers (the built-in catalog stays in code). Definitions
  // only — secret VALUES live in `~/.lattice/mcpSecrets.json`, never here.
  mcpCustomServers?: McpServerEntry[];
  // Per-id partial overrides of built-in catalog entries (e.g. edited args).
  mcpBuiltinOverrides?: Record<string, Partial<McpServerEntry>>;
  // Curated Pi model menu — `provider/model` patterns surfaced as "Pi — X"
  // rows in the harness dropdowns. Empty/absent → the default menu (every
  // models.json-declared model + Pi's current default; see piModels.ts).
  // Machine-global because Pi config (~/.pi/agent/) is machine-global.
  piModelMenu?: string[];
  // Lattice-managed Pi providers (OpenAI-compatible endpoints — e.g. vLLM).
  // Reconciled INTO `~/.pi/agent/models.json` on save/boot (Lattice owns these
  // provider ids there; hand-written providers are preserved). Secret VALUES
  // are stored inline here per the v1-simple decision: literal, an env-var
  // name, or a `!command` — all resolved by Pi natively. See piModels.ts.
  piProviders?: PiProvider[];
  // Opengrep (SAST) rule-pack enables — machine-global because the packs are
  // installed once per machine under `~/.lattice/opengrep/rules/`. See
  // opengrep/settings.ts (`packs: { [packId]: boolean }`, absent = the pack's
  // default).
  opengrep?: OpengrepGlobalSettings;
};

// --- maxConcurrentAgents (the spawn queue's softCap) ---------------------
//
// `maxConcurrentAgents` IS the spawn queue's softCap: spawns above it are
// deferred in the queue, not dropped (see spawnQueue.ts). The clamp bounds the
// user-supplied value; the upper bound stays well under the terminal-server
// hard cap (200) so the priority/interactive reserve band and un-queued manual
// terminals still have room. The default (env-seeded) is what a brand-new
// install gets before the user touches the cap.
export const MIN_MAX_CONCURRENT_AGENTS = 1;
export const MAX_MAX_CONCURRENT_AGENTS = 150;
const DEFAULT_MAX_CONCURRENT_AGENTS = 24;

function envDefaultMaxAgents(): number {
  const n = Number(process.env.LATTICE_MAX_CONCURRENT_AGENTS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT_AGENTS;
}

export function clampMaxConcurrentAgents(n: number): number {
  return Math.min(
    MAX_MAX_CONCURRENT_AGENTS,
    Math.max(MIN_MAX_CONCURRENT_AGENTS, Math.floor(n)),
  );
}

export const GLOBAL_SETTINGS_DEFAULTS: GlobalSettings = {
  maxConcurrentAgents: clampMaxConcurrentAgents(envDefaultMaxAgents()),
};

function globalSettingsFile(): string {
  return path.join(latticeHomeDir(), 'globalSettings.json');
}

// Validate a raw/partial settings object field-by-field, delegating each
// field to its focused validator. Only fields that are present are touched, so
// a partial PATCH (e.g. just the agent cap) never wipes the MCP / Pi fields.
function sanitize(raw: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const out: Partial<GlobalSettings> = {};
  if (
    typeof raw.maxConcurrentAgents === 'number' &&
    Number.isFinite(raw.maxConcurrentAgents) &&
    raw.maxConcurrentAgents > 0
  ) {
    out.maxConcurrentAgents = clampMaxConcurrentAgents(raw.maxConcurrentAgents);
  }
  if (raw.mcpCustomServers !== undefined) {
    out.mcpCustomServers = sanitizeCustomServers(raw.mcpCustomServers);
  }
  if (raw.mcpBuiltinOverrides !== undefined) {
    out.mcpBuiltinOverrides = sanitizeBuiltinOverrides(raw.mcpBuiltinOverrides);
  }
  if (raw.piModelMenu !== undefined) {
    out.piModelMenu = Array.isArray(raw.piModelMenu)
      ? raw.piModelMenu.filter((p): p is string => typeof p === 'string' && !!p)
      : [];
  }
  if (raw.piProviders !== undefined) {
    out.piProviders = sanitizePiProviders(raw.piProviders);
  }
  if (raw.opengrep !== undefined) {
    out.opengrep = sanitizeOpengrepGlobalSettings(raw.opengrep);
  }
  return out;
}

async function readGlobalSettings(fallbackOnError: boolean): Promise<GlobalSettings> {
  try {
    const raw = await fs.readFile(globalSettingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
    return { ...GLOBAL_SETTINGS_DEFAULTS, ...sanitize(parsed) };
  } catch (err) {
    // Reads may display defaults, but writes must not replace unread or
    // corrupt settings with a partial PATCH plus those defaults.
    if (!fallbackOnError && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { ...GLOBAL_SETTINGS_DEFAULTS };
  }
}

// Read global settings, falling back to defaults for a missing/corrupt file.
export async function getGlobalSettings(): Promise<GlobalSettings> {
  return readGlobalSettings(true);
}

// Merge-update and persist global settings; returns the full updated record.
// Serialized against itself so two concurrent PATCHes carrying disjoint fields
// each read the prior write's result rather than a shared stale base and
// clobber one another (see serializeWrites.ts). One global file → one key.
export async function updateGlobalSettings(
  patch: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  return runExclusive(`globalSettings:${globalSettingsFile()}`, async () => {
    const current = await readGlobalSettings(false);
    const updated: GlobalSettings = { ...current, ...sanitize(patch) };
    await fs.mkdir(latticeHomeDir(), { recursive: true });
    await atomicWriteFile(
      globalSettingsFile(),
      JSON.stringify(updated, null, 2),
    );
    return updated;
  });
}
